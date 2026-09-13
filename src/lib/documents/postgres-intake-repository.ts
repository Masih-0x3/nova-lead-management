import { isProxy } from "node:util/types";
import { randomBytes } from "node:crypto";

import type { DbClient } from "@/lib/db";

import { DocumentIntakeError } from "./errors";
import type {
  DocumentIntakeCommandIdentity,
  DocumentIntakeRepository,
  DocumentReservationPersistenceResult,
  DocumentUploadReservationRecord,
  FinalizeQuarantinePersistenceRequest,
  PersistDocumentScanResultRequest,
} from "./intake-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DISPATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const FORMATS = new Set(["pdf", "docx", "xlsx", "csv", "txt", "markdown", "jpeg", "png"]);
const RESULT_FIELDS = [
  "kind", "tenant_id", "workspace_id", "document_id", "version_id", "idempotency_key",
  "source_identity", "request_fingerprint", "file_name", "format", "media_type",
  "declared_byte_size", "max_bytes", "scanner_policy_version", "object_key", "state",
] as const;

const RESERVATION_ROW_FIELDS = [
  "tenant_id", "workspace_id", "document_id", "version_id", "idempotency_key",
  "source_identity", "request_fingerprint", "file_name", "format", "media_type",
  "declared_byte_size", "max_bytes", "scanner_policy_version", "object_key", "state",
] as const;

const FINALIZE_ROW_FIELDS = [
  "kind", ...RESERVATION_ROW_FIELDS, "checksum",
  "processing_document_id", "processing_version_id", "processing_checksum",
  "processing_policy_version", "outbox_dispatch_key", "outbox_job_id",
] as const;

const SCAN_CLAIM_ROW_FIELDS = [
  "kind", "job_id", "tenant_id", "workspace_id", "document_id", "version_id",
  "object_key", "checksum", "policy_version", "attempt", "max_attempts",
  "lease_generation", "lease_expires_at", "version_state", "result_state",
  "result_retry_scheduled", "persisted_verdict", "persisted_scanner_adapter_id",
  "persisted_scanner_version", "persisted_scanned_checksum", "persisted_scanned_at",
  "persisted_policy_version", "persisted_reason_code", "persisted_retryable",
] as const;

const SCAN_PERSIST_ROW_FIELDS = ["kind", "job_id", "state", "retry_scheduled"] as const;

function persistenceError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The document intake state could not be persisted safely.",
  );
}

function exactRow(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) throw persistenceError();
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
  return value;
}

