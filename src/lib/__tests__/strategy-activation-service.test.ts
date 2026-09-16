import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createLeadPlayActivationState,
  reviewLeadPlaySimulationEligibility,
  type LeadPlayActivationState,
} from "@/lib/strategy/lead-play-activation";
import { simulateLeadPlay, type LeadPlaySimulation } from "@/lib/strategy/lead-play-simulation";
import { buildIcpProposal, transitionIcpReview, type IcpReviewSnapshot } from "@/lib/strategy/icp";
import {
  buildLeadPlayProposal,
  transitionLeadPlayReview,
  type LeadPlayReviewSnapshot,
} from "@/lib/strategy/lead-play";
import {
  transitionLeadPlayActivationState,
  type StoredLeadPlayActivation,
  type StoredLeadPlaySimulation,
  type StoredLeadPlaySimulationReview,
  type StoredLeadPlayVersion,
  type StrategyRepository,
  type StrategyScope,
} from "@/lib/strategy/service";
import {
  buildBusinessUnderstandingProposal,
  transitionBusinessUnderstandingReview,
  type BusinessUnderstandingReviewSnapshot,
} from "@/lib/understanding/business-understanding";

const TENANT = "10000000-0000-4000-8000-0000000000aa";
const WORKSPACE = "20000000-0000-4000-8000-0000000000aa";
const REVIEWER = "30000000-0000-4000-8000-0000000000aa";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const REFS = [{ claimId: "claim:buyers", evidenceId: "evidence:catalog" }];
const PLAY_CREATED_AT = "2026-08-30T14:00:00.000Z";
const TRANSITION_AT = "2026-08-30T16:30:00.000Z";

const scope: StrategyScope = Object.freeze({ tenantId: TENANT, workspaceId: WORKSPACE });

function understandingSource() {
  return {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    proposalRef: "understanding:activation-service-fixture",
    revision: 1,
    supersedesProposalRef: null,
    supersedesVersionId: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    producer: {
      runRef: "agent-run:activation-service-fixture",
      runInputHash: HASH_A,
      agentVersion: "understanding-synthesizer:v1",
      modelRef: "fixture:deterministic",
      promptRef: "business-understanding@1",
      promptHash: HASH_A,
      policyRef: "evidence-policy:v1",
      policyHash: HASH_B,
    },
    evidence: [{
      evidenceId: "evidence:catalog",
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      sourceVersionRef: "document-version:catalog",
      locator: "page=2#buyers",
      contentHash: HASH_A,
      grade: "direct_observation",
      freshness: "current",
    }],
    claims: [{
      claimId: "claim:buyers",
      claimVersion: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      domain: "customer_types",
      claimClass: "identity",
      subject: "Industrial buyers",
      statement: "The catalog targets industrial formulators.",
      origin: "observed",
      status: "supported",
      confidenceBasisPoints: 9_000,
      material: true,
      evidenceIds: ["evidence:catalog"],
      uncertaintyReason: null,
    }],
  };
}

function approvedUnderstanding(): BusinessUnderstandingReviewSnapshot {
  const built = buildBusinessUnderstandingProposal(understandingSource());
  if (!built.ok) throw new Error(built.code);
  const transition = (current: BusinessUnderstandingReviewSnapshot, to: "in_review" | "approved", at: string) =>
    transitionBusinessUnderstandingReview({
      version: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      current,
      expectedVersionId: current.versionId,
      expectedContentHash: current.contentHash,
      expectedReviewHash: current.reviewHash,
      to,
      actor: { kind: "human", actorId: REVIEWER },
      at,
      reason: `Human understanding decision: ${to}.`,
      replacement: null,
    });
  const reviewing = transition(built.proposal.review, "in_review", "2026-08-30T12:01:00.000Z");
  if (!reviewing.ok) throw new Error(reviewing.code);
  const approved = transition(reviewing.review, "approved", "2026-08-30T12:02:00.000Z");
  if (!approved.ok) throw new Error(approved.code);
  return approved.review;
}

