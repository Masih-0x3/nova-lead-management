# Testing and release checks

Use Node 24. The repository rejects other Node majors in the composed release gate.

## Safe local gate

```bash
npm ci
npx playwright install chromium
npm run release:check
```

`release:check` runs TypeScript no-emit, ESLint, the platform-appropriate Vitest suite, a production build, and the public read-only Playwright project. On Windows that is the full Vitest suite. On other platforms it excludes the three tests that transitively require the accepted Windows/NTFS finalization boundary. The browser pass starts the built app on a temporary loopback port and never enables authenticated or mutating specs.

## Playwright lanes

| Command | Scope | Required state |
|---|---|---|
| `npm run test:e2e:public` | Public login/trust pages, desktop/mobile overflow, runtime errors | Running target only |
| `npm run test:e2e:auth` | Protected read-only workflow checks | Auth storage state or E2E credentials |
| `npm run test:e2e` | Public plus protected read-only projects | Auth storage state or E2E credentials |
| `npm run test:e2e:launch` | Protected desktop/mobile screenshot pass | Auth storage state or E2E credentials |
| `npm run test:e2e:mutating` | Disposable lead workbench, archive, drag, exclusion, and restoration flows | Auth plus explicit mutation opt-in and fixture binding |

Authenticated commands require either:

```bash
E2E_STORAGE_STATE=.auth/admin.json npm run test:e2e
```

or both `E2E_SUPABASE_EMAIL` and `E2E_SUPABASE_PASSWORD`. Missing auth is a hard failure, not a skipped green run.

Mutation suites are excluded by default. A local disposable target requires:

```bash
E2E_ALLOW_MUTATIONS=1 \
E2E_DISPOSABLE_LEAD_ID=lead-e2e-1 \
E2E_DISPOSABLE_LEAD_NAME='[E2E DISPOSABLE] Kanban lead' \
npm run test:e2e:mutating
```

The ID and exact name must identify the same operator-owned fixture. Its name must start with `[E2E DISPOSABLE] `, and it must be unarchived, non-excluded, in the `New` column, and expose `qualification_status=needs_verification` directly on its detail page; a missing or mismatched fixture is a hard failure. Kanban checks use the exact marked name as a search constraint, while cleanup navigates directly to the bound ID and restores exclusion, status, and archive state in `finally`; the suite does not create leads or persist outreach events.

For any non-loopback target, `E2E_ALLOW_REMOTE_MUTATIONS=1` is also required. Use that override only after approving the target, fixture data, rollback, and cleanup. Never point the mutating suite at production by habit.

The public project is release evidence for public rendering only. It does not prove authenticated workflows, production data, migrations, workers, paid APIs, or deployment state.

## L-01 local worker route rehearsal

The five tenant worker routes are proven end to end by the env-gated lane
`src/lib/__tests__/l01-local-worker-routes-postgres.test.ts`. It replays the 63
portable migrations on a disposable PostgreSQL 16 database, seeds a tenant
foundation, provisions restricted `l01_lease_issuer`/`l01_lease_resolver` roles
from the URL credentials (creating and dropping them itself), and drives every
worker route through a real issuer-issued lease while asserting fail-closed
denials. Safe command shape:

```bash
# PostgreSQL 16 on loopback with a disposable database named exactly
# l01_worker_routes_rehearsal, plus the two login roles named in the URLs.
L01_WORKER_ROUTES_RUN_DISPOSABLE_TESTS=1 \
L01_WORKER_ROUTES_ADMIN_DATABASE_URL=postgresql://postgres:pass@127.0.0.1:5432/l01_worker_routes_rehearsal \
TENANT_WORKER_LEASE_ISSUER_DATABASE_URL=postgresql://l01_lease_issuer:pass@127.0.0.1:5432/l01_worker_routes_rehearsal \
TENANT_WORKER_LEASE_RESOLVER_DATABASE_URL=postgresql://l01_lease_resolver:pass@127.0.0.1:5432/l01_worker_routes_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/l01-local-worker-routes-postgres.test.ts
```

The lane performs the same migration replay as the F-01/Q-006A lanes and
updates the tracked migration count with them when migrations are added.

## Local runtime tooling (L-01)

`npm run local:seed` (script `scripts/seed-local-tenant.mjs`) provisions the
restricted worker lease issuer/resolver roles and seeds an admin/researcher
tenant foundation on loopback PostgreSQL — including a local Supabase stack at
`127.0.0.1:54322`. Passwords are generated and printed once when unset; the
script verifies each role's exact runtime capability and prints ready
`.env.local` values. It refuses non-loopback targets unless
`LOCAL_SEED_ALLOW_REMOTE=1`.

`npm run local:dispatch` (script `scripts/run-local-workers.mjs`) acquires a
durable lease per worker through the issuer role and calls each of the five
worker routes with the lease selector. Run it against a seeded database and a
running app (`npm run dev` or `next start`) with the same issuer/resolver URLs
in `.env.local`.

`npm run local:seed:sqlite` (script `scripts/seed-local-tenant-sqlite.mjs`,
driver `scripts/local-tenant-seed.driver.ts`) provisions a tenant on the
SQLite compatibility runtime (`nosite-leads.db` — the `DATABASE_URL`-absent
path where member mutations are enabled) through the canonical services:
`provisionTenant` → owner `acceptInvitation` → optional member invites →
member `acceptInvitation`s, plus `app_users` profiles. Re-running replays the
journaled keys and converges to the same state. The owner membership is
tenant-wide (no workspace) because tenant-admin surfaces require tenant
scope; a workspace-bound membership can never resolve it. Defaults bind the
seeded memberships to the L-01 deterministic auth identities
(`admin@local.nosite.test` owner, `researcher@local.nosite.test` admin,
`approver@local.nosite.test` second owner) so the three-actor deletion
governance chain (request → verify → approve) is exercisable; override via
`LOCAL_SEED_*` env vars. `LOCAL_SEED_MEMBER=0` skips the extra members;
`LOCAL_SEED_ACCEPT=0` leaves invitations issued for manual acceptance. The
approver is invited as admin then promoted via `assignMemberRole` because
member invitations cannot issue the owner role.

The seed also registers one platform-support principal
(`support@local.nosite.test` → a deterministic `12000000-…-0005` identity,
`LOCAL_SEED_SUPPORT_REFERENCE`/`LOCAL_SEED_SUPPORT_IDENTITY_ID` to override)
in `platform_support_principals` — the registry the support-access service
resolves `supportPrincipalRef` against. Without an active row every grant
request fails closed at `SUPPORT_GRANT_REQUIRED`.

The provisioned `tenant_policies` baseline is restrictive-by-default (all
features disabled). The seed finishes with two version-advancing mutations —
both must run after every invitation step because invitations bind the
policy version at issue/acceptance time:

- `primary_delete_within_days = 1` (the schema minimum; bound is 1–30) via
  the canonical `requestRetentionChange` path
  (`createLocalTenantRetentionService`, the owner member-actor's
  `tenant:manage` capability) — the one-day schedule is what lets the local
  operator lane simulate the deletion-worker wake;
- `copy_export` enabled through the canonical `requestFeatureChange` path
  (`createLocalTenantFeatureService`, the owner member-actor's
  `feature:manage` capability) — otherwise the export surface is correctly
  feature-blocked. Replays return the service's `unchanged` no-op result.

`npm run local:tenancy:operator` (script `scripts/local-tenant-operator.mjs`,
driver `scripts/local-tenant-operator.driver.ts`) is the local
platform-operator surface for the invitation lifecycle — the same lane the
seed's `provisionTenant` uses, auditing as `actorLayer: "system"` under the
configured operator identity:

```
npm run local:tenancy:operator -- invite <authIdentityId> [role]
npm run local:tenancy:operator -- status <invitationId>
npm run local:tenancy:operator -- reissue <invitationId> [expiresAtIso]
npm run local:tenancy:operator -- revoke <invitationId>
```

