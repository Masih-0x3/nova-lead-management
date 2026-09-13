import { randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

import { DocumentIntakeError } from "./errors";
import type { DocumentRetentionDispositionReason } from "./retention";
import type {
  ApplyDocumentDeletionRequest,
  CancelDocumentExtractionInput,
  ClaimedExtractionLease,
  DeletionApplyPersistenceResult,
  DeletionRequestPersistenceResult,
  DeletionRequestReadResult,
  DocumentExtractionJobState,
  DocumentPipelineRepository,
  DocumentRetentionSubject,
  ExtractionClaimPersistenceResult,
  ExtractionFinalizePersistenceResult,
  ExtractionFinalizeRequest,
  ExtractionLeaseRecoveryResult,
  ExtractionRequestPersistenceResult,
  LeaseRecoveryPersistenceResult,
  RecordRetentionEvaluationInput,
  RequestDocumentDeletionInput,
  RequestDocumentExtractionInput,
  RetentionEvaluationPersistenceResult,
  RetentionSubjectPersistenceResult,
} from "./pipeline-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HASH_REF = /^sha256:[0-9a-f]{64}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PARSER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PARSER_VERSION = /^[a-z0-9][a-z0-9._+-]{0,63}$/u;
const OBJECT_KEY = /^tenants\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/original$/u;

const EXTRACTION_REQUEST_FIELDS = ["kind", "job_id", "version_id", "state"] as const;
const EXTRACTION_CANCEL_FIELDS = ["kind", "job_id", "state"] as const;
const EXTRACTION_CLAIM_FIELDS = [
  "kind", "job_id", "tenant_id", "workspace_id", "document_id", "version_id", "object_key",
  "checksum", "scanner_policy_version", "parser_id", "parser_version", "input_hash",
  "attempt", "max_attempts", "lease_generation", "lease_expires_at", "cancel_requested",
  "version_state", "result_state",
] as const;
const EXTRACTION_FINALIZE_FIELDS = ["kind", "job_id", "state", "version_state"] as const;
const EXTRACTION_RECOVER_FIELDS = ["kind", "job_id", "state"] as const;
const SCAN_RECOVER_FIELDS = ["kind", "job_id", "state"] as const;
const RETENTION_FIELDS = [
  "kind", "document_id", "version_id", "disposition", "reason", "deletion_request_id",
] as const;
const DELETION_REQUEST_FIELDS = ["kind", "request_id", "state"] as const;
const DELETION_APPLY_FIELDS = ["kind", "request_id", "version_state"] as const;
const RETENTION_SUBJECT_FIELDS = [
  "document_id", "version_id", "version_state", "object_key", "checksum",
  "is_current_version", "retention_expires_at", "prior_input_sha256", "policy_version",
  "legal_hold_active", "support_hold_active",
] as const;
const DELETION_REQUEST_READ_FIELDS = [
  "request_id", "document_id", "version_id", "state", "version_state", "object_key",
] as const;
const DISCOVERY_JOB_FIELDS = ["job_id", "tenant_id", "workspace_id"] as const;
const DISCOVERY_SUBJECT_FIELDS = [
  "tenant_id", "workspace_id", "document_id", "version_id",
] as const;
const DISCOVERY_REQUEST_FIELDS = ["request_id", "tenant_id", "workspace_id"] as const;

const EXTRACTION_JOB_STATES = new Set([
  "queued", "running", "retry_wait", "complete", "review_required", "error", "canceled",
]);
const DOCUMENT_LIFECYCLE_STATE_VALUES = new Set([
  "upload_reserved", "quarantined", "scanning", "clean", "extracting", "ready",
  "infected", "scanner_error", "extraction_failed", "rejected", "expired",
  "deletion_pending", "deletion_failed", "deleted", "retained_for_incident",
]);
const RETENTION_DISPOSITIONS = new Set(["purge_eligible", "retain"]);
const RETENTION_REASONS = new Set([
  "retention_elapsed", "replay_conflict", "legal_hold_active", "support_hold_active",
  "incident_hold_active", "current_version", "clean_version", "workflow_in_flight",
  "deletion_in_progress", "already_deleted", "retention_active",
]);

function persistenceError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The document pipeline persistence boundary returned an unexpected result.",
  );
}

