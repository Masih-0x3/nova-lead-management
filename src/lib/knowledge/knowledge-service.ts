import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import { DocumentIntakeError } from "@/lib/documents/errors";
import {
  DOCUMENT_LIFECYCLE_STATES,
  type DocumentLifecycleState,
} from "@/lib/documents/state-machine";
import type { LaunchDocumentFormat } from "@/lib/documents/validation";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const EVIDENCE_ID = /^evidence:[0-9a-f]{64}$/u;
const CITATION_ID = /^citation:[0-9a-f]{64}$/u;
const CLAIM_ID = /^claim:[0-9a-f]{64}$/u;
const CLAIM_VERSION_ID = /^claim-version:[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const REASON_CODE = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const SAFE_TOKEN = /^[a-z][a-z0-9_]{0,31}$/u;
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/u;

const LAUNCH_FORMATS: ReadonlySet<unknown> = new Set([
  "pdf", "docx", "xlsx", "csv", "txt", "markdown", "jpeg", "png",
]);
const SOURCE_KINDS: ReadonlySet<unknown> = new Set(["tenant_upload", "authorized_url"]);
const LIFECYCLE_STATES: ReadonlySet<unknown> = new Set(DOCUMENT_LIFECYCLE_STATES);
const CLAIM_CLASSES: ReadonlySet<unknown> = new Set([
  "identity", "product_technical_specification", "compatibility_application",
  "regulatory_compliance", "safety", "performance", "pricing_commercial",
  "capacity_supply", "geography", "contact_role", "personalization",
  "negative_absence", "customer_provided_strategic_fact",
]);
const POLARITIES: ReadonlySet<unknown> = new Set(["positive", "negative", "conditional", "unknown"]);
const REVIEW_STATES: ReadonlySet<unknown> = new Set(["proposed", "accepted", "rejected"]);
const RESOLVABLE_VERSION_STATES: ReadonlySet<unknown> = new Set([
  "clean", "extracting", "ready", "extraction_failed",
]);

type PlainRecord = Record<string, unknown>;

function snapshotRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): PlainRecord | null {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    if (required.some((key) => !Object.hasOwn(descriptors, key))) return null;
    const result: PlainRecord = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function boundaryError(message = "The knowledge query boundary returned an unsafe response."): DocumentIntakeError {
  return new DocumentIntakeError("intake_boundary_error", message);
}

function persistenceError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The knowledge state could not be persisted safely.",
  );
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) throw boundaryError();
  return value.toLowerCase();
}

function freezeResult<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freezeResult(child as object);
  }
  return Object.freeze(value);
}

function decisionId(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return `decision:${hash.digest("hex")}`;
}

export type TenantKnowledgeScope = Readonly<{
  tenantId: string;
  workspaceId: string;
}>;

export type KnowledgeDocumentSummary = Readonly<{
  documentId: string;
  versionId: string;
  sourceKind: "tenant_upload" | "authorized_url";
  originalName: string;
  format: LaunchDocumentFormat;
  mediaType: string;
  declaredByteSize: number;
  checksum: string;
  scannerPolicyVersion: string;
  state: DocumentLifecycleState;
  scanState: string | null;
  extractionState: string | null;
  extractionJobId: string | null;
  evidenceCount: number;
  claimCount: number;
  createdAt: string;
  updatedAt: string;
}>;

export type KnowledgeEvidenceView = Readonly<{
  evidenceId: string;
  documentId: string;
  versionId: string;
  blockOrdinal: number;
  sourceLocator: Readonly<Record<string, unknown>>;
  quote: string;
  quoteHash: string;
  citationId: string | null;
}>;

export type KnowledgeClaimView = Readonly<{
  claimId: string;
  claimVersionId: string;
  claimClass: string;
  subject: string;
  predicate: string;
  value: string;
  unit: string | null;
  polarity: string;
  material: boolean;
  reviewState: "proposed" | "accepted" | "rejected";
  reviewReason: string | null;
  evidenceIds: readonly string[];
}>;

