import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { OutcomeRecord, OutcomeTaxonomy } from "@/lib/outcomes/outcome-record";
import {
  buildLearningProposal,
  transitionLearningProposalReview,
  type LearningProposal,
} from "@/lib/outcomes/learning-proposal";
import type {
  LearningRepository,
  StoredLearningProposal,
} from "@/lib/learning/repository";
import type { OutcomeRepository } from "@/lib/outcomes/repository";
import type { StrategyRepository } from "@/lib/strategy/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const PROPOSAL_VERSION = /^learning-proposal-version:[0-9a-f]{64}$/u;
const OUTCOME_VERSION = /^outcome-version:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const METRICS = new Set([
  "reply_rate", "meeting_rate", "opportunity_rate", "win_rate", "opt_out_rate", "bounce_rate",
]);
const CHANGE_KINDS = new Set([
  "qualification_threshold_basis_points", "score_weight_basis_points",
  "query_family_status", "outreach_guidance_status",
]);
const REVIEW_TARGETS = new Set(["in_review", "approved", "rejected"]);
const MAX_OUTCOMES = 100;
const MAX_UNCERTAINTIES = 20;

type MetricKey =
  | "reply_rate" | "meeting_rate" | "opportunity_rate"
  | "win_rate" | "opt_out_rate" | "bounce_rate";

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export type LearningServiceErrorCode =
  | "LEARNING_INPUT_INVALID"
  | "LEARNING_NOT_FOUND"
  | "LEARNING_SCOPE_MISMATCH"
  | "LEARNING_VERSION_CONFLICT"
  | "LEARNING_INVALID_CHRONOLOGY"
  | "LEARNING_INVALID_TRANSITION"
  | "LEARNING_HUMAN_REVIEW_REQUIRED"
  | "LEARNING_METRIC_MISMATCH"
  | "LEARNING_OUTCOME_SCOPE"
  | "LEARNING_INTEGRITY_VIOLATION";

export class LearningServiceError extends Error {
  readonly code: LearningServiceErrorCode;

  constructor(code: LearningServiceErrorCode, message: string) {
    super(message);
    this.name = "LearningServiceError";
    this.code = code;
  }
}

function invalid(message: string): LearningServiceError {
  return new LearningServiceError("LEARNING_INPUT_INVALID", message);
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export interface LearningAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface LearningServiceDeps {
  readonly learning: LearningRepository;
  readonly outcomes: Pick<OutcomeRepository, "getVersion">;
  readonly strategy: Pick<StrategyRepository, "getLeadPlayVersion">;
  readonly audit?: LearningAuditSink;
  readonly clock?: () => Date;
}

type Scope = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
}>;

function uuid(value: unknown, field: string): string {
  return typeof value === "string" && UUID.test(value) ? value
    : (() => { throw invalid(`${field} must be a UUID`); })();
}

function safeRef(value: unknown, field: string): string {
  return typeof value === "string" && SAFE_REF.test(value) ? value
    : (() => { throw invalid(`${field} is malformed`); })();
}

function iso(value: unknown, field: string): string {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value))
    ? value : (() => { throw invalid(`${field} must be an ISO timestamp`); })();
}

function nowIso(clock: (() => Date) | undefined): string {
  return (clock?.() ?? new Date()).toISOString();
}

function parseScope(raw: PlainRecord): Scope {
  const playVersionId = typeof raw.playVersionId === "string" && PLAY_VERSION.test(raw.playVersionId)
    ? raw.playVersionId : (() => { throw invalid("playVersionId is malformed"); })();
  return Object.freeze({
    tenantId: uuid(raw.tenantId, "tenantId"),
    workspaceId: uuid(raw.workspaceId, "workspaceId"),
    accountId: uuid(raw.accountId, "accountId"),
    playVersionId,
  });
}

/** Mirrors the domain's metricMatch; the domain re-verifies on build. */
function metricMatch(metricKey: MetricKey, outcome: OutcomeTaxonomy): boolean {
  if (metricKey === "reply_rate") return outcome === "replied";
  if (metricKey === "meeting_rate") return outcome === "meeting_set";
  if (metricKey === "opportunity_rate") return outcome === "opportunity";
  if (metricKey === "win_rate") return outcome === "won";
  if (metricKey === "opt_out_rate") return outcome === "opted_out";
  return outcome === "bounced" || outcome === "unknown_bounce";
}

