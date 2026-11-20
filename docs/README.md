# Nova Lead Management documentation

Map of everything under `docs/`. New readers should start with the [root README](../README.md), then the [product requirements](product-requirements-multi-tenant-lead-intelligence-platform.md) and the [system atlas](ULTRA_SYSTEM_ATLAS.md).

## Product & specs

- [Product requirements: multi-tenant lead intelligence platform](product-requirements-multi-tenant-lead-intelligence-platform.md)
- [Launch cohort contract (D-016)](product/launch-cohort-contract.md)
- [Launch integration boundary (D-017)](product/launch-integration-boundary.md)
- [Launch quality gates (D-015)](product/launch-quality-gates.md)
- [Document support matrix (D-007)](product/document-support-matrix.md)
- [Source connector allowlist (D-010)](product/source-connector-allowlist.md)
- [Legacy website-lead compatibility play](product/legacy-website-lead-play.md)
- [Outbound call playbook](outbound-call-playbook.md)
- Design: [UI specification](design/multi-tenant-platform-ui-spec.md), [screen/component/state matrix](design/ui-000-screen-component-state-matrix.md), [wireframes](design/wireframes/)

## Architecture

- [System atlas](ULTRA_SYSTEM_ATLAS.md): code map and subsystem navigation
- [Tenant and workspace contract](architecture/tenant-workspace-contract.md)
- [Tenant database runtime context (T-030)](architecture/tenant-db-runtime-context.md)
- [RBAC and authorization matrix](architecture/rbac-matrix.md)
- [Evidence and claim contract (D-008)](architecture/evidence-claim-contract.md)
- [AI-data policy (D-009)](architecture/ai-data-policy.md)
- [Account identity and merge policy (D-011)](architecture/account-resolution-policy.md)
- [Legacy tenant ownership and migration map](architecture/legacy-tenant-ownership-map.md)
- [Migration baseline (D-005)](architecture/migration-baseline.md)
- [Concurrency registry](architecture/concurrency-registry.md)

### Decisions

- [Tenant provisioning model (D-003)](decisions/tenant-provisioning-model.md)
- [Document storage and malware scanning (D-006)](decisions/document-storage-and-malware-scanning.md)
- [Database compatibility horizon](decisions/database-compatibility-horizon.md)
- [Implementation execution-authority matrix (D-018)](decisions/implementation-authority.md)

### Compliance

- [Contact permitted-use, consent, and suppression (D-012)](compliance/contact-use-policy.md)
- [Outreach launch boundary and claim policy (D-013)](compliance/outreach-policy.md)
- [Data lifecycle, export, deletion, and audit](compliance/data-lifecycle-policy.md)

## Operations & environments

- [Isolated staging rehearsal](STAGING.md)
- [Vercel + Supabase deployment runbook](VERCEL_SUPABASE_DEPLOYMENT.md) (operator reference, not deployment authorization)
- [Data recovery contract (SQLite / portable JSON)](DATA_RECOVERY.md)
- [PostgreSQL recovery contract](DATA_RECOVERY_POSTGRES.md)

## Testing

- [Testing and release checks](TESTING.md): unit, PostgreSQL, browser, and release lanes
- [Deterministic multitenant fixtures](testing/deterministic-multitenant-fixtures.md)

## Audits

- 2026-05-20: [comprehensive audit](audits/2026-05-20-comprehensive-audit.md) ([backlog](audits/2026-05-20-comprehensive-remediation-backlog.md)), [live website audit](audits/2026-05-20-live-website-audit.md) ([backlog](audits/2026-05-20-live-remediation-backlog.md)), [authenticated admin audit](audits/2026-05-20-authenticated-admin-audit.md) ([backlog](audits/2026-05-20-authenticated-admin-remediation-backlog.md))
- 2026-06-16: [production readiness audit](audits/2026-06-16-production-readiness-audit.md)

## Validation reports

Dated evidence receipts in [`validation/`](validation/). Each records the scope, commands, and outcome of one task; IDs match the [implementation plan](plans/2026-07-27-multi-tenant-lead-intelligence-platform-implementation-plan.md).

### Baseline and foundation isolation

