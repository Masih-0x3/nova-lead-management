import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { DiscoveryPlan } from "@/lib/discovery/discovery-plan";
import type { DiscoveryRun } from "@/lib/discovery/discovery-run";
import type {
  DiscoveryPlanRow,
  DiscoveryRepository,
  DiscoveryRunRow,
} from "@/lib/discovery/repository";
import {
  appendDiscoveryBatchService,
  createDiscoveryPlanService,
  createDiscoveryRunService,
  listDiscoveryRunViews,
  transitionDiscoveryRunService,
  type PlayAuthorityPort,
} from "@/lib/discovery/service";
import { buildIcpProposal, transitionIcpReview, type IcpReviewSnapshot } from "@/lib/strategy/icp";
import { buildLeadPlayProposal, transitionLeadPlayReview, type LeadPlayReviewSnapshot } from "@/lib/strategy/lead-play";
import { buildBusinessUnderstandingProposal, transitionBusinessUnderstandingReview, type BusinessUnderstandingReviewSnapshot } from "@/lib/understanding/business-understanding";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const REVIEWER = "30000000-0000-4000-8000-000000000001";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const REFS = [{ claimId: "claim:buyers", evidenceId: "evidence:catalog" }];

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function understandingSource() {
  return {
    version: 1, tenantId: TENANT, workspaceId: WORKSPACE, proposalRef: "understanding:discovery",
    revision: 1, supersedesProposalRef: null, supersedesVersionId: null, createdAt: "2026-08-30T12:00:00.000Z",
    producer: { runRef: "agent-run:discovery", runInputHash: HASH_A, agentVersion: "understanding:v1",
      modelRef: "fixture:model", promptRef: "understanding@1", promptHash: HASH_A,
      policyRef: "evidence-policy:v1", policyHash: HASH_B },
    evidence: [{ evidenceId: "evidence:catalog", tenantId: TENANT, workspaceId: WORKSPACE,
      sourceVersionRef: "document-version:catalog", locator: "page=2#buyers", contentHash: HASH_A,
      grade: "direct_observation", freshness: "current" }],
    claims: [{ claimId: "claim:buyers", claimVersion: 1, tenantId: TENANT, workspaceId: WORKSPACE,
      domain: "customer_types", claimClass: "identity", subject: "Industrial buyers",
      statement: "The catalog targets industrial formulators.", origin: "observed", status: "supported",
      confidenceBasisPoints: 9_000, material: true, evidenceIds: ["evidence:catalog"], uncertaintyReason: null }],
  };
}

function approvedUnderstanding(): BusinessUnderstandingReviewSnapshot {
  const built = buildBusinessUnderstandingProposal(understandingSource());
  if (!built.ok) throw new Error(built.code);
  const move = (current: BusinessUnderstandingReviewSnapshot, to: "in_review" | "approved", at: string) =>
    transitionBusinessUnderstandingReview({ version: 1, tenantId: TENANT, workspaceId: WORKSPACE, current,
      expectedVersionId: current.versionId, expectedContentHash: current.contentHash,
      expectedReviewHash: current.reviewHash, to, actor: { kind: "human", actorId: REVIEWER }, at,
      reason: `Human understanding decision: ${to}.`, replacement: null });
  const reviewing = move(built.proposal.review, "in_review", "2026-08-30T12:01:00.000Z");
  if (!reviewing.ok) throw new Error(reviewing.code);
  const approved = move(reviewing.review, "approved", "2026-08-30T12:02:00.000Z");
  if (!approved.ok) throw new Error(approved.code);
  return approved.review;
}

