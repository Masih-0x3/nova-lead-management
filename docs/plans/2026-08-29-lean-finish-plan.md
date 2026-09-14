# Nova Trade Lean Finish Plan

- **Status:** Current execution queue
- **Updated:** 2026-09-14
- **Product source:** `docs/product-requirements-multi-tenant-lead-intelligence-platform.md`
- **Handoff:** `docs/CODEX_HANDOFF.md`

This file replaces the execution queue in the historical 318-card plan. Old plans, ledgers, audits, and decision records remain reference material; they are not checklists that must be exhausted.

## Finish line

The first design-partner release is done when an invited user can work inside an isolated tenant, provide approved business evidence, approve an ICP and play, discover and qualify accounts and contacts, approve cited outreach for copy/export only, record outcomes, and complete the workflow accessibly. Local and staging proof must cover isolation, recovery, migration safety, provider budgets, and fail-closed behavior.

Automatic sending, mailbox/LinkedIn automation, self-serve signup or billing, broad CRM synchronization, generalized workflow builders, non-U.S. policy, and speculative connectors are not part of this finish line.

## Rules

1. Build vertical outcomes, not separate cards for schema, service, UI, tests, review, and documentation.
2. Run focused checks for the slice. Run the full gate only after shared-foundation changes or an end-to-end workflow lands.
3. Use a second reviewer only for tenant isolation, authorization, destructive lifecycle work, migrations, provider policy, or outreach guardrails.
4. Ask for approval only before external or costly actions: remote migrations, deployment, production/customer data, paid providers, enrollment, or sending.
5. Keep automatic outreach sending out of scope. All drafts require explicit human approval and only support copy/export.
6. Update this plan only when an L-level outcome changes state. Do not create receipt, dispatch, lineage, lock-release, review-of-review, or per-commit plan tasks.

## Current position

- L-01 through L-08 implementation commits are integrated. The remaining work is release proof and operational cleanup, not the historical READY/WAITING feature backlog.
- On September 14 the integrated production build passed both L-08 happy/degraded acceptance paths against local Supabase, plus 26 admin and 12 researcher browser tests. Each role was exercised with its own seeded identity.
- Release completion is in progress using Devin CLI SWE-2 Max: full PostgreSQL recovery coverage, expanded database CI/staging, real private Supabase Storage/malware-scanner runtime proof, and supported dependency updates for the fresh audit's five production-package advisories. The legacy portable recovery format remains v4 with 37 tables; newer PostgreSQL data needs its own complete recovery boundary.
- The user authorized completing these tasks, creating an appropriate staging environment, committing, pushing, merging, and cleaning completed worktrees. A reproducible isolated staging rehearsal is the selected approach. Production deployment, customer enrollment, paid provider use, and automatic sending remain separate actions.
- GitHub integration PR #5 is the review/CI boundary. Feature PRs #3 and #4 are merged. Nova's redundant hourly maintenance automation is disabled and completed feature worktrees have been privately archived and removed.
- Historical anchor-repair commit `1d2931d` was explicitly rejected by `cfbb650` and stopped by `a0c1d82`; preserve it as archival history, not a release merge. The lean finish line does not reopen those abandoned SQLite writer experiments.

## Execution queue

`INTEGRATED` means the implementation is on the integration branch. `LOCAL_PASS` adds successful local acceptance evidence. `VERIFYING` and `IN_PROGRESS` identify the remaining release work. Production deployment is a separate decision.

