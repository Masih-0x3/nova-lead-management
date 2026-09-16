# Nova Trade Agent Handoff

Current as of September 16, 2026. This file and the [lean finish plan](plans/2026-08-29-lean-finish-plan.md) replace the historical June/July task queue. The old 318-card plan is reference material, not a backlog to restart.

## Start here

- Repository: `Masih-0x3/nova-trade-lead-management`.
- Release history: [PR #5](https://github.com/Masih-0x3/nova-trade-lead-management/pull/5) merged into `main`. The multitenant lead intelligence platform implementation (L-01 through L-08) is integrated on `main`. Continue from current `main`.
- Product scope: [multi-tenant lead intelligence requirements](product-requirements-multi-tenant-lead-intelligence-platform.md).
- Read `AGENTS.md`, check `git status --short --branch`, and inspect overlapping edits before writing. Use Node 24; the system Node 22 is not the supported build/test runtime.

The user authorized completing the remaining release work, establishing the staging rehearsal, and merging PR #5 into `main`. That authorization does not enable production/customer enrollment, paid provider work, or automatic sending. Future agents must still follow the current user's requested scope.

## Implemented product

L-01 through L-08 implementation is integrated: local Supabase Auth/PostgreSQL and restricted worker roles; tenant provisioning, invitation acceptance and operations; document intake/extraction/evidence; business understanding and versioned ICP/play strategy; governed discovery/accounts/contacts/qualification; cited outreach copy/export and outcomes; authenticated product UI; and automated happy/degraded acceptance.

Tenant context, policy, budgets, leases, replay protection, and explicit human approval remain authoritative. A successful unit test or build does not substitute for authenticated acceptance, real service integration, or a production approval.

PostgreSQL is the multi-tenant application's authority. SQLite remains the `DATABASE_URL`-absent compatibility path, not a replacement for Supabase Auth or PostgreSQL worker leases. The portable v4 JSON recovery contract covers 37 legacy tables and is not a complete backup of newer PostgreSQL product data.

## Completed engineering release work

Four isolated Devin CLI SWE-2 Max lanes delivered full PostgreSQL application-schema recovery, expanded database CI and isolated staging, private Supabase Storage/ClamAV runtime integration, and supported dependency updates. Independent review also fixed pre-tenant audit persistence, provider request cancellation, actor attribution, fresh review-queue chronology, replay timestamps, citation/PDF validation, and destructive compatibility-rehearsal preflight.

A GitHub `staging` environment now runs reproducible disposable infrastructure, not an always-on public URL. Its CI job depends on five independent prerequisite jobs: the release gate, disposable schema tests, self-provisioning database/native-recovery tests, restricted tenant-ops/auth-audit tests, and real Storage/ClamAV integration. No merge is accepted until all six jobs pass for the final candidate; use PR #5 for their live status rather than an older branch's green check.

The engineering merge and staging rehearsal do not approve a production launch. Named-owner production qualification remains explicit below.

## Current verification evidence

September 14 accepted local evidence:

- Final code candidate `9a90f00`: `release:check` passed TypeScript, ESLint, **4,519 tests**, production build, deployment-trace safety, and **5** public read-only browser tests. Its portable lane explicitly skips 39 environment-gated files (261 tests) and excludes three Windows-only files; those skips are not database proof.
- Isolated Supabase staging applies **91/91** migrations, verifies restricted worker roles, and passes **2** happy/degraded acceptance, **26** admin, and **12** researcher browser checks with separate identities and verified owned-resource teardown. Portable PostgreSQL replay applies 89 of the same 91 files, excluding two Supabase-only migrations.
- Independent real database checks passed **105** tenant-ops tests, **8** pre-tenant auth-audit tests, and **33** native PostgreSQL recovery tests. Recovery classifies all **120** migrated public tables; the portable legacy contract remains **37** tables.
- Real private Storage/ClamAV integration passed **12/12**, including malware, expiry, tenant binding, and clean-document extraction. The final forced-cleanup probe left **zero new anonymous volumes**. Browser staging uses separate explicit local document backends, not the Storage/ClamAV stack.
- Harness safety checks passed **27** staging selftests, **6** independent staging-preservation tests, **16** tenant-ops-runner tests, and **4** real-services-runner tests.
- `npm audit` reports **zero vulnerabilities** across production and development dependencies after the supported updates.
- Git-history secret-scan candidates were reviewed as deliberate test fixtures or non-secret task labels. The final incremental scan's three matches are two synthetic Auth UUIDs and one negative-test secret, not live credentials. This does not revoke credentials previously exposed in chat.

Use `npm run release:check` as the local gate. Database and authenticated browser rehearsals are separate requirements; environment-gated skips are not proof. The release plan will hold the final accepted evidence.

## Running and testing locally

See [TESTING.md](TESTING.md), [STAGING.md](STAGING.md), [DATA_RECOVERY_POSTGRES.md](DATA_RECOVERY_POSTGRES.md), and `.env.example`. With Node 24 and a Docker-compatible daemon, `node scripts/staging-rehearsal.mjs rehearse` creates, tests, and tears down an isolated staging instance. It does not overwrite the development stack or require cloud credentials. Only its sanitized receipt is uploadable.

For an existing production-mode local server, use the canonical `http://localhost:3000` origin consistently. Do not weaken Secure cookies to accommodate Playwright's differing loopback handling. L-08 runs with `E2E_ACCEPTANCE=1`; admin smoke excludes `Researcher Smoke Test`, and the researcher spec must run with its own researcher credentials. Running all role assertions under one admin identity is invalid.

Keep `.env.local`, Supabase local keys/certificates, SQLite databases/sidecars, auth storage state, raw traces, and recovery archives private and ignored. Missing authentication or worker-role configuration must remain fail-closed. Required lease variables are `TENANT_WORKER_LEASE_ISSUER_DATABASE_URL` and `TENANT_WORKER_LEASE_RESOLVER_DATABASE_URL`.

## Cleanup and historical work

Nova's redundant hourly maintenance automation is disabled. Completed feature/release worktrees and their terminals were closed after private checkout archives and verified all-ref Git bundles were created. Original local application/PostgreSQL data is preserved; ignored credentials, Auth state, and database archives do not belong in GitHub artifacts. Other repositories and their active terminals are outside this cleanup.

The historical `codex/nova-g006c2a-anchor-repair` commit `1d2931d` was explicitly rejected in `cfbb650` and stopped in `a0c1d82`: it breaks upgraded replay after legitimate writes and lacks continuous proof-to-write binding. It must remain archival history, not be merged as part of cleanup. Its underlying primitive has no production caller. Other completed branch tips can be removed only after ancestry or patch-equivalence checks and recoverable preservation.

The GitHub/CodeRabbit credential exposed in an earlier conversation still requires owner-confirmed revocation/rotation; absence from Git history does not undo chat exposure.

## Next agent workflow

Do not restart completed L-01–L-08 work or exhaust old implementation cards. With PR #5 merged into `main`, the remaining distinct task is production qualification (L-09) with a named owner:

1. Select the actual deployment target; provision production-only secrets, a least-privilege application role, restricted worker roles, provider budgets, private Storage, and the scanner. Verify the managed Storage target's signed-upload lifetime and private connectivity.
2. Rehearse external Supabase Auth/Storage/configuration/key recovery as well as the application-schema backup on production-sized fixtures. The native public-schema archive alone is not complete Supabase disaster recovery.
3. Record the named owner's go/no-go before deployment or design-partner enrollment. No paid provider, customer onboarding, or automatic sending was enabled by this engineering release.

See [deployment qualification](VERCEL_SUPABASE_DEPLOYMENT.md). Automatic outreach sending, self-serve billing/signup, broad CRM synchronization, speculative connectors, and unmeasured performance work remain deferred.
