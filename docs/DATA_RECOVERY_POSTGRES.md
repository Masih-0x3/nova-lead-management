# PostgreSQL recovery contract

This runbook covers the **PostgreSQL-native** recovery path for the expanded
product surface (L-02 through L-06 and the tenant foundation). It is a separate
contract from the portable SQLite path in `docs/DATA_RECOVERY.md`, which remains
frozen at manifest schema 4 / 37 tables and is unchanged by this document.

- Format: `novatrade-pg-recovery`
- Schema version: **1**
- Contract module: `scripts/postgres-recovery-contract.mjs`
- Tool: `scripts/postgres-recovery.mjs`
- Coverage: **all 120 migration-created public tables**, classified durable

## Scope and boundaries

The archive owns exactly the `public` schema: table data (via `pg_dump`
custom-format), the table DDL needed to recreate it, RLS policies, triggers,
foreign keys, indexes, sequences, and function/procedure bodies the dump
carries. Native `pg_dump` preserves ownership and ACL `GRANT`s, so the
migration-owned `novatrade_*_definer` roles and their grants restore verbatim.

The archive is **secret-bearing**: `settings.*_encrypted` holds provider-key
ciphertext, tenant/contact/document/outreach rows are confidential customer
data, and lease/credential columns hold opaque hashes that must stay
tamper-evident. Store archives encrypted at rest with restricted access.

These scopes are **not** in the archive and are restored by their own lanes:

| Scope | Boundary |
| --- | --- |
| Auth | `auth.users`/identities/credentials are Supabase-owned. Public rows **do carry auth user UUIDs** as foreign-key values, but never credentials. Real Auth rows must exist **before** the public restore runs — foreign keys validate at restore time. |
| Storage | Object bytes live outside the database. The archive restores only `object_key`/storage-ref/checksum metadata; blobs are re-verified against Storage separately. |
| Vault | Vault secrets (`worker_cron_secret`, `worker_base_url`, connector credentials) are never dumped; re-provision through Vault. |
| Migration ledger | `supabase_migrations` is environment-owned. Re-record applied versions per the runbook after restore. |
| Extensions | `pgcrypto`/`pg_net`/`pg_cron` and scheduler runtime state are platform-provisioned. Destination prep installs required extensions before restore. |
| Environment | `NOSITE_ENCRYPTION_SECRET`, JWT signing keys, `WORKER_CRON_SECRET`, provider keys are deploy-time configuration, never archived. |

Every migrated `public` table must be classified in
`PG_RECOVERY_TABLES`. `verify-data-recovery.mjs` and the `coverage` command
fail closed on an unclassified table; there is no bypass list. A new migration
that creates a table without a classification breaks coverage checks until the
contract is updated.

## Commands

```bash
# classify every public table (fail-closed; no mutation)
node scripts/postgres-recovery.mjs coverage --url postgres://user:pass@127.0.0.1:5432/db

# write manifest.json + data.dump + SHA256SUMS into a new private dir (0700)
node scripts/postgres-recovery.mjs backup --url postgres://user:pass@127.0.0.1:5432/db --out <new-dir>

# offline integrity/contract check; no database contact
node scripts/postgres-recovery.mjs verify --dir <dir>

# guarded atomic restore into a prepared empty database + post-restore verify
node scripts/postgres-recovery.mjs restore --dir <dir> \
  --url postgres://user:pass@127.0.0.1:5432/<db> --database <db>
```

`pg_dump`, `pg_restore`, and `psql` are child processes. Override their argv
prefix with `--pg-dump-cmd` / `--pg-restore-cmd` / `--psql-cmd` (or
`PG_DUMP_COMMAND` / `PG_RESTORE_COMMAND` / `PSQL_COMMAND`), e.g.
`"docker exec -i <container> pg_dump"`. When the tools live in a different
network namespace (docker exec, a bastion), pass `--tool-url` with the URL as
reachable from the tool side. It must name the **same database and user**, and
for **both** backup and restore the tool-side psql probes
`pg_control_system()`'s `system_identifier` to prove it lands on the same
cluster instance — a `--tool-url` that reaches a different cluster is refused
before any archive is produced or any mutation attempted.

## Safety model

### Backup consistency

Backup opens a `REPEATABLE READ` transaction, calls `pg_export_snapshot()`,
and passes `--snapshot` to `pg_dump`. The manifest's per-table row counts and
canonical content digests are computed inside that same transaction, so the
archive and its evidence share one MVCC snapshot — writes committed after
snapshot export cannot split them (verified by a concurrent-write rehearsal).

### Restore safety

- **Backup is loopback-only, always** — there is no remote-backup path.
  Restore is loopback-only by default; a remote restore target additionally
  requires `--allow-remote` plus the operator acknowledgement flag.
- `--database` must equal the URL's database name.
- The tool-side connection is identity-bound to the SQL-side one at preflight:
  same database, same user, same `system_identifier` — and the in-transaction
  guard **re-verifies all three** (including `pg_control_system()`'s
  `system_identifier`) inside the same restore transaction, so a tool path
  switched after preflight aborts the restore before `DROP` runs.
- Preflight refuses a non-empty `public` schema and a cluster missing the
  archive's required roles or extensions.