function metricFailure(result: { ok: false; code: string }): LearningServiceError {
  const code = result.code === "SCOPE_MISMATCH" ? "LEARNING_SCOPE_MISMATCH"
    : result.code === "VERSION_CONFLICT" ? "LEARNING_VERSION_CONFLICT"
      : result.code === "STALE_VERSION" ? "LEARNING_VERSION_CONFLICT"
        : result.code === "INVALID_CHRONOLOGY" ? "LEARNING_INVALID_CHRONOLOGY"
          : result.code === "INVALID_TRANSITION" ? "LEARNING_INVALID_TRANSITION"
            : result.code === "HUMAN_REVIEW_REQUIRED" ? "LEARNING_HUMAN_REVIEW_REQUIRED"
              : result.code === "METRIC_MISMATCH" ? "LEARNING_METRIC_MISMATCH"
                : "LEARNING_INPUT_INVALID";
  return new LearningServiceError(
    code, `The learning proposal could not be processed (${result.code}).`);
}

/* ---------- propose ---------- */

export type LearningUncertaintyInput = Readonly<{
  uncertaintyId: string;
  statement: string;
  impact: string;
  severity: number;
}>;

export type LearningChangeInput = Readonly<{
  kind:
    | "qualification_threshold_basis_points" | "score_weight_basis_points"
    | "query_family_status" | "outreach_guidance_status";
  targetKey: string;
  currentValue: number | "enabled" | "disabled";
  proposedValue: number | "enabled" | "disabled";
  rationale: string;
}>;

export type ProposeLearningInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  /** Chain identity; a new revision supersedes the chain's approved head. */
  stableKey: string;
  /** Persisted outcome version ids forming the evidence cohort (1–100). */
  outcomeVersionIds: readonly string[];
  cohort: Readonly<{ cohortId: string; windowStart: string; windowEnd: string }>;
  metric: Readonly<{ metricKey: MetricKey; formulaVersion: string }>;
  change: LearningChangeInput;
  uncertainties: readonly LearningUncertaintyInput[];
  expectedImpact: Readonly<{
    direction: "increase" | "decrease";
    estimateBasisPoints: number;
    lowerBoundBasisPoints: number;
    upperBoundBasisPoints: number;
    horizonDays: number;
    rationale: string;
  }>;
  rollback: Readonly<{
    triggerMetricKey: MetricKey;
    triggerThresholdBasisPoints: number;
    reason: string;
  }>;
  /** Optimistic concurrency on the chain head. */
  expectedPredecessorVersionId?: string;
}>;

export type ProposedLearning = Readonly<{
  proposal: LearningProposal;
  created: boolean;
}>;