export type DocumentKnowledgeProjection = Readonly<{
  documentId: string;
  versionId: string;
  evidence: readonly KnowledgeEvidenceView[];
  claims: readonly KnowledgeClaimView[];
}>;

export type ResolvedKnowledgeCitation = Readonly<{
  citationId: string;
  evidenceId: string;
  documentId: string;
  versionId: string;
  quote: string;
  quoteHash: string;
  sourceLocator: Readonly<Record<string, unknown>>;
  versionState: DocumentLifecycleState;
}>;

export type KnowledgeClaimReviewAction = "approve" | "edit" | "reject";

export type KnowledgeClaimReviewOutcome = Readonly<{
  value?: string;
  unit?: string | null;
  uncertainty?: string | null;
  confidenceBasisPoints?: number;
}>;

export type KnowledgeClaimReviewInput = TenantKnowledgeScope & Readonly<{
  claimId: string;
  claimVersionId: string;
  action: KnowledgeClaimReviewAction;
  reasonCode: string;
  idempotencyKey: string;
  outcome?: KnowledgeClaimReviewOutcome;
}>;

export type KnowledgeClaimReviewRequest = TenantKnowledgeScope & Readonly<{
  claimId: string;
  claimVersionId: string;
  decisionId: string;
  action: KnowledgeClaimReviewAction;
  reasonCode: string;
  outcome: KnowledgeClaimReviewOutcome | null;
}>;

export type KnowledgeClaimReviewResult = Readonly<
  | {
      kind: "applied";
      claimId: string;
      claimVersionId: string;
      outcomeClaimVersionId: string;
      reviewState: "accepted" | "rejected";
    }
  | { kind: "unavailable"; claimId: string }
>;

export interface KnowledgeQueryRepository {
  listKnowledgeDocuments(scope: TenantKnowledgeScope): Promise<readonly Record<string, unknown>[]>;
  getDocumentKnowledge(scope: TenantKnowledgeScope & Readonly<{
    documentId: string;
    versionId: string;
  }>): Promise<readonly Record<string, unknown>[]>;
  resolveCitation(scope: TenantKnowledgeScope & Readonly<{
    citationId: string;
  }>): Promise<Record<string, unknown> | undefined>;
  reviewClaim(request: KnowledgeClaimReviewRequest): Promise<Record<string, unknown> | undefined>;
}

function scope(value: unknown): TenantKnowledgeScope {
  const record = snapshotRecord(value, ["tenantId", "workspaceId"]);
  if (!record) throw boundaryError("The knowledge scope is invalid.");
  return {
    tenantId: canonicalUuid(record.tenantId),
    workspaceId: canonicalUuid(record.workspaceId),
  };
}

function locator(value: unknown): Readonly<Record<string, unknown>> {
  const record = snapshotRecord(value, ["kind", "label"], ["startLine", "endLine", "row"]);
  if (!record || (record.kind !== "line_range" && record.kind !== "row")
    || typeof record.label !== "string" || record.label.length > 128) {
    throw persistenceError();
  }
  return Object.freeze({ ...record });
}

function timestamp(value: unknown): string {
  const candidate = value instanceof Date ? value.toISOString()
    : typeof value === "string" ? value : null;
  if (!candidate || !Number.isFinite(Date.parse(candidate))) throw persistenceError();
  return new Date(candidate).toISOString();
}

function boundedInt(value: unknown): number {
  const normalized = typeof value === "string" && /^-?[0-9]{1,15}$/u.test(value)
    ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized)) throw persistenceError();
  return normalized;
}

function nullableToken(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) throw persistenceError();
  return value;
}