function approvedIcp() {
  const understanding = approvedUnderstanding();
  const source = {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    stableKey: "icp:activation-service-fixture",
    revision: 1,
    predecessor: null,
    createdAt: "2026-08-30T13:00:00.000Z",
    understanding: {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      versionId: understanding.versionId,
      contentHash: understanding.contentHash,
      claimSetHash: understanding.claimSetHash,
      reviewHash: understanding.reviewHash,
      snapshot: understanding,
      authority: {
        authorityVersion: 1,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        understandingVersionId: understanding.versionId,
        understandingContentHash: understanding.contentHash,
        understandingClaimSetHash: understanding.claimSetHash,
        understandingReviewHash: understanding.reviewHash,
        source: understandingSource(),
      },
    },
    title: "Industrial formulation-change accounts",
    segment: "Industrial formulators",
    useCase: "Prioritize evidence-backed formulation changes",
    positiveCriteria: [{
      criterionId: "criterion:change",
      ruleKey: "trigger:formulation-change",
      domain: "buying_trigger",
      rule: "A formulation change creates an active need.",
      rationale: "The approved understanding identifies industrial buyers.",
      confidenceBasisPoints: 8_500,
      rationaleRefs: REFS,
    }],
    exclusions: [{
      criterionId: "exclusion:consumer",
      ruleKey: "disqualifier:consumer-only",
      domain: "disqualifier",
      rule: "Exclude consumer-only organizations.",
      rationale: "The evidence supports an industrial profile.",
      confidenceBasisPoints: 8_000,
      rationaleRefs: REFS,
    }],
    uncertainties: [],
  };
  const built = buildIcpProposal(source);
  if (!built.ok) throw new Error(built.code);
  const transition = (current: IcpReviewSnapshot, to: "in_review" | "approved", at: string) =>
    transitionIcpReview({
      version: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      current,
      expectedVersionId: current.versionId,
      expectedContentHash: current.contentHash,
      expectedReviewHash: current.reviewHash,
      to,
      actor: { kind: "human", actorId: REVIEWER },
      at,
      reason: `Human ICP decision: ${to}.`,
      replacement: null,
    });
  const reviewing = transition(built.proposal.review, "in_review", "2026-08-30T13:01:00.000Z");
  if (!reviewing.ok) throw new Error(reviewing.code);
  const approved = transition(reviewing.review, "approved", "2026-08-30T13:02:00.000Z");
  if (!approved.ok) throw new Error(approved.code);
  return { source, review: approved.review };
}

function playSource(icp = approvedIcp()) {
  return {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    stableKey: "lead-play:activation-service-fixture",
    revision: 1,
    predecessor: null,
    createdAt: PLAY_CREATED_AT,
    icp: {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      stableKey: icp.review.stableKey,
      revision: icp.review.revision,
      supersedesVersionId: icp.review.supersedesVersionId,
      versionId: icp.review.versionId,
      contentHash: icp.review.contentHash,
      reviewHash: icp.review.reviewHash,
      understandingVersionId: icp.review.understandingVersionId,
      understandingContentHash: icp.review.understandingContentHash,
      understandingReviewHash: icp.review.understandingReviewHash,
      snapshot: icp.review,
      source: icp.source,
    },
    title: "Formulation-change discovery",
    objective: "Find evidence-backed formulation-change accounts for human review.",
    motion: "Discover accounts with current formulation-change signals.",
    searchHypotheses: [{
      hypothesisId: "hypothesis:change",
      queryFamily: "industrial-formulation-change",
      statement: "Organizations announcing formulation changes may have an active need.",
      rationale: "The approved ICP identifies formulation change as a buying trigger.",
      rationaleRefs: REFS,
    }],
    sourceAllowlist: ["customer-list", "google-places"],
    bounds: { maxAccounts: 4, maxProviderRequests: 3, maxSpendCents: 500 },
    outreachMode: "draft_only" as const,
    rationaleRefs: REFS,
    uncertainties: [{
      uncertaintyId: "uncertainty:timing",
      statement: "The timing of each formulation change is not yet known.",
      impact: "Keep ambiguous timing in human review.",
      relatedClaimIds: ["claim:buyers"],
    }],
  };
}

function approvedPlay() {
  const source = playSource();
  const built = buildLeadPlayProposal(source);
  if (!built.ok) throw new Error(built.code);
  const transition = (current: LeadPlayReviewSnapshot, to: "in_review" | "approved", at: string) =>
    transitionLeadPlayReview({
      version: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      current,
      expectedVersionId: current.versionId,
      expectedContentHash: current.contentHash,
      expectedReviewHash: current.reviewHash,
      to,
      actor: { kind: "human", actorId: REVIEWER },
      at,
      reason: `Human lead-play decision: ${to}.`,
      replacement: null,
    });
  const reviewing = transition(built.proposal.review, "in_review", "2026-08-30T14:01:00.000Z");
  if (!reviewing.ok) throw new Error(reviewing.code);
  const approved = transition(reviewing.review, "approved", "2026-08-30T14:02:00.000Z");
  if (!approved.ok) throw new Error(approved.code);
  return { source, review: approved.review };
}