- [Concurrency transition baseline receipt](validation/2026-07-29-concurrency-transition-baseline.md) (2026-07-29)
- [Q-001 Pre-Implementation Baseline](validation/baseline.md)
- [Q-006A foundation repository/service isolation](validation/q006a-foundation-repository-service-isolation.md)

### Phase 1 tenant foundation (T-027…T-033, 2026-07-27)

- [T-027 tenant foundation RLS rehearsal](validation/2026-07-27-t027-tenant-foundation-rls-rehearsal.md) (2026-07-27)
- [T-028 Compatibility-Tenant Backfill Rehearsal](validation/2026-07-27-t028-compatibility-tenant-backfill-rehearsal.md) (2026-07-27)
- [T-029 tenant-foundation recovery rehearsal](validation/2026-07-27-t029-tenant-foundation-recovery-rehearsal.md) (2026-07-27)
- [T-030 tenant DB context rehearsal](validation/2026-07-27-t030-tenant-db-context-rehearsal.md) (2026-07-27)
- [T-033 Phase 1 Tenant-Isolation Acceptance](validation/2026-07-27-t033-phase-1-tenant-isolation-acceptance.md) (2026-07-27)

### Domain tenant scope (G-002…G-005)

- [G-002 Location and Crawl Tenant Scope Validation](validation/2026-07-29-g002-location-crawl-tenant-scope.md) (2026-07-29)
- [G-003 Lead CRM Tenant Scope Validation](validation/2026-07-29-g003-lead-crm-tenant-scope.md) (2026-07-29)
- [G-004A AI tenant scope and worker envelope](validation/2026-07-29-g004-ai-tenant-scope-worker-envelope.md) (2026-07-29)
- [G-005 source cache, observation, and usage tenant scope](validation/2026-07-29-g005-source-cache-usage-tenant-scope.md) (2026-07-29)
- [G-006C2A SQLite G002 storage-operation permit](validation/2026-07-30-g006c2a-sqlite-g002-operation-permit.md) (2026-07-30)
- [G-004A-R1 AI-usage transitive lead-delete repair](validation/2026-08-01-g004a-r1-ai-usage-transitive-lead-delete.md) (2026-08-01)

### SQLite compatibility and recovery (G-006)

- [G-006A SQLite fresh schema and whole-schema coordinator preparation](validation/2026-07-29-g006a-sqlite-fresh-schema-coordinator.md) (2026-07-29)
- [G-006R recovery logical identity](validation/2026-07-29-g006r-recovery-logical-identity.md) (2026-07-29)
- [G-006B-B1 SQLite pre-finalization repair validation](validation/2026-07-30-g006b-pre-finalization.md) (2026-07-30)
- [G-006C0 SQLite compatibility storage-scope validation](validation/2026-07-30-g006c0-sqlite-compatibility-scope.md) (2026-07-30)
- [G-006C1 SQLite fresh foundation validation](validation/2026-07-30-g006c1-sqlite-fresh-foundation.md) (2026-07-30)
- [G-006C2A SQLite G002 storage-operation permit](validation/2026-07-30-g006c2a-sqlite-g002-operation-permit.md) (2026-07-30)

### Stabilization repairs (G-007SR, 2026-08-01)

- [G-007SR1 researcher lifecycle authorization repair](validation/2026-08-01-g007sr1-researcher-lifecycle-authorization-repair.md) (2026-08-01)
- [G-007SR2 stored-exclusion fail-closed normalization](validation/2026-08-01-g007sr2-stored-exclusion-normalization.md) (2026-08-01)
- [G-007SR3 Explore cell-command lowercase normalization](validation/2026-08-01-g007sr3-explore-cell-command-normalization.md) (2026-08-01)
- [G-007SR4 minimum-review integer contract](validation/2026-08-01-g007sr4-minimum-review-integer-contract.md) (2026-08-01)
- [G-007SR5 researcher-AI lifecycle fixture repair](validation/2026-08-01-g007sr5-researcher-ai-lifecycle-fixture.md) (2026-08-01)

### Release, services, and design

