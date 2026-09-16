import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  STRUCTURAL_CHUNKING_ALGORITHM_VERSION,
  STRUCTURAL_CHUNK_MAX_BLOCKS,
  STRUCTURAL_CHUNK_MAX_UTF8_BYTES,
} from "@/lib/knowledge/chunking";
import {
  createCitedKnowledgeClaims,
  type CitedKnowledgeClaimVersion,
  type KnowledgeClaimProposal,
} from "@/lib/knowledge/claims";
import {
  createKnowledgeEvidenceCitations,
  KNOWLEDGE_EVIDENCE_MAX_CITATIONS,
  KNOWLEDGE_EVIDENCE_MAX_QUOTE_UTF8_BYTES,
  type KnowledgeEvidenceAnchor,
  type KnowledgeEvidenceRecord,
  type RenderSafeKnowledgeCitation,
} from "@/lib/knowledge/evidence-citations";
import {
  runKnowledgeExtractionPipeline,
  type KnowledgeExtractionArtifact,
} from "@/lib/knowledge/extraction-pipeline";
import { countWorkbookRows } from "@/lib/knowledge/parsers/ooxml";
import { countPdfPages } from "@/lib/knowledge/parsers/pdf";

import { DocumentIntakeError } from "./errors";
import type { UploadedDocumentReader } from "./intake-service";
import { buildDocumentObjectKey } from "./object-keys";
import {
  evaluateDocumentRetentionDisposition,
  type DocumentRetentionDispositionReason,
} from "./retention";
import {
  DOCUMENT_LIFECYCLE_STATES,
  type DocumentLifecycleState,
} from "./state-machine";
import {
  DOCUMENT_MAX_BYTES,
  type LaunchDocumentFormat,
} from "./validation";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HASH_REF = /^sha256:[0-9a-f]{64}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PARSER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PARSER_VERSION = /^[a-z0-9][a-z0-9._+-]{0,63}$/u;
const ERROR_CODE = /^[a-z][a-z0-9._:-]{0,127}$/u;
const ARTIFACT_MAX_DESCRIPTOR_CHUNKS = 2048;
const ARTIFACT_MAX_DESCRIPTOR_TABLES = 256;

type PlainRecord = Record<string, unknown>;

const LIFECYCLE_STATES: ReadonlySet<unknown> = new Set(DOCUMENT_LIFECYCLE_STATES);

/**
 * Launch extraction parsers are pinned per text format; the version row's
 * declared format selects exactly one parser identity and media type, so a
 * caller can never steer extraction toward an unverified parser.
 */
const LAUNCH_EXTRACTION_PARSERS = Object.freeze({
  csv: Object.freeze({
    parserId: "launch-csv-records",
    parserVersion: "1.0.0",
    mediaType: "text/csv",
  }),
  docx: Object.freeze({
    parserId: "launch-docx-blocks",
    parserVersion: "1.0.0",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }),
  markdown: Object.freeze({
    parserId: "launch-markdown-lines",
    parserVersion: "1.0.0",
    mediaType: "text/markdown",
  }),
  pdf: Object.freeze({
    parserId: "launch-pdf-text-layer",
    parserVersion: "1.0.0",
    mediaType: "application/pdf",
  }),
  txt: Object.freeze({
    parserId: "launch-text-lines",
    parserVersion: "1.0.0",
    mediaType: "text/plain",
  }),
  xlsx: Object.freeze({
    parserId: "launch-xlsx-rows",
    parserVersion: "1.0.0",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }),
} as const);
type LaunchExtractionFormat = keyof typeof LAUNCH_EXTRACTION_PARSERS;

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

function boundaryError(message = "The document pipeline boundary returned an unsafe response."): DocumentIntakeError {
  return new DocumentIntakeError("intake_boundary_error", message);
}

function persistenceError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The document pipeline state could not be persisted safely.",
  );
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) throw boundaryError();
  return value.toLowerCase();
}

function boundedToken(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw boundaryError();
  return value;
}

function freezeResult<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freezeResult(child as object);
  }
  return Object.freeze(value);
}

function hashReference(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Persistence contract. These types mirror the L-03 SECURITY DEFINER RPC
// result sets exactly; the postgres repository validates every row against
// them before a result may cross the boundary.
// ---------------------------------------------------------------------------

export type DocumentExtractionJobState =
  | "queued"
  | "running"
  | "retry_wait"
  | "complete"
  | "review_required"
  | "error"
  | "canceled";

export type RequestDocumentExtractionInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  jobId: string;
  idempotencyKey: string;
  parserId: string;
  parserVersion: string;
  inputHash: string;
}>;

export type ExtractionRequestPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "conflict" }
  | {
      kind: "queued" | "replay";
      jobId: string;
      versionId: string;
      state: DocumentExtractionJobState;
    }
>;

export type CancelDocumentExtractionInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  jobId: string;
}>;

export type ExtractionLeaseRecoveryResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "canceled" | "cancel_requested" | "terminal";
      jobId: string;
      state: DocumentExtractionJobState;
    }
>;

export type ClaimedExtractionLease = Readonly<{
  leaseToken: string;
  jobId: string;
  tenantId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  objectKey: string;
  checksum: string;
  scannerPolicyVersion: string;
  parserId: string;
  parserVersion: string;
  inputHash: string;
  attempt: number;
  maxAttempts: number;
  leaseGeneration: number;
  leaseExpiresAt: string;
  cancelRequested: boolean;
  versionState: string;
}>;

export type ExtractionClaimPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "already_persisted";
      jobId: string;
      tenantId: string;
      workspaceId: string;
      documentId: string;
      versionId: string;
      versionState: string;
      jobState: DocumentExtractionJobState;
      cancelRequested: boolean;
    }
  | { kind: "leased"; lease: ClaimedExtractionLease }
>;

export type ExtractionFinalizeOutput = Readonly<{
  sha256: string;
  artifact: Readonly<Record<string, unknown>>;
  blockCount: number;
  chunkCount: number;
  qualityScore: number;
  reviewRequired: boolean;
  warnings: readonly string[];
  evidence?: readonly KnowledgeEvidenceRecord[];
  citations?: readonly RenderSafeKnowledgeCitation[];
  claims?: readonly CitedKnowledgeClaimVersion[];
  claimEdges?: readonly Readonly<{
    claimVersionId: string;
    citationId: string;
    evidenceId: string;
    edgeOrdinal: number;
  }>[];
}>;

export type ExtractionFinalizeRequest = Readonly<{
  jobId: string;
  leaseToken: string;
  outcome: "complete" | "review_required" | "error" | "canceled";
  output: ExtractionFinalizeOutput | null;
  errorCode: string | null;
  errorFingerprint: string | null;
  retryable: boolean | null;
}>;

export type ExtractionFinalizePersistenceResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "persisted" | "already_persisted";
      jobId: string;
      state: DocumentExtractionJobState;
      versionState: string;
    }
>;

export type LeaseRecoveryPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "requeued" | "terminated" | "canceled"; jobId: string; state: string }
>;

export type RecordRetentionEvaluationInput = Readonly<{
  documentId: string;
  versionId: string;
  inputSha256: `sha256:${string}`;
  disposition: "purge_eligible" | "retain";
  reason: DocumentRetentionDispositionReason;
  policyVersion: string;
  retentionExpiresAt: string;
  evaluatedAt: string;
}>;