function text(value: unknown, pattern: RegExp, maxLength?: number): string {
  if (typeof value !== "string" || !pattern.test(value) || (maxLength !== undefined && value.length > maxLength)) {
    throw persistenceError();
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const normalized = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized <= 0) {
    throw persistenceError();
  }
  return normalized;
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

function reservationRecord(row: Record<string, unknown>): DocumentUploadReservationRecord {
  const format = row.format;
  if (typeof format !== "string" || !FORMATS.has(format)) throw persistenceError();
  const state = row.state;
  if (state !== "upload_reserved") throw persistenceError();
  return Object.freeze({
    tenantId: uuid(row.tenant_id),
    workspaceId: uuid(row.workspace_id),
    documentId: uuid(row.document_id),
    versionId: uuid(row.version_id),
    idempotencyKey: text(row.idempotency_key, IDEMPOTENCY_KEY),
    sourceIdentity: text(row.source_identity, /^tenant_upload:[0-9a-f-]{36}$/u, 64),
    requestFingerprint: text(row.request_fingerprint, SHA256),
    fileName: text(row.file_name, /^[^\u0000-\u001f\u007f]+$/u, 1024),
    format: format as DocumentUploadReservationRecord["format"],
    mediaType: text(row.media_type, /^.{3,255}$/u, 255),
    declaredByteSize: positiveInteger(row.declared_byte_size),
    maxBytes: positiveInteger(row.max_bytes),
    scannerPolicyVersion: text(row.scanner_policy_version, POLICY_VERSION),
    objectKey: text(row.object_key, /^tenants\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/original$/u, 256),
    state,
  });
}

function parseReservation(
  row: Record<string, unknown>,
  expected: DocumentUploadReservationRecord,
): DocumentReservationPersistenceResult {
  if (row.kind === "conflict") {
    if (RESULT_FIELDS.slice(1).some((field) => row[field] !== null)) throw persistenceError();
    return Object.freeze({ kind: "conflict" });
  }
  if (row.kind !== "created" && row.kind !== "replay") throw persistenceError();
  const record = reservationRecord(row);
  const expectedSource = `tenant_upload:${record.documentId}`;
  const expectedObject = `tenants/${record.tenantId}/documents/${record.documentId}/versions/${record.versionId}/original`;
  if (
    record.sourceIdentity !== expectedSource || record.objectKey !== expectedObject ||
    record.tenantId !== expected.tenantId || record.workspaceId !== expected.workspaceId ||
    record.documentId !== expected.documentId || record.versionId !== expected.versionId ||
    record.idempotencyKey !== expected.idempotencyKey || record.sourceIdentity !== expected.sourceIdentity ||
    record.requestFingerprint !== expected.requestFingerprint || record.fileName !== expected.fileName ||
    record.format !== expected.format || record.mediaType !== expected.mediaType ||
    record.declaredByteSize !== expected.declaredByteSize || record.maxBytes !== expected.maxBytes ||
    record.scannerPolicyVersion !== expected.scannerPolicyVersion || record.objectKey !== expected.objectKey ||
    record.state !== expected.state
  ) throw persistenceError();
  return Object.freeze({ kind: row.kind, record: Object.freeze(record) });
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

export function createPostgresDocumentIntakeRepository(
  db: DbClient,
): DocumentIntakeRepository {
  return Object.freeze({
    async reserveUpload(record: DocumentUploadReservationRecord): Promise<DocumentReservationPersistenceResult> {
      const rows = await callFunction(db,
        `kind,tenant_id,workspace_id,document_id,version_id,idempotency_key,
        source_identity,request_fingerprint,file_name,format,media_type,declared_byte_size,max_bytes,
        scanner_policy_version,object_key,state`,
        "novatrade_reserve_document_upload(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          record.tenantId,
          record.workspaceId,
          record.documentId,
          record.versionId,
          record.idempotencyKey,
          record.requestFingerprint,
          record.fileName,
          record.format,
          record.mediaType,
          String(record.declaredByteSize),
          String(record.maxBytes),
          record.scannerPolicyVersion,
          record.sourceIdentity,
          record.objectKey,
        ]);
      if (rows.length !== 1) throw persistenceError();
      return parseReservation(exactRow(rows[0], RESULT_FIELDS), record);
    },

    async getUploadReservation(
      identity: DocumentIntakeCommandIdentity,
    ): Promise<DocumentUploadReservationRecord | undefined> {
      const rows = await callFunction(db,
        `tenant_id,workspace_id,document_id,version_id,idempotency_key,source_identity,
        request_fingerprint,file_name,format,media_type,declared_byte_size,max_bytes,
        scanner_policy_version,object_key,state`,
        "novatrade_get_document_reservation(?,?,?,?,?)",
        [
          identity.tenantId,
          identity.workspaceId,
          identity.documentId,
          identity.versionId,
          identity.idempotencyKey,
        ]);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) throw persistenceError();
      return reservationRecord(exactRow(rows[0], RESERVATION_ROW_FIELDS));
    },

    async finalizeQuarantine(request: FinalizeQuarantinePersistenceRequest): Promise<unknown> {
      const reservation = request.reservation;
      const rows = await callFunction(db,
        `kind,tenant_id,workspace_id,document_id,version_id,idempotency_key,source_identity,
        request_fingerprint,file_name,format,media_type,declared_byte_size,max_bytes,
        scanner_policy_version,object_key,state,checksum,processing_document_id,
        processing_version_id,processing_checksum,processing_policy_version,
        outbox_dispatch_key,outbox_job_id`,
        "novatrade_finalize_document_upload(?,?,?,?,?,?,?,?)",
        [
          reservation.tenantId,
          reservation.workspaceId,
          reservation.documentId,
          reservation.versionId,
          reservation.idempotencyKey,
          request.checksum,
          String(request.verifiedByteSize),
          request.verifiedMediaType,
        ]);
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], FINALIZE_ROW_FIELDS);
      const kind = row.kind;
      if (kind !== "quarantined" && kind !== "replay" && kind !== "duplicate") throw persistenceError();
      const record = Object.freeze({
        ...reservationRecord(row),
        state: "quarantined" as const,
        checksum: text(row.checksum, SHA256),
      });
      const processing = Object.freeze({
        tenantId: record.tenantId,
        workspaceId: record.workspaceId,
        sourceIdentity: record.sourceIdentity,
        documentId: uuid(row.processing_document_id),
        versionId: uuid(row.processing_version_id),
        checksum: text(row.processing_checksum, SHA256),
        policyVersion: text(row.processing_policy_version, POLICY_VERSION),
      });
      if (kind === "duplicate") {
        if (row.outbox_dispatch_key !== null || row.outbox_job_id !== null) throw persistenceError();
        return Object.freeze({ kind, record, processing, outbox: null });
      }
      const outbox = Object.freeze({
        dispatchKey: text(row.outbox_dispatch_key, DISPATCH_KEY),
        jobId: uuid(row.outbox_job_id),
        tenantId: record.tenantId,
        workspaceId: record.workspaceId,
        documentId: record.documentId,
        versionId: record.versionId,
        objectKey: record.objectKey,
        checksum: record.checksum,
        policyVersion: record.scannerPolicyVersion,
      });
      return Object.freeze({ kind, record, processing, outbox });
    },

    async leaseScanJob(jobId: string | null): Promise<unknown> {
      const leaseToken = `lease_${randomBytes(24).toString("hex")}`;
      const rows = await callFunction(db,
        `kind,job_id,tenant_id,workspace_id,document_id,version_id,object_key,checksum,
        policy_version,attempt,max_attempts,lease_generation,lease_expires_at,version_state,
        result_state,result_retry_scheduled,persisted_verdict,persisted_scanner_adapter_id,
        persisted_scanner_version,persisted_scanned_checksum,persisted_scanned_at,
        persisted_policy_version,persisted_reason_code,persisted_retryable`,
        "novatrade_claim_document_scan_job(?,?)",
        [jobId, leaseToken]);
      if (rows.length === 0) return Object.freeze({ kind: "unavailable" });
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], SCAN_CLAIM_ROW_FIELDS);
      const kind = row.kind;
      if (kind === "already_persisted") {
        const state = row.result_state;
        if (state !== "clean" && state !== "infected" && state !== "scanner_error") {
          throw persistenceError();
        }
        const verdict = row.persisted_verdict;
        if (verdict !== "clean" && verdict !== "infected" && verdict !== "error") {
          throw persistenceError();
        }
        return Object.freeze({
          kind,
          result: Object.freeze({
            jobId: uuid(row.job_id),
            tenantId: uuid(row.tenant_id),
            workspaceId: uuid(row.workspace_id),
            documentId: uuid(row.document_id),
            versionId: uuid(row.version_id),
            checksum: text(row.checksum, SHA256),
            policyVersion: text(row.policy_version, POLICY_VERSION),
            state,
            scan: Object.freeze({
              verdict,
              scannerAdapterId: text(row.persisted_scanner_adapter_id, /^.{1,128}$/u),
              scannerVersion: text(row.persisted_scanner_version, /^.{1,64}$/u),
              scannedChecksum: text(row.persisted_scanned_checksum, SHA256),
              scannedAt: isoTimestamp(row.persisted_scanned_at),
              policyVersion: text(row.persisted_policy_version, POLICY_VERSION),
              ...(row.persisted_reason_code === null
                ? {}
                : { reasonCode: text(row.persisted_reason_code, /^.{1,128}$/u) }),
              ...(row.persisted_retryable === null
                ? {}
                : { retryable: booleanValue(row.persisted_retryable) }),
            }),
            retryScheduled: booleanValue(row.result_retry_scheduled),
          }),
        });
      }
      if (kind !== "leased") throw persistenceError();
      return Object.freeze({
        kind,
        lease: Object.freeze({
          leaseToken,
          jobId: uuid(row.job_id),
          tenantId: uuid(row.tenant_id),
          workspaceId: uuid(row.workspace_id),
          documentId: uuid(row.document_id),
          versionId: uuid(row.version_id),
          objectKey: text(row.object_key, /^tenants\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/original$/u, 256),
          checksum: text(row.checksum, SHA256),
          policyVersion: text(row.policy_version, POLICY_VERSION),
          attempt: positiveInteger(row.attempt),
          maxAttempts: positiveInteger(row.max_attempts),
          leaseGeneration: positiveInteger(row.lease_generation),
          leaseExpiresAt: isoTimestamp(row.lease_expires_at),
          state: "quarantined",
        }),
      });
    },

    async persistScanResult(request: PersistDocumentScanResultRequest): Promise<unknown> {
      const scan = request.scan;
      const rows = await callFunction(db,
        "kind,job_id,state,retry_scheduled",
        "novatrade_persist_document_scan_result(?,?,?,?,?,?,?,?,?,?)",
        [
          request.jobId,
          request.leaseToken,
          request.state,
          scan.scannerAdapterId,
          scan.scannerVersion,
          scan.scannedChecksum,
          scan.scannedAt,
          scan.policyVersion,
          scan.reasonCode ?? null,
          request.retryRequested,
        ]);
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], SCAN_PERSIST_ROW_FIELDS);
      if (row.kind !== "persisted" && row.kind !== "already_persisted") throw persistenceError();
      const state = row.state;
      if (state !== "clean" && state !== "infected" && state !== "scanner_error") {
        throw persistenceError();
      }
      return Object.freeze({
        kind: "persisted",
        jobId: uuid(row.job_id),
        tenantId: request.tenantId,
        workspaceId: request.workspaceId,
        documentId: request.documentId,
        versionId: request.versionId,
        checksum: request.checksum,
        policyVersion: request.policyVersion,
        state,
        scan: request.scan,
        retryScheduled: booleanValue(row.retry_scheduled),
      });
    },
  });
}