function storedPlay(play: ReturnType<typeof approvedPlay>): StoredLeadPlayVersion {
  return Object.freeze({
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    versionId: play.review.versionId,
    stableKey: play.review.stableKey,
    revision: play.review.revision,
    supersedesVersionId: play.review.supersedesVersionId,
    contentHash: play.review.contentHash,
    icpVersionId: play.review.icpVersionId,
    understandingVersionId: play.review.understandingVersionId,
    source: play.source,
    review: play.review,
    createdAt: PLAY_CREATED_AT,
    updatedAt: PLAY_CREATED_AT,
  });
}

function simulationInput(play: ReturnType<typeof approvedPlay>) {
  return {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playReview: play.review,
    playSource: play.source,
    estimates: { providerRequests: 1, spendCents: 100 },
    accounts: [{
      accountId: "account:fixture",
      observations: [{
        observationId: "observation:fixture",
        sourceKey: "google-places",
        hypothesisId: "hypothesis:change",
        assessment: "supported" as const,
        rationaleRefs: REFS,
        uncertaintyIds: [],
      }],
    }],
  };
}

function storedSimulation(
  play: ReturnType<typeof approvedPlay>,
): Readonly<{ source: ReturnType<typeof simulationInput>; simulation: LeadPlaySimulation; record: StoredLeadPlaySimulation }> {
  const source = simulationInput(play);
  const result = simulateLeadPlay(source);
  if (!result.ok) throw new Error(result.code);
  const record: StoredLeadPlaySimulation = Object.freeze({
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    simulationId: result.simulation.simulationId,
    playVersionId: play.review.versionId,
    playReviewHash: play.review.reviewHash,
    simulationHash: result.simulation.simulationHash,
    input: source,
    simulation: result.simulation,
    createdAt: "2026-08-30T15:00:00.000Z",
  });
  return Object.freeze({ source, simulation: result.simulation, record });
}

function storedEligibility(
  play: ReturnType<typeof approvedPlay>,
  simulation: ReturnType<typeof storedSimulation>,
): StoredLeadPlaySimulationReview {
  const result = reviewLeadPlaySimulationEligibility({
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playSource: play.source,
    playReview: play.review,
    simulationInput: simulation.source,
    simulation: simulation.simulation,
    decision: "eligible",
    actor: { kind: "human", actorId: REVIEWER },
    reviewedAt: "2026-08-30T15:30:00.000Z",
    reason: "Human reviewed the hypothetical fixture outcomes for activation eligibility.",
  });
  if (!result.ok) throw new Error(result.code);
  return Object.freeze({
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playVersionId: play.review.versionId,
    simulationId: simulation.record.simulationId,
    eligibilityHash: result.review.eligibilityHash,
    review: result.review,
    createdAt: result.review.reviewedAt,
  });
}

function syntheticActivation(play: StoredLeadPlayVersion): LeadPlayActivationState {
  const created = createLeadPlayActivationState({
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    stableKey: play.stableKey,
    createdAt: play.createdAt,
  });
  if (!created.ok) throw new Error(created.code);
  return created.state;
}

function repository(overrides: Partial<StrategyRepository> = {}): StrategyRepository {
  const missing = (name: string) => async () => {
    throw new Error(`unexpected repository call: ${name}`);
  };
  return {
    getIcpVersion: missing("getIcpVersion"),
    getLatestIcpVersionByStableKey: missing("getLatestIcpVersionByStableKey"),
    listIcpVersions: missing("listIcpVersions"),
    appendIcpVersion: missing("appendIcpVersion"),
    applyIcpReviewTransition: missing("applyIcpReviewTransition"),
    getLeadPlayVersion: missing("getLeadPlayVersion"),
    getLatestLeadPlayVersionByStableKey: missing("getLatestLeadPlayVersionByStableKey"),
    listLeadPlayVersions: missing("listLeadPlayVersions"),
    appendLeadPlayVersion: missing("appendLeadPlayVersion"),
    applyLeadPlayReviewTransition: missing("applyLeadPlayReviewTransition"),
    appendSimulation: missing("appendSimulation"),
    getLatestSimulationForPlay: missing("getLatestSimulationForPlay"),
    listSimulationsForPlay: missing("listSimulationsForPlay"),
    appendSimulationReview: missing("appendSimulationReview"),
    getLatestSimulationReview: missing("getLatestSimulationReview"),
    getActivationState: missing("getActivationState"),
    appendActivationState: missing("appendActivationState"),
    applyActivationTransition: missing("applyActivationTransition"),
    ...overrides,
  } as StrategyRepository;
}