export type RetentionEvaluationPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "recorded" | "recorded_purge" | "replay" | "conflict";
      documentId: string;
      versionId: string;
      disposition: "purge_eligible" | "retain";
      reason: DocumentRetentionDispositionReason;
      deletionRequestId: string | null;
    }
>;

export type DocumentDeletionReasonCode =
  | "member_requested"
  | "retention_expired"
  | "policy_purge"
  | "source_stale"
  | "incident_complete";

export type RequestDocumentDeletionInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  requestId: string;
  reasonCode: DocumentDeletionReasonCode;
}>;

export type DeletionRequestPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "requested"; requestId: string; state: string }
  | { kind: "replay" | "denied"; requestId: string | null; state: string }
>;

export type ApplyDocumentDeletionRequest = Readonly<{
  requestId: string;
}>;

export type DeletionApplyPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "applied" | "replay"; requestId: string; versionState: string }
>;

export type DocumentRetentionSubject = Readonly<{
  documentId: string;
  versionId: string;
  versionState: DocumentLifecycleState;
  objectKey: string;
  checksum: string;
  isCurrentVersion: boolean;
  retentionExpiresAt: string;
  priorInputSha256: `sha256:${string}` | null;
  policyVersion: string;
  legalHoldActive: boolean;
  supportHoldActive: boolean;
}>;

export type RetentionSubjectPersistenceResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "subject"; subject: DocumentRetentionSubject }
>;

export type DocumentDeletionRequestRecord = Readonly<{
  requestId: string;
  documentId: string;
  versionId: string;
  state: "pending" | "applied" | "denied";
  versionState: string;
  objectKey: string;
}>;

export type DeletionRequestReadResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "request"; request: DocumentDeletionRequestRecord }
>;

export type DocumentJobLeaseLoss = Readonly<{
  jobId: string;
  tenantId: string;
  workspaceId: string;
}>;

export type DocumentRetentionSubjectRef = Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
}>;

export type DocumentDeletionRequestRef = Readonly<{
  requestId: string;
  tenantId: string;
  workspaceId: string;
}>;

export interface DocumentPipelineRepository {
  requestExtraction(
    input: RequestDocumentExtractionInput,
  ): Promise<ExtractionRequestPersistenceResult>;
  cancelExtraction(
    input: CancelDocumentExtractionInput,
  ): Promise<ExtractionLeaseRecoveryResult>;
  leaseExtractionJob(jobId: string | null): Promise<ExtractionClaimPersistenceResult>;
  finalizeExtraction(
    request: ExtractionFinalizeRequest,
  ): Promise<ExtractionFinalizePersistenceResult>;
  recoverExtractionLease(jobId: string): Promise<LeaseRecoveryPersistenceResult>;
  recoverScanLease(jobId: string): Promise<LeaseRecoveryPersistenceResult>;
  getRetentionSubject(
    input: Readonly<{ documentId: string; versionId: string }>,
  ): Promise<RetentionSubjectPersistenceResult>;
  recordRetentionEvaluation(
    input: RecordRetentionEvaluationInput,
  ): Promise<RetentionEvaluationPersistenceResult>;
  requestDeletion(
    input: RequestDocumentDeletionInput,
  ): Promise<DeletionRequestPersistenceResult>;
  getDeletionRequest(
    input: ApplyDocumentDeletionRequest,
  ): Promise<DeletionRequestReadResult>;
  applyDeletion(
    request: ApplyDocumentDeletionRequest,
  ): Promise<DeletionApplyPersistenceResult>;
  discoverScanLeaseLosses(limit: number): Promise<unknown>;
  discoverExtractionLeaseLosses(limit: number): Promise<unknown>;
  discoverRetentionSubjects(limit: number): Promise<unknown>;
  discoverDeletionRequests(limit: number): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Deterministic extraction input hash. The member request stores the bare
// digest on the job row; the worker pipeline recomputes the identical
// reference at finalize so evidence binds to exactly one input fact set.
// ---------------------------------------------------------------------------

export function documentExtractionInputHash(input: Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  checksum: string;
  scannerPolicyVersion: string;
  parserId: string;
  parserVersion: string;
  format: string;
  mediaType: string;
  maxChunkUtf8Bytes: number;
  maxBlocksPerChunk: number;
}>): string {
  const documentIdentityHash = hashReference([
    "document-identity-v1", input.tenantId, input.workspaceId, input.documentId,
  ]);
  const versionIdentityHash = hashReference([
    "document-version-v1", documentIdentityHash, input.versionId,
    input.checksum, input.scannerPolicyVersion,
  ]);
  const parserIdentityHash = hashReference([
    "document-parser-v1", input.parserId, input.parserVersion, input.format, input.mediaType,
  ]);
  return hashReference([
    "knowledge-extraction-input-v1", versionIdentityHash, parserIdentityHash,
    STRUCTURAL_CHUNKING_ALGORITHM_VERSION, String(input.maxChunkUtf8Bytes),
    String(input.maxBlocksPerChunk),
  ]).slice("sha256:".length);
}

// ---------------------------------------------------------------------------
// Member-facing extraction request / cancel.
// ---------------------------------------------------------------------------

const EXTRACTION_REQUEST_FIELDS = [
  "tenantId", "workspaceId", "documentId", "versionId", "jobId", "idempotencyKey",
  "checksum", "scannerPolicyVersion", "format", "mediaType",
] as const;

export type RequestDocumentExtractionServiceInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  jobId: string;
  idempotencyKey: string;
  checksum: string;
  scannerPolicyVersion: string;
  format: LaunchDocumentFormat;
  mediaType: string;
}>;

export type DocumentExtractionRequestResult = Readonly<{
  kind: "queued" | "replay";
  jobId: string;
  versionId: string;
  state: DocumentExtractionJobState;
}>;

function launchExtractionFormat(value: unknown): LaunchExtractionFormat {
  if (typeof value !== "string" || !Object.hasOwn(LAUNCH_EXTRACTION_PARSERS, value)) {
    throw new DocumentIntakeError(
      "unsupported_type",
      "The document format has no launch extraction parser.",
    );
  }
  return value as LaunchExtractionFormat;
}

