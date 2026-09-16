import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  buildOutcomeAttributionReport,
  type OutcomeAttributionReport,
} from "@/lib/outcomes/outcome-attribution";
import {
  buildOutcomeRecord,
  type OutcomeAttributionEvidenceRef,
  type OutcomeRecord,
  type OutcomeTaxonomy,
} from "@/lib/outcomes/outcome-record";
import type {
  OutcomeRepository,
  StoredOutcomeVersion,
} from "@/lib/outcomes/repository";
import type { OutreachRepository } from "@/lib/outreach/repository";
import { buildSuppressionRecord } from "@/lib/suppressions/suppression-record";
import type { SuppressionRepository } from "@/lib/suppressions/repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const DRAFT_VERSION = /^outreach-draft-version:[0-9a-f]{64}$/u;
const OUTCOME_VERSION = /^outcome-version:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const TAXONOMY = new Set<OutcomeTaxonomy>([
  "copied", "exported", "sent_manually", "delivery_unknown", "bounced", "unknown_bounce",
  "opted_out", "complaint", "replied", "meeting_set", "opportunity", "won", "lost",
  "not_interested", "disqualified", "unknown",
]);
const CHANNELS = new Set(["email", "phone", "sms", "social", "in_person", "other", "none"]);
const BOUNCE_CLASSES = new Set(["hard_bounce", "soft_bounce", "unknown_bounce"]);
const ATTRIBUTION_KINDS = new Set(["direct", "assisted", "unknown"]);
const ATTRIBUTION_REF_KINDS = new Set(["play_version", "outreach_draft_version", "source_receipt"]);

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

export type OutcomeServiceErrorCode =
  | "OUTCOME_INPUT_INVALID"
  | "OUTCOME_NOT_FOUND"
  | "OUTCOME_SCOPE_MISMATCH"
  | "OUTCOME_VERSION_CONFLICT"
  | "OUTCOME_INVALID_CHRONOLOGY"
  | "OUTCOME_HUMAN_CORRECTION_REQUIRED"
  | "OUTCOME_DRAFT_UNLINKABLE"
  | "OUTCOME_SUPPRESSION_NOT_APPLICABLE"
  | "OUTCOME_REPORT_INVALID"
  | "OUTCOME_INTEGRITY_VIOLATION";

export class OutcomeServiceError extends Error {
  readonly code: OutcomeServiceErrorCode;

  constructor(code: OutcomeServiceErrorCode, message: string) {
    super(message);
    this.name = "OutcomeServiceError";
    this.code = code;
  }
}

function invalid(message: string): OutcomeServiceError {
  return new OutcomeServiceError("OUTCOME_INPUT_INVALID", message);
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export interface OutcomeAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface OutcomeServiceDeps {
  readonly outcomes: OutcomeRepository;
  /** Required only when a draft link or draft attribution ref is supplied. */
  readonly outreach?: Pick<OutreachRepository, "getDraftVersion">;
  /** Required only when suppression derivation is requested. */
  readonly suppressions?: SuppressionRepository;
  readonly audit?: OutcomeAuditSink;
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
  const observed = clock?.() ?? new Date();
  return observed.toISOString();
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

/* ---------- record / correct ---------- */

export type OutcomeSourceInput = Readonly<{
  kind: "member_observation" | "approved_import";
  sourceId: string;
  sourceVersionId: string;
  sourceContentHash: string;
  sourceReceiptHash: string;
  observedAt: string;
}>;

export type OutcomeAttributionInput = Readonly<{
  kind: "direct" | "assisted" | "unknown";
  confidenceBasisPoints: number;
  rationale: string;
  evidenceRefs?: readonly OutcomeAttributionEvidenceRef[];
}>;

export type RecordOutcomeInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  /** Chain identity; a new revision supersedes the chain's latest version. */
  stableKey: string;
  outcome: OutcomeTaxonomy;
  channel: "email" | "phone" | "sms" | "social" | "in_person" | "other" | "none";
  bounceClassification?: "hard_bounce" | "soft_bounce" | "unknown_bounce" | null;
  occurredAt: string;
  notes: string;
  source: OutcomeSourceInput;
  recordedBy: string;
  /** Approved outreach draft the outcome is attributed to, when known. */
  outreachDraftVersionId?: string;
  attribution?: OutcomeAttributionInput;
  /** Required when a chain already exists for stableKey. */
  correctionReason?: string;
  /** Optimistic concurrency on the chain head. */
  expectedPredecessorVersionId?: string;
  /**
   * Explicit, human-requested derivation of a protective suppression record
   * from this outcome. Never implicit: omit to record the outcome alone.
   * Protective records are append-only and dominate eligibility.
   */
  suppress?: Readonly<{ contactStableKey?: string; reason?: string }>;
}>;

export type RecordedOutcome = Readonly<{
  record: OutcomeRecord;
  created: boolean;
  corrected: boolean;
  suppressionRecordId: string | null;
}>;

const PROTECTIVE_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  opted_out: "opt_out",
  complaint: "complaint",
  hard_bounce: "hard_bounce",
  soft_bounce: "soft_bounce",
});

