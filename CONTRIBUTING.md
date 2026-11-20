# Contributing to Nova Lead Management

Thanks for your interest in improving Nova Lead Management. This guide covers
local setup, the checks every change must pass, and the conventions we follow.

- Test lanes and release gates: [docs/TESTING.md](docs/TESTING.md)
- Environments and the isolated staging rehearsal: [docs/STAGING.md](docs/STAGING.md)

## Prerequisites

- **Node.js `>=24 <25`** (see `.nvmrc` / `.node-version`; other majors are rejected by the release gate)
- **npm** (the repository uses `package-lock.json`; do not commit other lockfiles)
- **Docker**, for the local Supabase stack and the disposable PostgreSQL suites

## Setup

```bash
npm ci
node scripts/local-supabase.mjs all   # bootstraps the local Supabase stack and writes .env.local
npm run dev                           # http://localhost:3000
```

`node scripts/local-supabase.mjs all` is a full bootstrap for a fresh checkout.
On an existing checkout, use `node scripts/local-supabase.mjs up` to resume the
stack without touching your data. See [docs/TESTING.md](docs/TESTING.md) for
details and default endpoints.

## Running checks

Run these before opening a pull request:

```bash
npm run typecheck      # TypeScript, no emit
npm run lint           # ESLint
npm test               # Vitest
npm run release:check  # composed release gate (typecheck, lint, tests, build, public e2e, ...)
```

Additional Playwright and real-integration lanes are documented in
[docs/TESTING.md](docs/TESTING.md). A gated test that skips is not a pass.

## Commits and pull requests

- Branch from `main`; keep each pull request focused on one change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  messages, e.g. `feat: ...`, `fix(ci): ...`, `docs: ...`, `chore: ...`, `test: ...`.
- Fill in the pull request template: summary, test plan, and checklist.
- CI must be green before merge. Add or update tests for behavior changes.
- Update documentation (and `CHANGELOG.md` where relevant) alongside the code.
- Never commit secrets or real customer data; see [SECURITY.md](SECURITY.md).

## Database migrations

- Historical files in `supabase/migrations/*.sql` are **immutable**. Never edit,
  rename, or delete an applied migration.
- To change the schema, add a new, timestamped migration file instead.

## Naming

- New code, configuration, and documentation must use the
  **Nova Lead Management** name and the `NOVA_*` prefix for environment
  variables and identifiers.
- Never introduce `nosite` / `NoSite` naming. Legacy occurrences in immutable
  migrations stay as they are.

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
