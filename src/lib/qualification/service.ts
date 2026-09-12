import { isProxy } from "node:util/types";

import {
  qualifyAccount,
  reviewAccountQualification,
  type AccountQualification,
  type AccountQualificationFailureCode,
} from "./account-qualification";
import type { QualificationRepository, QualificationRow } from "./repository";

export type QualificationServiceErrorCode =
  | "QUALIFICATION_INPUT_INVALID"
  | "QUALIFICATION_NOT_FOUND"
  | "QUALIFICATION_STALE"
  | `QUALIFICATION_${AccountQualificationFailureCode}`;

export class QualificationServiceError extends Error {
  readonly code: QualificationServiceErrorCode;

  constructor(code: QualificationServiceErrorCode, message: string) {
    super(message);
    this.name = "QualificationServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const QUALIFICATION_ID = /^account-qualification:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const DECISIONS = new Set(["qualified", "needs_review", "unqualified"]);

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

function invalid(message: string): QualificationServiceError {
  return new QualificationServiceError("QUALIFICATION_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

function engineFailure(code: string): QualificationServiceError {
  if (code === "STALE_VERSION") {
    return new QualificationServiceError(
      "QUALIFICATION_STALE", "The qualification changed concurrently; retry with the latest hash.");
  }
  return new QualificationServiceError(
    `QUALIFICATION_${code}` as QualificationServiceErrorCode,
    `The qualification operation was rejected (${code}).`);
}

export interface QualificationAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface ReviewEnqueuePort {
  enqueueQualificationReview(input: Readonly<{
    tenantId: string;
    workspaceId: string;
    versionId: string;
    qualificationHash: string;
    reason: string;
    uncertaintyIds: readonly string[];
    at: string;
  }>): Promise<void>;
}

export interface QualificationServiceDeps {
  readonly repository: QualificationRepository;
  readonly audit?: QualificationAuditSink;
  readonly reviewQueue?: ReviewEnqueuePort;
  readonly clock?: () => Date;
}

export type EvaluateQualificationInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  playContentHash: string;
  policy: Record<string, unknown>;
  observations: readonly unknown[];
  factors: readonly unknown[];
  contactContext?: unknown;
  evaluatedAt?: string;
}>;

/**
 * Evaluates a play-specific qualification snapshot. When the automated
 * decision is needs_review, the snapshot is also offered to the review queue.
 */
export async function evaluateQualification(
  deps: QualificationServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ qualification: AccountQualification; persisted: "created" | "replayed" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const playVersionId = typeof rawInput.playVersionId === "string" && PLAY_VERSION.test(rawInput.playVersionId)
    ? rawInput.playVersionId : (() => { throw invalid("playVersionId is malformed"); })();
  const playContentHash = typeof rawInput.playContentHash === "string" && HASH.test(rawInput.playContentHash)
    ? rawInput.playContentHash : (() => { throw invalid("playContentHash is malformed"); })();
  if (!Array.isArray(rawInput.observations)) throw invalid("observations must be an array");
  if (!Array.isArray(rawInput.factors)) throw invalid("factors must be an array");

  const evaluated = qualifyAccount({
    version: 1, tenantId, workspaceId, accountId, playVersionId, playContentHash,
    evaluatedAt: rawInput.evaluatedAt ?? nowIso(deps.clock),
    policy: rawInput.policy,
    observations: rawInput.observations,
    factors: rawInput.factors,
    contactContext: rawInput.contactContext ?? null,
  });
  if (!evaluated.ok) throw engineFailure(evaluated.code);
  const qualification = evaluated.qualification;
  const persisted = await deps.repository.insertQualification(qualification);
  await deps.audit?.record({
    action: "qualification.evaluated",
    entityType: "account_qualification",
    entityId: qualification.versionId,
    metadata: {
      decision: qualification.decision,
      weightedScore: qualification.weightedScore,
      automatedDecision: qualification.automatedDecision,
    },
  });
  if (qualification.decision === "needs_review" && deps.reviewQueue) {
    const uncertaintyIds = qualification.factors
      .filter((factor) => isPlainRecord(factor.uncertainty) && factor.uncertainty.level === "high")
      .map((factor) => factor.factorId);
    await deps.reviewQueue.enqueueQualificationReview({
      tenantId, workspaceId,
      versionId: qualification.versionId,
      qualificationHash: qualification.qualificationHash,
      reason: `Automated decision requires review (score ${qualification.weightedScore})`,
      uncertaintyIds: Object.freeze(uncertaintyIds),
      at: nowIso(deps.clock),
    });
  }
  return Object.freeze({ qualification, persisted });
}

export type ReviewQualificationInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  versionId: string;
  expectedQualificationHash: string;
  action: "confirm" | "override";
  decision?: "qualified" | "needs_review" | "unqualified";
  actorId: string;
  at?: string;
  reason: string;
}>;

/** Applies a human confirm/override to a qualification snapshot. */
export async function reviewQualification(
  deps: QualificationServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ qualification: AccountQualification }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const actorId = uuid(rawInput.actorId, "actorId");
  const versionId = typeof rawInput.versionId === "string" && QUALIFICATION_ID.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  const expectedHash = typeof rawInput.expectedQualificationHash === "string"
    && HASH.test(rawInput.expectedQualificationHash) ? rawInput.expectedQualificationHash
    : (() => { throw invalid("expectedQualificationHash is malformed"); })();
  const action = rawInput.action === "confirm" || rawInput.action === "override" ? rawInput.action
    : (() => { throw invalid("action must be confirm or override"); })();
  const decision = rawInput.decision === undefined ? undefined
    : typeof rawInput.decision === "string" && DECISIONS.has(rawInput.decision) ? rawInput.decision
      : (() => { throw invalid("decision is malformed"); })();

  const row = await deps.repository.getQualification(tenantId, workspaceId, accountId, versionId);
  if (!row) {
    throw new QualificationServiceError("QUALIFICATION_NOT_FOUND", "The qualification was not found.");
  }
  const reviewed = reviewAccountQualification({
    version: 1, tenantId, workspaceId, accountId,
    current: row.payload,
    expectedQualificationHash: expectedHash,
    action,
    decision: action === "confirm" ? row.decision : decision ?? null,
    actor: { kind: "human", actorId },
    at: rawInput.at ?? nowIso(deps.clock),
    reason: rawInput.reason,
  });
  if (!reviewed.ok) throw engineFailure(reviewed.code);
  try {
    await deps.repository.applyReview(row.qualificationSha256, reviewed.qualification);
  } catch {
    throw new QualificationServiceError(
      "QUALIFICATION_STALE", "The qualification changed concurrently.");
  }
  await deps.audit?.record({
    action: `qualification.review.${action}`,
    entityType: "account_qualification",
    entityId: versionId,
    metadata: {
      actorId,
      fromDecision: row.decision,
      toDecision: reviewed.qualification.decision,
      reviewStatus: reviewed.qualification.reviewStatus,
    },
  });
  return Object.freeze({ qualification: reviewed.qualification });
}

/* ---------- query projections ---------- */

export type QualificationView = Readonly<{
  versionId: string;
  accountId: string;
  playVersionId: string;
  weightedScore: number;
  automatedDecision: QualificationRow["automatedDecision"];
  decision: QualificationRow["decision"];
  reviewStatus: QualificationRow["reviewStatus"];
  factorCount: number;
  highUncertaintyFactors: readonly string[];
  observationCount: number;
  evaluatedAt: string;
  createdAt: string;
}>;

function toView(row: QualificationRow): QualificationView {
  const factors = Array.isArray(row.payload.factors) ? row.payload.factors : [];
  const observations = Array.isArray(row.payload.observations) ? row.payload.observations : [];
  return Object.freeze({
    versionId: row.versionId,
    accountId: row.accountId,
    playVersionId: row.playVersionId,
    weightedScore: row.weightedScore,
    automatedDecision: row.automatedDecision,
    decision: row.decision,
    reviewStatus: row.reviewStatus,
    factorCount: factors.length,
    highUncertaintyFactors: Object.freeze(factors.filter(isPlainRecord)
      .filter((factor) => isPlainRecord(factor.uncertainty) && factor.uncertainty.level === "high")
      .map((factor) => typeof factor.factorId === "string" ? factor.factorId : "unknown")),
    observationCount: observations.length,
    evaluatedAt: row.evaluatedAt,
    createdAt: row.createdAt,
  });
}

export async function listQualificationViews(
  repository: QualificationRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string; accountId?: string }>,
): Promise<readonly QualificationView[]> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const accountId = scope.accountId === undefined ? undefined : uuid(scope.accountId, "accountId");
  const rows = await repository.listQualifications(tenantId, workspaceId, accountId);
  return Object.freeze(rows.map(toView));
}

export async function getQualificationView(
  repository: QualificationRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string; accountId: string; versionId: string }>,
): Promise<QualificationView | null> {
  const row = await repository.getQualification(
    uuid(scope.tenantId, "tenantId"), uuid(scope.workspaceId, "workspaceId"),
    uuid(scope.accountId, "accountId"), scope.versionId);
  return row === null ? null : toView(row);
}