export async function requestDocumentExtraction(
  rawInput: RequestDocumentExtractionServiceInput,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "requestExtraction">;
  }>,
): Promise<DocumentExtractionRequestResult> {
  const input = snapshotRecord(rawInput, EXTRACTION_REQUEST_FIELDS);
  if (!input) throw boundaryError();
  const format = launchExtractionFormat(input.format);
  const parser = LAUNCH_EXTRACTION_PARSERS[format];
  if (input.mediaType !== parser.mediaType) {
    throw new DocumentIntakeError(
      "type_mismatch",
      "The document media type does not match its declared format.",
    );
  }
  const request: RequestDocumentExtractionInput = {
    tenantId: canonicalUuid(input.tenantId),
    workspaceId: canonicalUuid(input.workspaceId),
    documentId: canonicalUuid(input.documentId),
    versionId: canonicalUuid(input.versionId),
    jobId: canonicalUuid(input.jobId),
    idempotencyKey: boundedToken(input.idempotencyKey, IDEMPOTENCY_KEY),
    parserId: parser.parserId,
    parserVersion: parser.parserVersion,
    inputHash: documentExtractionInputHash({
      tenantId: canonicalUuid(input.tenantId),
      workspaceId: canonicalUuid(input.workspaceId),
      documentId: canonicalUuid(input.documentId),
      versionId: canonicalUuid(input.versionId),
      checksum: boundedToken(input.checksum, SHA256),
      scannerPolicyVersion: boundedToken(input.scannerPolicyVersion, POLICY_VERSION),
      parserId: parser.parserId,
      parserVersion: parser.parserVersion,
      format,
      mediaType: parser.mediaType,
      maxChunkUtf8Bytes: STRUCTURAL_CHUNK_MAX_UTF8_BYTES,
      maxBlocksPerChunk: STRUCTURAL_CHUNK_MAX_BLOCKS,
    }),
  };
  let persistence: ExtractionRequestPersistenceResult;
  try {
    persistence = await dependencies.repository.requestExtraction(freezeResult({ ...request }));
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, ["kind"], [
    "jobId", "versionId", "state",
  ]);
  if (!result) throw persistenceError();
  if (result.kind === "conflict") {
    throw new DocumentIntakeError(
      "idempotency_conflict",
      "The extraction idempotency key was already used for a different request.",
    );
  }
  if (result.kind === "unavailable") {
    throw new DocumentIntakeError(
      "illegal_transition",
      "The document version is not eligible for extraction.",
    );
  }
  if ((result.kind !== "queued" && result.kind !== "replay")
    || result.jobId !== request.jobId || result.versionId !== request.versionId
    || (result.state !== "queued" && result.state !== "running" && result.state !== "retry_wait"
      && result.state !== "complete" && result.state !== "review_required"
      && result.state !== "error" && result.state !== "canceled")) {
    throw persistenceError();
  }
  return freezeResult({
    kind: result.kind,
    jobId: request.jobId,
    versionId: request.versionId,
    state: result.state as DocumentExtractionJobState,
  });
}

export type DocumentExtractionCancelResult = Readonly<{
  kind: "canceled" | "cancel_requested" | "terminal";
  jobId: string;
  state: DocumentExtractionJobState;
}>;

export async function cancelDocumentExtraction(
  rawInput: CancelDocumentExtractionInput,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "cancelExtraction">;
  }>,
): Promise<DocumentExtractionCancelResult> {
  const input = snapshotRecord(rawInput, ["tenantId", "workspaceId", "jobId"]);
  if (!input) throw boundaryError();
  const request: CancelDocumentExtractionInput = {
    tenantId: canonicalUuid(input.tenantId),
    workspaceId: canonicalUuid(input.workspaceId),
    jobId: canonicalUuid(input.jobId),
  };
  let persistence: ExtractionLeaseRecoveryResult;
  try {
    persistence = await dependencies.repository.cancelExtraction(freezeResult({ ...request }));
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, ["kind", "jobId", "state"]);
  if (!result || result.kind === "unavailable") {
    throw new DocumentIntakeError(
      "illegal_transition",
      "The extraction job could not be canceled in its current state.",
    );
  }
  if ((result.kind !== "canceled" && result.kind !== "cancel_requested" && result.kind !== "terminal")
    || result.jobId !== request.jobId
    || (result.state !== "queued" && result.state !== "running" && result.state !== "retry_wait"
      && result.state !== "complete" && result.state !== "review_required"
      && result.state !== "error" && result.state !== "canceled")) {
    throw persistenceError();
  }
  return freezeResult({
    kind: result.kind,
    jobId: request.jobId,
    state: result.state as DocumentExtractionJobState,
  });
}

// ---------------------------------------------------------------------------
// Worker extraction claim / execute / finalize / recover.
// ---------------------------------------------------------------------------

export type DocumentExtractionClaimResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "already_persisted";
      jobId: string;
      tenantId: string;
      workspaceId: string;
      documentId: string;
      versionId: string;
      versionState: string;
      jobState: DocumentExtractionJobState;
      cancelRequested: boolean;
    }
  | { kind: "leased"; lease: ClaimedExtractionLease }
>;