export async function proposeLearning(
  deps: LearningServiceDeps,
  rawInput: unknown,
): Promise<ProposedLearning> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const scope = parseScope(rawInput);
  const stableKey = safeRef(rawInput.stableKey, "stableKey");
  const createdAt = nowIso(deps.clock);

  const strategyScope = Object.freeze({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  });
  const play = await deps.strategy.getLeadPlayVersion(strategyScope, scope.playVersionId);
  if (!play) {
    throw new LearningServiceError("LEARNING_NOT_FOUND", "The lead play version is unavailable.");
  }

  const ids = rawInput.outcomeVersionIds;
  if (!Array.isArray(ids) || isProxy(ids) || ids.length < 1 || ids.length > MAX_OUTCOMES) {
    throw invalid("outcomeVersionIds must contain 1-100 entries");
  }
  const outcomeRecords: OutcomeRecord[] = [];
  for (const candidate of ids) {
    const versionId = typeof candidate === "string" && OUTCOME_VERSION.test(candidate)
      ? candidate : (() => { throw invalid("outcomeVersionIds entry is malformed"); })();
    const stored = await deps.outcomes.getVersion(
      scope.tenantId, scope.workspaceId, scope.accountId, versionId);
    if (!stored || stored.playVersionId !== scope.playVersionId) {
      throw new LearningServiceError(
        "LEARNING_OUTCOME_SCOPE",
        "An outcome version is unavailable or outside the proposal scope.");
    }
    outcomeRecords.push(stored.record);
  }

  if (!isPlainRecord(rawInput.cohort)) throw invalid("cohort is required");
  const cohortInput = rawInput.cohort;
  const cohortId = safeRef(cohortInput.cohortId, "cohort.cohortId");
  const windowStart = iso(cohortInput.windowStart, "cohort.windowStart");
  const windowEnd = iso(cohortInput.windowEnd, "cohort.windowEnd");
  const cohort = Object.freeze({
    cohortId,
    definitionHash: hashJson({
      cohortId, windowStart, windowEnd,
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      accountId: scope.accountId, playVersionId: scope.playVersionId,
      outcomeVersionIds: [...outcomeRecords.map((record) => record.versionId)].sort(),
    }),
    windowStart,
    windowEnd,
    denominator: outcomeRecords.length,
  });

  if (!isPlainRecord(rawInput.metric)) throw invalid("metric is required");
  const metricKey = typeof rawInput.metric.metricKey === "string"
    && METRICS.has(rawInput.metric.metricKey) ? rawInput.metric.metricKey as MetricKey
    : (() => { throw invalid("metric.metricKey is malformed"); })();
  const formulaVersion = safeRef(rawInput.metric.formulaVersion, "metric.formulaVersion");
  const numerator = outcomeRecords.filter((record) => metricMatch(metricKey, record.outcome)).length;
  const metric = Object.freeze({
    metricKey,
    formulaVersion,
    numerator,
    denominator: outcomeRecords.length,
    valueBasisPoints: Math.round((numerator * 10_000) / outcomeRecords.length),
  });

  if (!isPlainRecord(rawInput.change)) throw invalid("change is required");
  const change = rawInput.change;
  if (typeof change.kind !== "string" || !CHANGE_KINDS.has(change.kind)) {
    throw invalid("change.kind is malformed");
  }

  const uncertainties = rawInput.uncertainties;
  if (!Array.isArray(uncertainties) || isProxy(uncertainties)
    || uncertainties.length < 1 || uncertainties.length > MAX_UNCERTAINTIES) {
    throw invalid("uncertainties must contain 1-20 entries");
  }

  if (!isPlainRecord(rawInput.expectedImpact)) throw invalid("expectedImpact is required");
  const impact = rawInput.expectedImpact;
  const expectedImpact = Object.freeze({
    metricKey,
    direction: impact.direction === "increase" || impact.direction === "decrease"
      ? impact.direction : (() => { throw invalid("expectedImpact.direction is malformed"); })(),
    estimateBasisPoints: impact.estimateBasisPoints,
    lowerBoundBasisPoints: impact.lowerBoundBasisPoints,
    upperBoundBasisPoints: impact.upperBoundBasisPoints,
    horizonDays: impact.horizonDays,
    rationale: impact.rationale,
  });

  if (!isPlainRecord(rawInput.rollback)) throw invalid("rollback is required");
  const rollback = Object.freeze({
    restorePlayVersionId: scope.playVersionId,
    restorePolicyHash: play.contentHash,
    triggerMetricKey: typeof rawInput.rollback.triggerMetricKey === "string"
      && METRICS.has(rawInput.rollback.triggerMetricKey)
      ? rawInput.rollback.triggerMetricKey
      : (() => { throw invalid("rollback.triggerMetricKey is malformed"); })(),
    triggerThresholdBasisPoints: rawInput.rollback.triggerThresholdBasisPoints,
    reason: rawInput.rollback.reason,
  });

  const latest = await deps.learning.getLatestVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, scope.playVersionId, stableKey);
  if (rawInput.expectedPredecessorVersionId !== undefined
    && rawInput.expectedPredecessorVersionId !== (latest?.proposal.versionId ?? null)) {
    throw new LearningServiceError(
      "LEARNING_VERSION_CONFLICT", "The proposal chain head changed concurrently.");
  }
  const revision = latest ? latest.proposal.revision + 1 : 1;

  const result = buildLearningProposal({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    playVersionId: scope.playVersionId,
    stableKey,
    revision,
    predecessor: latest?.proposal ?? null,
    createdAt,
    outcomeRecords,
    cohort,
    metric,
    target: {
      kind: "play_policy",
      currentPlayVersionId: scope.playVersionId,
      currentPolicyHash: play.contentHash,
    },
    change,
    uncertainties,
    expectedImpact,
    rollback,
  });
  if (!result.ok) throw metricFailure(result);
  const persisted = await deps.learning.insertVersion(result.proposal);
  await deps.audit?.record({
    action: revision === 1 ? "learning.proposed" : "learning.proposal_revised",
    entityType: "learning_proposal_version",
    entityId: result.proposal.versionId,
    metadata: { stableKey, revision, metricKey },
  });
  return Object.freeze({ proposal: result.proposal, created: persisted === "created" });
}

/* ---------- review ---------- */

export type TransitionLearningInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  versionId: string;
  to: "in_review" | "approved" | "rejected";
  actorId: string;
  reason: string;
  expectedReviewHash?: string;
}>;

