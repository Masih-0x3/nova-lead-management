import "server-only";

import { isProxy } from "node:util/types";

import {
  buildBusinessUnderstandingProposal,
  transitionBusinessUnderstandingReview,
  type BusinessUnderstandingProposal,
  type BusinessUnderstandingReviewEvent,
  type BusinessUnderstandingReviewSnapshot,
  type BusinessUnderstandingReviewStatus,
  type UnderstandingProducer,
} from "@/lib/understanding/business-understanding";

/**
 * Durable boundary for business understanding versions (L-04 / 0X3-244).
 *
 * The domain module owns all content validation and the review state machine.
 * This service owns only orchestration: scope binding, predecessor resolution,
 * idempotent persistence, and reproducible hydration. Every stored row keeps
 * the exact build input (`source`) so historical versions replay
 * deterministically, plus the current review snapshot for review-state reads.
 */

export type UnderstandingScope = Readonly<{ tenantId: string; workspaceId: string | null }>;

export interface StoredUnderstandingVersion {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly versionId: string;
  readonly proposalRef: string;
  readonly revision: number;
  readonly supersedesProposalRef: string | null;
  readonly supersedesVersionId: string | null;
  readonly contentHash: string;
  readonly claimSetHash: string;
  readonly source: unknown;
  readonly review: BusinessUnderstandingReviewSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UnderstandingRepository {
  getVersion(scope: UnderstandingScope, versionId: string): Promise<StoredUnderstandingVersion | null>;
  getLatestVersionByProposalRef(
    scope: UnderstandingScope,
    proposalRef: string,
  ): Promise<StoredUnderstandingVersion | null>;
  listVersions(scope: UnderstandingScope): Promise<readonly StoredUnderstandingVersion[]>;
  appendVersion(record: StoredUnderstandingVersion): Promise<"created" | "replayed" | "conflict">;
  applyReviewTransition(
    scope: UnderstandingScope,
    versionId: string,
    expectedReviewHash: string,
    review: BusinessUnderstandingReviewSnapshot,
    event: BusinessUnderstandingReviewEvent,
  ): Promise<"updated" | "stale" | "not_found">;
}

export interface UnderstandingServiceClock {
  now(): string;
}

export const systemUnderstandingClock: UnderstandingServiceClock = Object.freeze({
  now: () => new Date().toISOString(),
});

export type UnderstandingServiceCode =
  | "UNDERSTANDING_CREATED"
  | "UNDERSTANDING_REPLAYED"
  | "UNDERSTANDING_READ"
  | "UNDERSTANDING_LISTED"
  | "UNDERSTANDING_REVIEW_TRANSITIONED"
  | "MALFORMED_INPUT"
  | "VERSION_CONFLICT"
  | "SCOPE_MISMATCH"
  | "EVIDENCE_UNRESOLVABLE"
  | "EVIDENCE_INELIGIBLE"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "INVALID_TRANSITION"
  | "HUMAN_REVIEW_REQUIRED"
  | "PERSISTENCE_CONFLICT"
  | "INTEGRITY_VIOLATION";

export type UnderstandingServiceResult<T = undefined> =
  | Readonly<{ ok: true; code: UnderstandingServiceCode; value: T }>
  | Readonly<{ ok: false; code: UnderstandingServiceCode }>;

export interface CreateUnderstandingVersionRequest {
  readonly proposalRef: string;
  readonly supersedesProposalRef?: string | null;
  readonly producer: UnderstandingProducer;
  readonly evidence: readonly unknown[];
  readonly claims: readonly unknown[];
}

export interface CreateUnderstandingVersionDependencies {
  readonly repository: UnderstandingRepository;
  readonly clock?: UnderstandingServiceClock;
}

export interface UnderstandingVersionView {
  readonly stored: StoredUnderstandingVersion;
  readonly proposal: BusinessUnderstandingProposal;
}

export interface TransitionUnderstandingReviewRequest {
  readonly versionId: string;
  readonly expectedReviewHash: string;
  readonly to: Exclude<BusinessUnderstandingReviewStatus, "draft">;
  readonly reason: string;
  readonly actor: Readonly<{ kind: "human"; actorId: string }>;
  /** Required when `to === "superseded"`: the approved replacement version id. */
  readonly replacementVersionId?: string | null;
}

export interface TransitionUnderstandingReviewDependencies {
  readonly repository: UnderstandingRepository;
  readonly clock?: UnderstandingServiceClock;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const VERSION_ID = /^understanding-version:[a-f0-9]{64}$/u;
const TERMINAL_STATUSES: ReadonlySet<BusinessUnderstandingReviewStatus> = new Set(["rejected", "superseded"]);

function fail(code: UnderstandingServiceCode): UnderstandingServiceResult<never> {
  return Object.freeze({ ok: false, code });
}

function validScope(scope: UnderstandingScope): boolean {
  return typeof scope?.tenantId === "string" && UUID.test(scope.tenantId)
    && (scope.workspaceId === null
      || (typeof scope.workspaceId === "string" && UUID.test(scope.workspaceId)));
}

/**
 * Rebuilds the proposal from the persisted build input and verifies every
 * persisted identity hash. A stored row that cannot reproduce its identity is
 * an integrity violation, never a normal read miss.
 */
export function hydrateUnderstandingVersion(
  stored: StoredUnderstandingVersion,
): UnderstandingServiceResult<UnderstandingVersionView> {
  const rebuilt = buildBusinessUnderstandingProposal(stored.source);
  if (!rebuilt.ok) return fail("INTEGRITY_VIOLATION");
  const proposal = rebuilt.proposal;
  const review = stored.review;
  if (
    proposal.versionId !== stored.versionId
    || proposal.contentHash !== stored.contentHash
    || proposal.claimSetHash !== stored.claimSetHash
    || proposal.proposalRef !== stored.proposalRef
    || proposal.revision !== stored.revision
    || proposal.supersedesVersionId !== stored.supersedesVersionId
    || proposal.supersedesProposalRef !== stored.supersedesProposalRef
    || proposal.tenantId !== stored.tenantId
    || proposal.workspaceId !== stored.workspaceId
    || review.versionId !== stored.versionId
    || review.proposalRef !== stored.proposalRef
    || review.revision !== stored.revision
    || review.contentHash !== stored.contentHash
    || review.claimSetHash !== stored.claimSetHash
    || review.tenantId !== stored.tenantId
    || review.workspaceId !== stored.workspaceId
  ) {
    return fail("INTEGRITY_VIOLATION");
  }
  return Object.freeze({ ok: true, code: "UNDERSTANDING_READ", value: Object.freeze({ stored, proposal }) });
}

/**
 * Replays the stored review snapshot through the domain transition boundary
 * with a guaranteed-invalid transition target. A structurally sound snapshot
 * reaches transition validation (INVALID_TRANSITION or REVIEW_TRANSITIONED);
 * any parse/hash failure surfaces as MALFORMED_INPUT or STALE_VERSION.
 */
export function verifyUnderstandingReviewIntegrity(
  review: BusinessUnderstandingReviewSnapshot,
): boolean {
  const probe = transitionBusinessUnderstandingReview({
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

export function loadUnderstandingVersion(
  stored: StoredUnderstandingVersion,
): UnderstandingVersionView | null {
  const hydrated = hydrateUnderstandingVersion(stored);
  if (!hydrated.ok || !verifyUnderstandingReviewIntegrity(stored.review)) return null;
  return hydrated.value;
}

/**
 * Creates a new understanding version from member-supplied evidence and
 * claims. The version id is content-derived, so an identical retry replays the
 * stored row and a divergent payload under an existing id is a conflict.
 */
export async function createUnderstandingVersion(
  scope: UnderstandingScope,
  request: CreateUnderstandingVersionRequest,
  dependencies: CreateUnderstandingVersionDependencies,
): Promise<UnderstandingServiceResult<UnderstandingVersionView>> {
  try {
    if (!validScope(scope) || isProxy(request)) return fail("MALFORMED_INPUT");
    const proposalRef = typeof request.proposalRef === "string" && REF.test(request.proposalRef)
      ? request.proposalRef : null;
    const supersedesProposalRef = request.supersedesProposalRef === undefined
      || request.supersedesProposalRef === null
      ? null
      : typeof request.supersedesProposalRef === "string" && REF.test(request.supersedesProposalRef)
        ? request.supersedesProposalRef : undefined;
    if (!proposalRef || supersedesProposalRef === undefined) return fail("MALFORMED_INPUT");

    let revision = 1;
    let supersedesVersionId: string | null = null;
    if (supersedesProposalRef !== null) {
      const predecessor = await dependencies.repository.getLatestVersionByProposalRef(
        scope,
        supersedesProposalRef,
      );
      if (!predecessor) return fail("NOT_FOUND");
      if (TERMINAL_STATUSES.has(predecessor.review.status)) return fail("VERSION_CONFLICT");
      revision = predecessor.revision + 1;
      supersedesVersionId = predecessor.versionId;
    }

    const createdAt = (dependencies.clock ?? systemUnderstandingClock).now();
    const source = Object.freeze({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      proposalRef,
      revision,
      supersedesProposalRef,
      supersedesVersionId,
      createdAt,
      producer: request.producer,
      evidence: request.evidence,
      claims: request.claims,
    });
    const built = buildBusinessUnderstandingProposal(source);
    if (!built.ok) return fail(built.code);

    const record: StoredUnderstandingVersion = Object.freeze({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      versionId: built.proposal.versionId,
      proposalRef,
      revision,
      supersedesProposalRef,
      supersedesVersionId,
      contentHash: built.proposal.contentHash,
      claimSetHash: built.proposal.claimSetHash,
      source,
      review: built.proposal.review,
      createdAt,
      updatedAt: createdAt,
    });

    const outcome = await dependencies.repository.appendVersion(record);
    if (outcome === "conflict") return fail("PERSISTENCE_CONFLICT");
    const hydrated = hydrateUnderstandingVersion(record);
    if (!hydrated.ok) return hydrated;
    return Object.freeze({
      ok: true,
      code: outcome === "replayed" ? "UNDERSTANDING_REPLAYED" : "UNDERSTANDING_CREATED",
      value: hydrated.value,
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export async function getUnderstandingVersion(
  scope: UnderstandingScope,
  versionId: string,
  repository: UnderstandingRepository,
): Promise<UnderstandingServiceResult<UnderstandingVersionView>> {
  if (!validScope(scope) || typeof versionId !== "string" || !VERSION_ID.test(versionId)) {
    return fail("MALFORMED_INPUT");
  }
  const stored = await repository.getVersion(scope, versionId);
  if (!stored) return fail("NOT_FOUND");
  const hydrated = hydrateUnderstandingVersion(stored);
  if (!hydrated.ok) return hydrated;
  if (!verifyUnderstandingReviewIntegrity(stored.review)) return fail("INTEGRITY_VIOLATION");
  return Object.freeze({ ok: true, code: "UNDERSTANDING_READ", value: hydrated.value });
}

export async function listUnderstandingVersions(
  scope: UnderstandingScope,
  repository: UnderstandingRepository,
): Promise<UnderstandingServiceResult<readonly UnderstandingVersionView[]>> {
  if (!validScope(scope)) return fail("MALFORMED_INPUT");
  const stored = await repository.listVersions(scope);
  const views: UnderstandingVersionView[] = [];
  for (const record of stored) {
    const hydrated = hydrateUnderstandingVersion(record);
    if (!hydrated.ok || !verifyUnderstandingReviewIntegrity(record.review)) {
      return fail("INTEGRITY_VIOLATION");
    }
    views.push(hydrated.value);
  }
  views.sort((left, right) => (left.stored.createdAt < right.stored.createdAt ? -1
    : left.stored.createdAt > right.stored.createdAt ? 1
      : left.stored.versionId < right.stored.versionId ? -1
        : left.stored.versionId > right.stored.versionId ? 1 : 0));
  return Object.freeze({ ok: true, code: "UNDERSTANDING_LISTED", value: Object.freeze(views) });
}

export async function getCurrentApprovedUnderstanding(
  scope: UnderstandingScope,
  repository: UnderstandingRepository,
): Promise<UnderstandingServiceResult<UnderstandingVersionView | null>> {
  const listed = await listUnderstandingVersions(scope, repository);
  if (!listed.ok) return listed;
  const approved = listed.value.filter((view) => view.stored.review.status === "approved");
  approved.sort((left, right) => {
    const leftAt = left.stored.review.events.at(-1)?.at ?? left.stored.createdAt;
    const rightAt = right.stored.review.events.at(-1)?.at ?? right.stored.createdAt;
    return rightAt.localeCompare(leftAt) || left.stored.versionId.localeCompare(right.stored.versionId);
  });
  return Object.freeze({ ok: true, code: "UNDERSTANDING_READ", value: approved[0] ?? null });
}

/**
 * Applies one human review transition against the stored snapshot with
 * optimistic-concurrency on the expected review hash. The domain validates the
 * full event chain before persistence; the repository applies the expected
 * hash atomically.
 */
export async function transitionUnderstandingVersionReview(
  scope: UnderstandingScope,
  request: TransitionUnderstandingReviewRequest,
  dependencies: TransitionUnderstandingReviewDependencies,
): Promise<UnderstandingServiceResult<UnderstandingVersionView>> {
  try {
    if (!validScope(scope)
      || typeof request.versionId !== "string" || !VERSION_ID.test(request.versionId)
      || typeof request.expectedReviewHash !== "string" || !HASH.test(request.expectedReviewHash)
      || request.actor?.kind !== "human"
      || typeof request.actor.actorId !== "string" || !UUID.test(request.actor.actorId)) {
      return fail("MALFORMED_INPUT");
    }

    const stored = await dependencies.repository.getVersion(scope, request.versionId);
    if (!stored) return fail("NOT_FOUND");
    const hydrated = hydrateUnderstandingVersion(stored);
    if (!hydrated.ok) return hydrated;

    let replacement: unknown = null;
    if (request.replacementVersionId !== undefined && request.replacementVersionId !== null) {
      if (!VERSION_ID.test(request.replacementVersionId)) return fail("MALFORMED_INPUT");
      const replacementStored = await dependencies.repository.getVersion(scope, request.replacementVersionId);
      if (!replacementStored) return fail("NOT_FOUND");
      const replacementHydrated = hydrateUnderstandingVersion(replacementStored);
      if (!replacementHydrated.ok) return replacementHydrated;
      if (!verifyUnderstandingReviewIntegrity(replacementStored.review)) return fail("INTEGRITY_VIOLATION");
      replacement = Object.freeze({
        replacementVersion: 1,
        supersedesVersionId: request.versionId,
        review: replacementStored.review,
      });
    }

    const transitioned = transitionBusinessUnderstandingReview({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      current: stored.review,
      expectedVersionId: request.versionId,
      expectedContentHash: stored.contentHash,
      expectedReviewHash: request.expectedReviewHash,
      to: request.to,
      actor: Object.freeze({ kind: "human" as const, actorId: request.actor.actorId }),
      at: (dependencies.clock ?? systemUnderstandingClock).now(),
      reason: request.reason,
      replacement,
    });
    if (!transitioned.ok) return fail(transitioned.code);

    const event = transitioned.review.events.at(-1);
    if (!event) return fail("INTEGRITY_VIOLATION");
    const applied = await dependencies.repository.applyReviewTransition(
      scope,
      request.versionId,
      request.expectedReviewHash,
      transitioned.review,
      event,
    );
    if (applied !== "updated") return fail(applied === "not_found" ? "NOT_FOUND" : "STALE_VERSION");
    return Object.freeze({
      ok: true,
      code: "UNDERSTANDING_REVIEW_TRANSITIONED",
      value: Object.freeze({
        stored: Object.freeze({ ...stored, review: transitioned.review, updatedAt: event.at }),
        proposal: hydrated.value.proposal,
      }),
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}