export async function claimDocumentExtractionJob(
  rawInput: Readonly<{ jobId: string | null }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "leaseExtractionJob">;
  }>,
): Promise<DocumentExtractionClaimResult> {
  const input = snapshotRecord(rawInput, ["jobId"]);
  if (!input || (input.jobId !== null && typeof input.jobId !== "string")) throw boundaryError();
  const jobId = input.jobId === null ? null : canonicalUuid(input.jobId);
  let claim: ExtractionClaimPersistenceResult;
  try {
    claim = await dependencies.repository.leaseExtractionJob(jobId);
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(claim, ["kind"], [
    "lease", "jobId", "tenantId", "workspaceId", "documentId", "versionId",
    "versionState", "jobState", "cancelRequested",
  ]);
  if (!result || result.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if (result.kind === "already_persisted") {
    const persisted = snapshotRecord(result, [
      "kind", "jobId", "tenantId", "workspaceId", "documentId", "versionId",
      "versionState", "jobState", "cancelRequested",
    ]);
    if (!persisted || typeof persisted.cancelRequested !== "boolean"
      || typeof persisted.versionState !== "string" || !LIFECYCLE_STATES.has(persisted.versionState)) {
      throw persistenceError();
    }
    return freezeResult({
      kind: "already_persisted",
      jobId: canonicalUuid(persisted.jobId),
      tenantId: canonicalUuid(persisted.tenantId),
      workspaceId: canonicalUuid(persisted.workspaceId),
      documentId: canonicalUuid(persisted.documentId),
      versionId: canonicalUuid(persisted.versionId),
      versionState: persisted.versionState,
      jobState: persisted.jobState as DocumentExtractionJobState,
      cancelRequested: persisted.cancelRequested,
    });
  }
  if (result.kind !== "leased") throw persistenceError();
  const lease = snapshotRecord(result.lease, [
    "leaseToken", "jobId", "tenantId", "workspaceId", "documentId", "versionId",
    "objectKey", "checksum", "scannerPolicyVersion", "parserId", "parserVersion",
    "inputHash", "attempt", "maxAttempts", "leaseGeneration", "leaseExpiresAt",
    "cancelRequested", "versionState",
  ]);
  if (!lease) throw persistenceError();
  const parsedLease: ClaimedExtractionLease = {
    leaseToken: boundedToken(lease.leaseToken, /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/u),
    jobId: canonicalUuid(lease.jobId),
    tenantId: canonicalUuid(lease.tenantId),
    workspaceId: canonicalUuid(lease.workspaceId),
    documentId: canonicalUuid(lease.documentId),
    versionId: canonicalUuid(lease.versionId),
    objectKey: boundedToken(lease.objectKey, /^tenants\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/original$/u),
    checksum: boundedToken(lease.checksum, SHA256),
    scannerPolicyVersion: boundedToken(lease.scannerPolicyVersion, POLICY_VERSION),
    parserId: boundedToken(lease.parserId, PARSER_ID),
    parserVersion: boundedToken(lease.parserVersion, PARSER_VERSION),
    inputHash: boundedToken(lease.inputHash, SHA256),
    attempt: Number.isSafeInteger(lease.attempt) && (lease.attempt as number) >= 1
      ? lease.attempt as number : (() => { throw persistenceError(); })(),
    maxAttempts: Number.isSafeInteger(lease.maxAttempts) && (lease.maxAttempts as number) >= 1
      ? lease.maxAttempts as number : (() => { throw persistenceError(); })(),
    leaseGeneration: Number.isSafeInteger(lease.leaseGeneration)
      && (lease.leaseGeneration as number) >= 1 && (lease.leaseGeneration as number) <= 999999
      ? lease.leaseGeneration as number : (() => { throw persistenceError(); })(),
    leaseExpiresAt: typeof lease.leaseExpiresAt === "string"
      && Number.isFinite(Date.parse(lease.leaseExpiresAt))
      ? new Date(lease.leaseExpiresAt).toISOString()
      : (() => { throw persistenceError(); })(),
    cancelRequested: lease.cancelRequested === true,
    versionState: typeof lease.versionState === "string" && LIFECYCLE_STATES.has(lease.versionState)
      ? lease.versionState : (() => { throw persistenceError(); })(),
  };
  if (parsedLease.attempt > parsedLease.maxAttempts
    || parsedLease.objectKey !== buildDocumentObjectKey({
      tenantId: parsedLease.tenantId,
      documentId: parsedLease.documentId,
      versionId: parsedLease.versionId,
      object: { kind: "original" },
    })) {
    throw persistenceError();
  }
  return freezeResult({ kind: "leased", lease: parsedLease });
}

export interface DocumentObjectRemover {
  deleteObject(request: Readonly<{
    tenantId: string;
    objectKey: string;
  }>): Promise<unknown>;
}

type PipelineFailure = Extract<
  Awaited<ReturnType<typeof runKnowledgeExtractionPipeline>>,
  { ok: false }
>;

function errorOutcome(
  lease: ClaimedExtractionLease,
  errorCode: string,
  retryable: boolean,
): ExtractionFinalizeRequest {
  return {
    jobId: lease.jobId,
    leaseToken: lease.leaseToken,
    outcome: "error",
    output: null,
    errorCode,
    errorFingerprint: sha256Hex(
      `extraction_error|${lease.jobId}|${lease.leaseGeneration}|${errorCode}`,
    ),
    retryable,
  };
}

function parserFailureOutcome(
  lease: ClaimedExtractionLease,
  failure: PipelineFailure,
): ExtractionFinalizeRequest {
  if (failure.stage === "parser" && failure.code === "CANCELED") {
    return {
      jobId: lease.jobId,
      leaseToken: lease.leaseToken,
      outcome: "canceled",
      output: null,
      errorCode: null,
      errorFingerprint: null,
      retryable: null,
    };
  }
  let errorCode: string;
  let retryable = false;
  if (failure.stage === "input") {
    errorCode = failure.code === "UNSUPPORTED_LAUNCH_FORMAT"
      ? "unsupported_launch_format" : "malformed_input";
  } else if (failure.stage === "eligibility") {
    errorCode = `document_ineligible_${failure.reason}`;
    retryable = failure.reason === "state_not_clean";
  } else if (failure.stage === "parser") {
    errorCode = `parser_${failure.code.toLowerCase()}`;
    retryable = failure.code === "TIME_BUDGET_EXCEEDED";
  } else if (failure.stage === "chunking") {
    errorCode = `chunking_${failure.code.toLowerCase()}`;
  } else {
    errorCode = "invalid_pipeline_output";
  }
  if (!ERROR_CODE.test(errorCode)) errorCode = "extraction_failed";
  return errorOutcome(lease, errorCode, retryable);
}

function boundedQuote(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= KNOWLEDGE_EVIDENCE_MAX_QUOTE_UTF8_BYTES) return text;
  let end = 0;
  let bytes = 0;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    const width = code < 0x80 ? 1 : code < 0x800 ? 2
      : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
    const units = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    if (bytes + width > KNOWLEDGE_EVIDENCE_MAX_QUOTE_UTF8_BYTES) break;
    bytes += width;
    end += units;
  }
  return text.slice(0, end);
}

function countDelimitedRows(bytes: Uint8Array): number {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/u).filter((line) => line.length > 0).length;
}

function extractionArtifactView(
  artifact: KnowledgeExtractionArtifact,
): Record<string, unknown> {
  const truncated = artifact.chunks.length > ARTIFACT_MAX_DESCRIPTOR_CHUNKS
    || artifact.tables.length > ARTIFACT_MAX_DESCRIPTOR_TABLES;
  return {
    artifactVersion: artifact.artifactVersion,
    binding: artifact.binding,
    status: artifact.status,
    quality: artifact.quality,
    warnings: [...artifact.warnings],
    blockCount: artifact.blocks.length,
    chunkCount: artifact.chunks.length,
    tableCount: artifact.tables.length,
    tables: artifact.tables.slice(0, ARTIFACT_MAX_DESCRIPTOR_TABLES).map((table) => ({
      ordinal: table.ordinal,
      startBlockOrdinal: table.startBlockOrdinal,
      endBlockOrdinal: table.endBlockOrdinal,
      rowCount: table.rowCount,
      contentHash: table.contentHash,
    })),
    chunks: artifact.chunks.slice(0, ARTIFACT_MAX_DESCRIPTOR_CHUNKS).map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      contentHash: chunk.contentHash,
      startBlockOrdinal: chunk.startBlockOrdinal,
      endBlockOrdinal: chunk.endBlockOrdinal,
      blockCount: chunk.blockCount,
      utf8Bytes: chunk.utf8Bytes,
      sourceLocators: chunk.sourceLocators,
    })),
    truncated,
  };
}

export type KnowledgeClaimProposer = (input: Readonly<{
  lease: ClaimedExtractionLease;
  artifact: KnowledgeExtractionArtifact;
  evidence: readonly KnowledgeEvidenceRecord[];
  citations: readonly RenderSafeKnowledgeCitation[];
}>) => Promise<unknown> | unknown;

/**
 * Runs the pure extraction pipeline against the leased object and returns the
 * exact fenced finalize request the worker must persist. No persistence
 * happens here: the caller installs the claimed lease_generation scope and
 * hands the request to finalizeDocumentExtraction.
 */