function approvedIcp() {
  const understanding = approvedUnderstanding();
  const source = {
    version: 1, tenantId: TENANT, workspaceId: WORKSPACE, stableKey: "icp:discovery", revision: 1,
    predecessor: null, createdAt: "2026-08-30T13:00:00.000Z",
    understanding: { tenantId: TENANT, workspaceId: WORKSPACE, versionId: understanding.versionId,
      contentHash: understanding.contentHash, claimSetHash: understanding.claimSetHash,
      reviewHash: understanding.reviewHash, snapshot: understanding,
      authority: { authorityVersion: 1, tenantId: TENANT, workspaceId: WORKSPACE,
        understandingVersionId: understanding.versionId, understandingContentHash: understanding.contentHash,
        understandingClaimSetHash: understanding.claimSetHash, understandingReviewHash: understanding.reviewHash,
        source: understandingSource() } },
    title: "Industrial formulation accounts", segment: "Industrial formulators",
    useCase: "Prioritize formulation changes",
    positiveCriteria: [{ criterionId: "criterion:change", ruleKey: "trigger:change", domain: "buying_trigger",
      rule: "A formulation change creates an active need.", rationale: "The understanding supports industrial buyers.",
      confidenceBasisPoints: 8_500, rationaleRefs: REFS }],
    exclusions: [{ criterionId: "exclusion:consumer", ruleKey: "exclude:consumer", domain: "disqualifier",
      rule: "Exclude consumer-only organizations.", rationale: "The evidence supports an industrial profile.",
      confidenceBasisPoints: 8_000, rationaleRefs: REFS }], uncertainties: [],
  };
  const built = buildIcpProposal(source);
  if (!built.ok) throw new Error(built.code);
  const move = (current: IcpReviewSnapshot, to: "in_review" | "approved", at: string) => transitionIcpReview({
    version: 1, tenantId: TENANT, workspaceId: WORKSPACE, current, expectedVersionId: current.versionId,
    expectedContentHash: current.contentHash, expectedReviewHash: current.reviewHash, to,
    actor: { kind: "human", actorId: REVIEWER }, at, reason: `Human ICP decision: ${to}.`, replacement: null });
  const reviewing = move(built.proposal.review, "in_review", "2026-08-30T13:01:00.000Z");
  if (!reviewing.ok) throw new Error(reviewing.code);
  const approved = move(reviewing.review, "approved", "2026-08-30T13:02:00.000Z");
  if (!approved.ok) throw new Error(approved.code);
  return { source, review: approved.review };
}

function approvedPlay() {
  const icp = approvedIcp();
  const source = {
    version: 1, tenantId: TENANT, workspaceId: WORKSPACE, stableKey: "lead-play:discovery", revision: 1,
    predecessor: null, createdAt: "2026-08-30T14:00:00.000Z",
    icp: { tenantId: TENANT, workspaceId: WORKSPACE, stableKey: icp.review.stableKey,
      revision: icp.review.revision, supersedesVersionId: icp.review.supersedesVersionId,
      versionId: icp.review.versionId, contentHash: icp.review.contentHash, reviewHash: icp.review.reviewHash,
      understandingVersionId: icp.review.understandingVersionId,
      understandingContentHash: icp.review.understandingContentHash,
      understandingReviewHash: icp.review.understandingReviewHash, snapshot: icp.review, source: icp.source },
    title: "Formulation-change discovery", objective: "Find evidence-backed accounts for human review.",
    motion: "Discover accounts with current formulation-change signals.",
    searchHypotheses: [{ hypothesisId: "hypothesis:change", queryFamily: "industrial-formulation-change",
      statement: "Organizations announcing formulation changes may have an active need.",
      rationale: "The approved ICP identifies formulation change as a buying trigger.", rationaleRefs: REFS }],
    sourceAllowlist: ["customer-list", "google-places"],
    bounds: { maxAccounts: 4, maxProviderRequests: 3, maxSpendCents: 500 }, outreachMode: "draft_only" as const,
    rationaleRefs: REFS, uncertainties: [{ uncertaintyId: "uncertainty:timing",
      statement: "The timing is not yet known.", impact: "Retain review until timing evidence exists.",
      relatedClaimIds: ["claim:buyers"] }],
  };
  const built = buildLeadPlayProposal(source);
  if (!built.ok) throw new Error(built.code);
  const move = (current: LeadPlayReviewSnapshot, to: "in_review" | "approved", at: string) =>
    transitionLeadPlayReview({ version: 1, tenantId: TENANT, workspaceId: WORKSPACE, current,
      expectedVersionId: current.versionId, expectedContentHash: current.contentHash,
      expectedReviewHash: current.reviewHash, to, actor: { kind: "human", actorId: REVIEWER }, at,
      reason: `Human lead-play decision: ${to}.`, replacement: null });
  const reviewing = move(built.proposal.review, "in_review", "2026-08-30T14:01:00.000Z");
  if (!reviewing.ok) throw new Error(reviewing.code);
  const approved = move(reviewing.review, "approved", "2026-08-30T14:02:00.000Z");
  if (!approved.ok) throw new Error(approved.code);
  return { source, review: approved.review };
}

function activeAuthority() {
  const play = approvedPlay();
  const binding = Object.freeze({ versionId: play.review.versionId, contentHash: play.review.contentHash,
    reviewHash: play.review.reviewHash, revision: 1, supersedesVersionId: null,
    simulationId: `lead-play-simulation:${"c".repeat(64)}`, simulationHash: HASH_C,
    simulationEligibilityHash: HASH_B });
  const event = Object.freeze({ sequence: 1, action: "activate", fromVersionId: null, to: binding,
    actor: Object.freeze({ kind: "human", actorId: REVIEWER }), at: "2026-08-30T16:01:00.000Z",
    reason: "Human activation after reviewed eligibility and caller-owned checks." });
  const payload = Object.freeze({ stateVersion: 1, tenantId: TENANT, workspaceId: WORKSPACE,
    stableKey: play.review.stableKey, createdAt: "2026-08-30T16:00:00.000Z", active: binding,
    inactive: Object.freeze([]), events: Object.freeze([event]) });
  const activationState = Object.freeze({ ...payload, stateHash: sha256(payload) });
  return Object.freeze({ activationState, playReview: play.review, playSource: play.source });
}