function outcomeDisposition(record: OutcomeRecord): string | null {
  if (record.outcome === "bounced" && record.bounceClassification !== null) {
    return PROTECTIVE_OUTCOMES[record.bounceClassification] ?? null;
  }
  return PROTECTIVE_OUTCOMES[record.outcome] ?? null;
}

async function buildDraftRef(
  deps: OutcomeServiceDeps,
  scope: Scope,
  draftVersionId: string,
): Promise<unknown> {
  if (!deps.outreach) {
    throw new OutcomeServiceError(
      "OUTCOME_DRAFT_UNLINKABLE", "No outreach repository is bound for draft linking.");
  }
  const stored = await deps.outreach.getDraftVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, draftVersionId);
  if (!stored || stored.playVersionId !== scope.playVersionId) {
    throw new OutcomeServiceError(
      "OUTCOME_DRAFT_UNLINKABLE",
      "The outreach draft is unavailable or belongs to a different play.");
  }
  const payload = {
    draftRefVersion: 1 as const,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    playVersionId: scope.playVersionId,
    versionId: stored.draft.versionId,
    contentHash: stored.draft.contentHash,
    reviewHash: stored.draft.review.reviewHash,
  };
  return Object.freeze({ ...payload, draftRefHash: hashJson(payload) });
}