function exactRow(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    throw persistenceError();
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw persistenceError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some((key) =>
      typeof key !== "string" || !fields.includes(key))) {
      throw persistenceError();
    }
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw persistenceError();
      row[field] = descriptor.value;
    }
    return row;
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw persistenceError();
  return value.toLowerCase();
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw persistenceError();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 999999) {
    return value;
  }
  throw persistenceError();
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw persistenceError();
  return value;
}

function isoTimestamp(value: unknown): string {
  const candidate = value instanceof Date ? value.toISOString()
    : typeof value === "string" ? value : null;
  if (!candidate || !Number.isFinite(Date.parse(candidate))) throw persistenceError();
  return new Date(candidate).toISOString();
}

function jobState(value: unknown): DocumentExtractionJobState {
  if (typeof value !== "string" || !EXTRACTION_JOB_STATES.has(value)) throw persistenceError();
  return value as DocumentExtractionJobState;
}

async function callFunction(
  db: DbClient,
  select: string,
  fn: string,
  params: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  let rows: unknown;
  try {
    rows = await db.prepare(`SELECT ${select} FROM public.${fn}`).all(...params);
  } catch {
    throw persistenceError();
  }
  if (!Array.isArray(rows) || isProxy(rows)) throw persistenceError();
  return rows as readonly Record<string, unknown>[];
}