`invite` is a member-actor convenience (owner `invitePendingMember` +
`issueMembershipInvitation`) that produces a pending invitation to operate
on; the other three are the operator-scoped service ops. Reissue supersedes
the issued invitation and issues generation n+1 with delivery through the
local adapter; status returns the privacy-safe lifecycle view; revoke closes
an issued invitation. All ops are journaled — deterministic per-target keys
replay the recorded result on accidental re-runs; `LOCAL_OPERATOR_IDENTITY`,
`LOCAL_OPERATOR_REASON_CODE`, `LOCAL_OPERATOR_REASON`, and
`LOCAL_OPERATOR_IDEM` override the defaults.

The same driver exercises the member-facing tenant lifecycle and stands in
for the absent platform deletion worker. Member commands resolve the
caller's active tenant-wide membership + role binding and run the canonical
service ops as `actorLayer: "member"` (audit carries the verified binding);
`run-deletion` executes the worker pass as `actorLayer: "system"` under the
operator identity:

```
npm run local:tenancy:operator -- archive <authIdentityId>
npm run local:tenancy:operator -- deletion-request <authIdentityId>
npm run local:tenancy:operator -- deletion-verify <jobId> <authIdentityId>
npm run local:tenancy:operator -- deletion-approve <jobId> <authIdentityId>
npm run local:tenancy:operator -- deletion-cancel <jobId> <authIdentityId>
npm run local:tenancy:operator -- deletion-requeue <jobId> <authIdentityId>
npm run local:tenancy:operator -- run-deletion <jobId>
npm run local:tenancy:operator -- feature-set <authIdentityId> <featureId> <on|off>
npm run local:tenancy:operator -- retention-set <authIdentityId> <knob> <days>
npm run local:tenancy:operator -- limit-cap <authIdentityId> <action> <cap>
npm run local:tenancy:operator -- limit-kill <authIdentityId> <action> <on|off>
npm run local:tenancy:operator -- platform-limit-kill <operatorPrincipalId> <global <on|off>|action <action> <on|off>>
npm run local:tenancy:operator -- support-request <authIdentityId> <principalRef> [permissionsCsv] [dataClassesCsv]
npm run local:tenancy:operator -- support-approve <grantId> <authIdentityId>
npm run local:tenancy:operator -- support-revoke <grantId> <authIdentityId>
npm run local:tenancy:operator -- support-list <authIdentityId>
npm run local:tenancy:operator -- support-check <grantId> <principalRef>
npm run local:tenancy:operator -- support-run <grantId> <principalRef>
npm run local:tenancy:operator -- support-export <grantId> <principalRef>
```

`feature-set` is the member-facing feature-policy lane: the local
`TenantFeatureActorResolver` proves the caller's `feature:manage` capability
(owner/admin are role-capable) and the `TenantFeaturePolicyChangeExecutor`
CASes `tenant_policies` one version forward with the
`tenant_feature_policy_changed` audit row in the same transaction — the two
ports `createTenantFeatureService` leaves to the runtime. `autonomous_send`
stays forbidden; a same-value request returns `unchanged` without a version
bump; a stale `expectedPolicyVersion` fails `POLICY_VERSION_CONFLICT`.

`retention-set` is the same pattern over the retention knobs —
`createTenantRetentionService` (retention-policy.ts) gates on `tenant:manage`
(owner/admin are role-capable) and the local executor CASes `tenant_policies`
one version forward with the `tenant_retention_policy_changed` audit row in
one transaction. The knob vocabulary is the six bounded integer fields:
`export_retention_days` (1–7), `operational_log_retention_days` (1–30),
`raw_source_retention_days` (1–180), `contact_freshness_days` (1–180),
`primary_delete_within_days` (1–30), `backup_expire_within_days` (1–35).
Bounds come from each field's own schema validator; out-of-range or
non-integer days fail `INVALID_DAYS_VALUE`, and literal-fixed fields
(`tombstone_retention_years`, `active_materials_mode`) plus enablement/review
fields fail `INVALID_KNOB` — they are not mutable through this lane.

`limit-cap` and `limit-kill` are the member-facing quota-configuration lane:
`changeConfiguration` resolves authority from the tenant context (installed by
`runWithTenantContext` — the same way the HTTP action path does), the role's
`budget:manage`/`feature:manage` conditional decision passes through the
session-echo policy evaluator `executeTenantOperation` uses, and the backend
CASes `tenant_limit_configuration` one version forward with the
`tenant_limit_configuration_changed` event in one transaction. A same-value
request throws `CONFIGURATION_NOOP`, a cap above the action's
`platformHardCap` throws `CONFIGURATION_INVALID`, and a stale version throws
`CONFIGURATION_VERSION_CONFLICT`. `platform-limit-kill` is the
platform-operator lane through `changePlatformKillSwitch`: locally the
operator registry is the `LOCAL_PLATFORM_OPERATOR_ID` env seam — without it
every principal resolves null and the service denies
`PLATFORM_CONFIGURATION_UNAUTHORIZED`. Both scopes are exercisable:
`action <action> <on|off>` freezes one action across tenants and
`global <on|off>` freezes all consumption; either one makes the next member
consume fail `BLOCKED_LIMIT`/`BLOCKED_KILL_SWITCH` until switched back off.

The `support-*` commands drive the support-access grant lifecycle through
`createSupportAccessService` composed with the local repository, principal
resolver, and policy evaluator — the same wiring the
`tenant-operations-actions` server actions use. `support-request`,
`support-approve`, `support-revoke`, and `support-list` are member-actor ops
(`support:grant`/`audit:read` capability, owner/admin) run inside
`runWithTenantContext`; `support-check` is the support-actor lane — the
acting principal is bound via the resolver's `currentReference` (the local
stand-in for a platform-support session) and must run outside any member
context. A request opens a two-hour `pending` grant scoped to
`tenant:read`/`audit:read` over `tenant_metadata`/`audit_operational_metadata`;
approval activates it, `support-check` proves scope/window/permission
eligibility (`OK_SUPPORT_AUTHORIZED`), and revocation removes authority
immediately (a post-revoke check returns `SUPPORT_GRANT_REQUIRED`). Every op
journaled through `support_access_journal`/`support_access_events`: replays
return `OK_SUPPORT_REPLAY`, a re-used key over a different payload returns
`SUPPORT_STATE_CONFLICT`, and unresolvable principal references deny
non-enumerating under the `platform-safe-null` actor namespace. Note the
service's text grammar excludes `@` from idempotency keys — the driver
hashes the principal reference into the request key.

`support-run` and `support-export` exercise the *use* half of a grant —
`authorizeAndRun` binds the support principal, asserts the grant's
permission/window/data-class scope, installs a `SupportAccessContext`, and the
db layer resolves `source: "support"` inside `withTenantDbContext` (the scoped
read returns the tenant's membership count under that context). `support-run`
asserts the grant's first declared permission as a scoped-read proof.
`support-export` asserts `data:export`, then drives the canonical
`requestExport` with `requester.supportAccessGrantId` (the service re-validates
grant tenant/state/window/scope/permission and anchors the job to the grant)
followed by `runExport`. A successful run produces a `released`
`tenant_export_jobs` row with `requester_auth_identity_id` = the support
identity, `requester_membership_id` NULL, `support_access_grant_id` set, and
`tenant.export.requested` audited under `actor_layer: "support"`. Requesting a
grant with export scope:
`support-request <authIdentityId> <principalRef> data:export,audit:read tenant_metadata,customer_lists,audit_operational_metadata`.
After revocation both lanes deny `SUPPORT_GRANT_REQUIRED` and create nothing.

The member-facing half of the same lifecycle is also reachable through the
`/tenancy` page for owner/admin sessions: "Request support access" opens the
request form (principal reference, reason, UTC window, permissions, data
classes), and the latest grant renders in `SupportAccessPanel` with approve
and revoke controls — both call `requestTenantSupportAccessAction` /
`decideTenantSupportAccessAction`, which resolve the real session, assert
`support:grant`, run inside `runWithTenantContext`, and revalidate the page
on success.

The same page carries the full destructive-governance UI, verified live in a
browser across three real sessions: "Request tenant archive" opens the
reason-code editor (`tenant-lifecycle:` correlation), then "Request deletion"
on the archived tenant, "Verify deletion request" by a second admin who did
not request, "Approve and schedule deletion" by a third owner who neither
requested nor verified (the `DeletionDecisionStrip` gates all three
independence checks client-side; the service rechecks), and "Cancel deletion
request" rolls `deletion_pending` back to `archived` — the durable
cancel-rollback edge. Every step journals through
`requestTenantLifecycleTransitionAction` / the `tenant-deletion:*` actions as
member-layer audit rows. A released export job renders its receipt card
(format, scope hash, audit event, included/excluded/redacted counts) while
correctly gating the request button until the artifact expires or deletes —
`released → expired → deleted` is the only path back to a requestable state.
Note: cancel returns the tenant to `archived`, not `active` — archive is a
one-way transition, so a UI deletion pass ends with a deleted-via-CLI or
archived tenant; reseeding then replays foundations but cannot resurrect it
(delete `nosite-leads.db*` and reseed for a fresh active fixture).

The export artifact lifecycle completes through the retention sweep —
`sweepExportRetention` advances each eligible job by exactly one legal
transition per pass: `released` past `expires_at` becomes `expired` (the
schema trigger enforces the expiry precondition and `isArtifactUsableAt`
already gates the window), and `expired` becomes `deleted` after the
export-runner port's `purge` removes the artifact bytes (the local runner
persists no bytes — the job row's committed ref + checksum remain as the
accountability record). Both transitions audit under `actor_layer:
"system"` as `tenant.export.expired` / `tenant.export.deleted`. The member
lane round-trips through the operator:

