# Isolated staging rehearsal

`scripts/staging-rehearsal.mjs` runs a fully ephemeral staging proof against a
run-scoped Supabase/Postgres stack. It exists so release evidence comes from
the real runtime — the `docker.io/supabase/postgres:15.14.1.170` image, all 91
migration files, a production `next build` + `next start`, and the real
Playwright suites — without touching the developer's `nova-local-*` stack.

## Usage

```bash
node scripts/staging-rehearsal.mjs rehearse   # the only live command
node scripts/staging-rehearsal.mjs help       # inert
```

There is deliberately **no** `keep`, `down`, or pid-file surface: every run is
ephemeral, uniquely named, and torn down by the same process that started it.

## What a run does

1. Strict CLI parse; `help`/`--help`/bare invocations are inert even under a
   malformed ambient environment. Unknown commands/flags, malformed ports, and
   malformed run ids reject before any mutation.
2. Read-only preflight (zero mutation): docker daemon reachability is required
   (an unreachable daemon is not "empty"), the protected `nova-local-*`
   containers are verified present-and-untouched, ports are probed, run-prefix
   leftovers refuse, and `staging-artifacts/` must be a real uid-owned
   directory (symlinks and preexisting run dirs refuse).
3. Exclusive `mkdir staging-artifacts/<run-id>` (0700) — the ownership
   boundary. All later state lives under `private/` (0700/0600): generated
   certs, env files, the app log, Playwright output, document store.
4. `local-supabase.mjs up` + `migrate` on a unique compose project
   `nova-staging-<run-id>` (containers `<run>-{db,auth,gateway}`, own volume +
   network, all stamped `nova.staging.run=<run-id>`). All **91** migration
   files apply — including the two supabase-runtime-only migrations that the
   portable lanes cannot run — verified against the migration ledger.
5. Canonical seeds: `local-supabase.mjs seed` (local-demo tenant,
   admin/researcher, restricted lease roles) then
   `seed-acceptance-tenant.mjs` (acceptance admin + approver).
6. `local-supabase.mjs verify` — seeded identities, auth gateway health, and
   least-privilege worker lease proofs (`novatrade_worker_lease_issuer` can
   acquire but holds no lease-table privileges; `_resolver` likewise).
7. Production build (`next build --turbopack`; webpack fallback only when
   `node_modules` is a symlinked worktree), then
   `scripts/server-traces.selftest.mjs` must pass — server NFT manifests must
   not bundle `.env*`, local databases, private keys, or artifact dirs.
8. `next start` as an in-memory detached process group; `/api/health` must
   return HTTP 200.
9. Exact browser coverage — no silent skips:
   - L-08 acceptance: **2** passed / 0 failed / 0 skipped / 0 flaky
   - admin smoke: **26** / 0 / 0 / 0
   - researcher smoke: **12** / 0 / 0 / 0
10. `receipt.json` — a strict allowlist (stage names, counts, error codes,
    cleanup states). It never contains raw child output, SQL, credentials, or
    URLs with secrets. It is the only uploadable artifact.
11. Verified teardown: containers, the volume, and the network must each be
    absent afterwards. Compose down runs only after every run-prefixed
    container is name- and label-verified, and the volume/network carry this
    run's `nova.staging.run` label or exact compose-project label. Foreign or
    unverifiable same-name resources refuse cleanup outright — `compose down`
    is never invoked. Any unverified cleanup flips an otherwise-passing run to
    fail, preserves `private/` for forensics, and prints the leftover run
    identity for an operator.

## Environment isolation

- `APP_ORIGIN` is always computed `http://localhost:<app port>`; an inherited
  `NEXT_PUBLIC_APP_URL` (e.g. a production URL) can never drive browser
  traffic off loopback.
- Every key found in the checkout's `.env`, `.env.local`, `.env.production`,
  `.env.production.local` (full dotenv grammar: `KEY=`, `export KEY =`,
  `KEY: `) is neutralized to `""` before the generated staging env is
  overlaid. Only key names are ever recorded — never values.
- Provider keys (`OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`,
  `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, `OPENAI_MODEL`) are force-emptied; the
  app throws before egress when they are empty.
- Document acceptance runs on local backends with fresh run-owned state:
  `NOVA_DOCUMENT_STORAGE_BACKEND=local`, `NOVA_DOCUMENT_SCANNER_BACKEND=local`,
  `NOVA_DOCUMENT_LOCAL_ACCEPTANCE=1`, run-private `NOVA_DOCUMENT_STORE_ROOT`,
  fresh `NOVA_DOCUMENT_SIGNING_SECRET`, `NOVA_DOCUMENT_UPLOAD_ORIGIN` =
  computed loopback origin, `NOVA_SCANNER_POLICY_VERSION=launch-v1`.
- `E2E_ACCEPTANCE_STATE_FILE` points inside `private/` so the acceptance
  specs never overwrite the checkout's `e2e/.acceptance-state.json`.

## CI

`.github/workflows/ci.yml` runs `staging-rehearsal` on `ubuntu-latest` with
`environment: staging`: Node 24, `npm ci`, Playwright Chromium, the selftest,
then `rehearse`. Only `staging-artifacts/*/receipt.json` is uploaded.

## Known limitations

- Service/recovery rehearsal hooks are **not yet integrated** (parent-owned);
  the receipt reports `servicesRehearsal: "not-integrated"`.
- The auth-audit real-PG suite is intentionally extensible: the seed stage is
  the insertion point before e2e, but the suite itself lands with the parent.
- The sibling real-services lane (Supabase Storage + ClamAV) is proved
  separately; this lane pins local document backends.