export async function executeDocumentExtraction(
  lease: ClaimedExtractionLease,
  dependencies: Readonly<{
    reader: UploadedDocumentReader;
    proposeClaims?: KnowledgeClaimProposer;
    signal?: AbortSignal;
  }>,
): Promise<ExtractionFinalizeRequest> {
  if (lease.cancelRequested) {
    return freezeResult({
      jobId: lease.jobId,
      leaseToken: lease.leaseToken,
      outcome: "canceled",
      output: null,
      errorCode: null,
      errorFingerprint: null,
      retryable: null,
    });
  }
  const parserEntry = Object.entries(LAUNCH_EXTRACTION_PARSERS).find(
    ([, parser]) => parser.parserId === lease.parserId
      && parser.parserVersion === lease.parserVersion,
  );
  if (!parserEntry) {
    return freezeResult(errorOutcome(lease, "unsupported_parser", false));
  }
  const [format, parser] = parserEntry as [LaunchExtractionFormat, typeof parserEntry[1]];

  let rawObject: unknown;
  try {
    rawObject = await dependencies.reader.readUploadedObject(freezeResult({
      tenantId: lease.tenantId,
      workspaceId: lease.workspaceId,
      documentId: lease.documentId,
      versionId: lease.versionId,
      objectKey: lease.objectKey,
      maxBytes: DOCUMENT_MAX_BYTES,
    }));
  } catch {
    return freezeResult(errorOutcome(lease, "object_read_failed", true));
  }
  const object = snapshotRecord(rawObject, ["objectKey", "bytes", "mediaType", "byteSize"]);
  if (!object || object.objectKey !== lease.objectKey
    || !(object.bytes instanceof Uint8Array) || isProxy(object.bytes)
    || object.mediaType !== parser.mediaType
    || typeof object.byteSize !== "number" || object.byteSize !== object.bytes.byteLength) {
    return freezeResult(errorOutcome(lease, "object_read_mismatch", false));
  }
  const bytes = new Uint8Array(object.bytes);
  if (sha256Hex(bytes) !== lease.checksum) {
    return freezeResult(errorOutcome(lease, "content_checksum_mismatch", false));
  }

  const result = await runKnowledgeExtractionPipeline({
    version: 1,
    tenantId: lease.tenantId,
    workspaceId: lease.workspaceId,
    documentId: lease.documentId,
    candidate: {
      version: { versionId: lease.versionId, checksum: lease.checksum, state: "clean" },
      immutable: true,
      format,
      cleanBinding: {
        versionId: lease.versionId,
        checksum: lease.checksum,
        policyVersion: lease.scannerPolicyVersion,
      },
      expectedBinding: {
        versionId: lease.versionId,
        checksum: lease.checksum,
        policyVersion: lease.scannerPolicyVersion,
      },
      parserMetadata: {
        versionId: lease.versionId,
        checksum: lease.checksum,
        policyVersion: lease.scannerPolicyVersion,
        validated: true,
        ...(format === "csv" ? { rowCount: countDelimitedRows(bytes) } : {}),
        ...(format === "xlsx" ? { rowCount: countWorkbookRows(bytes) } : {}),
        ...(format === "pdf" ? { pageCount: countPdfPages(bytes) } : {}),
      },
    },
    mediaType: parser.mediaType,
    bytes,
    chunking: {
      algorithmVersion: STRUCTURAL_CHUNKING_ALGORITHM_VERSION,
      maxUtf8Bytes: STRUCTURAL_CHUNK_MAX_UTF8_BYTES,
      maxBlocksPerChunk: STRUCTURAL_CHUNK_MAX_BLOCKS,
    },
  }, dependencies.signal ? { signal: dependencies.signal } : undefined);
  if (!result.ok) {
    return freezeResult(parserFailureOutcome(lease, result));
  }
  const artifact = result.artifact;
  if (artifact.binding.inputHash !== `sha256:${lease.inputHash}`
    || artifact.binding.documentVersionId !== lease.versionId
    || artifact.binding.checksum !== lease.checksum
    || artifact.binding.scannerPolicyVersion !== lease.scannerPolicyVersion
    || artifact.binding.parserId !== lease.parserId
    || artifact.binding.parserVersion !== lease.parserVersion
    || artifact.binding.tenantId !== lease.tenantId
    || artifact.binding.workspaceId !== lease.workspaceId
    || artifact.binding.documentId !== lease.documentId) {
    return freezeResult(errorOutcome(lease, "extraction_input_hash_mismatch", false));
  }
  if (artifact.quality.reviewRequired !== (artifact.status === "review_required")
    || !Number.isFinite(artifact.quality.score)
    || artifact.quality.score < 0 || artifact.quality.score > 1) {
    return freezeResult(errorOutcome(lease, "invalid_pipeline_output", false));
  }

  const anchors: KnowledgeEvidenceAnchor[] = artifact.blocks
    .slice(0, KNOWLEDGE_EVIDENCE_MAX_CITATIONS)
    .map((block) => {
      const quote = boundedQuote(block.text);
      return {
        blockOrdinal: block.ordinal,
        blockContentHash: block.contentHash,
        sourceLocator: block.sourceLocator,
        quoteStart: 0,
        quoteEnd: quote.length,
        quote,
        quoteHash: `sha256:${sha256Hex(quote)}`,
      };
    });
  const evidenceResult = createKnowledgeEvidenceCitations({
    version: 1,
    scope: {
      tenantId: lease.tenantId,
      workspaceId: lease.workspaceId,
      documentId: lease.documentId,
      documentVersionId: lease.versionId,
      checksum: lease.checksum,
      scannerPolicyVersion: lease.scannerPolicyVersion,
    },
    extraction: {
      artifactVersion: artifact.artifactVersion,
      binding: artifact.binding,
      blocks: artifact.blocks,
    },
    anchors,
  });
  if (!evidenceResult.ok) {
    return freezeResult(errorOutcome(lease, "evidence_binding_mismatch", false));
  }
  const evidence = evidenceResult.evidence;
  const citations = evidenceResult.citations;

  let claims: readonly CitedKnowledgeClaimVersion[] | undefined;
  let claimEdges: readonly Readonly<{
    claimVersionId: string;
    citationId: string;
    evidenceId: string;
    edgeOrdinal: number;
  }>[] | undefined;
  if (dependencies.proposeClaims) {
    let rawProposals: unknown;
    try {
      rawProposals = await dependencies.proposeClaims(freezeResult({
        lease,
        artifact,
        evidence,
        citations,
      }));
    } catch {
      return freezeResult(errorOutcome(lease, "claim_proposal_failed", true));
    }
    if (rawProposals !== undefined) {
      const proposals = rawProposals as readonly KnowledgeClaimProposal[];
      const claimsResult = createCitedKnowledgeClaims({
        version: 1,
        scope: {
          tenantId: lease.tenantId,
          workspaceId: lease.workspaceId,
          documentId: lease.documentId,
          documentVersionId: lease.versionId,
          checksum: lease.checksum,
          scannerPolicyVersion: lease.scannerPolicyVersion,
        },
        evidence,
        citations,
        proposals,
      });
      if (!claimsResult.ok) {
        return freezeResult(errorOutcome(lease, "claim_proposal_invalid", false));
      }
      claims = claimsResult.claims;
      const citationById = new Map(citations.map((citation) => [citation.citationId, citation]));
      const edges: { claimVersionId: string; citationId: string; evidenceId: string; edgeOrdinal: number }[] = [];
      for (const claim of claims) {
        claim.citationIds.forEach((citationId, edgeOrdinal) => {
          const citation = citationById.get(citationId);
          if (!citation) return;
          edges.push({
            claimVersionId: claim.claimVersionId,
            citationId,
            evidenceId: citation.evidenceId,
            edgeOrdinal,
          });
        });
      }
      claimEdges = Object.freeze(edges);
    }
  }

  const artifactView = extractionArtifactView(artifact);
  const output: ExtractionFinalizeOutput = {
    sha256: sha256Hex(JSON.stringify(artifactView)),
    artifact: artifactView,
    blockCount: artifact.blocks.length,
    chunkCount: artifact.chunks.length,
    qualityScore: artifact.quality.score,
    reviewRequired: artifact.quality.reviewRequired,
    warnings: [...artifact.warnings],
    evidence,
    citations,
    ...(claims ? { claims } : {}),
    ...(claimEdges ? { claimEdges } : {}),
  };
  return freezeResult({
    jobId: lease.jobId,
    leaseToken: lease.leaseToken,
    outcome: artifact.status === "review_required" ? "review_required" : "complete",
    output,
    errorCode: null,
    errorFingerprint: null,
    retryable: null,
  });
}

export type DocumentExtractionFinalizeResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "persisted" | "already_persisted";
      jobId: string;
      state: DocumentExtractionJobState;
      versionState: string;
    }
>;

export async function finalizeDocumentExtraction(
  request: ExtractionFinalizeRequest,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "finalizeExtraction">;
  }>,
): Promise<DocumentExtractionFinalizeResult> {
  const input = snapshotRecord(request, [
    "jobId", "leaseToken", "outcome", "output", "errorCode", "errorFingerprint", "retryable",
  ]);
  if (!input
    || (input.outcome !== "complete" && input.outcome !== "review_required"
      && input.outcome !== "error" && input.outcome !== "canceled")) {
    throw boundaryError();
  }
  canonicalUuid(input.jobId);
  boundedToken(input.leaseToken, /^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$/u);
  if (input.outcome === "error") {
    if (input.output !== null || typeof input.errorCode !== "string"
      || !ERROR_CODE.test(input.errorCode) || typeof input.errorFingerprint !== "string"
      || !SHA256.test(input.errorFingerprint) || typeof input.retryable !== "boolean") {
      throw boundaryError();
    }
  } else if (input.outcome === "canceled") {
    if (input.output !== null || input.errorCode !== null
      || input.errorFingerprint !== null || input.retryable !== null) {
      throw boundaryError();
    }
  } else {
    const output = snapshotRecord(input.output, [
      "sha256", "artifact", "blockCount", "chunkCount", "qualityScore", "reviewRequired", "warnings",
    ], ["evidence", "citations", "claims", "claimEdges"]);
    if (!output || typeof output.sha256 !== "string" || !SHA256.test(output.sha256)
      || input.errorCode !== null || input.errorFingerprint !== null || input.retryable !== null
      || !Number.isSafeInteger(output.blockCount) || (output.blockCount as number) < 1
      || (output.blockCount as number) > 500_000
      || !Number.isSafeInteger(output.chunkCount) || (output.chunkCount as number) < 1
      || (output.chunkCount as number) > (output.blockCount as number)
      || typeof output.qualityScore !== "number" || !Number.isFinite(output.qualityScore)
      || output.qualityScore < 0 || output.qualityScore > 1
      || typeof output.reviewRequired !== "boolean"
      || output.reviewRequired !== (input.outcome === "review_required")
      || !Array.isArray(output.warnings) || output.warnings.length > 100
      || output.warnings.some((warning) => typeof warning !== "string")) {
      throw boundaryError();
    }
  }
  let persistence: ExtractionFinalizePersistenceResult;
  try {
    persistence = await dependencies.repository.finalizeExtraction(freezeResult({ ...request }));
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, ["kind", "jobId", "state", "versionState"]);
  if (!result || result.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if ((result.kind !== "persisted" && result.kind !== "already_persisted")
    || result.jobId !== request.jobId
    || (result.state !== "queued" && result.state !== "running" && result.state !== "retry_wait"
      && result.state !== "complete" && result.state !== "review_required"
      && result.state !== "error" && result.state !== "canceled")
    || typeof result.versionState !== "string" || !LIFECYCLE_STATES.has(result.versionState)) {
    throw persistenceError();
  }
  return freezeResult({
    kind: result.kind,
    jobId: request.jobId,
    state: result.state as DocumentExtractionJobState,
    versionState: result.versionState,
  });
}

export type DocumentLeaseRecoveryResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "requeued" | "terminated" | "canceled"; jobId: string; state: string }
>;

async function recoverLease(
  rawJobId: unknown,
  recover: (jobId: string) => Promise<LeaseRecoveryPersistenceResult>,
): Promise<DocumentLeaseRecoveryResult> {
  const jobId = canonicalUuid(rawJobId);
  let persistence: LeaseRecoveryPersistenceResult;
  try {
    persistence = await recover(jobId);
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, ["kind", "jobId", "state"]);
  if (!result || result.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if ((result.kind !== "requeued" && result.kind !== "terminated" && result.kind !== "canceled")
    || result.jobId !== jobId || typeof result.state !== "string"
    || result.state.length === 0 || result.state.length > 64) {
    throw persistenceError();
  }
  return freezeResult({ kind: result.kind, jobId, state: result.state });
}

export async function recoverDocumentExtractionLease(
  rawInput: Readonly<{ jobId: string }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "recoverExtractionLease">;
  }>,
): Promise<DocumentLeaseRecoveryResult> {
  const input = snapshotRecord(rawInput, ["jobId"]);
  if (!input) throw boundaryError();
  return recoverLease(input.jobId, (jobId) =>
    dependencies.repository.recoverExtractionLease(jobId));
}

export async function recoverDocumentScanLease(
  rawInput: Readonly<{ jobId: string }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "recoverScanLease">;
  }>,
): Promise<DocumentLeaseRecoveryResult> {
  const input = snapshotRecord(rawInput, ["jobId"]);
  if (!input) throw boundaryError();
  return recoverLease(input.jobId, (jobId) =>
    dependencies.repository.recoverScanLease(jobId));
}

// ---------------------------------------------------------------------------
// Worker discovery sweeps. Each returns only validated identifiers; the
// caller binds a fresh tenant-scoped worker scope to each row before mutating.
// ---------------------------------------------------------------------------

function discoveryLimit(rawLimit: unknown): number {
  if (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1
    || (rawLimit as number) > 100) throw boundaryError();
  return rawLimit as number;
}

function uuidRowList(
  value: unknown,
  fields: readonly string[],
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || isProxy(value)) throw persistenceError();
  const rows: Record<string, unknown>[] = [];
  for (const entry of value) {
    const row = snapshotRecord(entry, fields);
    if (!row) throw persistenceError();
    rows.push(row);
  }
  return rows;
}

function persistenceUuid(value: unknown): string {
  try {
    return canonicalUuid(value);
  } catch {
    throw persistenceError();
  }
}

export async function discoverDocumentScanLeaseLosses(
  rawInput: Readonly<{ limit: number }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "discoverScanLeaseLosses">;
  }>,
): Promise<readonly DocumentJobLeaseLoss[]> {
  const input = snapshotRecord(rawInput, ["limit"]);
  if (!input) throw boundaryError();
  const limit = discoveryLimit(input.limit);
  let rawRows: unknown;
  try {
    rawRows = await dependencies.repository.discoverScanLeaseLosses(limit);
  } catch {
    throw persistenceError();
  }
  const rows = uuidRowList(rawRows, ["jobId", "tenantId", "workspaceId"]);
  return Object.freeze(rows.map((row) => Object.freeze({
    jobId: persistenceUuid(row.jobId),
    tenantId: persistenceUuid(row.tenantId),
    workspaceId: persistenceUuid(row.workspaceId),
  })));
}