export async function transitionLearningReview(
  deps: LearningServiceDeps,
  rawInput: unknown,
): Promise<LearningProposal> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const scope = parseScope(rawInput);
  const versionId = typeof rawInput.versionId === "string" && PROPOSAL_VERSION.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  const to = typeof rawInput.to === "string" && REVIEW_TARGETS.has(rawInput.to)
    ? rawInput.to as "in_review" | "approved" | "rejected"
    : (() => { throw invalid("to is malformed"); })();
  const actorId = uuid(rawInput.actorId, "actorId");
  if (typeof rawInput.reason !== "string" || rawInput.reason.trim().length === 0) {
    throw invalid("reason is required");
  }
  const at = nowIso(deps.clock);

  const stored = await deps.learning.getVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, versionId);
  if (!stored || stored.playVersionId !== scope.playVersionId) {
    throw new LearningServiceError("LEARNING_NOT_FOUND", "The learning proposal is unavailable.");
  }
  const expectedReviewHash = typeof rawInput.expectedReviewHash === "string"
    && HASH.test(rawInput.expectedReviewHash)
    ? rawInput.expectedReviewHash
    : rawInput.expectedReviewHash === undefined ? stored.proposal.review.reviewHash
      : (() => { throw invalid("expectedReviewHash is malformed"); })();

  const result = transitionLearningProposalReview({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    playVersionId: scope.playVersionId,
    current: stored.proposal,
    expectedVersionId: stored.proposal.versionId,
    expectedContentHash: stored.proposal.contentHash,
    expectedReviewHash,
    to,
    actor: { kind: "human", actorId },
    at,
    reason: rawInput.reason,
  });
  if (!result.ok) throw metricFailure(result);
  await deps.learning.updateReview(stored.proposal.review.reviewHash, result.proposal);
  await deps.audit?.record({
    action: "learning.review_transitioned",
    entityType: "learning_proposal_version",
    entityId: result.proposal.versionId,
    metadata: { to, actorId },
  });
  return result.proposal;
}

/* ---------- query views ---------- */

export type LearningProposalView = Readonly<{
  versionId: string;
  stableKey: string;
  revision: number;
  supersedesVersionId: string | null;
  metricKey: string;
  reviewStatus: string;
  outcomeRefs: number;
  changeKind: string;
  createdAt: string;
}>;

function toView(stored: StoredLearningProposal): LearningProposalView {
  const proposal = stored.proposal;
  return Object.freeze({
    versionId: proposal.versionId,
    stableKey: proposal.stableKey,
    revision: proposal.revision,
    supersedesVersionId: proposal.supersedesVersionId,
    metricKey: proposal.metric.metricKey,
    reviewStatus: proposal.review.status,
    outcomeRefs: proposal.outcomeRefs.length,
    changeKind: proposal.change.kind,
    createdAt: proposal.createdAt,
  });
}

export async function getLearningProposalView(
  deps: LearningServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ view: LearningProposalView; proposal: LearningProposal }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const versionId = typeof rawInput.versionId === "string" && PROPOSAL_VERSION.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  const stored = await deps.learning.getVersion(
    uuid(rawInput.tenantId, "tenantId"), uuid(rawInput.workspaceId, "workspaceId"),
    uuid(rawInput.accountId, "accountId"), versionId);
  if (!stored) {
    throw new LearningServiceError("LEARNING_NOT_FOUND", "The learning proposal is unavailable.");
  }
  return Object.freeze({ view: toView(stored), proposal: stored.proposal });
}

export async function listLearningProposalViews(
  deps: LearningServiceDeps,
  rawInput: unknown,
): Promise<readonly LearningProposalView[]> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const playVersionId = rawInput.playVersionId === undefined ? undefined
    : typeof rawInput.playVersionId === "string" && PLAY_VERSION.test(rawInput.playVersionId)
      ? rawInput.playVersionId : (() => { throw invalid("playVersionId is malformed"); })();
  const stableKey = rawInput.stableKey === undefined ? undefined
    : safeRef(rawInput.stableKey, "stableKey");
  const rows = await deps.learning.listVersions(
    uuid(rawInput.tenantId, "tenantId"), uuid(rawInput.workspaceId, "workspaceId"),
    {
      accountId: rawInput.accountId === undefined ? undefined : uuid(rawInput.accountId, "accountId"),
      playVersionId,
      stableKey,
    });
  return Object.freeze(rows.map(toView));
}