export function createPostgresDocumentPipelineRepository(
  db: DbClient,
): DocumentPipelineRepository {
  return Object.freeze({
    async requestExtraction(
      input: RequestDocumentExtractionInput,
    ): Promise<ExtractionRequestPersistenceResult> {
      const rows = await callFunction(db,
        "kind,job_id,version_id,state",
        "novatrade_request_document_extraction(?,?,?,?,?,?,?,?,?)",
        [
          input.tenantId,
          input.workspaceId,
          input.documentId,
          input.versionId,
          input.jobId,
          input.idempotencyKey,
          input.parserId,
          input.parserVersion,
          input.inputHash,
        ]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], EXTRACTION_REQUEST_FIELDS);
      const kind = row.kind;
      if (kind === "conflict") {
        if (row.job_id !== null || row.version_id !== null || row.state !== null) {
          throw persistenceError();
        }
        return Object.freeze({ kind: "conflict" });
      }
      if (kind !== "queued" && kind !== "replay") throw persistenceError();
      return Object.freeze({
        kind,
        jobId: uuid(row.job_id),
        versionId: uuid(row.version_id),
        state: jobState(row.state),
      });
    },

    async cancelExtraction(
      input: CancelDocumentExtractionInput,
    ): Promise<ExtractionLeaseRecoveryResult> {
      const rows = await callFunction(db,
        "kind,job_id,state",
        "novatrade_cancel_document_extraction(?,?,?)",
        [input.tenantId, input.workspaceId, input.jobId]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], EXTRACTION_CANCEL_FIELDS);
      const kind = row.kind;
      if (kind !== "canceled" && kind !== "cancel_requested" && kind !== "terminal") {
        throw persistenceError();
      }
      return Object.freeze({
        kind,
        jobId: uuid(row.job_id),
        state: jobState(row.state),
      });
    },

    async leaseExtractionJob(jobId: string | null): Promise<ExtractionClaimPersistenceResult> {
      const leaseToken = `lease_${randomBytes(24).toString("hex")}`;
      const rows = await callFunction(db,
        `kind,job_id,tenant_id,workspace_id,document_id,version_id,object_key,checksum,
        scanner_policy_version,parser_id,parser_version,input_hash,attempt,max_attempts,
        lease_generation,lease_expires_at,cancel_requested,version_state,result_state`,
        "novatrade_claim_document_extraction_job(?,?)",
        [jobId, leaseToken]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], EXTRACTION_CLAIM_FIELDS);
      const kind = row.kind;
      if (kind === "already_persisted") {
        return Object.freeze({
          kind,
          jobId: uuid(row.job_id),
          tenantId: uuid(row.tenant_id),
          workspaceId: uuid(row.workspace_id),
          documentId: uuid(row.document_id),
          versionId: uuid(row.version_id),
          versionState: text(row.version_state, /^[a-z_]{1,64}$/u),
          jobState: jobState(row.result_state),
          cancelRequested: booleanValue(row.cancel_requested),
        });
      }
      if (kind !== "leased") throw persistenceError();
      const lease: ClaimedExtractionLease = Object.freeze({
        leaseToken,
        jobId: uuid(row.job_id),
        tenantId: uuid(row.tenant_id),
        workspaceId: uuid(row.workspace_id),
        documentId: uuid(row.document_id),
        versionId: uuid(row.version_id),
        objectKey: text(row.object_key, OBJECT_KEY),
        checksum: text(row.checksum, SHA256),
        scannerPolicyVersion: text(row.scanner_policy_version, POLICY_VERSION),
        parserId: text(row.parser_id, PARSER_ID),
        parserVersion: text(row.parser_version, PARSER_VERSION),
        inputHash: text(row.input_hash, SHA256),
        attempt: positiveInteger(row.attempt),
        maxAttempts: positiveInteger(row.max_attempts),
        leaseGeneration: positiveInteger(row.lease_generation),
        leaseExpiresAt: isoTimestamp(row.lease_expires_at),
        cancelRequested: booleanValue(row.cancel_requested),
        versionState: text(row.version_state, /^[a-z_]{1,64}$/u),
      });
      return Object.freeze({ kind, lease });
    },

    async finalizeExtraction(
      request: ExtractionFinalizeRequest,
    ): Promise<ExtractionFinalizePersistenceResult> {
      const rows = await callFunction(db,
        "kind,job_id,state,version_state",
        "novatrade_finalize_document_extraction(?,?,?,?,?,?,?)",
        [
          request.jobId,
          request.leaseToken,
          request.outcome,
          request.output === null ? null : JSON.stringify(request.output),
          request.errorCode,
          request.errorFingerprint,
          request.retryable,
        ]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], EXTRACTION_FINALIZE_FIELDS);
      const kind = row.kind;
      if (kind !== "persisted" && kind !== "already_persisted") throw persistenceError();
      return Object.freeze({
        kind,
        jobId: uuid(row.job_id),
        state: jobState(row.state),
        versionState: text(row.version_state, /^[a-z_]{1,64}$/u),
      });
    },

    async recoverExtractionLease(jobId: string): Promise<LeaseRecoveryPersistenceResult> {
      const rows = await callFunction(db,
        "kind,job_id,state",
        "novatrade_recover_document_extraction_lease(?)",
        [jobId]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], EXTRACTION_RECOVER_FIELDS);
      const kind = row.kind;
      if (kind !== "requeued" && kind !== "terminated" && kind !== "canceled") {
        throw persistenceError();
      }
      return Object.freeze({
        kind,
        jobId: uuid(row.job_id),
        state: jobState(row.state),
      });
    },

    async recoverScanLease(jobId: string): Promise<LeaseRecoveryPersistenceResult> {
      const rows = await callFunction(db,
        "kind,job_id,state",
        "novatrade_recover_document_scan_lease(?)",
        [jobId]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], SCAN_RECOVER_FIELDS);
      const kind = row.kind;
      if (kind !== "requeued" && kind !== "terminated") throw persistenceError();
      return Object.freeze({
        kind,
        jobId: uuid(row.job_id),
        state: text(row.state, /^[a-z_]{1,64}$/u),
      });
    },

    async getRetentionSubject(
      input: Readonly<{ documentId: string; versionId: string }>,
    ): Promise<RetentionSubjectPersistenceResult> {
      const rows = await callFunction(db,
        `document_id,version_id,version_state,object_key,checksum,is_current_version,
        retention_expires_at,prior_input_sha256,policy_version,legal_hold_active,support_hold_active`,
        "novatrade_get_document_retention_subject(?,?)",
        [input.documentId, input.versionId]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], RETENTION_SUBJECT_FIELDS);
      const subject: DocumentRetentionSubject = Object.freeze({
        documentId: uuid(row.document_id),
        versionId: uuid(row.version_id),
        versionState: typeof row.version_state === "string"
          && DOCUMENT_LIFECYCLE_STATE_VALUES.has(row.version_state)
          ? row.version_state as DocumentRetentionSubject["versionState"]
          : (() => { throw persistenceError(); })(),
        objectKey: text(row.object_key, OBJECT_KEY),
        checksum: text(row.checksum, SHA256),
        isCurrentVersion: booleanValue(row.is_current_version),
        retentionExpiresAt: isoTimestamp(row.retention_expires_at),
        priorInputSha256: row.prior_input_sha256 === null
          ? null : text(row.prior_input_sha256, HASH_REF) as `sha256:${string}`,
        policyVersion: text(row.policy_version, POLICY_VERSION),
        legalHoldActive: booleanValue(row.legal_hold_active),
        supportHoldActive: booleanValue(row.support_hold_active),
      });
      return Object.freeze({ kind: "subject", subject });
    },

    async recordRetentionEvaluation(
      input: RecordRetentionEvaluationInput,
    ): Promise<RetentionEvaluationPersistenceResult> {
      const rows = await callFunction(db,
        "kind,document_id,version_id,disposition,reason,deletion_request_id",
        "novatrade_record_document_retention_evaluation(?,?,?,?,?,?,?,?)",
        [
          input.documentId,
          input.versionId,
          input.inputSha256,
          input.disposition,
          input.reason,
          input.policyVersion,
          input.retentionExpiresAt,
          input.evaluatedAt,
        ]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], RETENTION_FIELDS);
      const kind = row.kind;
      if (kind !== "recorded" && kind !== "recorded_purge" && kind !== "replay" && kind !== "conflict") {
        throw persistenceError();
      }
      const disposition = row.disposition;
      const reason = row.reason;
      if (typeof disposition !== "string" || !RETENTION_DISPOSITIONS.has(disposition)
        || typeof reason !== "string" || !RETENTION_REASONS.has(reason)) {
        throw persistenceError();
      }
      return Object.freeze({
        kind,
        documentId: uuid(row.document_id),
        versionId: uuid(row.version_id),
        disposition: disposition as "purge_eligible" | "retain",
        reason: reason as DocumentRetentionDispositionReason,
        deletionRequestId: row.deletion_request_id === null ? null : uuid(row.deletion_request_id),
      });
    },

    async requestDeletion(
      input: RequestDocumentDeletionInput,
    ): Promise<DeletionRequestPersistenceResult> {
      const rows = await callFunction(db,
        "kind,request_id,state",
        "novatrade_request_document_deletion(?,?,?,?,?,?)",
        [
          input.tenantId,
          input.workspaceId,
          input.documentId,
          input.versionId,
          input.requestId,
          input.reasonCode,
        ]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], DELETION_REQUEST_FIELDS);
      const kind = row.kind;
      if (kind !== "requested" && kind !== "replay" && kind !== "denied") {
        throw persistenceError();
      }
      if (kind === "requested") {
        return Object.freeze({
          kind,
          requestId: uuid(row.request_id),
          state: text(row.state, /^[a-z_]{1,64}$/u),
        });
      }
      if (row.request_id !== null) throw persistenceError();
      return Object.freeze({
        kind,
        requestId: null,
        state: text(row.state, /^[a-z_]{1,64}$/u),
      });
    },

    async getDeletionRequest(
      request: ApplyDocumentDeletionRequest,
    ): Promise<DeletionRequestReadResult> {
      const rows = await callFunction(db,
        "request_id,document_id,version_id,state,version_state,object_key",
        "novatrade_get_document_deletion_request(?)",
        [request.requestId]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], DELETION_REQUEST_READ_FIELDS);
      const state = row.state;
      if (state !== "pending" && state !== "applied" && state !== "denied") {
        throw persistenceError();
      }
      return Object.freeze({
        kind: "request",
        request: Object.freeze({
          requestId: uuid(row.request_id),
          documentId: uuid(row.document_id),
          versionId: uuid(row.version_id),
          state,
          versionState: text(row.version_state, /^[a-z_]{1,64}$/u),
          objectKey: text(row.object_key, OBJECT_KEY),
        }),
      });
    },

    async applyDeletion(
      request: ApplyDocumentDeletionRequest,
    ): Promise<DeletionApplyPersistenceResult> {
      const rows = await callFunction(db,
        "kind,request_id,version_state",
        "novatrade_apply_document_deletion(?)",
        [request.requestId]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], DELETION_APPLY_FIELDS);
      const kind = row.kind;
      if (kind !== "applied" && kind !== "replay") throw persistenceError();
      return Object.freeze({
        kind,
        requestId: uuid(row.request_id),
        versionState: text(row.version_state, /^[a-z_]{1,64}$/u),
      });
    },

    async discoverScanLeaseLosses(limit: number): Promise<unknown> {
      const rows = await callFunction(db,
        "job_id,tenant_id,workspace_id",
        "novatrade_discover_document_scan_lease_losses(?)",
        [String(limit)]);
      if (rows.length > limit) throw persistenceError();
      return Object.freeze(rows.map((row) => {
        const record = exactRow(row, DISCOVERY_JOB_FIELDS);
        return Object.freeze({
          jobId: uuid(record.job_id),
          tenantId: uuid(record.tenant_id),
          workspaceId: uuid(record.workspace_id),
        });
      }));
    },

    async discoverExtractionLeaseLosses(limit: number): Promise<unknown> {
      const rows = await callFunction(db,
        "job_id,tenant_id,workspace_id",
        "novatrade_discover_document_extraction_lease_losses(?)",
        [String(limit)]);
      if (rows.length > limit) throw persistenceError();
      return Object.freeze(rows.map((row) => {
        const record = exactRow(row, DISCOVERY_JOB_FIELDS);
        return Object.freeze({
          jobId: uuid(record.job_id),
          tenantId: uuid(record.tenant_id),
          workspaceId: uuid(record.workspace_id),
        });
      }));
    },

    async discoverRetentionSubjects(limit: number): Promise<unknown> {
      const rows = await callFunction(db,
        "tenant_id,workspace_id,document_id,version_id",
        "novatrade_discover_document_retention_subjects(?)",
        [String(limit)]);
      if (rows.length > limit) throw persistenceError();
      return Object.freeze(rows.map((row) => {
        const record = exactRow(row, DISCOVERY_SUBJECT_FIELDS);
        return Object.freeze({
          tenantId: uuid(record.tenant_id),
          workspaceId: uuid(record.workspace_id),
          documentId: uuid(record.document_id),
          versionId: uuid(record.version_id),
        });
      }));
    },

    async discoverDeletionRequests(limit: number): Promise<unknown> {
      const rows = await callFunction(db,
        "request_id,tenant_id,workspace_id",
        "novatrade_discover_document_deletion_requests(?)",
        [String(limit)]);
      if (rows.length > limit) throw persistenceError();
      return Object.freeze(rows.map((row) => {
        const record = exactRow(row, DISCOVERY_REQUEST_FIELDS);
        return Object.freeze({
          requestId: uuid(record.request_id),
          tenantId: uuid(record.tenant_id),
          workspaceId: uuid(record.workspace_id),
        });
      }));
    },
  });
}
