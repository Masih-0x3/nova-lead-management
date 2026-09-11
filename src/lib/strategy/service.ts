import "server-only";

import { isProxy } from "node:util/types";

import {
  buildIcpProposal,
  transitionIcpReview,
  type IcpProposal,
  type IcpReviewEvent,
  type IcpReviewSnapshot,
  type IcpReviewStatus,
} from "@/lib/strategy/icp";
import {
  buildLeadPlayProposal,
  transitionLeadPlayReview,
  type LeadPlayProposal,
  type LeadPlayReviewEvent,
  type LeadPlayReviewSnapshot,
  type LeadPlayReviewStatus,
} from "@/lib/strategy/lead-play";
import {
  simulateLeadPlay,
  type LeadPlaySimulation,
  type LeadPlaySimulationAccountInput,
} from "@/lib/strategy/lead-play-simulation";
import {
  createLeadPlayActivationState,
  reviewLeadPlaySimulationEligibility,
  transitionLeadPlayActivation,
  LEAD_PLAY_ACTIVATION_VERSION,
  type LeadPlayActivationState,
  type LeadPlaySimulationEligibilityReview,
} from "@/lib/strategy/lead-play-activation";
import {
  hydrateUnderstandingVersion,
  verifyUnderstandingReviewIntegrity,
  type StoredUnderstandingVersion,
  type UnderstandingRepository,
} from "@/lib/understanding/service";

/**
 * Durable boundary for versioned ICPs and lead plays (L-04 / 0X3-246).
 *
 * The domain modules own all content validation, review state machines,
 * simulation evaluation, and activation replay. This service owns only
 * orchestration: approved-authority resolution, predecessor resolution,
 * idempotent persistence, expected-hash concurrency, and hydration. Approved
 * content is never overwritten — supersession and rollback are recorded as new
 * events on immutable version identities.
 */

export type StrategyScope = Readonly<{ tenantId: string; workspaceId: string | null }>;