```bash
npm run local:tenancy:operator -- export-request <authIdentityId>
npm run local:tenancy:operator -- run-export <jobId>
npm run local:tenancy:operator -- export-sweep <tenantId>
```

`LOCAL_EXPORT_ARTIFACT_TTL_MS=<ms>` on `run-export` wraps the runner's
committed `expiresAt` so the ≥1-day retention floor is exercisable in a
local session (same philosophy as the `run-deletion` clock seam): the
row's artifact facts are real; only the committed artifact lifetime
shortens. Verified live: a 1.5s-TTL export went `released → expired →
deleted` across two sweeps while a policy-window (7-day) `released` job
was left untouched.

The T-028 legacy cutover is exercised end-to-end against a dedicated
fixture file (`nosite-leads-legacy.db`, overridable via
`LOCAL_COMPAT_DB`) — the same `compatibility-backfill.ts` functions the
unit tests drive, but against a real legacy-shaped database on disk:

```bash
npm run local:tenancy:compat -- stage     # fresh legacy db: full schema +
                                          # unscoped rows on all 18 tables
npm run local:tenancy:compat -- prepare   # adds nullable scope columns +
                                          # receipt ledger (idempotent)
npm run local:tenancy:compat -- run       # snapshots the file, introspects
                                          # the manifest from live rows,
                                          # executes the cutover
npm run local:tenancy:compat -- replay    # same key replays the recorded
                                          # receipt after drift checks
npm run local:tenancy:compat -- verify    # scoped counts + memberships +
                                          # receipt summary
npm run local:tenancy:compat -- rollback  # restores the pre-run snapshot
                                          # (rollback: snapshot_restore_only)
```

`run` stamps every legacy row with the compatibility tenant scope in one
transaction — all 18 tables end scoped except `audit_logs`, which stays
`legacy_unscoped` by design (preserved accountability history). User
mapping is manifest-driven: the active `admin` app_user becomes the
tenant `owner`, researchers become `researcher` members, and the disabled
legacy user lands as a `suspended` membership with a revoked binding.
`replay` proves the idempotency ledger: the same manifest returns the
recorded receipt only after `verifySqliteReceipt` rechecks foundations,
user mappings, auth references, and per-table checksums — a tampered row
fails `T028_REPLAY_*` instead of replaying. `rollback` exercises the
receipt's own `snapshot_restore_only` contract: restoring the pre-run
file copy returns the database to the prepared-but-uncutover state
(tenants 0, memberships 0, receipt ledger empty, all scope columns NULL),
and `run` is re-runnable afterward — it reproduces the identical
deterministic receipt.

The Postgres half of the same cutover — the migration-installed
`public.novatrade_run_compatibility_backfill(jsonb)` function — is
rehearsed by the env-gated test in
`src/lib/__tests__/compatibility-tenant-backfill.test.ts`. It requires a
disposable PostgreSQL 16 database named exactly
`t028_compatibility_rehearsal` on loopback:

```bash
docker run -d --name nova-l02-t028-rehearsal \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=t028_compatibility_rehearsal \
  -p 127.0.0.1:55440:5432 postgres:16
T028_RUN_DISPOSABLE_PG_TESTS=1 \
T028_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t028_compatibility_rehearsal \
npx vitest run src/lib/__tests__/compatibility-tenant-backfill.test.ts
```

The rehearsal replays the dependency + T-028 migrations, then proves the
engine contract (`T028_SOURCE_ENGINE_CONTRACT_MISMATCH`), unmapped-auth
denials, checksum-mismatch zero-residue, concurrent exactly-once (two
racing invocations produce one receipt), receipt-binding/engine-pair/
cross-tenant-policy constraints, `anon`/`authenticated` privilege +
forced-RLS denial, deterministic replay, post-cutover drift detection
(`T028_REPLAY_CHECKSUM_DRIFT`, `T028_POLICY_BASELINE_DRIFT`,
`T028_IDEMPOTENCY_CONTENT_CONFLICT`), and the append-only receipt guard.
The same disposable container can host the other gated tenancy lanes
(`f01_session_bootstrap_rehearsal`, `t027_rls_rehearsal` databases plus
restricted `NOSUPERUSER NOBYPASSRLS` roles); each lane expects a fresh
database per run — the migration history is one-shot, not re-runnable.

The T-015 tenant-aware audit guard is rehearsed the same way by
`src/lib/__tests__/tenant-audit-context-postgres.test.ts`. Provision a
`t015_audit_context_rehearsal` database on the same container, seed it
with the migrated schema (`pg_dump -s` from the bootstrap rehearsal
database applies cleanly), create a `t015_runtime` role with
`NOSUPERUSER NOBYPASSRLS LOGIN`, then grant `USAGE` on `public`,
`SELECT, INSERT` on `public.audit_logs`, `SELECT` on
`public.tenant_memberships` and `public.tenant_role_bindings` (the guard
trigger's cross-checks run as the invoker), and `EXECUTE` on the four
`novatrade_rls_*` helpers:

```bash
T015_RUN_DISPOSABLE_AUDIT_TESTS=1 \
T015_RUNTIME_ROLE=t015_runtime \
T015_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t015_audit_context_rehearsal \
DATABASE_URL=postgresql://t015_runtime:t015_runtime@127.0.0.1:55440/t015_audit_context_rehearsal \
npx vitest run src/lib/__tests__/tenant-audit-context-postgres.test.ts
```

The lane proves the two-layer contract on real Postgres: the
`trg_novatrade_audit_logs_guard` trigger fires even for the privileged
owner connection (triggers are not RLS-gated), accepting exactly-shaped
`tenant`/`platform`/`legacy_unscoped` rows while rejecting tenant rows
missing any server-derived context field, spoofed `actor_email`,
non-`member` actor layers, cross-tenant or identity-mismatched
memberships, role-binding mismatches, platform/legacy rows carrying
tenant context, every lexical-envelope violation, and any UPDATE or
DELETE (append-only). The second layer is that `audit_logs` carries RLS
with zero policies: the `t015_runtime` member role sees zero rows and a
direct INSERT under a fully valid member context fails the
`WITH CHECK` default-deny — audit writes exist only through the trusted
writer path.

The T-030 canonical transaction boundary (`withTenantDbContext` in
`src/lib/db/index.ts`) is rehearsed end-to-end on real Postgres by
`src/lib/__tests__/tenant-db-context-postgres.test.ts`. Where T-027
hand-installed `app.*` GUCs, this lane drives the production path:
accepted member/worker AsyncLocalStorage context →
`installTransactionLocalContext` → transaction-local `set_config` →
real RLS row filtering under a restricted role. Provision a
`t030_db_context_rehearsal` database on the same container, seed it
with the migrated schema (`pg_dump -s` from the bootstrap rehearsal
database applies cleanly), create a `t030_runtime` role with
`NOSUPERUSER NOBYPASSRLS LOGIN`, then grant `USAGE` on `public`,
`SELECT, INSERT, UPDATE, DELETE` on the eight foundation tables
(`tenants`, `workspaces`, `tenant_memberships`, `tenant_role_bindings`,
`tenant_policies`, `support_access_grants`,
`support_access_grant_permissions`, `support_access_grant_data_classes`),
and `EXECUTE` on all four `novatrade_rls_*` helpers (member + support
context plus the two support metadata readers — every policy's helper
must be executable for RLS evaluation to proceed):

```bash
T030_RUN_DISPOSABLE_PG_TESTS=1 \
T030_RUNTIME_ROLE=t030_runtime \
T030_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t030_db_context_rehearsal \
DATABASE_URL=postgresql://t030_runtime:t030_runtime@127.0.0.1:55440/t030_db_context_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-db-context-postgres.test.ts
```

The lane proves the adapter end-to-end: member GUCs installed through
`PostgresClient` give a tenant-wide owner exactly its tenant's rows
across all foundation tables, a workspace-scoped session filters to its
workspace, a different tenant's researcher sees only its own rows (and
no memberships — the member-select role gate), member-context mutations
are denied by the `deny_all_other_verbs` policies, a worker context
installs its lease GUCs yet sees zero member rows, missing/mixed
contexts are rejected before any SQL runs, identical nesting reuses the
transaction client, and transaction-local GUCs are cleared after both
commit and rollback on the pooled connection. The same `DATABASE_URL`
also exercises the dormant Postgres cases inside
`src/lib/__tests__/tenant-db-context.test.ts` (concurrent
transaction-local isolation, rollback cleanup, pooled-reuse cleanup):