export async function recordOutcome(
  deps: OutcomeServiceDeps,
  rawInput: unknown,
): Promise<RecordedOutcome> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const scope = parseScope(rawInput);
  const stableKey = safeRef(rawInput.stableKey, "stableKey");
  const outcome = typeof rawInput.outcome === "string" && TAXONOMY.has(rawInput.outcome as OutcomeTaxonomy)
    ? rawInput.outcome as OutcomeTaxonomy
    : (() => { throw invalid("outcome is not in the launch taxonomy"); })();
  const channel = typeof rawInput.channel === "string" && CHANNELS.has(rawInput.channel)
    ? rawInput.channel as RecordOutcomeInput["channel"]
    : (() => { throw invalid("channel is malformed"); })();
  const bounceClassification = rawInput.bounceClassification === undefined
    || rawInput.bounceClassification === null ? null
    : typeof rawInput.bounceClassification === "string"
      && BOUNCE_CLASSES.has(rawInput.bounceClassification)
      ? rawInput.bounceClassification as OutcomeRecord["bounceClassification"]
      : (() => { throw invalid("bounceClassification is malformed"); })();
  const occurredAt = iso(rawInput.occurredAt, "occurredAt");
  const recordedAt = nowIso(deps.clock);
  if (typeof rawInput.notes !== "string" || rawInput.notes.trim().length === 0) {
    throw invalid("notes are required");
  }
  const recordedBy = uuid(rawInput.recordedBy, "recordedBy");
  if (occurredAt > recordedAt) throw invalid("occurredAt cannot be in the future");

  if (!isPlainRecord(rawInput.source)) throw invalid("source is required");
  const sourceInput = rawInput.source;
  const kind = sourceInput.kind === "member_observation" || sourceInput.kind === "approved_import"
    ? sourceInput.kind : (() => { throw invalid("source.kind is malformed"); })();
  const sourcePayload = {
    sourceVersion: 1 as const,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    kind,
    sourceId: safeRef(sourceInput.sourceId, "source.sourceId"),
    sourceVersionId: safeRef(sourceInput.sourceVersionId, "source.sourceVersionId"),
    sourceContentHash: typeof sourceInput.sourceContentHash === "string"
      && HASH.test(sourceInput.sourceContentHash) ? sourceInput.sourceContentHash
      : (() => { throw invalid("source.sourceContentHash is malformed"); })(),
    sourceReceiptHash: typeof sourceInput.sourceReceiptHash === "string"
      && HASH.test(sourceInput.sourceReceiptHash) ? sourceInput.sourceReceiptHash
      : (() => { throw invalid("source.sourceReceiptHash is malformed"); })(),
    observedAt: iso(sourceInput.observedAt, "source.observedAt"),
  };
  const source = Object.freeze({ ...sourcePayload, sourceHash: hashJson(sourcePayload) });

  const draftRef = rawInput.outreachDraftVersionId === undefined
    || rawInput.outreachDraftVersionId === null ? null
    : typeof rawInput.outreachDraftVersionId === "string"
      && DRAFT_VERSION.test(rawInput.outreachDraftVersionId)
      ? await buildDraftRef(deps, scope, rawInput.outreachDraftVersionId)
      : (() => { throw invalid("outreachDraftVersionId is malformed"); })();

  const attributionInput = rawInput.attribution;
  const attribution = attributionInput === undefined || attributionInput === null
    ? Object.freeze({
      kind: "unknown" as const,
      confidenceBasisPoints: 0,
      rationale: "No attribution evidence declared.",
      attributedAt: recordedAt,
      evidenceRefs: Object.freeze([]),
    })
    : (() => {
      if (!isPlainRecord(attributionInput)) throw invalid("attribution is malformed");
      const attributionKind = typeof attributionInput.kind === "string"
        && ATTRIBUTION_KINDS.has(attributionInput.kind) ? attributionInput.kind
        : (() => { throw invalid("attribution.kind is malformed"); })();
      const confidence = attributionInput.confidenceBasisPoints;
      if (!Number.isSafeInteger(confidence) || (confidence as number) < 0
        || (confidence as number) > 10_000) {
        throw invalid("attribution.confidenceBasisPoints is malformed");
      }
      if (typeof attributionInput.rationale !== "string"
        || attributionInput.rationale.trim().length === 0) {
        throw invalid("attribution.rationale is required");
      }
      const refs = attributionInput.evidenceRefs;
      const evidenceRefs = refs === undefined ? [] : !Array.isArray(refs) || refs.length > 20
        ? (() => { throw invalid("attribution.evidenceRefs is malformed"); })()
        : refs.map((ref) => {
          if (!isPlainRecord(ref) || typeof ref.kind !== "string"
            || !ATTRIBUTION_REF_KINDS.has(ref.kind) || typeof ref.refId !== "string"
            || !SAFE_REF.test(ref.refId) || typeof ref.refHash !== "string"
            || !HASH.test(ref.refHash)) {
            throw invalid("attribution.evidenceRefs entry is malformed");
          }
          return Object.freeze({
            kind: ref.kind as OutcomeAttributionEvidenceRef["kind"],
            refId: ref.refId,
            refHash: ref.refHash,
          });
        });
      return Object.freeze({
        kind: attributionKind as "direct" | "assisted" | "unknown",
        confidenceBasisPoints: confidence as number,
        rationale: attributionInput.rationale,
        attributedAt: recordedAt,
        evidenceRefs: Object.freeze(evidenceRefs),
      });
    })();

  const latest = await deps.outcomes.getLatestVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, scope.playVersionId, stableKey);
  if (rawInput.expectedPredecessorVersionId !== undefined
    && rawInput.expectedPredecessorVersionId !== (latest?.record.versionId ?? null)) {
    throw new OutcomeServiceError(
      "OUTCOME_VERSION_CONFLICT", "The outcome chain head changed concurrently.");
  }
  const revision = latest ? latest.record.revision + 1 : 1;
  const correction = latest === null ? null : (() => {
    if (typeof rawInput.correctionReason !== "string" || rawInput.correctionReason.trim().length === 0) {
      throw new OutcomeServiceError(
        "OUTCOME_HUMAN_CORRECTION_REQUIRED",
        "A correction reason is required when revising an outcome chain.");
    }
    return Object.freeze({
      kind: "human" as const,
      actorId: recordedBy,
      at: recordedAt,
      reason: rawInput.correctionReason,
    });
  })();

  const result = buildOutcomeRecord({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    playVersionId: scope.playVersionId,
    stableKey,
    revision,
    predecessor: latest?.record ?? null,
    outcome,
    channel,
    bounceClassification,
    occurredAt,
    recordedAt,
    notes: rawInput.notes,
    source,
    recordedBy: { kind: "human", actorId: recordedBy },
    outreachDraftVersionRef: draftRef,
    attribution,
    correction,
  });
  if (!result.ok) {
    const code = result.code === "SCOPE_MISMATCH" ? "OUTCOME_SCOPE_MISMATCH"
      : result.code === "VERSION_CONFLICT" ? "OUTCOME_VERSION_CONFLICT"
        : result.code === "INVALID_CHRONOLOGY" ? "OUTCOME_INVALID_CHRONOLOGY"
          : result.code === "HUMAN_CORRECTION_REQUIRED" ? "OUTCOME_HUMAN_CORRECTION_REQUIRED"
            : "OUTCOME_INPUT_INVALID";
    throw new OutcomeServiceError(code, `The outcome could not be recorded (${result.code}).`);
  }
  const record = result.record;
  const persisted = await deps.outcomes.insertVersion(record);

  let suppressionRecordId: string | null = null;
  if (rawInput.suppress !== undefined && rawInput.suppress !== null) {
    if (!isPlainRecord(rawInput.suppress)) throw invalid("suppress is malformed");
    if (!deps.suppressions) {
      throw new OutcomeServiceError(
        "OUTCOME_SUPPRESSION_NOT_APPLICABLE",
        "No suppression repository is bound for derivation.");
    }
    const disposition = outcomeDisposition(record);
    if (disposition === null) {
      throw new OutcomeServiceError(
        "OUTCOME_SUPPRESSION_NOT_APPLICABLE",
        `Outcome ${record.outcome} does not map to a protective disposition.`);
    }
    const contactStableKey = rawInput.suppress.contactStableKey === undefined
      ? null : safeRef(rawInput.suppress.contactStableKey, "suppress.contactStableKey");
    const suppression = buildSuppressionRecord({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      accountId: scope.accountId,
      contactStableKey,
      disposition,
      reason: typeof rawInput.suppress.reason === "string"
        && rawInput.suppress.reason.trim().length > 0
        ? rawInput.suppress.reason : `Derived from outcome ${record.versionId}.`,
      source: { kind: "outcome_derived", outcomeVersionId: record.versionId },
      actor: { kind: "human", actorId: recordedBy },
      occurredAt: record.occurredAt,
      recordedAt,
    });
    if (!suppression.ok) {
      throw new OutcomeServiceError(
        "OUTCOME_INTEGRITY_VIOLATION",
        `The derived suppression could not be built (${suppression.code}).`);
    }
    await deps.suppressions.insertRecord(suppression.record);
    suppressionRecordId = suppression.record.recordId;
  }

  await deps.audit?.record({
    action: revision === 1 ? "outcome.recorded" : "outcome.corrected",
    entityType: "outcome_record_version",
    entityId: record.versionId,
    metadata: {
      stableKey,
      revision,
      outcome: record.outcome,
      suppressionRecordId,
    },
  });
  return Object.freeze({
    record,
    created: persisted === "created",
    corrected: revision > 1,
    suppressionRecordId,
  });
}

