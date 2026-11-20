# Nova Lead Management

Nova Lead Management is a multitenant lead-management platform built on Next.js 16 and Supabase. Invited business teams upload their own materials. The platform turns that evidence into cited business knowledge, ideal-customer profiles, and lead plays. It then runs governed discovery and qualification of accounts and contacts, and produces outreach drafts that a human must approve before copy or export. Tenant isolation is enforced in PostgreSQL with row-level security, and background work runs on database-leased workers. The platform never sends outreach automatically.

## Quickstart

Requires Node 24 (`.nvmrc`) and Docker.

```bash
npm ci
node scripts/local-supabase.mjs all   # fresh checkout only: local Supabase + migrations + seed; rewrites .env.local
npm run dev                           # http://localhost:3000
```

Sign in as `admin@nova.local` (or `researcher@nova.local`). Passwords are in `.env.local` as `LOCAL_ADMIN_PASSWORD` / `LOCAL_RESEARCHER_PASSWORD`. Configuration reference: [`.env.example`](.env.example). Missing configuration fails closed by design. On an existing setup, use `node scripts/local-supabase.mjs up` instead of `all` ([details](docs/TESTING.md)).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / server |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm test` | Vitest suite (database-gated suites skip without a database; a skip is not a pass) |
| `npm run test:e2e:public` | Playwright public read-only smoke |
| `npm run test:e2e:auth` | Playwright authenticated project (needs credentials) |
| `npm run release:check` | Full gate: static checks, recovery checks, tests, production build, browser smoke |
| `node scripts/local-supabase.mjs <up\|down\|verify>` | Manage the local Supabase stack |
| `node scripts/staging-rehearsal.mjs rehearse` | Disposable staging stack with role-separated acceptance |
| `node scripts/ci-postgres-rehearsal.mjs all` | Real-PostgreSQL restricted-role test lanes |

## Architecture

- **App:** Next.js App Router, React, TypeScript, and Tailwind (`src/app`, domain logic in `src/lib`).
- **Data:** Supabase Auth and PostgreSQL with versioned migrations (`supabase/migrations`). Tenant/workspace context, RLS, worker leases, budgets, and human approval are explicit boundaries. SQLite remains as a legacy compatibility path.
- **Documents:** private Supabase Storage with ClamAV scanning, behind a quarantine pipeline.

See the [documentation map](docs/README.md). Good starting points are the [system atlas](docs/ULTRA_SYSTEM_ATLAS.md), the [tenant and workspace contract](docs/architecture/tenant-workspace-contract.md), and the [product requirements](docs/product-requirements-multi-tenant-lead-intelligence-platform.md). Original agent working files are kept in [docs/genesis](docs/genesis/).

## Testing

The test lanes are separate: Vitest unit tests, real disposable-PostgreSQL suites, production-build Playwright tests, and isolated service rehearsals. Opt-in flags and safety guards are in [docs/TESTING.md](docs/TESTING.md). Per-task evidence is in [docs/validation](docs/README.md#validation-reports).

## License

See [LICENSE](LICENSE).