```bash
DATABASE_URL=postgresql://t030_runtime:t030_runtime@127.0.0.1:55440/t030_db_context_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-db-context.test.ts
```

The T-031 tenant feature-policy write path — the first Postgres-backed
service-port mutation — is rehearsed by
`src/lib/__tests__/tenant-feature-policy-change-postgres.test.ts`.
Foundation-table writes are denied to every runtime member context by the
`deny_all_other_verbs` policies, so the adapter invokes the SECURITY
DEFINER `novatrade_apply_tenant_feature_policy_change` (migration
`202609120004`) inside `withTenantDbContext`; the function re-validates
the transaction-local member GUCs database-side, requires tenant-wide
owner/admin authority, CAS-updates `tenant_policies`, and appends the
member-layer audit row atomically. Provision a
`t031_feature_policy_rehearsal` database seeded with the migrated schema,
a `t031_runtime` role (`NOSUPERUSER NOBYPASSRLS LOGIN`) with the T-030
grant set plus `EXECUTE` on
`public.novatrade_apply_tenant_feature_policy_change(text, boolean,
integer, jsonb)`, then run — `DATABASE_SSL=disable` is required because
the production `PostgresClient` forces TLS otherwise, and the lane
preflights a `getDb()` probe so a transport failure cannot masquerade as
a designed denial:

```bash
T031_RUN_DISPOSABLE_PG_TESTS=1 \
T031_RUNTIME_ROLE=t031_runtime \
T031_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t031_feature_policy_rehearsal \
DATABASE_URL=postgresql://t031_runtime:t031_runtime@127.0.0.1:55440/t031_feature_policy_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-feature-policy-change-postgres.test.ts
```

The lane drives the canonical
`createPostgresTenantFeatureService().requestFeatureChange` path: an
owner change applies and appends exactly one correctly shaped
member-layer audit row; a non-capable member, a workspace-scoped owner,
and a cross-tenant request are each denied without mutation or audit
residue; a version conflict is reported by both the service pre-check and
the function CAS; an already-matching request reports `unchanged` with no
new audit row; and the service fails closed with no accepted member
context at all. One case bypasses the service on purpose: a direct
function call under a fully valid owner member context must still refuse
`autonomousSendEnabled`, because the runtime role holds EXECUTE and the
database boundary cannot rely on the service layer to enforce the
forbidden-feature rule.

The T-032 tenant retention-policy write path is the same adapter pattern
for the retention knobs, rehearsed by
`src/lib/__tests__/tenant-retention-policy-change-postgres.test.ts`.
`novatrade_apply_tenant_retention_policy_change` (migration
`202609120005`) mirrors the feature function: member-GUC re-validation,
tenant-wide `tenant:manage` (owner/admin) gate, version CAS, atomic
member-layer audit append — plus the per-knob `1..max` day bounds from
`tenantPolicySchema` enforced database-side, since the runtime role holds
EXECUTE and a direct caller must not set out-of-contract retention
periods. Provision a `t032_retention_policy_rehearsal` database (seeded
schema), a `t032_runtime` role with the T-030 grant set plus EXECUTE on
the change function, then:

```bash
T032_RUN_DISPOSABLE_PG_TESTS=1 \
T032_RUNTIME_ROLE=t032_runtime \
T032_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t032_retention_policy_rehearsal \
DATABASE_URL=postgresql://t032_runtime:t032_runtime@127.0.0.1:55440/t032_retention_policy_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-retention-policy-change-postgres.test.ts
```

The lane proves owner apply + audit shape, non-capable member and
cross-tenant denial, workspace-scoped denial inside the function,
service-level and function-level version conflict, no-op `unchanged`,
no-context fail-closed, and a direct EXECUTE caller exceeding
`export_retention_days`' schema maximum refused `invalid_field` with zero
residue.

The T-033 tenant-limit (quota) runtime is the same adapter pattern for the
atomic consume + configuration CAS, rehearsed by
`src/lib/__tests__/tenant-limits-postgres.test.ts`. The limit store tables
carry RLS with zero policies, so the restricted role can neither read nor
write them: `novatrade_tenant_limit_runtime_state` (member read),
`novatrade_tenant_limit_consume` (advisory-locked `(tenant, action)` lane,
expected-state revalidation, idempotency replay/conflict, sliding-window
buckets, bucket + idempotency reservation in one transaction), and
`novatrade_change_tenant_limit_configuration` (per-action permission gate
derived server-side, version CAS, event append) are all in migration
`202609120006`. The consume request is a `text` parameter parsed to jsonb
inside the function — the postgres.js driver double-encodes a JS string
bound to a jsonb parameter, so the adapter sends a JSON string and the
function parses it (the same convention as `p_audit_metadata`). Because the
runtime role holds EXECUTE, the function re-derives every sensitive fact
server-side — the platform hard cap, the sliding window, both SHA-256
bucket digests — and bounds `nowMs` against the database clock, so a direct
caller cannot inflate caps, forge another tenant's bucket keys, shrink the
window, or reset buckets with a far-future timestamp; a cross-tenant
idempotency key is refused `denied`, never `idempotency_conflict`.
Provision a `t033_tenant_limits_rehearsal` database (seeded schema plus
migration `202609120006`), a `t033_runtime` role with the T-030 grant set
plus EXECUTE on the three limit functions and
`novatrade_apply_tenant_feature_policy_change` (the feature-gate case),
then:

```bash
T033_RUN_DISPOSABLE_PG_TESTS=1 \
T033_RUNTIME_ROLE=t033_runtime \
T033_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t033_tenant_limits_rehearsal \
DATABASE_URL=postgresql://t033_runtime:t033_runtime@127.0.0.1:55440/t033_tenant_limits_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-limits-postgres.test.ts
```

The lane proves consume + replay + conflict, configuration CAS and stale
version, rate limiting on bucket exhaustion, tenant action kill, the
feature gate closing then opening after a feature flip, non-capable member
config denial while consume still succeeds, workspace-scoped member
consume, no-context fail-closed, suspended-tenant fail-closed through the
member-context helper, and the direct-call bypass refusals above. Platform
kill-switch mutation stays fail-closed on Postgres — platform-operator
authority is not part of the member-GUC context model.

