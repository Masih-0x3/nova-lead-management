import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

import { DocumentIntakeError } from "./errors";
import type {
  BeginDocumentUrlIntake,
  DocumentUrlIntakeRepository,
  DocumentUrlSource,
  DocumentUrlSourceLookup,
  FailDocumentUrlIntake,
  FinalizeDocumentUrlIntake,
  UrlIntakeBeginPersistenceResult,
  UrlIntakeFailPersistenceResult,
  UrlIntakeFinalizePersistenceResult,
} from "./url-intake-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DISPATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u;
const REQUEST_STATES = new Set([
  "fetching", "quarantined", "blocked_security", "rejected", "failed",
]);

const BEGIN_ROW_FIELDS = ["kind", "request_id", "document_id", "state"] as const;
const FINALIZE_ROW_FIELDS = [
  "kind", "version_id", "state", "checksum", "processing_version_id",
  "scan_job_id", "dispatch_key",
] as const;
const FAIL_ROW_FIELDS = ["kind", "state"] as const;
const LOOKUP_ROW_FIELDS = ["document_id", "normalized_url"] as const;

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
  return value.toLowerCase();
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

export function createPostgresDocumentUrlIntakeRepository(
  db: DbClient,
): DocumentUrlIntakeRepository {
  return Object.freeze({
    async beginUrlIntake(
      input: BeginDocumentUrlIntake,
    ): Promise<UrlIntakeBeginPersistenceResult> {
      const rows = await callFunction(db,
        "kind,request_id,document_id,state",
        "novatrade_begin_document_url_intake(?,?,?,?,?,?,?,?)",
        [
          input.tenantId,
          input.workspaceId,
          input.documentId,
          input.requestId,
          input.idempotencyKey,
          input.urlSha256,
          input.normalizedUrl,
          input.requestedName,
        ]);
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], BEGIN_ROW_FIELDS);
      const kind = row.kind;
      if (kind === "conflict") {
        if (row.request_id !== null || row.state !== null
          || (row.document_id !== null && typeof row.document_id !== "string")) {
          throw persistenceError();
        }
        return Object.freeze({
          kind: "conflict",
          existingDocumentId: row.document_id === null ? null : uuid(row.document_id),
        });
      }
      if (kind !== "created" && kind !== "replay") throw persistenceError();
      const requestId = uuid(row.request_id);
      const documentId = uuid(row.document_id);
      const state = row.state;
      if (requestId !== input.requestId || documentId !== input.documentId
        || typeof state !== "string" || !REQUEST_STATES.has(state)) {
        throw persistenceError();
      }
      if (kind === "created") {
        if (state !== "fetching") throw persistenceError();
        return Object.freeze({ kind, requestId, documentId });
      }
      return Object.freeze({
        kind,
        requestId,
        documentId,
        state: state as "fetching" | "quarantined" | "blocked_security" | "rejected" | "failed",
      });
    },

    async finalizeUrlIntake(
      input: FinalizeDocumentUrlIntake,
    ): Promise<UrlIntakeFinalizePersistenceResult | undefined> {
      const rows = await callFunction(db,
        "kind,version_id,state,checksum,processing_version_id,scan_job_id,dispatch_key",
        "novatrade_finalize_document_url_intake(?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          input.tenantId,
          input.workspaceId,
          input.requestId,
          input.documentId,
          input.versionId,
          input.format,
          input.mediaType,
          String(input.declaredByteSize),
          input.scannerPolicyVersion,
          input.checksum,
          input.finalUrlSha256,
          String(input.redirectCount),
        ]);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], FINALIZE_ROW_FIELDS);
      const kind = row.kind;
      if (kind !== "quarantined" && kind !== "duplicate") throw persistenceError();
      const versionId = uuid(row.version_id);
      const checksum = row.checksum;
      if (versionId !== input.versionId || row.state !== "quarantined"
        || typeof checksum !== "string" || !SHA256.test(checksum)
        || checksum !== input.checksum) {
        throw persistenceError();
      }
      const processingVersionId = uuid(row.processing_version_id);
      if (kind === "duplicate") {
        if (row.scan_job_id !== null || row.dispatch_key !== null) throw persistenceError();
        return Object.freeze({
          kind, versionId, checksum, processingVersionId, scanJobId: null, dispatchKey: null,
        });
      }
      return Object.freeze({
        kind,
        versionId,
        checksum,
        processingVersionId,
        scanJobId: uuid(row.scan_job_id),
        dispatchKey: typeof row.dispatch_key === "string" && DISPATCH_KEY.test(row.dispatch_key)
          ? row.dispatch_key
          : (() => { throw persistenceError(); })(),
      });
    },

    async failUrlIntake(
      input: FailDocumentUrlIntake,
    ): Promise<UrlIntakeFailPersistenceResult | undefined> {
      const rows = await callFunction(db,
        "kind,state",
        "novatrade_fail_document_url_intake(?,?,?,?,?,?)",
        [
          input.tenantId,
          input.workspaceId,
          input.requestId,
          input.documentId,
          input.state,
          input.reasonCode,
        ]);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], FAIL_ROW_FIELDS);
      if (row.kind !== "updated" || row.state !== input.state) throw persistenceError();
      return Object.freeze({ kind: "updated", state: input.state });
    },

    async lookupUrlSource(
      input: DocumentUrlSourceLookup,
    ): Promise<DocumentUrlSource | undefined> {
      const rows = await callFunction(db,
        "document_id,normalized_url",
        "novatrade_lookup_document_url_source(?,?,?)",
        [input.tenantId, input.workspaceId, input.urlSha256]);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) throw persistenceError();
      const row = exactRow(rows[0], LOOKUP_ROW_FIELDS);
      const normalizedUrl = row.normalized_url;
      if (typeof normalizedUrl !== "string" || normalizedUrl.length < 12
        || normalizedUrl.length > 2048 || !/^https?:\/\//u.test(normalizedUrl)) {
        throw persistenceError();
      }
      return Object.freeze({
        documentId: uuid(row.document_id),
        normalizedUrl,
      });
    },
  });
}