function summary(row: unknown): KnowledgeDocumentSummary {
  const record = snapshotRecord(row, [
    "document_id", "version_id", "source_kind", "original_name", "format", "media_type",
    "declared_byte_size", "checksum", "scanner_policy_version", "state", "scan_state",
    "extraction_state", "extraction_job_id", "evidence_count", "claim_count",
    "created_at", "updated_at",
  ]);
  if (!record || !SOURCE_KINDS.has(record.source_kind) || !LAUNCH_FORMATS.has(record.format)
    || !LIFECYCLE_STATES.has(record.state)) {
    throw persistenceError();
  }
  if (typeof record.original_name !== "string" || record.original_name.length < 1
    || record.original_name.length > 1024 || !NO_CONTROL.test(record.original_name)
    || typeof record.media_type !== "string" || record.media_type.length < 3
    || record.media_type.length > 255
    || boundedInt(record.declared_byte_size) <= 0
    || typeof record.checksum !== "string" || !SHA256.test(record.checksum)
    || typeof record.scanner_policy_version !== "string" || !POLICY_VERSION.test(record.scanner_policy_version)
    || boundedInt(record.evidence_count) < 0 || boundedInt(record.claim_count) < 0) {
    throw persistenceError();
  }
  return {
    documentId: canonicalUuid(record.document_id),
    versionId: canonicalUuid(record.version_id),
    sourceKind: record.source_kind as KnowledgeDocumentSummary["sourceKind"],
    originalName: record.original_name,
    format: record.format as LaunchDocumentFormat,
    mediaType: record.media_type,
    declaredByteSize: boundedInt(record.declared_byte_size),
    checksum: record.checksum,
    scannerPolicyVersion: record.scanner_policy_version,
    state: record.state as DocumentLifecycleState,
    scanState: nullableToken(record.scan_state),
    extractionState: nullableToken(record.extraction_state),
    extractionJobId: record.extraction_job_id === null ? null : canonicalUuid(record.extraction_job_id),
    evidenceCount: boundedInt(record.evidence_count),
    claimCount: boundedInt(record.claim_count),
    createdAt: timestamp(record.created_at),
    updatedAt: timestamp(record.updated_at),
  };
}

/**
 * Tenant-scoped document list for the knowledge surface. The repository is
 * authoritative for parsing; the service re-validates the domain contract so a
 * persistence-boundary surprise can never reach the UI seam.
 */