export async function discoverDocumentExtractionLeaseLosses(
  rawInput: Readonly<{ limit: number }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "discoverExtractionLeaseLosses">;
  }>,
): Promise<readonly DocumentJobLeaseLoss[]> {
  const input = snapshotRecord(rawInput, ["limit"]);
  if (!input) throw boundaryError();
  const limit = discoveryLimit(input.limit);
  let rawRows: unknown;
  try {
    rawRows = await dependencies.repository.discoverExtractionLeaseLosses(limit);
  } catch {
    throw persistenceError();
  }
  const rows = uuidRowList(rawRows, ["jobId", "tenantId", "workspaceId"]);
  return Object.freeze(rows.map((row) => Object.freeze({
    jobId: persistenceUuid(row.jobId),
    tenantId: persistenceUuid(row.tenantId),
    workspaceId: persistenceUuid(row.workspaceId),
  })));
}

export async function discoverDocumentRetentionSubjects(
  rawInput: Readonly<{ limit: number }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "discoverRetentionSubjects">;
  }>,
): Promise<readonly DocumentRetentionSubjectRef[]> {
  const input = snapshotRecord(rawInput, ["limit"]);
  if (!input) throw boundaryError();
  const limit = discoveryLimit(input.limit);
  let rawRows: unknown;
  try {
    rawRows = await dependencies.repository.discoverRetentionSubjects(limit);
  } catch {
    throw persistenceError();
  }
  const rows = uuidRowList(rawRows, ["tenantId", "workspaceId", "documentId", "versionId"]);
  return Object.freeze(rows.map((row) => Object.freeze({
    tenantId: persistenceUuid(row.tenantId),
    workspaceId: persistenceUuid(row.workspaceId),
    documentId: persistenceUuid(row.documentId),
    versionId: persistenceUuid(row.versionId),
  })));
}

export async function discoverDocumentDeletionRequests(
  rawInput: Readonly<{ limit: number }>,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "discoverDeletionRequests">;
  }>,
): Promise<readonly DocumentDeletionRequestRef[]> {
  const input = snapshotRecord(rawInput, ["limit"]);
  if (!input) throw boundaryError();
  const limit = discoveryLimit(input.limit);
  let rawRows: unknown;
  try {
    rawRows = await dependencies.repository.discoverDeletionRequests(limit);
  } catch {
    throw persistenceError();
  }
  const rows = uuidRowList(rawRows, ["requestId", "tenantId", "workspaceId"]);
  return Object.freeze(rows.map((row) => Object.freeze({
    requestId: persistenceUuid(row.requestId),
    tenantId: persistenceUuid(row.tenantId),
    workspaceId: persistenceUuid(row.workspaceId),
  })));
}

// ---------------------------------------------------------------------------
// Worker retention evaluation. The subject read is fenced to the
// document_retention:evaluate action; only a purge-eligible or terminal
// disposition is recorded so a live evaluation can never wedge a later purge.
// ---------------------------------------------------------------------------

const RETENTION_EVALUATION_STATES = new Set<DocumentLifecycleState>([
  "clean", "ready", "extraction_failed", "infected", "scanner_error",
  "rejected", "expired", "retained_for_incident", "deleted",
  "deletion_pending", "deletion_failed",
]);

export type DocumentRetentionEvaluationResult = Readonly<
  | { kind: "unavailable" }
  | {
      kind: "deferred";
      documentId: string;
      versionId: string;
      disposition: "purge_eligible" | "retain";
      reason: DocumentRetentionDispositionReason;
    }
  | {
      kind: "recorded" | "recorded_purge" | "replay" | "conflict";
      documentId: string;
      versionId: string;
      disposition: "purge_eligible" | "retain";
      reason: DocumentRetentionDispositionReason;
      deletionRequestId: string | null;
    }
>;