- [Fedora/Supabase resume reconciliation](validation/2026-07-31-linux-supabase-resume-reconciliation.md) (2026-07-31)
- [UI-000 design approval receipt — draft](validation/2026-08-23-ui-000-design-approval.md) (2026-08-23)
- [L-03 real-service rehearsal (Supabase Storage + clamd)](validation/2026-09-14-l03-real-services-rehearsal.md) (2026-09-14)

### PostgreSQL index audits (G-007P1…P40, 2026-07-31 → 2026-08-01)

One report per index family; each records the query shape, tenant-prefix decision, and receipt.

- [G-007P1 Postgres tenant-prefixed AI artifact indexes](validation/2026-07-31-g007p1-tenant-ai-artifact-indexes.md) (2026-07-31)
- [G-007P2 tenant-prefixed AI verification indexes](validation/2026-07-31-g007p2-tenant-ai-verification-indexes.md) (2026-07-31)
- [G-007P3 tenant-prefixed lead AI queue indexes](validation/2026-07-31-g007p3-tenant-lead-ai-queue-indexes.md) (2026-07-31)
- [G-007P4 crawl-unit retry-ready index audit](validation/2026-07-31-g007p4-crawl-unit-retry-index-audit.md) (2026-07-31)
- [G-007P5 lead enrichment-ready index audit](validation/2026-07-31-g007p5-lead-enrichment-ready-index-audit.md) (2026-07-31)
- [G-007P6 tenant enrichment recovery index validation](validation/2026-07-31-g007p6-tenant-enrichment-recovery-index.md) (2026-07-31)
- [G-007P7 tenant AI website-repair index validation](validation/2026-07-31-g007p7-tenant-ai-website-repair-index.md) (2026-07-31)
- [G-007P8 tenant dashboard discovered-at index validation](validation/2026-07-31-g007p8-tenant-dashboard-discovered-at-index.md) (2026-07-31)
- [G-007P9 active statistics index audit](validation/2026-07-31-g007p9-active-statistics-index-audit.md) (2026-07-31)
- [G-007P10 score-recompute stale index audit](validation/2026-07-31-g007p10-score-recompute-stale-index-audit.md) (2026-07-31)
- [G-007P11 tenant-wide open admin-request list index validation](validation/2026-07-31-g007p11-tenant-open-admin-request-list-index.md) (2026-07-31)
- [G-007P12 tenant outreach actor index deferred-defect audit](validation/2026-07-31-g007p12-tenant-outreach-actor-index-audit.md) (2026-07-31)
- [G-007P13 tenant lead-note author index deferred-defect audit](validation/2026-07-31-g007p13-tenant-lead-note-author-index-audit.md) (2026-07-31)
- [G-007P14 tenant admin-request creator index deferred-defect audit](validation/2026-07-31-g007p14-tenant-admin-request-creator-index-audit.md) (2026-07-31)
- [G-007P15 tenant admin-request assignee index deferred-defect audit](validation/2026-07-31-g007p15-tenant-admin-request-assignee-index-audit.md) (2026-07-31)
- [G-007P16 public demo slug index classification](validation/2026-07-31-g007p16-public-demo-slug-index-classification.md) (2026-07-31)
- [G-007P17 demo lead-index no-defect audit](validation/2026-08-01-g007p17-demo-lead-index-audit.md) (2026-08-01)
- [G-007P18 AI-feedback reference-index no-defect audit](validation/2026-08-01-g007p18-ai-feedback-reference-index-audit.md) (2026-08-01)
- [G-007P19 AI-usage reference audit blocker](validation/2026-08-01-g007p19-ai-usage-reference-audit-blocker.md) (2026-08-01)
- [G-007P19 AI-usage reference-index no-defect audit](validation/2026-08-01-g007p19-ai-usage-reference-index-audit.md) (2026-08-01)
- [G-007P20 AI-usage query-history index audit](validation/2026-08-01-g007p20-ai-usage-query-history-index-audit.md) (2026-08-01)
- [G-007P20A tenant researcher-actor AI-usage index](validation/2026-08-01-g007p20a-tenant-researcher-actor-index.md) (2026-08-01)
- [G-007P21 crawl-run visibility index audit](validation/2026-08-01-g007p21-crawl-run-visibility-index-audit.md) (2026-08-01)
- [G-007P22 blocked-run partial-index classification](validation/2026-08-01-g007p22-blocked-run-partial-index-classification.md) (2026-08-01)
- [G-007P23 crawl-run market index classification](validation/2026-08-01-g007p23-crawl-run-market-index-classification.md) (2026-08-01)
- [G-007P24 crawl-unit budget-pages index audit](validation/2026-08-01-g007p24-crawl-unit-budget-pages-index-audit.md) (2026-08-01)
- [G-007P25 crawl-unit cell-status index audit](validation/2026-08-01-g007p25-crawl-unit-cell-status-index-audit.md) (2026-08-01)
- [G-007P26 crawl-unit market-status index classification](validation/2026-08-01-g007p26-crawl-unit-market-status-index-classification.md) (2026-08-01)
- [G-007P27 user-market-access index family classification](validation/2026-08-01-g007p27-user-market-access-index-family-classification.md) (2026-08-01)
- [G-007P28 crawl-unit status-ZIP index audit](validation/2026-08-01-g007p28-crawl-unit-status-zip-index-audit.md) (2026-08-01)
- [G-007P29 archived-active lead-index audit](validation/2026-08-01-g007p29-archived-active-index-audit.md) (2026-08-01)
- [G-007P30 assigned-lead index audit](validation/2026-08-01-g007p30-assigned-lead-index-audit.md) (2026-08-01)
- [G-007P31 business-type score-index audit](validation/2026-08-01-g007p31-business-type-score-index-audit.md) (2026-08-01)
- [G-007P32 component-score index audit](validation/2026-08-01-g007p32-component-score-index-audit.md) (2026-08-01)
- [G-007P33 country/admin index audit](validation/2026-08-01-g007p33-country-admin-index-audit.md) (2026-08-01)
- [G-007P34 enrichment-status/score index audit](validation/2026-08-01-g007p34-enrichment-index-audit.md) (2026-08-01)
- [G-007P35 exclusion/score index audit](validation/2026-08-01-g007p35-exclusion-score-index-audit.md) (2026-08-01)
- [G-007P36 location-cell/score index audit](validation/2026-08-01-g007p36-location-cell-index-audit.md) (2026-08-01)
- [G-007P37 market/lifecycle/score index audit](validation/2026-08-01-g007p37-market-active-index-audit.md) (2026-08-01)
- [G-007P38 numeric-filter index audit](validation/2026-08-01-g007p38-numeric-filters-index-audit.md) (2026-08-01)
- [G-007P39 phone-quality index audit](validation/2026-08-01-g007p39-phone-quality-index-audit.md) (2026-08-01)
- [G-007P40 primary-type score index audit](validation/2026-08-01-g007p40-primary-type-score-index-audit.md) (2026-08-01)
- [G-007 retained global-index crosswalk](validation/2026-08-01-g007-residual-index-crosswalk.md) (2026-08-01)
## Plans and handoffs

- [Agent handoff (current state)](CODEX_HANDOFF.md)
- [Lean finish plan](plans/2026-08-29-lean-finish-plan.md) (2026-08-29): final release evidence
- [Meaningful-milestone execution plan](plans/2026-07-30-meaningful-milestone-human-checkpoint-execution-plan.md) (2026-07-30)
- [Concurrent multi-conductor execution plan](plans/2026-07-29-concurrent-multi-conductor-execution-plan.md) (2026-07-29)
- [Platform implementation plan](plans/2026-07-27-multi-tenant-lead-intelligence-platform-implementation-plan.md) (2026-07-27) and its [ledger](plans/2026-07-27-multi-tenant-lead-intelligence-platform-implementation-plan-implementation-ledger.jsonl)
- [Whole-application remediation plan](plans/2026-07-10-whole-app-pipeline-remediation-plan.md) (2026-07-10)
- [Linux handoff checkpoint](handoffs/2026-07-31-linux-handoff.md) (2026-07-31)

## Genesis (agent working files)

[`genesis/`](genesis/) holds the original agent inputs and working files, kept verbatim for provenance: the first PRD, build prompts, the remediation ledger, and agent preference notes. See [genesis/README.md](genesis/README.md).