export async function listKnowledgeDocuments(
  rawScope: TenantKnowledgeScope,
  dependencies: Readonly<{
    repository: Pick<KnowledgeQueryRepository, "listKnowledgeDocuments">;
  }>,
): Promise<readonly KnowledgeDocumentSummary[]> {
  const input = scope(rawScope);
  let rows: unknown;
  try {
    rows = await dependencies.repository.listKnowledgeDocuments(freezeResult({ ...input }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
  if (!Array.isArray(rows) || isProxy(rows) || rows.length > 500) throw persistenceError();
  const documents = rows.map((row) => summary(row));
  return Object.freeze(documents);
}

const KNOWLEDGE_ROW_FIELDS = [
  "evidence_id", "document_id", "version_id", "block_ordinal", "source_locator",
  "quote", "quote_hash", "citation_id", "claim_id", "claim_version_id", "claim_class",
  "subject", "predicate", "value", "unit", "polarity", "material", "review_state",
  "review_reason",
] as const;

function knowledgeText(value: unknown, maxLength: number, nullable: true): string | null;
function knowledgeText(value: unknown, maxLength: number, nullable?: false): string;
function knowledgeText(value: unknown, maxLength: number, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw persistenceError();
  }
  return value;
}

/**
 * Tenant-scoped evidence/citation/claim projection for one document version.
 * Raw rows are folded into render-safe evidence entries and deduplicated claim
 * versions; inconsistent joins are persistence failures, never silent merges.
 */
export async function getDocumentKnowledge(
  rawScope: TenantKnowledgeScope & Readonly<{ documentId: string; versionId: string }>,
  dependencies: Readonly<{
    repository: Pick<KnowledgeQueryRepository, "getDocumentKnowledge">;
  }>,
): Promise<DocumentKnowledgeProjection> {
  const base = scope(rawScope);
  const input = snapshotRecord(rawScope, ["tenantId", "workspaceId", "documentId", "versionId"]);
  if (!input) throw boundaryError("The knowledge scope is invalid.");
  const documentId = canonicalUuid(input.documentId);
  const versionId = canonicalUuid(input.versionId);

  let rows: unknown;
  try {
    rows = await dependencies.repository.getDocumentKnowledge(freezeResult({
      ...base, documentId, versionId,
    }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
  if (!Array.isArray(rows) || isProxy(rows) || rows.length > 2000) throw persistenceError();

  const evidence = new Map<string, KnowledgeEvidenceView>();
  const claims = new Map<string, {
    claimId: string;
    claimVersionId: string;
    claimClass: string;
    subject: string;
    predicate: string;
    value: string;
    unit: string | null;
    polarity: string;
    material: boolean;
    reviewState: "proposed" | "accepted" | "rejected";
    reviewReason: string | null;
    evidenceIds: Set<string>;
  }>();
  const orderedEvidence: KnowledgeEvidenceView[] = [];
  const orderedClaims: string[] = [];

  for (const raw of rows) {
    const row = snapshotRecord(raw, KNOWLEDGE_ROW_FIELDS);
    if (!row) throw persistenceError();
    const evidenceId = knowledgeText(row.evidence_id, 90);
    if (!EVIDENCE_ID.test(evidenceId)) throw persistenceError();
    if (row.document_id !== documentId || row.version_id !== versionId) throw persistenceError();
    if (!Number.isSafeInteger(row.block_ordinal) || (row.block_ordinal as number) < 0) {
      throw persistenceError();
    }
    const quote = knowledgeText(row.quote, 8192);
    const quoteHash = knowledgeText(row.quote_hash, 80);
    if (!quoteHash.startsWith("sha256:") || !SHA256.test(quoteHash.slice(7))) {
      throw persistenceError();
    }
    const citationId = row.citation_id === null ? null : knowledgeText(row.citation_id, 92);
    if (citationId !== null && !CITATION_ID.test(citationId)) throw persistenceError();
    const sourceLocator = locator(row.source_locator);

    const existing = evidence.get(evidenceId);
    if (existing) {
      if (existing.blockOrdinal !== row.block_ordinal || existing.quote !== quote
        || existing.quoteHash !== quoteHash || existing.citationId !== citationId) {
        throw persistenceError();
      }
    } else {
      const entry: KnowledgeEvidenceView = Object.freeze({
        evidenceId,
        documentId,
        versionId,
        blockOrdinal: row.block_ordinal as number,
        sourceLocator,
        quote,
        quoteHash,
        citationId,
      });
      evidence.set(evidenceId, entry);
      orderedEvidence.push(entry);
    }

    const claimVersionId = row.claim_version_id;
    if (claimVersionId === null) {
      if (row.claim_id !== null || row.claim_class !== null || row.subject !== null
        || row.predicate !== null || row.value !== null || row.unit !== null
        || row.polarity !== null || row.material !== null || row.review_state !== null
        || row.review_reason !== null) {
        throw persistenceError();
      }
      continue;
    }
    const claimId = knowledgeText(row.claim_id, 90);
    const versionKey = knowledgeText(claimVersionId, 98);
    if (!CLAIM_ID.test(claimId) || !CLAIM_VERSION_ID.test(versionKey)
      || !CLAIM_CLASSES.has(row.claim_class) || !POLARITIES.has(row.polarity)
      || !REVIEW_STATES.has(row.review_state) || typeof row.material !== "boolean") {
      throw persistenceError();
    }
    const claim = {
      claimId,
      claimVersionId: versionKey,
      claimClass: row.claim_class as string,
      subject: knowledgeText(row.subject, 512),
      predicate: knowledgeText(row.predicate, 128),
      value: knowledgeText(row.value, 2048),
      unit: knowledgeText(row.unit, 64, true),
      polarity: row.polarity as string,
      material: row.material,
      reviewState: row.review_state as "proposed" | "accepted" | "rejected",
      reviewReason: knowledgeText(row.review_reason, 128, true),
      evidenceIds: new Set<string>([evidenceId]),
    };
    const seen = claims.get(versionKey);
    if (seen) {
      if (seen.claimId !== claim.claimId || seen.claimClass !== claim.claimClass
        || seen.subject !== claim.subject || seen.predicate !== claim.predicate
        || seen.value !== claim.value || seen.unit !== claim.unit
        || seen.polarity !== claim.polarity || seen.material !== claim.material
        || seen.reviewState !== claim.reviewState || seen.reviewReason !== claim.reviewReason) {
        throw persistenceError();
      }
      seen.evidenceIds.add(evidenceId);
    } else {
      claims.set(versionKey, claim);
      orderedClaims.push(versionKey);
    }
  }

  return freezeResult({
    documentId,
    versionId,
    evidence: orderedEvidence,
    claims: orderedClaims.map((key) => {
      const claim = claims.get(key);
      if (!claim) throw persistenceError();
      return Object.freeze({
        claimId: claim.claimId,
        claimVersionId: claim.claimVersionId,
        claimClass: claim.claimClass,
        subject: claim.subject,
        predicate: claim.predicate,
        value: claim.value,
        unit: claim.unit,
        polarity: claim.polarity,
        material: claim.material,
        reviewState: claim.reviewState,
        reviewReason: claim.reviewReason,
        evidenceIds: Object.freeze([...claim.evidenceIds]),
      });
    }),
  });
}

/**
 * Tenant-permission-resolvable citation read. Deleted or pre-clean versions
 * resolve to undefined; the result is render-safe by construction.
 */
export async function resolveKnowledgeCitation(
  rawScope: TenantKnowledgeScope & Readonly<{ citationId: string }>,
  dependencies: Readonly<{
    repository: Pick<KnowledgeQueryRepository, "resolveCitation">;
  }>,
): Promise<ResolvedKnowledgeCitation | undefined> {
  const base = scope(rawScope);
  const input = snapshotRecord(rawScope, ["tenantId", "workspaceId", "citationId"]);
  if (!input || typeof input.citationId !== "string" || !CITATION_ID.test(input.citationId)) {
    throw boundaryError("The citation lookup is invalid.");
  }
  const citationId = input.citationId;

  let result: unknown;
  try {
    result = await dependencies.repository.resolveCitation(freezeResult({
      ...base, citationId,
    }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
  if (result === undefined) return undefined;
  const row = snapshotRecord(result, [
    "citation_id", "evidence_id", "document_id", "version_id", "quote", "quote_hash",
    "source_locator", "version_state",
  ]);
  if (!row || row.citation_id !== citationId
    || typeof row.evidence_id !== "string" || !EVIDENCE_ID.test(row.evidence_id)
    || !RESOLVABLE_VERSION_STATES.has(row.version_state)
    || typeof row.quote !== "string" || row.quote.length > 8192
    || typeof row.quote_hash !== "string" || !row.quote_hash.startsWith("sha256:")
    || !SHA256.test(row.quote_hash.slice(7))) {
    throw persistenceError();
  }
  return freezeResult({
    citationId,
    evidenceId: row.evidence_id,
    documentId: canonicalUuid(row.document_id),
    versionId: canonicalUuid(row.version_id),
    quote: row.quote,
    quoteHash: row.quote_hash,
    sourceLocator: locator(row.source_locator),
    versionState: row.version_state as DocumentLifecycleState,
  });
}

const REVIEW_OUTCOME_FIELDS = [
  "value", "unit", "uncertainty", "confidenceBasisPoints",
] as const;

function reviewOutcome(value: unknown): KnowledgeClaimReviewOutcome | null {
  if (value === undefined) return null;
  const record = snapshotRecord(value, [], REVIEW_OUTCOME_FIELDS);
  if (!record) throw boundaryError("The claim review outcome is invalid.");
  const outcome: Record<string, unknown> = {};
  if (record.value !== undefined) {
    if (typeof record.value !== "string" || record.value.length < 1 || record.value.length > 2048) {
      throw boundaryError("The claim review outcome is invalid.");
    }
    outcome.value = record.value;
  }
  if (record.unit !== undefined) {
    if (record.unit !== null && (typeof record.unit !== "string" || record.unit.length < 1
      || record.unit.length > 64)) {
      throw boundaryError("The claim review outcome is invalid.");
    }
    outcome.unit = record.unit;
  }
  if (record.uncertainty !== undefined) {
    if (record.uncertainty !== null && (typeof record.uncertainty !== "string"
      || record.uncertainty.length < 1 || record.uncertainty.length > 1000)) {
      throw boundaryError("The claim review outcome is invalid.");
    }
    outcome.uncertainty = record.uncertainty;
  }
  if (record.confidenceBasisPoints !== undefined) {
    if (!Number.isSafeInteger(record.confidenceBasisPoints)
      || (record.confidenceBasisPoints as number) < 0
      || (record.confidenceBasisPoints as number) > 10_000) {
      throw boundaryError("The claim review outcome is invalid.");
    }
    outcome.confidenceBasisPoints = record.confidenceBasisPoints;
  }
  return Object.freeze(outcome as KnowledgeClaimReviewOutcome);
}

/**
 * Member claim review: approve/edit/reject appends a superseding claim version
 * through the review RPC. The decision ID is derived deterministically from the
 * idempotency key so retries never mint duplicate decisions.
 */
export async function reviewKnowledgeClaim(
  rawInput: KnowledgeClaimReviewInput,
  dependencies: Readonly<{
    repository: Pick<KnowledgeQueryRepository, "reviewClaim">;
  }>,
): Promise<KnowledgeClaimReviewResult> {
  const input = snapshotRecord(rawInput, [
    "tenantId", "workspaceId", "claimId", "claimVersionId", "action", "reasonCode",
    "idempotencyKey",
  ], ["outcome"]);
  if (!input || typeof input.claimId !== "string" || !CLAIM_ID.test(input.claimId)
    || typeof input.claimVersionId !== "string" || !CLAIM_VERSION_ID.test(input.claimVersionId)
    || (input.action !== "approve" && input.action !== "edit" && input.action !== "reject")
    || typeof input.reasonCode !== "string" || !REASON_CODE.test(input.reasonCode)
    || input.reasonCode !== input.reasonCode.trim()
    || typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw boundaryError("The claim review request is invalid.");
  }
  const outcome = reviewOutcome(input.outcome);
  if (input.action !== "edit" && outcome !== null) {
    throw boundaryError("The claim review request is invalid.");
  }
  const request: KnowledgeClaimReviewRequest = {
    tenantId: canonicalUuid(input.tenantId),
    workspaceId: canonicalUuid(input.workspaceId),
    claimId: input.claimId,
    claimVersionId: input.claimVersionId,
    decisionId: decisionId([
      "knowledge-claim-decision-v1",
      input.tenantId as string,
      input.claimId,
      input.claimVersionId,
      input.action,
      input.idempotencyKey,
    ]),
    action: input.action,
    reasonCode: input.reasonCode,
    outcome,
  };

  let result: unknown;
  try {
    result = await dependencies.repository.reviewClaim(freezeResult({ ...request }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
  if (result === undefined) {
    return freezeResult({ kind: "unavailable", claimId: request.claimId });
  }
  const row = snapshotRecord(result, [
    "kind", "claim_id", "claim_version_id", "outcome_claim_version_id", "review_state",
  ]);
  if (!row || row.kind !== "applied" || row.claim_id !== request.claimId
    || row.claim_version_id !== request.claimVersionId
    || typeof row.outcome_claim_version_id !== "string"
    || !CLAIM_VERSION_ID.test(row.outcome_claim_version_id)
    || (row.review_state !== "accepted" && row.review_state !== "rejected")
    || row.review_state !== (request.action === "reject" ? "rejected" : "accepted")) {
    throw persistenceError();
  }
  return freezeResult({
    kind: "applied",
    claimId: request.claimId,
    claimVersionId: request.claimVersionId,
    outcomeClaimVersionId: row.outcome_claim_version_id,
    reviewState: row.review_state,
  });
}
