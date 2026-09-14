# Nova Trade Agent Handoff

Current as of September 14, 2026. This file and the [lean finish plan](plans/2026-08-29-lean-finish-plan.md) replace the historical June/July task queue. The old 318-card plan is reference material, not a backlog to restart.

## Start here

- Repository: `Masih-0x3/nova-trade-lead-management`.
- Release integration: `codex/nova-multitenant-integration`, [PR #5](https://github.com/Masih-0x3/nova-trade-lead-management/pull/5).
- Product scope: [multi-tenant lead intelligence requirements](product-requirements-multi-tenant-lead-intelligence-platform.md).
- Read `AGENTS.md`, check `git status --short --branch`, and inspect overlapping edits before writing. Use Node 24; the system Node 22 is not the supported build/test runtime.

The user authorized finishing the remaining release work with Devin CLI SWE-2 Max, establishing an appropriate staging rehearsal, committing, pushing, merging, and cleaning completed worktrees. That authorization does not enable production/customer enrollment, paid provider work, or automatic sending. Future agents must still follow the current user's requested scope.

## Implemented product

L-01 through L-08 implementation is integrated: local Supabase Auth/PostgreSQL and restricted worker roles; tenant provisioning, invitation acceptance and operations; document intake/extraction/evidence; business understanding and versioned ICP/play strategy; governed discovery/accounts/contacts/qualification; cited outreach copy/export and outcomes; authenticated product UI; and automated happy/degraded acceptance.

Tenant context, policy, budgets, leases, replay protection, and explicit human approval remain authoritative. A successful unit test or build does not substitute for authenticated acceptance, real service integration, or a production approval.

PostgreSQL is the multi-tenant application's authority. SQLite remains the `DATABASE_URL`-absent compatibility path, not a replacement for Supabase Auth or PostgreSQL worker leases. The portable v4 JSON recovery contract covers 37 legacy tables and is not a complete backup of newer PostgreSQL product data.

## Release work in progress

Four isolated Devin SWE-2 Max lanes are completing:

1. Full PostgreSQL application-schema recovery and a real restore rehearsal.
2. Expanded disposable database CI, followed by isolated Supabase staging and authenticated acceptance.
3. Explicit private Supabase Storage/ClamAV runtime wiring and real-service proof.
4. Supported dependency updates for the advisories found by the fresh September 14 audit.

The integration owner reviews each diff, runs independent checks, updates the lean plan, and merges through PR #5 only after the final candidate passes. A GitHub `staging` environment exists; the selected staging approach is reproducible disposable local/CI infrastructure, not an always-on public URL. Final release proof is not yet complete at this checkpoint.

## Current verification evidence

September 14 baseline, before the new release-lane changes:

- The integrated production build passed L-08 happy/degraded browser acceptance: 2/2.
- Separate admin and researcher sessions passed 26 and 12 authenticated browser checks respectively.
- GitHub's composed `release:check` passed. Its older PostgreSQL job exposed a stale migration-count assertion, corrected from 89/87 to 91/89 discovered/applied, with two explicitly Supabase-only migrations excluded from portable PostgreSQL replay.
- The read-only portable recovery verifier passed its 37-table contract.
- A full Git-history secret scan's 35 candidates were reviewed as deliberate fixtures or non-secret task labels; this is not evidence that previously exposed chat credentials have been revoked.
- A fresh production dependency audit reported five vulnerable packages, including critical Next.js advisories; repair and final verification are still in progress.

Use `npm run release:check` as the local gate. Database and authenticated browser rehearsals are separate requirements; environment-gated skips are not proof. The release plan will hold the final accepted evidence.

## Running and testing locally

See [TESTING.md](TESTING.md), [DATA_RECOVERY.md](DATA_RECOVERY.md), and `.env.example` for the relevant boundaries. The existing `scripts/local-supabase.mjs` supports local stack/bootstrap operations; use the isolated staging tooling for release rehearsal once integrated.

For an existing production-mode local server, use the canonical `http://localhost:3000` origin consistently. Do not weaken Secure cookies to accommodate Playwright's differing loopback handling. L-08 runs with `E2E_ACCEPTANCE=1`; admin smoke excludes `Researcher Smoke Test`, and the researcher spec must run with its own researcher credentials. Running all role assertions under one admin identity is invalid.

Keep `.env.local`, Supabase local keys/certificates, SQLite databases/sidecars, auth storage state, raw traces, and recovery archives private and ignored. Missing authentication or worker-role configuration must remain fail-closed. Required lease variables are `TENANT_WORKER_LEASE_ISSUER_DATABASE_URL` and `TENANT_WORKER_LEASE_RESOLVER_DATABASE_URL`.

## Cleanup and historical work

Nova's redundant hourly maintenance automation is disabled. The old L-03, L-07, and L-08 worktrees and local runtime state were privately backed up before cleanup. A verified all-ref Git bundle preserves the original branch history; no credentials or local database archives belong in GitHub artifacts.

The historical `codex/nova-g006c2a-anchor-repair` commit `1d2931d` was explicitly rejected in `cfbb650` and stopped in `a0c1d82`: it breaks upgraded replay after legitimate writes and lacks continuous proof-to-write binding. It must remain archival history, not be merged as part of cleanup. Its underlying primitive has no production caller. Other completed branch tips can be removed only after ancestry or patch-equivalence checks and recoverable preservation.

The GitHub/CodeRabbit credential exposed in an earlier conversation still requires owner-confirmed revocation/rotation; absence from Git history does not undo chat exposure.

## Next agent workflow

Finish the active release lanes and the final evidence/merge/cleanup first. Do not restart completed L-01–L-08 feature work or exhaust old implementation cards. Once the release candidate is merged and rehearsed, the next distinct decision is production infrastructure/configuration and owner go/no-go for the first design partner. Automatic outreach sending, self-serve billing/signup, broad CRM synchronization, speculative connectors, and unmeasured performance work remain deferred.