| ID | State | Outcome | Complete when | Depends on | Prior scope |
|---|---|---|---|---|---|
| L-01 | LOCAL_PASS | Make the current application work locally | Local Supabase Auth/PostgreSQL starts; migrations apply; admin, tenant, workspace, membership, role, and policy are seeded; restricted worker roles and a dispatcher run all five worker routes; authenticated admin/researcher browser smoke passes. | — | F-01 |
| L-02 | INTEGRATED | Finish tenant cutover and operations | Legacy rows reconcile to a compatibility tenant; tenant-scoped services replace old paths; invitation acceptance/user creation, membership, policy, support, quota, audit, export, retention, deletion, and suspension work with non-enumerating failures; rollback is exercised locally. | L-01 for final proof | F-02–F-03 |
| L-03 | VERIFYING | Complete the knowledge pipeline | Approved files and URLs pass private upload, validation, quarantine/scanning, extraction, chunk/evidence creation, review, retention, and render-safe citation flows on normal and adversarial fixtures. | L-01 for real-service proof | F-04–F-05 |
| L-04 | INTEGRATED | Deliver business understanding and strategy | Bounded agent runs use versioned prompts, budgets, leases, replay, and injection defenses; evidence produces reviewable understanding and useful questions; users can version, simulate, approve, activate, and roll back ICPs and plays. | L-03 | F-06–F-08 |
| L-05 | INTEGRATED | Deliver discovery, accounts, contacts, and qualification | Approved plays run through policy-controlled, budgeted connectors; observations resolve to reversible canonical accounts; contacts retain source/consent/freshness state; buying-center hypotheses and explainable qualification are reviewable and reproducible. | L-04 for complete flow; connector/account foundations may proceed now | F-09–F-12 |
| L-06 | INTEGRATED | Deliver cited outreach and outcomes | Approved evidence produces citation-backed drafts that fail closed on policy/suppression errors; users approve and copy/export without a send path; outcomes are correctable and learning only proposes reversible changes. | L-05 | F-13–F-14 |
| L-07 | LOCAL_PASS | Finish the authenticated product UI | The shell, onboarding, knowledge, strategy, discovery, account, contact, review, outreach, reporting, and tenant-admin workflows use real services and pass desktop, mobile, keyboard, screen-reader, loading, empty, denied, and failure states. Feature slices follow their service as it lands. | L-02–L-06 for completion | F-15–F-17 |
| L-08 | LOCAL_PASS | Prove the full application locally | One automated local happy path and critical degraded paths prove tenant isolation, worker recovery, idempotency, migration/rollback, lifecycle cleanup, logging, budgets, kill switches, and no-send behavior. | L-01–L-07 | Pre-release acceptance |
| L-09 | IN_PROGRESS | Rehearse and approve the release candidate | The L-08 suite passes in staging, production configuration is reviewed, backup/restore is rehearsed, and the named owner records one go/no-go decision. Deployment remains a separate explicit action. | L-08 and user authorization | F-18 |

## Concurrency

Use one integration owner and put every remaining slot on a ready, non-overlapping slice. Do not wait for a wave to finish.

Good parallel starting lanes are:

- L-01: local Supabase/bootstrap/worker dispatcher;
- L-02: invitation and tenant lifecycle gaps;
- L-03: upload-to-citation vertical slice;
- L-04: bounded agent and strategy contracts;
- L-05: connector/account foundations;
- L-07: UI slices whose service contracts are already stable.

Only serialize actual shared writes:

- one writer at a time in `supabase/migrations/` and the SQLite schema;
- one writer at a time in `src/lib/db/queries.ts` or tenant transaction plumbing;
- the producer owns a shared contract while consumers use adapters;
- the integration owner handles `package.json`, lockfiles, and global test/build configuration.

A worker handoff is one short report: objective, changed files, checks run, and real blockers. No conductor hierarchy, permanent packet ledger, path-claim ceremony, worktree, or extra review task is required unless an actual collision occurs.

## Verification

For a slice, run the smallest relevant tests plus typecheck/lint for touched code. At a shared-foundation or workflow boundary, run:

```bash
npx -y node@24 ./node_modules/typescript/bin/tsc --noEmit
npx -y node@24 ./node_modules/eslint/bin/eslint.js .
npx -y node@24 ./node_modules/vitest/vitest.mjs run
npx -y node@24 ./node_modules/next/dist/bin/next build
git diff --check
```

L-01 and L-08 additionally require real authenticated browser and worker execution. Passing unit tests alone does not complete them.

## Deferred

Defer automatic sending, mailboxes, LinkedIn automation, autonomous campaigns, live bidirectional CRM sync, public signup, billing, connectors without a concrete launch need, non-U.S. policy, non-English or legacy binary media ingestion, custom roles, generalized workflow builders, and performance tuning without a measured failing workload.

Deferred work does not block L-09 and should not be added to this queue without a concrete customer or operational need.