export interface StoredIcpVersion {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly versionId: string;
  readonly stableKey: string;
  readonly revision: number;
  readonly supersedesVersionId: string | null;
  readonly contentHash: string;
  readonly understandingVersionId: string;
  readonly source: unknown;
  readonly review: IcpReviewSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredLeadPlayVersion {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly versionId: string;
  readonly stableKey: string;
  readonly revision: number;
  readonly supersedesVersionId: string | null;
  readonly contentHash: string;
  readonly icpVersionId: string;
  readonly understandingVersionId: string;
  readonly source: unknown;
  readonly review: LeadPlayReviewSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredLeadPlaySimulation {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly simulationId: string;
  readonly playVersionId: string;
  readonly playReviewHash: string;
  readonly simulationHash: string;
  readonly input: unknown;
  readonly simulation: LeadPlaySimulation;
  readonly createdAt: string;
}

export interface StoredLeadPlaySimulationReview {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly playVersionId: string;
  readonly simulationId: string;
  readonly eligibilityHash: string;
  readonly review: LeadPlaySimulationEligibilityReview;
  readonly createdAt: string;
}

export interface StoredLeadPlayActivation {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly stableKey: string;
  readonly state: LeadPlayActivationState;
  readonly updatedAt: string;
}

export interface StrategyRepository {
  getIcpVersion(scope: StrategyScope, versionId: string): Promise<StoredIcpVersion | null>;
  getLatestIcpVersionByStableKey(scope: StrategyScope, stableKey: string): Promise<StoredIcpVersion | null>;
  listIcpVersions(scope: StrategyScope): Promise<readonly StoredIcpVersion[]>;
  appendIcpVersion(record: StoredIcpVersion): Promise<"created" | "replayed" | "conflict">;
  applyIcpReviewTransition(
    scope: StrategyScope,
    versionId: string,
    expectedReviewHash: string,
    review: IcpReviewSnapshot,
    event: IcpReviewEvent,
  ): Promise<"updated" | "stale" | "not_found">;

  getLeadPlayVersion(scope: StrategyScope, versionId: string): Promise<StoredLeadPlayVersion | null>;
  getLatestLeadPlayVersionByStableKey(
    scope: StrategyScope,
    stableKey: string,
  ): Promise<StoredLeadPlayVersion | null>;
  listLeadPlayVersions(scope: StrategyScope): Promise<readonly StoredLeadPlayVersion[]>;
  appendLeadPlayVersion(record: StoredLeadPlayVersion): Promise<"created" | "replayed" | "conflict">;
  applyLeadPlayReviewTransition(
    scope: StrategyScope,
    versionId: string,
    expectedReviewHash: string,
    review: LeadPlayReviewSnapshot,
    event: LeadPlayReviewEvent,
  ): Promise<"updated" | "stale" | "not_found">;

  appendSimulation(record: StoredLeadPlaySimulation): Promise<"created" | "replayed" | "conflict">;
  getLatestSimulationForPlay(
    scope: StrategyScope,
    playVersionId: string,
  ): Promise<StoredLeadPlaySimulation | null>;
  listSimulationsForPlay(
    scope: StrategyScope,
    playVersionId: string,
  ): Promise<readonly StoredLeadPlaySimulation[]>;

  appendSimulationReview(
    record: StoredLeadPlaySimulationReview,
  ): Promise<"created" | "replayed" | "conflict">;
  getLatestSimulationReview(
    scope: StrategyScope,
    playVersionId: string,
    simulationId: string,
  ): Promise<StoredLeadPlaySimulationReview | null>;

  getActivationState(scope: StrategyScope, stableKey: string): Promise<StoredLeadPlayActivation | null>;
  appendActivationState(record: StoredLeadPlayActivation): Promise<"created" | "conflict">;
  applyActivationTransition(
    scope: StrategyScope,
    stableKey: string,
    expectedStateHash: string,
    state: LeadPlayActivationState,
  ): Promise<"updated" | "stale" | "not_found">;
}

export interface StrategyClock {
  now(): string;
}

export const systemStrategyClock: StrategyClock = Object.freeze({
  now: () => new Date().toISOString(),
});

export type StrategyServiceCode =
  | "ICP_CREATED"
  | "ICP_REPLAYED"
  | "ICP_READ"
  | "ICP_LISTED"
  | "ICP_REVIEW_TRANSITIONED"
  | "LEAD_PLAY_CREATED"
  | "LEAD_PLAY_REPLAYED"
  | "LEAD_PLAY_READ"
  | "LEAD_PLAY_LISTED"
  | "LEAD_PLAY_REVIEW_TRANSITIONED"
  | "LEAD_PLAY_SIMULATED"
  | "LEAD_PLAY_SIMULATION_REPLAYED"
  | "SIMULATION_ELIGIBILITY_REVIEWED"
  | "LEAD_PLAY_ACTIVATED"
  | "LEAD_PLAY_ROLLED_BACK"
  | "MALFORMED_INPUT"
  | "SCOPE_MISMATCH"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "STALE_STATE"
  | "STALE_UNDERSTANDING"
  | "STALE_ICP"
  | "UNDERSTANDING_NOT_APPROVED"
  | "ICP_NOT_APPROVED"
  | "VERSION_CONFLICT"
  | "MISSING_RATIONALE_REFERENCE"
  | "DUPLICATE_RULE"
  | "CONTRADICTORY_RULE"
  | "UNSAFE_CRITERION"
  | "UNBOUNDED_PLAY"
  | "DUPLICATE_ITEM"
  | "AUTOMATIC_OUTREACH_FORBIDDEN"
  | "UNSAFE_PLAY"
  | "BOUNDS_EXCEEDED"
  | "INVALID_TRANSITION"
  | "HUMAN_REVIEW_REQUIRED"
  | "HUMAN_ACTOR_REQUIRED"
  | "PLAY_NOT_APPROVED"
  | "STALE_PLAY"
  | "SIMULATION_MISMATCH"
  | "SIMULATION_NOT_READY"
  | "SIMULATION_ELIGIBILITY_REQUIRED"
  | "PERSISTENCE_CONFLICT"
  | "INTEGRITY_VIOLATION";

export type StrategyServiceResult<T = undefined> =
  | Readonly<{ ok: true; code: StrategyServiceCode; value: T }>
  | Readonly<{ ok: false; code: StrategyServiceCode }>;

export interface IcpVersionView {
  readonly stored: StoredIcpVersion;
  readonly proposal: IcpProposal;
}

export interface LeadPlayVersionView {
  readonly stored: StoredLeadPlayVersion;
  readonly proposal: LeadPlayProposal;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ICP_VERSION_ID = /^icp-version:[a-f0-9]{64}$/u;
const PLAY_VERSION_ID = /^lead-play-version:[a-f0-9]{64}$/u;
const SIMULATION_ID = /^lead-play-simulation:[a-f0-9]{64}$/u;

function fail(code: StrategyServiceCode): StrategyServiceResult<never> {
  return Object.freeze({ ok: false, code });
}

function validScope(scope: StrategyScope): boolean {
  return typeof scope?.tenantId === "string" && UUID.test(scope.tenantId)
    && (scope.workspaceId === null
      || (typeof scope.workspaceId === "string" && UUID.test(scope.workspaceId)));
}

function validHumanActor(actor: unknown): actor is Readonly<{ kind: "human"; actorId: string }> {
  return typeof actor === "object" && actor !== null
    && (actor as { kind?: unknown }).kind === "human"
    && typeof (actor as { actorId?: unknown }).actorId === "string"
    && UUID.test((actor as { actorId: string }).actorId);
}

/** Rebuilds an ICP proposal from its stored build input and checks identity. */
export function hydrateIcpVersion(stored: StoredIcpVersion): StrategyServiceResult<IcpVersionView> {
  const rebuilt = buildIcpProposal(stored.source);
  if (!rebuilt.ok) return fail("INTEGRITY_VIOLATION");
  const proposal = rebuilt.proposal;
  const review = stored.review;
  if (
    proposal.versionId !== stored.versionId
    || proposal.contentHash !== stored.contentHash
    || proposal.stableKey !== stored.stableKey
    || proposal.revision !== stored.revision
    || proposal.supersedesVersionId !== stored.supersedesVersionId
    || proposal.tenantId !== stored.tenantId
    || proposal.workspaceId !== stored.workspaceId
    || proposal.understanding.versionId !== stored.understandingVersionId
    || review.versionId !== stored.versionId
    || review.contentHash !== stored.contentHash
    || review.stableKey !== stored.stableKey
    || review.revision !== stored.revision
    || review.tenantId !== stored.tenantId
    || review.workspaceId !== stored.workspaceId
  ) {
    return fail("INTEGRITY_VIOLATION");
  }
  return Object.freeze({ ok: true, code: "ICP_READ", value: Object.freeze({ stored, proposal }) });
}

/** Rebuilds a lead-play proposal from its stored build input and checks identity. */
export function hydrateLeadPlayVersion(
  stored: StoredLeadPlayVersion,
): StrategyServiceResult<LeadPlayVersionView> {
  const rebuilt = buildLeadPlayProposal(stored.source);
  if (!rebuilt.ok) return fail("INTEGRITY_VIOLATION");
  const proposal = rebuilt.proposal;
  const review = stored.review;
  if (
    proposal.versionId !== stored.versionId
    || proposal.contentHash !== stored.contentHash
    || proposal.stableKey !== stored.stableKey
    || proposal.revision !== stored.revision
    || proposal.supersedesVersionId !== stored.supersedesVersionId
    || proposal.tenantId !== stored.tenantId
    || proposal.workspaceId !== stored.workspaceId
    || proposal.icp.versionId !== stored.icpVersionId
    || proposal.icp.understandingVersionId !== stored.understandingVersionId
    || review.versionId !== stored.versionId
    || review.contentHash !== stored.contentHash
    || review.stableKey !== stored.stableKey
    || review.revision !== stored.revision
    || review.icpVersionId !== stored.icpVersionId
    || review.tenantId !== stored.tenantId
    || review.workspaceId !== stored.workspaceId
  ) {
    return fail("INTEGRITY_VIOLATION");
  }
  return Object.freeze({ ok: true, code: "LEAD_PLAY_READ", value: Object.freeze({ stored, proposal }) });
}

/** Replays a stored ICP review snapshot through the domain boundary. */
export function verifyIcpReviewIntegrity(review: IcpReviewSnapshot): boolean {
  const probe = transitionIcpReview({
    version: 1,
    tenantId: review.tenantId,
    workspaceId: review.workspaceId,
    current: review,
    expectedVersionId: review.versionId,
    expectedContentHash: review.contentHash,
    expectedReviewHash: review.reviewHash,
    to: "in_review",
    actor: { kind: "human", actorId: "00000000-0000-4000-8000-000000000000" },
    at: "9999-12-31T23:59:59.999Z",
    reason: "integrity verification probe for stored snapshot",
    replacement: null,
  });
  return probe.ok || probe.code === "INVALID_TRANSITION" || probe.code === "HUMAN_REVIEW_REQUIRED";
}

/** Replays a stored lead-play review snapshot through the domain boundary. */
export function verifyLeadPlayReviewIntegrity(review: LeadPlayReviewSnapshot): boolean {
  const probe = transitionLeadPlayReview({
    version: 1,
    tenantId: review.tenantId,
    workspaceId: review.workspaceId,
    current: review,
    expectedVersionId: review.versionId,
    expectedContentHash: review.contentHash,
    expectedReviewHash: review.reviewHash,
    to: "in_review",
    actor: { kind: "human", actorId: "00000000-0000-4000-8000-000000000000" },
    at: "9999-12-31T23:59:59.999Z",
    reason: "integrity verification probe for stored snapshot",
    replacement: null,
  });
  return probe.ok || probe.code === "INVALID_TRANSITION" || probe.code === "HUMAN_REVIEW_REQUIRED";
}

/** Builds the approved-understanding binding an ICP proposal requires. */
function understandingBinding(
  scope: StrategyScope,
  stored: StoredUnderstandingVersion,
): Readonly<Record<string, unknown>> | null {
  const hydrated = hydrateUnderstandingVersion(stored);
  if (!hydrated.ok || !verifyUnderstandingReviewIntegrity(stored.review)) return null;
  if (stored.review.status !== "approved") return null;
  if (stored.tenantId !== scope.tenantId || stored.workspaceId !== scope.workspaceId) return null;
  return Object.freeze({
    tenantId: stored.tenantId,
    workspaceId: stored.workspaceId,
    versionId: stored.versionId,
    contentHash: stored.contentHash,
    claimSetHash: stored.claimSetHash,
    reviewHash: stored.review.reviewHash,
    snapshot: stored.review,
    authority: Object.freeze({
      authorityVersion: 1,
      tenantId: stored.tenantId,
      workspaceId: stored.workspaceId,
      understandingVersionId: stored.versionId,
      understandingContentHash: stored.contentHash,
      understandingClaimSetHash: stored.claimSetHash,
      understandingReviewHash: stored.review.reviewHash,
      source: stored.source,
    }),
  });
}

export interface CreateIcpVersionRequest {
  readonly stableKey: string;
  readonly understandingVersionId: string;
  readonly title: string;
  readonly segment: string;
  readonly useCase: string;
  readonly positiveCriteria: readonly unknown[];
  readonly exclusions: readonly unknown[];
  readonly uncertainties: readonly unknown[];
}

export interface StrategyServiceDependencies {
  readonly repository: StrategyRepository;
  readonly understanding: UnderstandingRepository;
  readonly clock?: StrategyClock;
}

/**
 * Creates a new ICP draft bound to an approved understanding version. The
 * content-derived version id makes an identical retry a replay and a divergent
 * payload under the same id a conflict.
 */
export async function createIcpVersion(
  scope: StrategyScope,
  request: CreateIcpVersionRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<IcpVersionView>> {
  try {
    if (!validScope(scope) || isProxy(request)
      || typeof request.stableKey !== "string" || !REF.test(request.stableKey)
      || typeof request.understandingVersionId !== "string"
      || !/^understanding-version:[a-f0-9]{64}$/u.test(request.understandingVersionId)) {
      return fail("MALFORMED_INPUT");
    }

    const understanding = await dependencies.understanding.getVersion(
      scope,
      request.understandingVersionId,
    );
    if (!understanding) return fail("NOT_FOUND");
    const binding = understandingBinding(scope, understanding);
    if (!binding) return fail("UNDERSTANDING_NOT_APPROVED");

    const predecessor = await dependencies.repository.getLatestIcpVersionByStableKey(
      scope,
      request.stableKey,
    );
    const revision = predecessor ? predecessor.revision + 1 : 1;
    const predecessorInput = predecessor === null ? null : Object.freeze({
      predecessorVersion: 1,
      stableKey: predecessor.stableKey,
      revision: predecessor.revision,
      supersedesVersionId: predecessor.supersedesVersionId,
      review: predecessor.review,
    });
    if (predecessor !== null && predecessor.review.status !== "approved") {
      return fail("VERSION_CONFLICT");
    }

    const createdAt = (dependencies.clock ?? systemStrategyClock).now();
    const source = Object.freeze({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      stableKey: request.stableKey,
      revision,
      predecessor: predecessorInput,
      createdAt,
      understanding: binding,
      title: request.title,
      segment: request.segment,
      useCase: request.useCase,
      positiveCriteria: request.positiveCriteria,
      exclusions: request.exclusions,
      uncertainties: request.uncertainties,
    });
    const built = buildIcpProposal(source);
    if (!built.ok) return fail(built.code);

    const record: StoredIcpVersion = Object.freeze({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      versionId: built.proposal.versionId,
      stableKey: request.stableKey,
      revision,
      supersedesVersionId: built.proposal.supersedesVersionId,
      contentHash: built.proposal.contentHash,
      understandingVersionId: request.understandingVersionId,
      source,
      review: built.proposal.review,
      createdAt,
      updatedAt: createdAt,
    });
    const outcome = await dependencies.repository.appendIcpVersion(record);
    if (outcome === "conflict") return fail("PERSISTENCE_CONFLICT");
    const hydrated = hydrateIcpVersion(record);
    if (!hydrated.ok) return hydrated;
    return Object.freeze({
      ok: true,
      code: outcome === "replayed" ? "ICP_REPLAYED" : "ICP_CREATED",
      value: hydrated.value,
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export interface TransitionReviewRequest {
  readonly versionId: string;
  readonly expectedReviewHash: string;
  readonly to: Exclude<IcpReviewStatus, "draft"> & Exclude<LeadPlayReviewStatus, "draft">;
  readonly reason: string;
  readonly actor: Readonly<{ kind: "human"; actorId: string }>;
  readonly replacementVersionId?: string | null;
}

export async function transitionIcpVersionReview(
  scope: StrategyScope,
  request: TransitionReviewRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<IcpVersionView>> {
  try {
    if (!validScope(scope)
      || typeof request.versionId !== "string" || !ICP_VERSION_ID.test(request.versionId)
      || typeof request.expectedReviewHash !== "string" || !HASH.test(request.expectedReviewHash)
      || !validHumanActor(request.actor)) {
      return fail("MALFORMED_INPUT");
    }
    const stored = await dependencies.repository.getIcpVersion(scope, request.versionId);
    if (!stored) return fail("NOT_FOUND");
    const hydrated = hydrateIcpVersion(stored);
    if (!hydrated.ok) return hydrated;

    let replacement: unknown = null;
    if (request.replacementVersionId !== undefined && request.replacementVersionId !== null) {
      if (!ICP_VERSION_ID.test(request.replacementVersionId)) return fail("MALFORMED_INPUT");
      const replacementStored = await dependencies.repository.getIcpVersion(
        scope,
        request.replacementVersionId,
      );
      if (!replacementStored) return fail("NOT_FOUND");
      const replacementHydrated = hydrateIcpVersion(replacementStored);
      if (!replacementHydrated.ok) return replacementHydrated;
      if (!verifyIcpReviewIntegrity(replacementStored.review)) return fail("INTEGRITY_VIOLATION");
      replacement = Object.freeze({
        replacementVersion: 1,
        supersedesVersionId: request.versionId,
        review: replacementStored.review,
      });
    }

    const transitioned = transitionIcpReview({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      current: stored.review,
      expectedVersionId: request.versionId,
      expectedContentHash: stored.contentHash,
      expectedReviewHash: request.expectedReviewHash,
      to: request.to,
      actor: Object.freeze({ kind: "human" as const, actorId: request.actor.actorId }),
      at: (dependencies.clock ?? systemStrategyClock).now(),
      reason: request.reason,
      replacement,
    });
    if (!transitioned.ok) return fail(transitioned.code);
    const event = transitioned.review.events.at(-1);
    if (!event) return fail("INTEGRITY_VIOLATION");
    const applied = await dependencies.repository.applyIcpReviewTransition(
      scope,
      request.versionId,
      request.expectedReviewHash,
      transitioned.review,
      event,
    );
    if (applied !== "updated") return fail(applied === "not_found" ? "NOT_FOUND" : "STALE_VERSION");
    return Object.freeze({
      ok: true,
      code: "ICP_REVIEW_TRANSITIONED",
      value: Object.freeze({
        stored: Object.freeze({ ...stored, review: transitioned.review, updatedAt: event.at }),
        proposal: hydrated.value.proposal,
      }),
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export async function getIcpVersion(
  scope: StrategyScope,
  versionId: string,
  repository: StrategyRepository,
): Promise<StrategyServiceResult<IcpVersionView>> {
  if (!validScope(scope) || typeof versionId !== "string" || !ICP_VERSION_ID.test(versionId)) {
    return fail("MALFORMED_INPUT");
  }
  const stored = await repository.getIcpVersion(scope, versionId);
  if (!stored) return fail("NOT_FOUND");
  const hydrated = hydrateIcpVersion(stored);
  if (!hydrated.ok) return hydrated;
  if (!verifyIcpReviewIntegrity(stored.review)) return fail("INTEGRITY_VIOLATION");
  return Object.freeze({ ok: true, code: "ICP_READ", value: hydrated.value });
}

export async function listIcpVersions(
  scope: StrategyScope,
  repository: StrategyRepository,
): Promise<StrategyServiceResult<readonly IcpVersionView[]>> {
  if (!validScope(scope)) return fail("MALFORMED_INPUT");
  const stored = await repository.listIcpVersions(scope);
  const views: IcpVersionView[] = [];
  for (const record of stored) {
    const hydrated = hydrateIcpVersion(record);
    if (!hydrated.ok || !verifyIcpReviewIntegrity(record.review)) return fail("INTEGRITY_VIOLATION");
    views.push(hydrated.value);
  }
  views.sort((left, right) => left.stored.stableKey.localeCompare(right.stored.stableKey)
    || left.stored.revision - right.stored.revision
    || left.stored.versionId.localeCompare(right.stored.versionId));
  return Object.freeze({ ok: true, code: "ICP_LISTED", value: Object.freeze(views) });
}

/** The currently approved ICP for a stable key, if one exists. */
export async function getApprovedIcp(
  scope: StrategyScope,
  stableKey: string,
  repository: StrategyRepository,
): Promise<StrategyServiceResult<IcpVersionView | null>> {
  if (!validScope(scope) || typeof stableKey !== "string" || !REF.test(stableKey)) {
    return fail("MALFORMED_INPUT");
  }
  const latest = await repository.getLatestIcpVersionByStableKey(scope, stableKey);
  if (!latest) return Object.freeze({ ok: true, code: "ICP_READ", value: null });
  const hydrated = hydrateIcpVersion(latest);
  if (!hydrated.ok || !verifyIcpReviewIntegrity(latest.review)) return fail("INTEGRITY_VIOLATION");
  return Object.freeze({
    ok: true,
    code: "ICP_READ",
    value: latest.review.status === "approved" ? hydrated.value : null,
  });
}

export interface CreateLeadPlayVersionRequest {
  readonly stableKey: string;
  readonly icpVersionId: string;
  readonly title: string;
  readonly objective: string;
  readonly motion: string;
  readonly searchHypotheses: readonly unknown[];
  readonly sourceAllowlist: readonly string[];
  readonly bounds: unknown;
  readonly rationaleRefs: readonly unknown[];
  readonly uncertainties: readonly unknown[];
}

/**
 * Creates a new lead-play draft bound to an approved ICP version. The stored
 * ICP build input travels inside the binding so the play's content hash can be
 * rebuilt and verified end to end.
 */
export async function createLeadPlayVersion(
  scope: StrategyScope,
  request: CreateLeadPlayVersionRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<LeadPlayVersionView>> {
  try {
    if (!validScope(scope) || isProxy(request)
      || typeof request.stableKey !== "string" || !REF.test(request.stableKey)
      || typeof request.icpVersionId !== "string" || !ICP_VERSION_ID.test(request.icpVersionId)) {
      return fail("MALFORMED_INPUT");
    }

    const icp = await dependencies.repository.getIcpVersion(scope, request.icpVersionId);
    if (!icp) return fail("NOT_FOUND");
    const icpHydrated = hydrateIcpVersion(icp);
    if (!icpHydrated.ok || !verifyIcpReviewIntegrity(icp.review)) return fail("INTEGRITY_VIOLATION");
    if (icp.review.status !== "approved") return fail("ICP_NOT_APPROVED");

    const predecessor = await dependencies.repository.getLatestLeadPlayVersionByStableKey(
      scope,
      request.stableKey,
    );
    if (predecessor !== null && predecessor.review.status !== "approved") {
      return fail("VERSION_CONFLICT");
    }
    const revision = predecessor ? predecessor.revision + 1 : 1;
    const predecessorInput = predecessor === null ? null : Object.freeze({
      predecessorVersion: 1,
      stableKey: predecessor.stableKey,
      revision: predecessor.revision,
      supersedesVersionId: predecessor.supersedesVersionId,
      review: predecessor.review,
    });

    const createdAt = (dependencies.clock ?? systemStrategyClock).now();
    const source = Object.freeze({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      stableKey: request.stableKey,
      revision,
      predecessor: predecessorInput,
      createdAt,
      icp: Object.freeze({
        tenantId: icp.tenantId,
        workspaceId: icp.workspaceId,
        stableKey: icp.stableKey,
        revision: icp.revision,
        supersedesVersionId: icp.supersedesVersionId,
        versionId: icp.versionId,
        contentHash: icp.contentHash,
        reviewHash: icp.review.reviewHash,
        understandingVersionId: icp.review.understandingVersionId,
        understandingContentHash: icp.review.understandingContentHash,
        understandingReviewHash: icp.review.understandingReviewHash,
        snapshot: icp.review,
        source: icp.source,
      }),
      title: request.title,
      objective: request.objective,
      motion: request.motion,
      searchHypotheses: request.searchHypotheses,
      sourceAllowlist: request.sourceAllowlist,
      bounds: request.bounds,
      outreachMode: "draft_only",
      rationaleRefs: request.rationaleRefs,
      uncertainties: request.uncertainties,
    });
    const built = buildLeadPlayProposal(source);
    if (!built.ok) return fail(built.code);

    const record: StoredLeadPlayVersion = Object.freeze({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      versionId: built.proposal.versionId,
      stableKey: request.stableKey,
      revision,
      supersedesVersionId: built.proposal.supersedesVersionId,
      contentHash: built.proposal.contentHash,
      icpVersionId: request.icpVersionId,
      understandingVersionId: built.proposal.icp.understandingVersionId,
      source,
      review: built.proposal.review,
      createdAt,
      updatedAt: createdAt,
    });
    const outcome = await dependencies.repository.appendLeadPlayVersion(record);
    if (outcome === "conflict") return fail("PERSISTENCE_CONFLICT");
    const hydrated = hydrateLeadPlayVersion(record);
    if (!hydrated.ok) return hydrated;
    return Object.freeze({
      ok: true,
      code: outcome === "replayed" ? "LEAD_PLAY_REPLAYED" : "LEAD_PLAY_CREATED",
      value: hydrated.value,
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export async function transitionLeadPlayVersionReview(
  scope: StrategyScope,
  request: TransitionReviewRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<LeadPlayVersionView>> {
  try {
    if (!validScope(scope)
      || typeof request.versionId !== "string" || !PLAY_VERSION_ID.test(request.versionId)
      || typeof request.expectedReviewHash !== "string" || !HASH.test(request.expectedReviewHash)
      || !validHumanActor(request.actor)) {
      return fail("MALFORMED_INPUT");
    }
    const stored = await dependencies.repository.getLeadPlayVersion(scope, request.versionId);
    if (!stored) return fail("NOT_FOUND");
    const hydrated = hydrateLeadPlayVersion(stored);
    if (!hydrated.ok) return hydrated;

    let replacement: unknown = null;
    if (request.replacementVersionId !== undefined && request.replacementVersionId !== null) {
      if (!PLAY_VERSION_ID.test(request.replacementVersionId)) return fail("MALFORMED_INPUT");
      const replacementStored = await dependencies.repository.getLeadPlayVersion(
        scope,
        request.replacementVersionId,
      );
      if (!replacementStored) return fail("NOT_FOUND");
      const replacementHydrated = hydrateLeadPlayVersion(replacementStored);
      if (!replacementHydrated.ok) return replacementHydrated;
      if (!verifyLeadPlayReviewIntegrity(replacementStored.review)) return fail("INTEGRITY_VIOLATION");
      replacement = Object.freeze({
        replacementVersion: 1,
        supersedesVersionId: request.versionId,
        review: replacementStored.review,
      });
    }

    const transitioned = transitionLeadPlayReview({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      current: stored.review,
      expectedVersionId: request.versionId,
      expectedContentHash: stored.contentHash,
      expectedReviewHash: request.expectedReviewHash,
      to: request.to,
      actor: Object.freeze({ kind: "human" as const, actorId: request.actor.actorId }),
      at: (dependencies.clock ?? systemStrategyClock).now(),
      reason: request.reason,
      replacement,
    });
    if (!transitioned.ok) return fail(transitioned.code);
    const event = transitioned.review.events.at(-1);
    if (!event) return fail("INTEGRITY_VIOLATION");
    const applied = await dependencies.repository.applyLeadPlayReviewTransition(
      scope,
      request.versionId,
      request.expectedReviewHash,
      transitioned.review,
      event,
    );
    if (applied !== "updated") return fail(applied === "not_found" ? "NOT_FOUND" : "STALE_VERSION");
    return Object.freeze({
      ok: true,
      code: "LEAD_PLAY_REVIEW_TRANSITIONED",
      value: Object.freeze({
        stored: Object.freeze({ ...stored, review: transitioned.review, updatedAt: event.at }),
        proposal: hydrated.value.proposal,
      }),
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export async function getLeadPlayVersion(
  scope: StrategyScope,
  versionId: string,
  repository: StrategyRepository,
): Promise<StrategyServiceResult<LeadPlayVersionView>> {
  if (!validScope(scope) || typeof versionId !== "string" || !PLAY_VERSION_ID.test(versionId)) {
    return fail("MALFORMED_INPUT");
  }
  const stored = await repository.getLeadPlayVersion(scope, versionId);
  if (!stored) return fail("NOT_FOUND");
  const hydrated = hydrateLeadPlayVersion(stored);
  if (!hydrated.ok) return hydrated;
  if (!verifyLeadPlayReviewIntegrity(stored.review)) return fail("INTEGRITY_VIOLATION");
  return Object.freeze({ ok: true, code: "LEAD_PLAY_READ", value: hydrated.value });
}

export async function listLeadPlayVersions(
  scope: StrategyScope,
  repository: StrategyRepository,
): Promise<StrategyServiceResult<readonly LeadPlayVersionView[]>> {
  if (!validScope(scope)) return fail("MALFORMED_INPUT");
  const stored = await repository.listLeadPlayVersions(scope);
  const views: LeadPlayVersionView[] = [];
  for (const record of stored) {
    const hydrated = hydrateLeadPlayVersion(record);
    if (!hydrated.ok || !verifyLeadPlayReviewIntegrity(record.review)) {
      return fail("INTEGRITY_VIOLATION");
    }
    views.push(hydrated.value);
  }
  views.sort((left, right) => left.stored.stableKey.localeCompare(right.stored.stableKey)
    || left.stored.revision - right.stored.revision
    || left.stored.versionId.localeCompare(right.stored.versionId));
  return Object.freeze({ ok: true, code: "LEAD_PLAY_LISTED", value: Object.freeze(views) });
}

export interface SimulateLeadPlayRequest {
  readonly playVersionId: string;
  readonly estimates: Readonly<{ providerRequests: number; spendCents: number }>;
  readonly accounts: readonly LeadPlaySimulationAccountInput[];
}

/**
 * Runs the deterministic fixture simulation against an approved play version
 * and persists the simulation with its exact input. Simulations are
 * append-only; identical inputs replay the stored simulation.
 */
export async function simulateLeadPlayVersion(
  scope: StrategyScope,
  request: SimulateLeadPlayRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<StoredLeadPlaySimulation>> {
  try {
    if (!validScope(scope) || isProxy(request)
      || typeof request.playVersionId !== "string" || !PLAY_VERSION_ID.test(request.playVersionId)) {
      return fail("MALFORMED_INPUT");
    }
    const play = await dependencies.repository.getLeadPlayVersion(scope, request.playVersionId);
    if (!play) return fail("NOT_FOUND");
    if (!verifyLeadPlayReviewIntegrity(play.review)) return fail("INTEGRITY_VIOLATION");

    const input = Object.freeze({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      playReview: play.review,
      playSource: play.source,
      estimates: request.estimates,
      accounts: request.accounts,
    });
    const simulated = simulateLeadPlay(input);
    if (!simulated.ok) return fail(simulated.code);

    const record: StoredLeadPlaySimulation = Object.freeze({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      simulationId: simulated.simulation.simulationId,
      playVersionId: request.playVersionId,
      playReviewHash: play.review.reviewHash,
      simulationHash: simulated.simulation.simulationHash,
      input,
      simulation: simulated.simulation,
      createdAt: (dependencies.clock ?? systemStrategyClock).now(),
    });
    const outcome = await dependencies.repository.appendSimulation(record);
    if (outcome === "conflict") return fail("PERSISTENCE_CONFLICT");
    return Object.freeze({
      ok: true,
      code: outcome === "replayed" ? "LEAD_PLAY_SIMULATION_REPLAYED" : "LEAD_PLAY_SIMULATED",
      value: record,
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export interface ReviewSimulationEligibilityRequest {
  readonly playVersionId: string;
  readonly simulationId: string;
  readonly decision: "eligible" | "ineligible";
  readonly reason: string;
  readonly actor: Readonly<{ kind: "human"; actorId: string }>;
}

/**
 * Records a human eligibility review over a persisted simulation. The domain
 * re-runs the stored simulation input and rejects any mismatch.
 */
export async function reviewLeadPlaySimulationEligibilityDecision(
  scope: StrategyScope,
  request: ReviewSimulationEligibilityRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<StoredLeadPlaySimulationReview>> {
  try {
    if (!validScope(scope) || isProxy(request)
      || typeof request.playVersionId !== "string" || !PLAY_VERSION_ID.test(request.playVersionId)
      || typeof request.simulationId !== "string" || !SIMULATION_ID.test(request.simulationId)
      || !validHumanActor(request.actor)) {
      return fail("MALFORMED_INPUT");
    }
    const play = await dependencies.repository.getLeadPlayVersion(scope, request.playVersionId);
    if (!play) return fail("NOT_FOUND");
    const simulation = await dependencies.repository.getLatestSimulationForPlay(
      scope,
      request.playVersionId,
    );
    if (!simulation || simulation.simulationId !== request.simulationId) return fail("NOT_FOUND");

    const reviewed = reviewLeadPlaySimulationEligibility({
      version: LEAD_PLAY_ACTIVATION_VERSION,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      playSource: play.source,
      playReview: play.review,
      simulationInput: simulation.input,
      simulation: simulation.simulation,
      decision: request.decision,
      actor: Object.freeze({ kind: "human" as const, actorId: request.actor.actorId }),
      reviewedAt: (dependencies.clock ?? systemStrategyClock).now(),
      reason: request.reason,
    });
    if (!reviewed.ok) return fail(reviewed.code);

    const record: StoredLeadPlaySimulationReview = Object.freeze({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      playVersionId: request.playVersionId,
      simulationId: request.simulationId,
      eligibilityHash: reviewed.review.eligibilityHash,
      review: reviewed.review,
      createdAt: reviewed.review.reviewedAt,
    });
    const outcome = await dependencies.repository.appendSimulationReview(record);
    if (outcome === "conflict") return fail("PERSISTENCE_CONFLICT");
    return Object.freeze({ ok: true, code: "SIMULATION_ELIGIBILITY_REVIEWED", value: record });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export interface LeadPlayActivationTransitionRequest {
  readonly stableKey: string;
  readonly playVersionId: string;
  readonly expectedStateHash?: string;
  readonly action: "activate" | "rollback";
  readonly reason: string;
  readonly actor: Readonly<{ kind: "human"; actorId: string }>;
}

/**
 * Applies one activation transition (activate or rollback) for a stable key.
 * The target play must be approved, its latest simulation fully included, and
 * its eligibility review positive — all re-validated by the domain boundary.
 */
export async function transitionLeadPlayActivationState(
  scope: StrategyScope,
  request: LeadPlayActivationTransitionRequest,
  dependencies: StrategyServiceDependencies,
): Promise<StrategyServiceResult<StoredLeadPlayActivation>> {
  try {
    if (!validScope(scope) || isProxy(request)
      || typeof request.stableKey !== "string" || !REF.test(request.stableKey)
      || typeof request.playVersionId !== "string" || !PLAY_VERSION_ID.test(request.playVersionId)
      || (request.action !== "activate" && request.action !== "rollback")
      || !validHumanActor(request.actor)) {
      return fail("MALFORMED_INPUT");
    }

    const play = await dependencies.repository.getLeadPlayVersion(scope, request.playVersionId);
    if (!play) return fail("NOT_FOUND");
    if (play.stableKey !== request.stableKey) return fail("SCOPE_MISMATCH");
    if (!verifyLeadPlayReviewIntegrity(play.review)) return fail("INTEGRITY_VIOLATION");

    let storedState = await dependencies.repository.getActivationState(scope, request.stableKey);
    if (storedState === null) {
      const created = createLeadPlayActivationState({
        version: LEAD_PLAY_ACTIVATION_VERSION,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        stableKey: request.stableKey,
        createdAt: (dependencies.clock ?? systemStrategyClock).now(),
      });
      if (!created.ok) return fail("MALFORMED_INPUT");
      const record: StoredLeadPlayActivation = Object.freeze({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        stableKey: request.stableKey,
        state: created.state,
        updatedAt: created.state.createdAt,
      });
      const appended = await dependencies.repository.appendActivationState(record);
      if (appended !== "created") return fail("PERSISTENCE_CONFLICT");
      storedState = record;
    }
    if (request.expectedStateHash !== undefined
      && request.expectedStateHash !== storedState.state.stateHash) {
      return fail("STALE_STATE");
    }

    const simulation = await dependencies.repository.getLatestSimulationForPlay(
      scope,
      request.playVersionId,
    );
    if (!simulation) return fail("SIMULATION_NOT_READY");
    const eligibility = await dependencies.repository.getLatestSimulationReview(
      scope,
      request.playVersionId,
      simulation.simulationId,
    );
    if (!eligibility) return fail("SIMULATION_ELIGIBILITY_REQUIRED");

    const transitioned = transitionLeadPlayActivation({
      version: LEAD_PLAY_ACTIVATION_VERSION,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      current: storedState.state,
      expectedStateHash: storedState.state.stateHash,
      action: request.action,
      playSource: play.source,
      playReview: play.review,
      simulationInput: simulation.input,
      simulation: simulation.simulation,
      simulationEligibility: eligibility.review,
      actor: Object.freeze({ kind: "human" as const, actorId: request.actor.actorId }),
      at: (dependencies.clock ?? systemStrategyClock).now(),
      reason: request.reason,
    });
    if (!transitioned.ok) return fail(transitioned.code);

    const applied = await dependencies.repository.applyActivationTransition(
      scope,
      request.stableKey,
      storedState.state.stateHash,
      transitioned.state,
    );
    if (applied !== "updated") return fail(applied === "not_found" ? "NOT_FOUND" : "STALE_STATE");
    return Object.freeze({
      ok: true,
      code: transitioned.code,
      value: Object.freeze({ ...storedState, state: transitioned.state, updatedAt: transitioned.state.events.at(-1)?.at ?? storedState.updatedAt }),
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export async function getLeadPlayActivationState(
  scope: StrategyScope,
  stableKey: string,
  repository: StrategyRepository,
): Promise<StrategyServiceResult<StoredLeadPlayActivation | null>> {
  if (!validScope(scope) || typeof stableKey !== "string" || !REF.test(stableKey)) {
    return fail("MALFORMED_INPUT");
  }
  const state = await repository.getActivationState(scope, stableKey);
  return Object.freeze({ ok: true, code: "LEAD_PLAY_READ", value: state });
}