function requestFor(play: StoredLeadPlayVersion, expectedStateHash?: string) {
  return {
    stableKey: play.stableKey,
    playVersionId: play.versionId,
    expectedStateHash,
    action: "activate" as const,
    reason: "Human activation after reviewing the exact simulation receipt.",
    actor: { kind: "human" as const, actorId: REVIEWER },
  };
}

const fixedClock = Object.freeze({ now: () => TRANSITION_AT });

describe("lead-play activation service state initialization", () => {
  it("activates on first transition when the UI sends the synthetic state hash", async () => {
    const approved = approvedPlay();
    const play = storedPlay(approved);
    const simulation = storedSimulation(approved);
    const eligibility = storedEligibility(approved, simulation);
    const appended: StoredLeadPlayActivation[] = [];
    const applied: Array<{ expected: string; state: LeadPlayActivationState }> = [];
    const repo = repository({
      getLeadPlayVersion: async () => play,
      getActivationState: async () => null,
      appendActivationState: async (record) => {
        appended.push(record);
        return "created";
      },
      getLatestSimulationForPlay: async () => simulation.record,
      getLatestSimulationReview: async () => eligibility,
      applyActivationTransition: async (_scope, _stableKey, expectedStateHash, state) => {
        applied.push({ expected: expectedStateHash, state });
        return "updated";
      },
    });

    const result = await transitionLeadPlayActivationState(
      scope,
      requestFor(play, syntheticActivation(play).stateHash),
      { repository: repo, understanding: {} as never, clock: fixedClock },
    );

    expect(result).toMatchObject({ ok: true, code: "LEAD_PLAY_ACTIVATED" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.state.createdAt).toBe(PLAY_CREATED_AT);
    expect(applied).toHaveLength(1);
    if (result.ok) {
      expect(result.value.state.active?.versionId).toBe(play.versionId);
      expect(result.value.state.events.at(-1)?.at).toBe(TRANSITION_AT);
    }
  });

  it("still rejects a wrong expected hash on first activation", async () => {
    const play = storedPlay(approvedPlay());
    const repo = repository({
      getLeadPlayVersion: async () => play,
      getActivationState: async () => null,
      appendActivationState: async () => "created",
    });

    const result = await transitionLeadPlayActivationState(
      scope,
      requestFor(play, HASH_A),
      { repository: repo, understanding: {} as never, clock: fixedClock },
    );

    expect(result).toEqual({ ok: false, code: "STALE_STATE" });
  });

  it("enforces the stored-state CAS for persisted activations", async () => {
    const approved = approvedPlay();
    const play = storedPlay(approved);
    const simulation = storedSimulation(approved);
    const eligibility = storedEligibility(approved, simulation);
    const persisted: StoredLeadPlayActivation = Object.freeze({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      stableKey: play.stableKey,
      state: syntheticActivation(play),
      updatedAt: PLAY_CREATED_AT,
    });
    const applied: LeadPlayActivationState[] = [];
    const repo = repository({
      getLeadPlayVersion: async () => play,
      getActivationState: async () => persisted,
      getLatestSimulationForPlay: async () => simulation.record,
      getLatestSimulationReview: async () => eligibility,
      applyActivationTransition: async (_scope, _stableKey, _expected, state) => {
        applied.push(state);
        return "updated";
      },
    });

    const stale = await transitionLeadPlayActivationState(
      scope,
      requestFor(play, HASH_B),
      { repository: repo, understanding: {} as never, clock: fixedClock },
    );
    expect(stale).toEqual({ ok: false, code: "STALE_STATE" });

    const fresh = await transitionLeadPlayActivationState(
      scope,
      requestFor(play, persisted.state.stateHash),
      { repository: repo, understanding: {} as never, clock: fixedClock },
    );
    expect(fresh).toMatchObject({ ok: true, code: "LEAD_PLAY_ACTIVATED" });
    expect(applied).toHaveLength(1);
  });
});