/* ---------- query views ---------- */

export type OutcomeVersionView = Readonly<{
  versionId: string;
  stableKey: string;
  revision: number;
  supersedesVersionId: string | null;
  outcome: OutcomeTaxonomy;
  channel: string;
  bounceClassification: string | null;
  occurredAt: string;
  recordedAt: string;
  recordedBy: string;
  draftVersionId: string | null;
  attributionKind: string;
  auditEvents: number;
}>;

function toView(stored: StoredOutcomeVersion): OutcomeVersionView {
  const record = stored.record;
  return Object.freeze({
    versionId: record.versionId,
    stableKey: record.stableKey,
    revision: record.revision,
    supersedesVersionId: record.supersedesVersionId,
    outcome: record.outcome,
    channel: record.channel,
    bounceClassification: record.bounceClassification,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
    recordedBy: record.recordedBy.actorId,
    draftVersionId: record.outreachDraftVersionRef?.versionId ?? null,
    attributionKind: record.attribution.kind,
    auditEvents: record.audit.length,
  });
}

export async function getOutcomeVersionView(
  deps: OutcomeServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ view: OutcomeVersionView; record: OutcomeRecord }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const versionId = typeof rawInput.versionId === "string" && OUTCOME_VERSION.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  const stored = await deps.outcomes.getVersion(
    uuid(rawInput.tenantId, "tenantId"), uuid(rawInput.workspaceId, "workspaceId"),
    uuid(rawInput.accountId, "accountId"), versionId);
  if (!stored) throw new OutcomeServiceError("OUTCOME_NOT_FOUND", "The outcome version is unavailable.");
  return Object.freeze({ view: toView(stored), record: stored.record });
}