- Restore runs inside **one** `psql --single-transaction`: the guard SQL
  re-checks database/user/cluster/emptiness/roles/extensions inside the
  transaction, then `DROP SCHEMA public RESTRICT` — never `CASCADE` — swaps
  the schema only if nothing new appeared after preflight. If the destination
  changed between preflight and the transaction, `RESTRICT` fails and rolls
  back without deleting anything.
- The `pg_restore`-generated script replays under its own `\restrict` psql
  guard. Any failure **inside** the transaction leaves the destination
  untouched. Post-restore verification runs **after commit**: a verification
  failure leaves the restored (isolated) destination in place for
  investigation — drop the database manually and re-run after resolving; it is
  not rolled back.

### Output preservation

`backup` exclusively creates a fresh output directory (`0700`) and archive
files (`0600`). It refuses a preexisting, nonempty, or symlinked `--out`, and
on failure removes only paths it created — never an existing directory or
someone else's archive. Temporary SQL lives in `mkdtemp` dirs, not predictable
shared `/tmp` paths.

### Diagnostics

Tool failures return a **bounded allowlist** only: tool name, exit code, and
timeout status. Raw child stderr is never surfaced in thrown errors, logs, or
receipts — PostgreSQL `ERROR` text can echo rejected input values and quoted
secrets, and multiline continuations evade prefix filtering, so no stderr
content is relayed at all. If raw tool diagnostics are genuinely needed, the
operator opts in with `PG_RECOVERY_TOOL_STDERR_FILE=<path>`: the stderr is
written exclusively (`wx`) with mode `0600` to that path and nowhere else.
URL passwords are passed via `PGPASSWORD`, never argv. Errors name the
violated rule without printing rows, SQL, or credentials.

### Archive trust model

`manifest.json` + `SHA256SUMS` prove **integrity** (corruption/tamper
detection), not **authenticity** — anyone who can modify the archive can
recompute the sums. The `pg_restore`-rendered script is executable SQL: it
runs arbitrary statements with the privileges of the restoring user.
**Restore only artifacts you produced yourself and kept access-controlled**;
do not restore archives received from untrusted channels, and treat the
archive directory itself as secret material.

### Scale limits

The rehearsal covers a representative seed dataset (~85 populated tables on
disposable PG16). Two evidence paths materialize whole objects in memory:
per-table canonical digests buffer each table's rows, and the archive sha256
is computed over the dump bytes in memory. This qualifies the tooling at
rehearsal/dev scale. A production-scale database needs a **separate
qualification pass** (digest memory, pg_dump duration, disk headroom); this
tool does not claim streaming support for arbitrarily large production
backups.

## Destination preparation

A restore destination is a **freshly created** database on a cluster that has:

1. The four migration-owned definer roles
   (`novatrade_agent_runtime_definer`, `novatrade_document_pipeline_definer`,
   `novatrade_l04_strategy_definer`, `novatrade_worker_dispatch_definer`) —
   `CREATE ROLE ... NOLOGIN` suffices; the archive's GRANTs re-bind them.
2. `CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);` plus
   the real Auth user rows — public tables hold `auth.users` UUIDs in FK
   columns, so the Auth lane must populate them **before** the public restore
   or foreign keys fail at restore time. Credentials stay with Auth.
3. `CREATE SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH
   SCHEMA extensions;` — function bodies reference `extensions.crypt`/`gen_salt`.
4. Nothing else in `public` — the default empty `public` schema is dropped by
   the in-transaction `DROP SCHEMA public RESTRICT` guard.

After restore, re-record applied versions in `supabase_migrations.schema_migrations`
per environment procedure, restore Auth users, re-provision Vault secrets and
environment variables, then verify Storage objects against the restored
`object_key` metadata.

## Rehearsal evidence

`src/lib/__tests__/postgres-recovery-rehearsal.test.ts` is env-gated
(`PG_RECOVERY_RUN_DISPOSABLE_TESTS=1`) and self-provisions a disposable
PostgreSQL 16 container. It replays all portable migrations, seeds
representative L-02–L-06 rows through the real trigger/constraint machinery
(document pipeline states, scan/extraction leases, source runs and budget
reservations, L-04 strategy/discovery, L-05 qualification, L-06 outreach), and
proves: full-archive backup of all 120 tables, atomic restore with exact
row/digest/RLS/trigger verification, snapshot consistency under concurrent
writes, tamper/role-mismatch refusals, wrong-target and non-empty-destination
refusals with zero data loss, the in-transaction `RESTRICT` race guard, the
in-transaction cluster-`system_identifier` guard, backup-side tool/cluster
identity binding, stderr secret suppression, existing-output refusal, and
post-restore drift detection.

## Relationship to the portable contract

The v3/v4 SQLite→Postgres portable contract (`scripts/data-transfer-contract.mjs`,
`export-sqlite-data.mjs`, `import-supabase-data.mjs`) is unchanged: it still
owns the 37 legacy tables, its exclusion list still protects the encrypted
settings columns, and `--restore-historical` semantics are intact. This
PostgreSQL path does not widen the portable contract; it covers the full
public schema of a live Postgres deployment. `verify-data-recovery.mjs` checks
both: the portable 37-table manifest shape on SQLite, and the 120-table
Postgres classification on the migrated schema.