function authorityPort(authority: ReturnType<typeof activeAuthority> | null): PlayAuthorityPort {
  return { loadPlayAuthority: vi.fn(async () => authority) };
}

function planRow(plan: DiscoveryPlan): DiscoveryPlanRow {
  // Mirror the real repository: createdAt is column metadata, not part of the
  // hashed domain payload.
  const { createdAt: _rowCreatedAt, ...payload } =
    plan as DiscoveryPlan & { createdAt?: string };
  void _rowCreatedAt;
  return Object.freeze({
    planId: plan.planId,
    tenantId: plan.tenantId,
    workspaceId: plan.workspaceId,
    planSha256: plan.planHash.slice("sha256:".length),
    status: plan.status,
    playStableKey: plan.play.stableKey,
    playVersionId: plan.play.versionId,
    playRevision: plan.play.revision,
    sourceKeys: Object.freeze(plan.tasks.map((task) => task.sourceKey)),
    limits: plan.limits as Record<string, unknown>,
    payload: payload as Record<string, unknown>,
    createdAt: (plan as DiscoveryPlan & { createdAt?: string }).createdAt
      ?? "2026-08-30T17:00:00.000Z",
  });
}

function runRow(run: DiscoveryRun): DiscoveryRunRow {
  return Object.freeze({
    runId: run.runId,
    tenantId: run.tenantId,
    workspaceId: run.workspaceId,
    planId: run.plan.planId,
    status: run.status,
    runSha256: run.runHash.slice("sha256:".length),
    payload: run as unknown as Record<string, unknown>,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
  });
}

function fakeRepository() {
  const plans = new Map<string, DiscoveryPlanRow>();
  const runs = new Map<string, DiscoveryRunRow>();
  const key = (tenantId: string, workspaceId: string | null, id: string) =>
    `${tenantId}/${workspaceId ?? "*"}/${id}`;
  const repository: DiscoveryRepository = {
    insertPlan: vi.fn(async (plan) => {
      const record = plan as unknown as DiscoveryPlan;
      const k = key(record.tenantId, record.workspaceId, record.planId);
      if (plans.has(k)) return "replayed";
      plans.set(k, planRow(record));
      return "created";
    }),
    getPlan: vi.fn(async (tenantId, workspaceId, planId) =>
      plans.get(key(tenantId, workspaceId, planId)) ?? null),
    listPlans: vi.fn(async () => [...plans.values()]),
    insertRun: vi.fn(async (run) => {
      const record = run as unknown as DiscoveryRun;
      const k = key(record.tenantId, record.workspaceId, record.runId);
      if (runs.has(k)) return "replayed";
      runs.set(k, runRow(record));
      return "created";
    }),
    getRun: vi.fn(async (tenantId, workspaceId, runId) =>
      runs.get(key(tenantId, workspaceId, runId)) ?? null),
    listRuns: vi.fn(async () => [...runs.values()]),
    updateRun: vi.fn(async (expectedRunHash, run) => {
      const record = run as unknown as DiscoveryRun;
      const k = key(record.tenantId, record.workspaceId, record.runId);
      const current = runs.get(k);
      if (!current || `sha256:${current.runSha256}` !== expectedRunHash) {
        throw new Error("stale run hash");
      }
      runs.set(k, runRow(record));
    }),
  };
  return { repository, plans, runs };
}

const CLOCK = () => new Date("2026-08-30T17:00:00.000Z");

function planInput() {
  const authority = activeAuthority();
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playVersionId: authority.playReview.versionId,
    sourceKeys: ["google-places", "customer-list"],
    limits: { maxAccounts: 4, maxProviderRequests: 2, maxSpendCents: 200 },
  };
}