export async function listOutcomeVersionViews(
  deps: OutcomeServiceDeps,
  rawInput: unknown,
): Promise<readonly OutcomeVersionView[]> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const playVersionId = rawInput.playVersionId === undefined ? undefined
    : typeof rawInput.playVersionId === "string" && PLAY_VERSION.test(rawInput.playVersionId)
      ? rawInput.playVersionId : (() => { throw invalid("playVersionId is malformed"); })();
  const stableKey = rawInput.stableKey === undefined ? undefined
    : safeRef(rawInput.stableKey, "stableKey");
  const rows = await deps.outcomes.listVersions(
    uuid(rawInput.tenantId, "tenantId"), uuid(rawInput.workspaceId, "workspaceId"),
    {
      accountId: rawInput.accountId === undefined ? undefined : uuid(rawInput.accountId, "accountId"),
      playVersionId,
      stableKey,
    });
  return Object.freeze(rows.map(toView));
}

/* ---------- attribution report (derived, never persisted) ---------- */

export type AttributionReportInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  reportKey: string;
  accountId?: string;
  playVersionId?: string;
  from: string;
  to: string;
  asOf?: string;
}>;

export async function buildAttributionReportView(
  deps: OutcomeServiceDeps,
  rawInput: unknown,
): Promise<OutcomeAttributionReport> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const reportKey = safeRef(rawInput.reportKey, "reportKey");
  const from = iso(rawInput.from, "from");
  const to = iso(rawInput.to, "to");
  const asOf = rawInput.asOf === undefined ? nowIso(deps.clock) : iso(rawInput.asOf, "asOf");
  const rows = await deps.outcomes.listVersions(tenantId, workspaceId, {
    accountId: rawInput.accountId === undefined ? undefined : uuid(rawInput.accountId, "accountId"),
    playVersionId: rawInput.playVersionId === undefined ? undefined
      : typeof rawInput.playVersionId === "string" && PLAY_VERSION.test(rawInput.playVersionId)
        ? rawInput.playVersionId : (() => { throw invalid("playVersionId is malformed"); })(),
    limit: 10_000,
  });
  const result = buildOutcomeAttributionReport({
    version: 1,
    tenantId,
    workspaceId,
    reportKey,
    window: { from, to, asOf },
    outcomes: rows.map((row) => row.record),
  });
  if (!result.ok) {
    throw new OutcomeServiceError(
      "OUTCOME_REPORT_INVALID", `The attribution report could not be built (${result.code}).`);
  }
  return result.report;
}
