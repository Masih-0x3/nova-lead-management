# Nova Trade Lead Management

An invite-only, multitenant lead-intelligence application: approved business evidence becomes reviewed strategy, qualified accounts and contacts, and human-approved outreach for copy/export. Nova Trade does not send outreach automatically.

Start with the [current handoff](docs/CODEX_HANDOFF.md) and [lean finish plan](docs/plans/2026-08-29-lean-finish-plan.md). The historical implementation cards are reference material, not a backlog to restart.

## Product and architecture

The application combines tenant provisioning and operations; document upload, quarantine, scanning, extraction, and cited knowledge; business understanding, ICPs and lead plays; governed discovery and account/contact qualification; and approved outreach artifacts, outcomes, and reporting. The earlier website-sales CRM remains available alongside these workflows.

- Next.js App Router, React, TypeScript, and Tailwind CSS.
- Supabase Auth and PostgreSQL are authoritative for the multitenant product. Tenant/workspace context, RLS, worker leases, budgets, policy, and human approval are explicit boundaries.
- Private Supabase Storage and ClamAV serve the production document path. Local adapters require an explicit acceptance-only opt-in; missing configuration fails closed.
- SQLite is a compatibility path when `DATABASE_URL` is absent, not a substitute for Supabase Auth or PostgreSQL tenant/worker acceptance.
- Vitest, real disposable PostgreSQL suites, production-build Playwright tests, and isolated service rehearsals provide distinct evidence lanes.

See the [product requirements](docs/product-requirements-multi-tenant-lead-intelligence-platform.md) for scope and the [system atlas](docs/ULTRA_SYSTEM_ATLAS.md) for deeper navigation. Historical snapshots in those documents should be read alongside the current handoff.

## Local setup

Use Node 24 (see `.node-version` and `.nvmrc`) and Docker or the supported Docker-compatible local runtime.

```bash
npm ci
npx playwright install chromium
```

The [staging guide](docs/STAGING.md) describes the reproducible, disposable acceptance environment. It uses synthetic identities/data and a production Next build; no cloud account or paid provider is required. The GitHub `staging` environment records the CI rehearsal, not an always-on hosted URL.

```bash
node scripts/staging-rehearsal.mjs rehearse
```

For persistent development, use the local Supabase lifecycle documented in [TESTING.md](docs/TESTING.md), then `npm run dev`. Keep the canonical `http://localhost:3000` origin consistent for authenticated browser tests. Use separate admin and researcher identities; an admin session does not prove researcher authorization.

Use `.env.example` as the configuration reference. Keep `.env.local`, database files, service keys, certificates, auth storage state, traces, and recovery archives private and untracked. Do not copy production credentials into the disposable staging environment.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / server |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm test` | Unit and environment-gated test collection; skips are not integration proof |
| `npm run release:check` | Composed Node 24 gate: static checks, recovery schema checks, portable tests, production build, public browser smoke |
| `node scripts/ci-postgres-rehearsal.mjs all` | All 14 L-02 restricted-role PostgreSQL lanes, with owned cleanup |
| `node scripts/staging-rehearsal.mjs rehearse` | Isolated Supabase staging and role-separated authenticated acceptance |
| `node scripts/l03-real-services.mjs` | Disposable private Storage/ClamAV integration rehearsal |
| `npm run test:e2e:public` | Public read-only browser smoke against an existing target |
| `npm run test:e2e:auth` | Authenticated browser project; requires explicit credentials/state |
| `npm run test:e2e:acceptance` | Explicitly enabled L-08 happy/degraded acceptance on an approved target |
| `npm run db:verify:recovery` | Read-only schema/portable-export verification |

See [TESTING.md](docs/TESTING.md) for opt-in database flags and browser safety guards. The final release evidence is in the [lean finish plan](docs/plans/2026-08-29-lean-finish-plan.md).

## Recovery and release boundaries

The frozen v4 portable JSON format covers **37 legacy tables**. It does not back up the complete multitenant PostgreSQL product. Use [DATA_RECOVERY.md](docs/DATA_RECOVERY.md) for SQLite transfer/compatibility and [DATA_RECOVERY_POSTGRES.md](docs/DATA_RECOVERY_POSTGRES.md) for the separate native PostgreSQL application-schema recovery contract.

Auth identities, Storage object bytes, Vault secrets, encryption keys, extensions, and deployment configuration have separate recovery boundaries. A successful public-schema restore alone is not a complete Supabase disaster-recovery claim.

The [document-service runbook](docs/validation/2026-09-14-l03-real-services-rehearsal.md) records the real-provider test boundary and configuration requirements. The chosen Storage deployment must enforce the application's short-lived upload-capability contract; a provider's longer-lived default is not automatically acceptable.

The [deployment runbook](docs/VERCEL_SUPABASE_DEPLOYMENT.md) is an operator reference, not deployment authorization. Production needs its own infrastructure, secrets, least-privilege review, backup policy, provider budget/approval, authenticated smoke, and named-owner go/no-go. Staging or a merged PR does not enroll customers or activate paid providers.

Automatic sending, mailbox/LinkedIn automation, self-serve billing/signup, broad CRM synchronization, non-U.S. expansion, and speculative connectors remain deferred. Discovery uses approved official APIs; no Google Search or Maps-page scraping is authorized.