The T-034 tenant status-transition write path — `suspend`, `resume`, and
`archive` — is rehearsed by
`src/lib/__tests__/tenant-lifecycle-transition-postgres.test.ts`.
`novatrade_transition_tenant_status(pg_catalog.text)` (migration
`202609120007`) re-validates the member GUCs, binds the request tenant to
the session tenant, requires tenant-wide owner/admin authority, applies a
compare-and-swap on `tenants.status`, and appends the
`tenant.suspended|resumed|archived` member-layer audit row in the same
statement. It returns the post-transition tenant row as `jsonb` because the
status flip itself invalidates the member context mid-transaction — a
member-RLS re-read cannot see a suspended/archived tenant. Two scope cuts
match the canonical authority model: the deletion edges
(`archived→deletion_pending`, `deletion_pending→archived`,
`deletion_pending→deleted`) are excluded because they are paired with
deletion-job ledger mutations inside `cancelDeletion`; and `resume` /
archive-from-suspended are not member-callable at all — the member-context
helper and the session resolver both require an `active` tenant, so a
suspended tenant cannot even establish a member context and the member
adapter fails closed (`NOT_FOUND_NON_ENUMERATING`) until a
support/platform context lane owns those edges. Provision a
`t034_lifecycle_rehearsal` database (seeded schema plus migration
`202609120007`), a `t034_runtime` role with the T-030 grant set plus
EXECUTE on the transition function, then:

```bash
T034_RUN_DISPOSABLE_PG_TESTS=1 \
T034_RUNTIME_ROLE=t034_runtime \
T034_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t034_lifecycle_rehearsal \
DATABASE_URL=postgresql://t034_runtime:t034_runtime@127.0.0.1:55440/t034_lifecycle_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-lifecycle-transition-postgres.test.ts
```

The lane proves owner suspend + archive each commit `tenants.status` with
one correctly shaped member audit row and return the committed tenant,
stale `expectedCurrentState` and the `active→active` non-edge surface
`BLOCKED_STATE_CONFLICT` with zero residue, non-owner/workspace-scoped
denials and member-initiated resume on a suspended tenant fail closed
non-enumeratingly, and direct-EXECUTE calls reproduce the boundaries
(out-of-scope tenant → `denied`, malformed request → `invalid_request`,
foreign-tenant session → `actor_scope`).

The T-035 member-side support-access write path — `request`, `approve`,
`revoke`, plus the durable journal and decision-event ledger — is
rehearsed by
`src/lib/__tests__/tenant-support-access-postgres.test.ts`. Migration
`202609120008` adds nine `SECURITY DEFINER` functions:
`novatrade_support_access_reserve` / `..._commit` /
`..._append_event` wrap the zero-policy journal and event tables;
`..._create_grant` / `..._approve_grant` / `..._revoke_grant` mutate the
deny-all grant tables and return the grant row as `jsonb`;
`..._grant_json` builds the canonical grant shape (permissions and data
classes re-normalized from child rows) inside member RLS for the read
methods; and `novatrade_support_principal_resolve` /
`..._current` expose opaque-reference principal resolution without
granting tenants any read on `platform_support_principals`. Every
function re-validates the member GUCs and binds tenant, workspace,
actor, actor-layer, and correlation to the installed context; all take
`pg_catalog.text` payloads per the postgres.js jsonb double-encode
convention. Denial events legitimately reference grant/workspace ids
that do not exist as rows (prospective ids on refused requests,
absent ids on foreign-grant decisions), so the event function binds
context but records referenced ids verbatim. Provision a
`t035_support_access_rehearsal` database (seeded schema plus migration
`202609120008`), a `t035_runtime` role with the T-030 grant set plus
EXECUTE on the nine functions, then:

```bash
T035_RUN_DISPOSABLE_PG_TESTS=1 \
T035_RUNTIME_ROLE=t035_runtime \
T035_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t035_support_access_rehearsal \
DATABASE_URL=postgresql://t035_runtime:t035_runtime@127.0.0.1:55440/t035_support_access_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-support-access-postgres.test.ts
```

The lane proves request→approve→revoke commits grants with normalized
permission/data-class child rows and one journal + decision-event row
per attempt, identical replay returns `OK_SUPPORT_REPLAY` and a
same-key different-input call returns `SUPPORT_STATE_CONFLICT` without
residue, self-request / unknown / disabled principals and non-owner
requests are refused with their canonical codes and leave no grant,
workspace-scoped grants record the workspace and a workspace member
cannot approve a tenant-wide grant, current and historical listing
ride the owner/admin member-select policy, no-context and
suspended-tenant calls fail closed, and direct-EXECUTE calls cannot
escape the member-context bindings. Journal, event, and grant child
tables are append-only under trigger guards, so the privileged cleanup
disables triggers for the delete pass as in T-033.

The T-036 tenant-provisioning port moves the operator lane onto a
system-context discipline: provisioning creates a tenant before any
membership exists, so the eleven `SECURITY DEFINER` functions in
migration `202609120009` refuse whenever a member, support, or worker
GUC is installed and bind each mutation to the transaction that
inserted the tenant (an `xmin`/`pg_current_xact_id` check) — a stray
runtime-role call cannot append memberships, role bindings, or
invitations to a foreign tenant. The journal functions mirror the
local backend's three-state reserve→commit ledger, and invitation
delivery marking is a separate post-commit call because the durable
invitation row is the source of truth. Provision a
`t036_provisioning_rehearsal` database (seeded schema plus migration
`202609120009`), a `t036_runtime` role with the T-030 grant set plus
EXECUTE on the eleven functions, then:

```bash
T036_RUN_DISPOSABLE_PG_TESTS=1 \
T036_RUNTIME_ROLE=t036_runtime \
T036_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t036_provisioning_rehearsal \
DATABASE_URL=postgresql://t036_runtime:t036_runtime@127.0.0.1:55440/t036_provisioning_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-provisioning-postgres.test.ts
```

The lane proves a single `provisionTenant` call commits the tenant,
workspace, policy, owner membership, role binding, invitation, journal
row, and `tenant.provisioned` audit row in one transaction, identical
replay returns the recorded result, same-key different-input calls and
in-progress reservations produce their canonical conflicts, delivery
marking updates the invitation post-commit, malformed payloads and
member-context installs get zero-row refusals, and a direct
`create_membership` against a foreign tenant commits nothing. The
`pg_catalog.text` payload convention applies throughout: postgres.js
double-encodes JS strings bound to `jsonb` parameters, so every
function parses `::jsonb` internally.

The T-037 membership-administration port carries the canonical
`TenantMembershipAdministrationService` onto Postgres. Reads
(memberships, role bindings, workspaces, identity-selector lookups)
ride the existing member-select RLS; every write goes through the
`SECURITY DEFINER` functions in migration `202609120010` — a journal
lane (find/reserve/complete), `create_pending` for invitations, and
`apply_mutation`, which revalidates the expected-state CAS under the
target row lock, enforces the last-owner guard, and commits atomic
owner replacements (target demotion plus `owner_replacement` binding
on the candidate). The adapter captures
`transaction_timestamp()` once per transaction and hands it to the
service as the clock, so `effectiveAt` is the same instant the
triggers and `DEFAULT now()` columns record — satisfying the
service's `updatedAt === effectiveAt` invariant. Two
precision/context subtleties fall out of that design: the journal's
`completed_at` stores `now()` rather than the millisecond-truncated
`effectiveAt` (the same instant at microsecond precision — the
truncated value would land just under `created_at` and trip the
timestamps check), and the post-mutation lane (journal complete +
audit append) cannot re-run `novatrade_rls_member_context()` because
a self-demotion or self-revoke legitimately revokes the actor's own
binding mid-transaction; `novatrade_membership_actor_ctx_valid()`
instead proves the installed GUCs still resolve to real
membership+binding rows with role, auth-identity, and workspace
agreement. Provision a `t037_membership_admin_rehearsal` database
(seeded schema plus migration `202609120010`), a `t037_runtime` role
with SELECT on the member-RLS read tables and EXECUTE on the seven
API functions plus the `novatrade_rls_*` helpers the policies call,
then:

```bash
T037_RUN_DISPOSABLE_PG_TESTS=1 \
T037_RUNTIME_ROLE=t037_runtime \
T037_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t037_membership_admin_rehearsal \
DATABASE_URL=postgresql://t037_runtime:t037_runtime@127.0.0.1:55440/t037_membership_admin_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-membership-admin-postgres.test.ts
```

The lane proves an invite commits pending membership + binding +
journal + `tenant.membership.mutated` audit in one transaction with
honest replay/conflict behaviour; role, workspace, disable,
reactivate, and revoke mutations land with expected-state CAS
rejection on stale snapshots; the last-owner guard refuses sole-owner
demotion while the replacement swap commits atomically with
`owner_replacement` history; member-RLS reads stay scoped to the
accepted tenant/workspace slice; direct EXECUTE calls with foreign
tenant/binding claims refuse without disclosure; and calls with no
member context — or against a suspended tenant — fail closed.

The T-038 export-operations port adapts the canonical
`createTenantLifecycleOperationsService` export surface —
`requestExport`/`runExport`/`cancelExport`/`requeueExport`/
`sweepExportRetention` — onto `tenant_export_jobs` through
`withTenantDbContext` plus a `DbClient` shim that translates the
service's fixed SQL literals into `SECURITY DEFINER` calls
(`postgres-export-operations.ts` + migration `202609120011`). Job
reads ride member-RLS; inserts and every state transition run inside
`novatrade_export_request`/`novatrade_export_transition`, which
re-derive member context from the installed GUCs, bind the job row to
the accepted tenant/workspace slice, validate artifact facts, and
refuse non-enumeratingly (`applied`/`outcome` result columns).
`novatrade_export_audit_append` writes member-scope audit rows for
member actors and platform-scope rows for system/worker executors.
The lane replays against a disposable `t038_export_ops_rehearsal` db
(seeded schema plus migration `202609120011`) with a `t038_runtime`
role holding the T-030 grant set plus EXECUTE on the three API
functions:

```bash
T038_RUN_DISPOSABLE_PG_TESTS=1 \
T038_RUNTIME_ROLE=t038_runtime \
T038_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t038_export_ops_rehearsal \
DATABASE_URL=postgresql://t038_runtime:t038_runtime@127.0.0.1:55440/t038_export_ops_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-export-ops-postgres.test.ts
```

The lane proves request→run commits job + request/release audits
(member-scope for the requester, platform-scope for the executor) with
honest idempotent replay and same-key input-conflict rejection;
runner failures land `EXPORT_UNKNOWN_FAILURE` and requeue carries
retry facts; cancellation is single-edge; the retention sweep
advances `released→expired` then `expired→deleted` on separate passes
with `purge` invoked only on the deletion pass; member-RLS reads hide
foreign-tenant jobs so cross-tenant calls fail closed
(`NOT_FOUND_NON_ENUMERATING`); and direct EXECUTE probes with no
context, foreign tenant claims, bogus edges, or forged requester
memberships refuse without disclosure.

The T-039 deletion-ledger port adapts the canonical deletion surface —
`requestDeletion`/`verifyDeletion`/`approveDeletion`/`runDeletion`/
`requeueDeletion`/`cancelDeletion`/`getDeletionJob`/
`listDeletionCheckpoints` — onto `tenant_deletion_jobs` +
`tenant_deletion_checkpoints` + `tenant_deletion_checkpoint_events` +
`tenant_deletion_tombstones` (`postgres-deletion-operations.ts` +
migration `202609120012`). Those tables are zero-policy deny-all with
strict trigger guards, so every read and write routes through
`SECURITY DEFINER` functions: `novatrade_deletion_read` resolves
tenant/policy/membership/binding/job/checkpoint rows bound to the
installed context, `novatrade_deletion_actor_ctx` proves the member
GUCs resolve to a live membership + live binding without the usual
active-tenant requirement (deletion runs on `archived`→
`deletion_pending`→`deleted` tenants, where member-RLS can never be
live), and the write edges go through `novatrade_deletion_request`,
`novatrade_deletion_transition`, `novatrade_deletion_tenant_cas`,
`novatrade_deletion_checkpoint_insert`/`_transition`/`_event`,
`novatrade_deletion_tombstone_insert`, and
`novatrade_deletion_audit_append` — all of which re-derive the actor
claims from the installed GUCs rather than trusting payload fields.
The lane replays against a disposable `t039_deletion_ops_rehearsal`
db (seeded schema plus migration `202609120012`) with a
`t039_runtime` role holding EXECUTE on the nine API functions only:

```bash
T039_RUN_DISPOSABLE_PG_TESTS=1 \
T039_RUNTIME_ROLE=t039_runtime \
T039_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t039_deletion_ops_rehearsal \
DATABASE_URL=postgresql://t039_runtime:t039_runtime@127.0.0.1:55440/t039_deletion_ops_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-deletion-ops-postgres.test.ts
```

The lane proves the full request→verify→approve→run arc commits the
job, the exact ten-checkpoint set, ordered checkpoint execution,
tombstone, and per-edge audit rows; the three-person independence
rule (requester≠verifier≠approver, owner-only approval) and legal
edges refuse canonically; a second `requestDeletion` after the
`archived→deletion_pending` CAS fails closed and non-enumerating
(canonical semantics — the replay row is unreachable once the
tenant flips); `canceled→canceled` is the legal self-loop edge the
canonical map declares, so re-cancel re-answers
`OK_DELETION_CANCELED` with a second audit row while the immutable
`canceled_at` guard turns the row write into a no-op; cancel before
run rolls `deletion_pending` back to `archived`; failure-ledger
requeue lands retry facts and the retry completes the run; and
foreign-tenant reads/claims refuse without disclosure.

The T-040 invitation-service port adapts the canonical
`createTenantInvitationService` surface —
`issueMembershipInvitation`/`acceptInvitation`/`reissueInvitation`/
`revokeInvitation`/`getInvitationStatus` — onto `tenant_invitations` +
`tenant_invitation_journal` (`postgres-tenant-invitation.ts` +
migration `202609120013`). The service spans three caller lanes, and
the adapter's coordinator dispatches on `getTenantContext()`: an
ambient member context routes through `withTenantDbContext` (member
lane), while identity-lane acceptance and operator-lane
reissue/revoke/status run context-free with the function layer
re-validating the lane server-side. `tenant_invitations` and the
journal are zero-policy deny-all, so every read and write routes
through `SECURITY DEFINER` functions: bundled context-bound reads
(`novatrade_invitation_read`/`_live_read`/`_tenant_read`/
`_workspace_read`/`_membership_read`/`_binding_read`/`_policy_read`)
return no rows outside their lane; the journal twin
(`novatrade_invitation_journal_find`/`_reserve`/`_complete`) carries
reserve→complete idempotency in the same transaction;
`novatrade_invitation_create` accepts both member and context-free
lanes and re-checks pending membership + workspace facts;
`novatrade_invitation_finalize`/`_supersede`/`_revoke` perform the
status CAS edges; and the accept-path writes
(`novatrade_invitation_membership_status`/`_binding_revoke`/
`_membership_create`/`_binding_create`/`_tenant_activate`/
`_workspace_activate`) refuse unless `novatrade_invitation_finalize`
committed an acceptance in the same transaction — the finalize sets
a transaction-local capability the post-accept writes prove, so a
stolen or replayed call cannot mutate memberships outside a real
acceptance. `novatrade_invitation_audit_append` covers member-layer
tenant-scope rows (context-validated actor binding) and
system/platform-layer rows (operator + delivery events).
`novatrade_invitation_delivery_mark` was widened to dual-lane so
post-commit delivery marking works under either ambient. The lane
replays against a disposable `t040_invitation_ops_rehearsal` db
(seeded schema plus migration `202609120013`) with a `t040_runtime`
role holding EXECUTE on the API functions only:

```bash
T040_RUN_DISPOSABLE_PG_TESTS=1 \
T040_RUNTIME_ROLE=t040_runtime \
T040_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t040_invitation_ops_rehearsal \
DATABASE_URL=postgresql://t040_runtime:t040_runtime@127.0.0.1:55440/t040_invitation_ops_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-invitation-ops-postgres.test.ts
```

The lane proves member-lane issue (quota + journal + tenant audit)
followed by identity-lane acceptance: pending-placeholder
memberships expire and a replacement active membership + role
binding land atomically; pre-bound memberships activate in place;
owner acceptance flips `provisioning`→`active` on tenant and
workspace and lands the `tenant.provisioned` event; best-effort
delivery marking lands `delivery_state` + a platform-scope audit row
after commit; idempotent replays return the recorded result and
conflicting keys refuse `PROVISIONING_IDEMPOTENCY_CONFLICT`;
wrong-recipient, revoked, expired, and unknown invitations refuse
with canonical non-enumerating codes and no row mutation; a
researcher reaches the actor-role gate only when every fact matches
(`INVITATION_NOT_AUTHORIZED`); a member context bound to tenant A
collapses tenant-B invitations to the same closed refusal;
operator-lane reissue supersedes the prior row and issues the next
generation, revoke performs the issued→revoked CAS, and status reads
the privacy-safe shape — all with platform-scope audit; services
built without `operatorIdentityId` refuse the system lane; and raw
EXECUTE probes prove internal helpers carry no runtime grant,
post-finalize writes refuse without a same-transaction acceptance,
and member-layer audit refuses under a context-free session.

The T-041 cutover slice (0X3-234) retires the staged read-only
boundary: `isLocalMembershipAdministrationAvailable()` now selects
the Postgres service twin rather than refusing. Migration
`202609120014_tenant_cutover_ops.sql` adds six `SECURITY DEFINER`
functions. `novatrade_app_user_session_profile` ports
`ensureAppUserForAuthUser` — `app_users` is deny-all under the
runtime role, so the profile read, `last_seen_at` touch,
bootstrap-first-admin insert, and pending-phantom return all run
inside the definer. `novatrade_app_user_ensure_active` covers the
invitation-acceptance profile bootstrap: insert-if-missing only,
never rewriting a persisted active/disabled row, and admission-bound —
the INSERT path requires the identity to hold an active membership
and derives the app role from the live owner/admin bindings rather
than trusting the caller, so the runtime credential alone cannot
mint a profile or escalate its role.
`novatrade_tenant_lifecycle_snapshot_read` bundles the tenant row +
transition audit receipts + latest tenant-wide deletion job under
the structural actor context (`novatrade_deletion_actor_ctx`), which
validates live membership + binding without requiring tenant status
`active` — suspended/archived tenants keep their recorded lifecycle
truthful where member RLS cannot read deny-all `audit_logs` and
`tenant_deletion_jobs`. `novatrade_tenant_export_job_latest` /
`novatrade_tenant_deletion_job_latest` / `novatrade_tenant_export_job_read`
are the same actor-context-gated point/latest reads for the
data-lifecycle panels. `createPostgresExportRunner` mirrors the
local runner — the same five member-RLS table reads inside the job
transaction, the same redact/checksum/artifact-ref contract — so
`requestTenantExportAction` drives `requestExport`+`runExport`
inline under either backend. The action surfaces dispatch on the
backend flag: `invitation-actions.ts` (PG invitation service +
ensure-active definer), `membership-admin-actions.ts` (PG
membership + invitation + limits), `tenant-operations-actions.ts`
(PG lifecycle/export/deletion composite + PG support ports),
`users/actions.ts` (PG membership service), and the pages
(`users`, `tenancy`, protected layout pending-accept) follow the
same canonical paths. The lane replays against a disposable
`t041_action_cutover_rehearsal` db (seeded schema plus migration
`202609120014`) with a `t041_runtime` role holding EXECUTE on the
API functions and SELECT on the member-RLS read tables only:

```bash
T041_RUN_DISPOSABLE_PG_TESTS=1 \
T041_RUNTIME_ROLE=t041_runtime \
T041_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t041_action_cutover_rehearsal \
DATABASE_URL=postgresql://t041_runtime:t041_runtime@127.0.0.1:55440/t041_action_cutover_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-cutover-ops-postgres.test.ts
```

The lane proves the session-profile lanes (phantom → bootstrap admin
→ existing-row touch, second bootstrap claimant stays phantom while
an admin exists), ensure-active insert-if-missing with no rewrite of
a disabled persisted row and refusal of unsupported app roles, the
snapshot bundle under member actor context (tenant + transition
audit + deletion handoff) with refusals for missing/cross-tenant
context, a suspended tenant's recorded lifecycle staying truthful
through the actor-context gate where member RLS returns nothing,
export-job point/latest reads enforcing the tenant binding, the
Postgres export runner driving `requestExport`→`runExport` to a
released job with the canonical artifact ref, checksum, and
member/system audit pair, and the direct-EXECUTE boundary — the
internal lane predicates carry no runtime grant while the new API
refuses cleanly without context.

The T-042 support-authorization lane proves the platform-support
actor's own check path on Postgres. The edge asserts a support
session — tenant, optional workspace, support-actor identity,
grant, correlation — through `runWithSupportSession`
(`src/lib/tenancy/support-session.ts`); `resolveTenantDbContext`
maps it to the same transaction-local GUC envelope the
service-minted `SupportAccessContext` produces, merging only when
the two envelopes are identical and refusing member/worker mixes
with `TENANT_DB_CONTEXT_CONFLICT`. Migration
`202609120015_support_authorization_ops.sql` splits the gates into
two authority levels: `novatrade_support_lane_shape` is the
*structural* lane (well-formed support GUCs naming an existing
tenant, all member/worker fields empty) and stays internal-only,
while `novatrade_rls_support_context` remains the *authority* lane
(approved, unrevoked, in-window, bound grant on an active tenant).
The journal reserve/commit and event append accept either lane so
denials still ledger — including unresolved-principal refusals,
which record `actor_id` NULL while the journal's `actor_namespace`
stays bound to the asserted actor — and
`novatrade_support_principal_resolve` resolves only the session
actor's own reference under the support envelope.
`novatrade_support_access_grant_read` /
`novatrade_support_access_workspace_exists` are the lane-bound
readback definers the Postgres adapter routes `getGrant` /
`verifyWorkspace` through while a support lane is ambient; the
migration also re-asserts the internal-only posture on
`novatrade_support_principal_current`. The lane replays against a
disposable `t042_support_authorization_rehearsal` db with a
`t042_runtime` role holding EXECUTE on the check-path API surface
and SELECT on the support-readable tables only:

```bash
T042_RUN_DISPOSABLE_PG_TESTS=1 \
T042_RUNTIME_ROLE=t042_runtime \
T042_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t042_support_authorization_rehearsal \
DATABASE_URL=postgresql://t042_runtime:t042_runtime@127.0.0.1:55440/t042_support_authorization_rehearsal \
DATABASE_SSL=disable \
npx vitest run src/lib/__tests__/tenant-support-authorization-postgres.test.ts
```

The lane proves `check`/`authorizeAndRun` under the asserted
envelope (run context minted inside the callback, scoped reads
limited by the grant's permission + data class, context cleared
after), idempotent replay and conflicting-key refusal, denial
ledgering for foreign-actor/expired/revoked/disabled-principal/
wrong-reference envelopes, permission + data-class + workspace
escalation refusals without enumeration, the suspended-tenant
edge staying closed while its refusal still journals, fail-closed
behavior without an envelope and under a mixed member+session
context, and the direct-EXECUTE boundary — the lane-shape helper
carries no runtime grant and the asserted-grant read returns NULL
without an envelope.

The domain-table tenant-scope migrations have their own disposable-PG16
lanes, all sharing the same standing container where noted:

```bash
# G-002 location/crawl scope — self-migrates a fresh, uniquely named db
G002_RUN_DISPOSABLE_PG_TESTS=1 \
G002_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/g002_location_crawl_rehearsal_l02 \
npx vitest run src/lib/__tests__/location-crawl-tenant-scope-postgres.test.ts

# G-003 lead/CRM scope + the four G-007 index rehearsals — self-migrates
G003_RUN_DISPOSABLE_PG_TESTS=1 \
G003_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/g003_lead_crm_rehearsal_l02 \
npx vitest run src/lib/__tests__/lead-crm-tenant-scope-postgres.test.ts

# G-004A AI scope/worker envelope and G-005 source cache/usage —
# each self-provisions an ephemeral container; only the flag is needed
G004A_RUN_DISPOSABLE_PG_TESTS=1 \
npx vitest run src/lib/__tests__/ai-tenant-scope-worker-envelope-postgres.test.ts
G005_RUN_DISPOSABLE_PG_TESTS=1 \
npx vitest run src/lib/__tests__/source-cache-usage-tenant-scope-postgres.test.ts

# G-007SR4 min-reviews bind regression — needs a pre-migrated db
# (pg_dump -s from the bootstrap rehearsal database applies cleanly)
G007SR4_RUN_DISPOSABLE_PG_TESTS=1 \
G007SR4_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/g007sr4_min_reviews_rehearsal_l02 \
npx vitest run src/lib/__tests__/lead-min-reviews-postgres.test.ts

# T-029 SQLite→Postgres data transfer — needs an empty
# t029_tenant_foundation_rehearsal db; it applies the full history itself
T029_RUN_DISPOSABLE_PG_TESTS=1 \
T029_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t029_tenant_foundation_rehearsal \
npx vitest run src/lib/__tests__/data-transfer-contract.test.ts
```

Together these rehearse the "tenant-scoped services replace old paths"
half of the cutover on real Postgres: fresh-install and T-028-gated
upgrade paths, receipt drift detection, rollback, hostile catalog states,
member isolation, anon projection posture, migration replay, and — for
T-029 — the two-tenant SQLite→Postgres transfer contract including the
adversarial search_path shadow-schema check and tampered-manifest
rollback.

Three further lanes complete the Postgres matrix — the canonical
service/repository layer, the domain-table member-write policies, and
the shared fixture harness itself. All are self-provisioning against the
same disposable cluster (each creates and drops its own uniquely named
database and runtime role):

```bash
# Q-002 canonical fixture harness — cleanup-safe commits and
# rollback-only support history through the real repository on PG16
Q002_POSTGRES16=1 \
Q002_POSTGRES_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55440/postgres \
npx vitest run src/lib/__tests__/tenant-fixtures-postgres.test.ts

# Q-006A canonical service isolation — createTenantQueryRepository,
# createTenantFeatureService, and createTenantLifecycleService under
# withTenantDbContext + a restricted NOSUPERUSER NOBYPASSRLS role:
# member-context reads are tenant-filtered by RLS and every foundation
# write fails closed. Requires a disposable-cluster acknowledgement.
Q006A_POSTGRES16=1 \
Q006A_POSTGRES_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55440/postgres \
Q006A_DISPOSABLE_CLUSTER_ACK=I_ACKNOWLEDGE_Q006A_DISPOSABLE_POSTGRES16 \
npx vitest run src/lib/__tests__/tenant-foundation-repository-service-isolation-postgres.test.ts

# F-01 lead CRM member-write RLS — needs an empty f01_lead_rls_rehearsal
# db; the lane replays the full migration history itself and creates +
# drops its own f01_lead_rls_runtime role
F01_RUN_DISPOSABLE_PG_TESTS=1 \
F01_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/f01_lead_rls_rehearsal \
npx vitest run src/lib/__tests__/lead-crm-rls-postgres.test.ts
```

Note: Q-006A refuses to run unless preexisting `anon`/`authenticated`
bootstrap roles are exactly `NOLOGIN`-equivalent and `NOINHERIT` — on a
cluster where another lane already created them with the Postgres
`INHERIT` default, align them once with
`ALTER ROLE anon NOINHERIT; ALTER ROLE authenticated NOINHERIT;`.

The invitation lifecycle is also verified end-to-end in a real browser:
an owner issues an invitation through `/users` ("Invite member" → the
invitee's verified auth subject UUID → role), which audits
`tenant.invitation_issued` + `tenant.invitation_delivery_recorded` and
returns the invitation id in the notice. A memberless invitee signs in and
lands on the protected layout's "Access Pending" screen, which mounts the
`InvitationAcceptControl` whenever
`isLocalMembershipAdministrationAvailable()` — the only surface a pending
session can reach, since `/users` requires a resolved tenant session that
`tenant_memberships.status = 'active'` alone provides. Submitting the
invitation id calls `acceptLocalTenantInvitationAction` (an
`allowInactive` session — no tenant context is required), which binds the
recipient hash, activates the membership, and creates the active
`app_users` profile; `router.refresh()` then re-resolves the layout into
the normal shell. Durable state after the verified pass: tenant-wide
`active` membership + current role binding, `active` app profile, the
invitation `accepted` with `accepted_at`, and a member-layer
`tenant.invitation_accepted` audit row. A second memberless identity
replaying the same invitation id gets the single non-enumerating denial
"The invitation is not available." — never a disclosure that it existed,
was accepted, or was bound to a different recipient.

The remaining `/users` member-administration controls are likewise
browser-verified through `LocalMembershipAdminControls`: "Change role"
(researcher → analyst_read_only) appends a closed `role_change` binding
plus the new current binding; "Suspend member" drives `active →
disabled`, after which the suspended member's own session resolves to the
non-enumerating preview shell ("Tenant role unavailable") rather than an
error; "Reactivate member" restores `active`; "Revoke invitation" drives
`pending → revoked` and a revoked invitation cannot be accepted — the
invitee's pending-screen attempt returns the same non-enumerating denial;
"Remove member" drives `active → removed`, closing every role binding and
leaving the row as terminal accountability history. Each step lands as a
member-layer `tenant.membership.mutated` audit row through the real
server actions. The panel's own gating held throughout: no controls on
the actor's own card, and owner members expose only "Change role".

`run-deletion` reads the job's `scheduled_at`; when it is still in the
future the driver constructs the lifecycle service with a clock fixed at
`scheduled_at + 1s` — the same view a platform worker waking after the
scheduled time would see — so the seeded one-day policy stays honest while
the full checkpoint pipeline remains locally exercisable. A completed run
leaves the tenant `deleted`, all ten checkpoints `complete` with receipts,
and a retention-dated tombstone; the append-only ledgers (invitations,
journals, memberships, role bindings, policies, support-access
grants/events/journal/anchors, audit) survive as the accountability record
while mutable residue (quota configuration, quota buckets) is purged.
Surviving `approved` support grants are force-revoked inside the
primary-database checkpoint — revocation is the schema's only legal terminal
transition and the grant anchors make row deletion impossible — attributed
to the deletion approver, so no in-window grant can authorize
`check`/`authorizeAndRun` after the tenant is gone. Replays are safe:
`run-deletion` on a completed job returns `NOT_FOUND_NON_ENUMERATING` and a
repeat `deletion-request` fails closed at the lifecycle/quota gate.

## Linux and Windows SQLite lanes

On Linux, `src/lib/__tests__/sqlite-schema-coordinator.test.ts` runs the 12
portable catalog, schema, and hostile-input cases and reports the 26 native
file-identity/finalization cases as skipped. Those 26 cases require the accepted
Windows/NTFS lease boundary; a Linux skip is not a pass and does not replace the
recorded Windows evidence.

Do not run `src/lib/__tests__/sqlite-g006b-pre-finalization.test.ts` on Linux as
acceptance evidence. New platform database behavior must instead use the
explicit disposable-Postgres lane named by its task receipt.

The same boundary is used transitively by
`src/lib/__tests__/sqlite-compatibility-scope.test.ts` and
`src/lib/__tests__/sqlite-g002-operation-permit.test.ts`; the composed release
gate excludes all three outside Windows rather than reporting missing
PowerShell as a product failure.