describe("l05 discovery service", () => {
  it("fails closed when the play authority is unavailable", async () => {
    const { repository } = fakeRepository();
    await expect(createDiscoveryPlanService(
      { repository, playAuthority: authorityPort(null), clock: CLOCK }, planInput(),
    )).rejects.toMatchObject({ code: "PLAY_AUTHORITY_UNAVAILABLE" });
    expect(repository.insertPlan).not.toHaveBeenCalled();
  });

  it("creates a bounded plan from approved play authority and replays it", async () => {
    const { repository } = fakeRepository();
    const authority = activeAuthority();
    const deps = { repository, playAuthority: authorityPort(authority), clock: CLOCK };
    const first = await createDiscoveryPlanService(deps, planInput());
    expect(first.kind).toBe("created");
    expect(first.plan.status).toBe("plan_only");
    expect(first.plan.planId).toMatch(/^discovery-plan:[0-9a-f]{64}$/u);
    expect(first.plan.tasks).toHaveLength(2);

    const replay = await createDiscoveryPlanService(deps, planInput());
    expect(replay.kind).toBe("replayed");
    expect(replay.plan.planId).toBe(first.plan.planId);
  });

  it("rejects plan input that does not match the play's allowlist", async () => {
    const { repository } = fakeRepository();
    const authority = activeAuthority();
    const deps = { repository, playAuthority: authorityPort(authority), clock: CLOCK };
    await expect(createDiscoveryPlanService(deps,
      { ...planInput(), sourceKeys: ["unsupported-provider"] }))
      .rejects.toMatchObject({ code: "PLAN_UNSUPPORTED_SOURCE" });
  });

  it("runs the full lifecycle: create -> start -> batch -> replay -> complete", async () => {
    const { repository } = fakeRepository();
    const authority = activeAuthority();
    const deps = { repository, playAuthority: authorityPort(authority), clock: CLOCK };
    const { plan } = await createDiscoveryPlanService(deps, planInput());

    const created = await createDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, planId: plan.planId,
      createdAt: "2026-08-30T17:00:00.000Z",
    });
    expect(created.run.status).toBe("planned");
    const replayed = await createDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, planId: plan.planId,
      createdAt: "2026-08-30T17:00:00.000Z",
    });
    expect(replayed.kind).toBe("replayed");

    const started = await transitionDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, runId: created.run.runId,
      expectedRunHash: created.run.runHash, action: "start",
      at: "2026-08-30T17:01:00.000Z", reason: "Begin caller-controlled collection.",
    });
    expect(started.run.status).toBe("running");

    const taskId = started.run.tasks[0]?.taskId;
    const appended = await appendDiscoveryBatchService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, runId: created.run.runId,
      expectedRunHash: started.run.runHash,
      batch: {
        batchVersion: 1, batchId: "batch:page-1", taskId,
        cursor: null, nextCursor: null, complete: true,
        appendedAt: "2026-08-30T17:02:00.000Z", providerRequests: 1, spendCents: 40,
        observations: [{ observationVersion: 1, observationId: "observation:account-a",
          accountRef: "account:a", sourceKey: started.run.tasks[0]?.sourceKey,
          observedAt: "2026-08-30T17:01:30.000Z", fields: { name: "Acme" } }],
      },
    });
    expect(appended.code).toBe("DISCOVERY_BATCH_APPENDED");
    expect(appended.run.totals.accounts).toBe(1);
  });

  it("maps a lost update race to DISCOVERY_STALE", async () => {
    const { repository } = fakeRepository();
    const authority = activeAuthority();
    const deps = { repository, playAuthority: authorityPort(authority), clock: CLOCK };
    const { plan } = await createDiscoveryPlanService(deps, planInput());
    const { run } = await createDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, planId: plan.planId,
      createdAt: "2026-08-30T17:00:00.000Z",
    });
    repository.updateRun = vi.fn(async () => {
      throw new Error("row changed");
    });
    await expect(transitionDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, runId: run.runId,
      expectedRunHash: run.runHash, action: "start",
      at: "2026-08-30T17:01:00.000Z", reason: "Lose the race.",
    })).rejects.toMatchObject({ code: "DISCOVERY_STALE" });
  });

  it("rejects a missing run and malformed selectors without touching storage", async () => {
    const { repository } = fakeRepository();
    const deps = { repository, clock: CLOCK };
    await expect(transitionDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
      runId: `discovery-run:${"f".repeat(64)}`,
      expectedRunHash: HASH_A, action: "start",
      at: "2026-08-30T17:01:00.000Z", reason: "No such run.",
    })).rejects.toMatchObject({ code: "DISCOVERY_NOT_FOUND" });
    await expect(createDiscoveryRunService(deps, { tenantId: "bad" }))
      .rejects.toMatchObject({ code: "DISCOVERY_INPUT_INVALID" });
    expect(repository.updateRun).not.toHaveBeenCalled();
  });

  it("projects run views for the L-07 panels", async () => {
    const { repository } = fakeRepository();
    const authority = activeAuthority();
    const deps = { repository, playAuthority: authorityPort(authority), clock: CLOCK };
    const { plan } = await createDiscoveryPlanService(deps, planInput());
    await createDiscoveryRunService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, planId: plan.planId,
      createdAt: "2026-08-30T17:00:00.000Z",
    });
    const views = await listDiscoveryRunViews(repository,
      { tenantId: TENANT, workspaceId: WORKSPACE });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ planId: plan.planId, status: "planned" });
  });
});