export async function evaluateDocumentRetention(
  rawInput: Readonly<{
    tenantId: string;
    workspaceId: string;
    documentId: string;
    versionId: string;
  }>,
  dependencies: Readonly<{
    repository: Pick<
      DocumentPipelineRepository,
      "getRetentionSubject" | "recordRetentionEvaluation"
    >;
    evaluatedAt?: string;
  }>,
): Promise<DocumentRetentionEvaluationResult> {
  const input = snapshotRecord(rawInput, ["tenantId", "workspaceId", "documentId", "versionId"]);
  if (!input) throw boundaryError();
  const tenantId = canonicalUuid(input.tenantId);
  const documentId = canonicalUuid(input.documentId);
  const versionId = canonicalUuid(input.versionId);
  canonicalUuid(input.workspaceId);
  const evaluatedAt = dependencies.evaluatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw boundaryError();

  let subjectResult: RetentionSubjectPersistenceResult;
  try {
    subjectResult = await dependencies.repository.getRetentionSubject(
      freezeResult({ documentId, versionId }),
    );
  } catch {
    throw persistenceError();
  }
  const subjectRow = snapshotRecord(subjectResult, ["kind"], ["subject"]);
  if (!subjectRow || subjectRow.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if (subjectRow.kind !== "subject") throw persistenceError();
  const subject = snapshotRecord(subjectRow.subject, [
    "documentId", "versionId", "versionState", "objectKey", "checksum",
    "isCurrentVersion", "retentionExpiresAt", "priorInputSha256", "policyVersion",
    "legalHoldActive", "supportHoldActive",
  ]);
  if (!subject || subject.documentId !== documentId || subject.versionId !== versionId
    || typeof subject.versionState !== "string" || !LIFECYCLE_STATES.has(subject.versionState)
    || subject.objectKey !== buildDocumentObjectKey({
      tenantId,
      documentId,
      versionId,
      object: { kind: "original" },
    })
    || typeof subject.checksum !== "string" || !SHA256.test(subject.checksum)
    || typeof subject.isCurrentVersion !== "boolean"
    || typeof subject.retentionExpiresAt !== "string"
    || !Number.isFinite(Date.parse(subject.retentionExpiresAt))
    || (subject.priorInputSha256 !== null
      && (typeof subject.priorInputSha256 !== "string" || !HASH_REF.test(subject.priorInputSha256)))
    || typeof subject.policyVersion !== "string" || !POLICY_VERSION.test(subject.policyVersion)
    || typeof subject.legalHoldActive !== "boolean"
    || typeof subject.supportHoldActive !== "boolean") {
    throw persistenceError();
  }

  const evaluation = evaluateDocumentRetentionDisposition({
    contractVersion: 1,
    scopeTenantId: tenantId,
    tenantId,
    documentId,
    versionId,
    objectKey: subject.objectKey,
    state: subject.versionState,
    isCurrentVersion: subject.isCurrentVersion,
    policyVersion: subject.policyVersion,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    retentionExpiresAt: new Date(subject.retentionExpiresAt as string).toISOString(),
    legalHoldActive: subject.legalHoldActive,
    supportHoldActive: subject.supportHoldActive,
    idempotencyKey: `retention:${documentId}:${versionId}`,
    priorInputSha256: subject.priorInputSha256 as `sha256:${string}` | null,
  });

  const eligibleState = RETENTION_EVALUATION_STATES.has(evaluation.state)
    && evaluation.reason !== "retention_active"
    && evaluation.reason !== "workflow_in_flight";
  const recordable = evaluation.disposition === "purge_eligible"
    || evaluation.reason === "already_deleted";
  if (!eligibleState || !recordable) {
    return freezeResult({
      kind: "deferred",
      documentId,
      versionId,
      disposition: evaluation.disposition,
      reason: evaluation.reason,
    });
  }

  let persistence: RetentionEvaluationPersistenceResult;
  try {
    persistence = await dependencies.repository.recordRetentionEvaluation(freezeResult({
      documentId,
      versionId,
      inputSha256: evaluation.inputSha256,
      disposition: evaluation.disposition,
      reason: evaluation.reason,
      policyVersion: evaluation.policyVersion,
      retentionExpiresAt: evaluation.retentionExpiresAt,
      evaluatedAt: evaluation.evaluatedAt,
    }));
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, [
    "kind", "documentId", "versionId", "disposition", "reason", "deletionRequestId",
  ]);
  if (!result || result.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if ((result.kind !== "recorded" && result.kind !== "recorded_purge"
      && result.kind !== "replay" && result.kind !== "conflict")
    || result.documentId !== documentId || result.versionId !== versionId
    || result.disposition !== evaluation.disposition
    || (result.deletionRequestId !== null && typeof result.deletionRequestId !== "string")) {
    throw persistenceError();
  }
  return freezeResult({
    kind: result.kind,
    documentId,
    versionId,
    disposition: result.disposition as "purge_eligible" | "retain",
    reason: result.reason as DocumentRetentionDispositionReason,
    deletionRequestId: result.deletionRequestId === null
      ? null : persistenceUuid(result.deletionRequestId),
  });
}

// ---------------------------------------------------------------------------
// Member deletion request and fenced worker deletion application.
// ---------------------------------------------------------------------------

export type DocumentDeletionRequestResult = Readonly<
  | { kind: "requested"; requestId: string; state: string }
  | { kind: "replay" | "denied"; requestId: string | null; state: string }
>;

const DELETION_REASONS: ReadonlySet<string> = new Set([
  "member_requested", "retention_expired", "policy_purge", "source_stale", "incident_complete",
]);

export async function submitDocumentDeletionRequest(
  rawInput: RequestDocumentDeletionInput,
  dependencies: Readonly<{
    repository: Pick<DocumentPipelineRepository, "requestDeletion">;
  }>,
): Promise<DocumentDeletionRequestResult> {
  const input = snapshotRecord(rawInput, [
    "tenantId", "workspaceId", "documentId", "versionId", "requestId", "reasonCode",
  ]);
  if (!input) throw boundaryError();
  const request: RequestDocumentDeletionInput = {
    tenantId: canonicalUuid(input.tenantId),
    workspaceId: canonicalUuid(input.workspaceId),
    documentId: canonicalUuid(input.documentId),
    versionId: canonicalUuid(input.versionId),
    requestId: canonicalUuid(input.requestId),
    reasonCode: DELETION_REASONS.has(input.reasonCode as string)
      ? input.reasonCode as DocumentDeletionReasonCode
      : (() => { throw boundaryError(); })(),
  };
  let persistence: DeletionRequestPersistenceResult;
  try {
    persistence = await dependencies.repository.requestDeletion(freezeResult({ ...request }));
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, ["kind", "requestId", "state"]);
  if (!result || result.kind === "unavailable") {
    throw new DocumentIntakeError(
      "illegal_transition",
      "The document version is not eligible for deletion.",
    );
  }
  if (result.kind === "denied") {
    if (result.requestId !== null || typeof result.state !== "string") throw persistenceError();
    throw new DocumentIntakeError(
      "incident_hold_active",
      "An incident-held document cannot be deleted until the hold is released.",
    );
  }
  if (result.kind === "replay") {
    if (result.requestId !== null || typeof result.state !== "string"
      || !LIFECYCLE_STATES.has(result.state)) throw persistenceError();
    return freezeResult({ kind: "replay", requestId: null, state: result.state });
  }
  if (result.kind !== "requested" || result.requestId !== request.requestId
    || result.state !== "deletion_pending") {
    throw persistenceError();
  }
  return freezeResult({ kind: "requested", requestId: request.requestId, state: "deletion_pending" });
}

export type DocumentDeletionApplyResult = Readonly<
  | { kind: "unavailable" }
  | { kind: "applied" | "replay"; requestId: string; versionState: string }
>;

export async function applyDocumentDeletion(
  rawInput: ApplyDocumentDeletionRequest,
  dependencies: Readonly<{
    repository: Pick<
      DocumentPipelineRepository,
      "getDeletionRequest" | "applyDeletion"
    >;
    remover: DocumentObjectRemover;
  }>,
): Promise<DocumentDeletionApplyResult> {
  const input = snapshotRecord(rawInput, ["requestId"]);
  if (!input) throw boundaryError();
  const requestId = canonicalUuid(input.requestId);

  let readResult: DeletionRequestReadResult;
  try {
    readResult = await dependencies.repository.getDeletionRequest(freezeResult({ requestId }));
  } catch {
    throw persistenceError();
  }
  const read = snapshotRecord(readResult, ["kind"], ["request"]);
  if (!read || read.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if (read.kind !== "request") throw persistenceError();
  const record = snapshotRecord(read.request, [
    "requestId", "documentId", "versionId", "state", "versionState", "objectKey",
  ]);
  if (!record || record.requestId !== requestId
    || (record.state !== "pending" && record.state !== "applied" && record.state !== "denied")
    || typeof record.versionState !== "string" || !LIFECYCLE_STATES.has(record.versionState)) {
    throw persistenceError();
  }
  const documentId = canonicalUuid(record.documentId);
  const versionId = canonicalUuid(record.versionId);

  if (record.state === "pending") {
    const tenantRow = record.objectKey;
    const expectedKey = /^tenants\/([0-9a-f-]{36})\/documents\//u.exec(
      typeof tenantRow === "string" ? tenantRow : "",
    );
    if (!expectedKey) throw persistenceError();
    const tenantId = expectedKey[1];
    if (record.objectKey !== buildDocumentObjectKey({
      tenantId,
      documentId,
      versionId,
      object: { kind: "original" },
    })) {
      throw persistenceError();
    }
    let rawRemoval: unknown;
    try {
      rawRemoval = await dependencies.remover.deleteObject(freezeResult({
        tenantId,
        objectKey: record.objectKey as string,
      }));
    } catch {
      throw persistenceError();
    }
    const removal = snapshotRecord(rawRemoval, ["objectKey", "removed"]);
    if (!removal || removal.objectKey !== record.objectKey
      || typeof removal.removed !== "boolean") {
      throw persistenceError();
    }
  }

  let persistence: DeletionApplyPersistenceResult;
  try {
    persistence = await dependencies.repository.applyDeletion(freezeResult({ requestId }));
  } catch {
    throw persistenceError();
  }
  const result = snapshotRecord(persistence, ["kind", "requestId", "versionState"]);
  if (!result || result.kind === "unavailable") {
    return freezeResult({ kind: "unavailable" });
  }
  if ((result.kind !== "applied" && result.kind !== "replay")
    || result.requestId !== requestId
    || typeof result.versionState !== "string" || !LIFECYCLE_STATES.has(result.versionState)) {
    throw persistenceError();
  }
  return freezeResult({
    kind: result.kind,
    requestId,
    versionState: result.versionState,
  });
}
