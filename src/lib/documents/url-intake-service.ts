import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  fetchSafeHttpUrl,
  UnsafeOutboundUrlError,
  type SafeHttpFetch,
  type SafeHttpLookup,
} from "@/lib/safe-http";

import { DocumentIntakeError } from "./errors";
import { buildDocumentObjectKey } from "./object-keys";
import type { LaunchDocumentFormat } from "./validation";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_URL_CHARACTERS = 2048;
const MAX_REDIRECTS = 5;
const DOCUMENT_MAX_FETCH_BYTES = 52_428_800;
const IMAGE_MAX_FETCH_BYTES = 20_971_520;

const URL_MEDIA_FORMATS: ReadonlyMap<string, LaunchDocumentFormat> = new Map([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["text/csv", "csv"],
  ["text/plain", "txt"],
  ["text/markdown", "markdown"],
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
]);

const TERMINAL_REQUEST_STATES = new Set([
  "quarantined",
  "blocked_security",
  "rejected",
  "failed",
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

function boundaryError(message = "The document URL intake boundary returned an unsafe response."): DocumentIntakeError {
  return new DocumentIntakeError("intake_boundary_error", message);
}

function persistenceError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The document intake state could not be persisted safely.",
  );
}

function conflictError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "idempotency_conflict",
    "The idempotency key was already used for a different document intake request.",
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

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type DocumentUrlIntakeRequestState =
  | "fetching"
  | "quarantined"
  | "blocked_security"
  | "rejected"
  | "failed";

export type DocumentUrlIntakeInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  requestId: string;
  idempotencyKey: string;
  url: string;
  requestedName: string;
  scannerPolicyVersion: string;
}>;

export type DocumentUrlSourceLookup = Readonly<{
  tenantId: string;
  workspaceId: string;
  urlSha256: string;
}>;

export type DocumentUrlSource = Readonly<{
  documentId: string;
  normalizedUrl: string;
}>;

export type BeginDocumentUrlIntake = Readonly<{
  tenantId: string;
  workspaceId: string;
  documentId: string;
  requestId: string;
  idempotencyKey: string;
  urlSha256: string;
  normalizedUrl: string;
  requestedName: string;
}>;

export type UrlIntakeBeginPersistenceResult = Readonly<
  | { kind: "created"; requestId: string; documentId: string }
  | {
      kind: "replay";
      requestId: string;
      documentId: string;
      state: DocumentUrlIntakeRequestState;
    }
  | { kind: "conflict"; existingDocumentId: string | null }
>;

export type FinalizeDocumentUrlIntake = Readonly<{
  tenantId: string;
  workspaceId: string;
  requestId: string;
  documentId: string;
  versionId: string;
  format: LaunchDocumentFormat;
  mediaType: string;
  declaredByteSize: number;
  scannerPolicyVersion: string;
  checksum: string;
  finalUrlSha256: string;
  redirectCount: number;
}>;

export type UrlIntakeFinalizePersistenceResult = Readonly<{
  kind: "quarantined" | "duplicate";
  versionId: string;
  checksum: string;
  processingVersionId: string;
  scanJobId: string | null;
  dispatchKey: string | null;
}>;

export type FailDocumentUrlIntake = Readonly<{
  tenantId: string;
  workspaceId: string;
  requestId: string;
  documentId: string;
  state: "blocked_security" | "rejected" | "failed";
  reasonCode: string;
}>;

export type UrlIntakeFailPersistenceResult = Readonly<{
  kind: "updated";
  state: "blocked_security" | "rejected" | "failed";
}>;

export interface DocumentUrlIntakeRepository {
  beginUrlIntake(input: BeginDocumentUrlIntake): Promise<UrlIntakeBeginPersistenceResult>;
  finalizeUrlIntake(input: FinalizeDocumentUrlIntake): Promise<UrlIntakeFinalizePersistenceResult | undefined>;
  failUrlIntake(input: FailDocumentUrlIntake): Promise<UrlIntakeFailPersistenceResult | undefined>;
  lookupUrlSource(input: DocumentUrlSourceLookup): Promise<DocumentUrlSource | undefined>;
}

/**
 * Server-side writer for objects fetched by the authorized URL intake. The
 * local-directory adapter satisfies this port today; private buckets bind later.
 */
export interface FetchedDocumentObjectWriter {
  writeFetchedObject(request: Readonly<{
    tenantId: string;
    workspaceId: string;
    documentId: string;
    versionId: string;
    objectKey: string;
    mediaType: string;
    bytes: Uint8Array;
  }>): Promise<unknown>;
}

export type DocumentUrlIntakeResult = Readonly<
  | {
      kind: "quarantined";
      requestId: string;
      documentId: string;
      versionId: string;
      checksum: string;
      processingVersionId: string;
      scanJobId: string;
      dispatchKey: string;
    }
  | {
      kind: "duplicate";
      requestId: string;
      documentId: string;
      versionId: string;
      checksum: string;
      processingVersionId: string;
    }
  | {
      kind: "replay";
      requestId: string;
      documentId: string;
      state: DocumentUrlIntakeRequestState;
    }
>;

const INTAKE_INPUT_FIELDS = [
  "tenantId", "workspaceId", "documentId", "requestId", "idempotencyKey",
  "url", "requestedName", "scannerPolicyVersion",
] as const;

type NormalizedUrlIntake = Readonly<{
  input: DocumentUrlIntakeInput;
  normalizedUrl: string;
  urlSha256: string;
}>;

function normalizeUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.length > MAX_URL_CHARACTERS) {
    throw boundaryError("The document URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw boundaryError("The document URL is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== "" || url.password !== "") {
    throw boundaryError("The document URL is invalid.");
  }
  const normalized = url.toString();
  if (normalized.length < 12 || normalized.length > MAX_URL_CHARACTERS) {
    throw boundaryError("The document URL is invalid.");
  }
  return url;
}

function normalizeIntakeInput(value: unknown): NormalizedUrlIntake {
  const input = snapshotRecord(value, INTAKE_INPUT_FIELDS);
  if (!input) throw boundaryError("The document URL intake request is invalid.");
  const url = normalizeUrl(input.url);
  if (typeof input.requestedName !== "string" || input.requestedName.length < 1
    || input.requestedName.length > 1024 || !NO_CONTROL.test(input.requestedName)) {
    throw boundaryError("The document URL intake request is invalid.");
  }
  const normalizedUrl = url.toString();
  return {
    input: {
      tenantId: canonicalUuid(input.tenantId),
      workspaceId: canonicalUuid(input.workspaceId),
      documentId: canonicalUuid(input.documentId),
      requestId: canonicalUuid(input.requestId),
      idempotencyKey: typeof input.idempotencyKey === "string"
        && IDEMPOTENCY_KEY.test(input.idempotencyKey)
        ? input.idempotencyKey
        : (() => { throw boundaryError("The document URL intake request is invalid."); })(),
      url: normalizedUrl,
      requestedName: input.requestedName,
      scannerPolicyVersion: typeof input.scannerPolicyVersion === "string"
        && POLICY_VERSION.test(input.scannerPolicyVersion)
        ? input.scannerPolicyVersion
        : (() => { throw boundaryError("The document URL intake request is invalid."); })(),
    },
    normalizedUrl,
    urlSha256: sha256Hex(normalizedUrl),
  };
}

function parseBeginResult(value: unknown, expected: NormalizedUrlIntake): UrlIntakeBeginPersistenceResult {
  const row = snapshotRecord(value, ["kind", "request_id", "document_id", "state"]);
  if (!row || (row.kind !== "created" && row.kind !== "replay" && row.kind !== "conflict")) {
    throw persistenceError();
  }
  if (row.kind === "conflict") {
    const existing = row.document_id;
    if (row.request_id !== null || row.state !== null
      || (existing !== null && (typeof existing !== "string" || !CANONICAL_UUID.test(existing)))) {
      throw persistenceError();
    }
    return Object.freeze({
      kind: "conflict",
      existingDocumentId: typeof existing === "string" ? existing.toLowerCase() : null,
    });
  }
  if (row.request_id !== expected.input.requestId
    || row.document_id !== expected.input.documentId) {
    throw persistenceError();
  }
  if (row.kind === "created") {
    if (row.state !== "fetching") throw persistenceError();
    return Object.freeze({
      kind: "created",
      requestId: expected.input.requestId,
      documentId: expected.input.documentId,
    });
  }
  const state = row.state;
  if (typeof state !== "string" || (state !== "fetching" && !TERMINAL_REQUEST_STATES.has(state))) {
    throw persistenceError();
  }
  return Object.freeze({
    kind: "replay",
    requestId: expected.input.requestId,
    documentId: expected.input.documentId,
    state: state as DocumentUrlIntakeRequestState,
  });
}

function parseFinalizeResult(
  value: unknown,
  expected: Readonly<{ versionId: string; checksum: string }>,
): UrlIntakeFinalizePersistenceResult {
  const row = snapshotRecord(value, [
    "kind", "version_id", "state", "checksum", "processing_version_id", "scan_job_id", "dispatch_key",
  ]);
  if (!row || (row.kind !== "quarantined" && row.kind !== "duplicate")
    || row.state !== "quarantined" || row.version_id !== expected.versionId
    || row.checksum !== expected.checksum
    || typeof row.processing_version_id !== "string"
    || !CANONICAL_UUID.test(row.processing_version_id)) {
    throw persistenceError();
  }
  if (row.kind === "duplicate") {
    if (row.scan_job_id !== null || row.dispatch_key !== null) throw persistenceError();
    return Object.freeze({
      kind: "duplicate",
      versionId: expected.versionId,
      checksum: expected.checksum,
      processingVersionId: (row.processing_version_id as string).toLowerCase(),
      scanJobId: null,
      dispatchKey: null,
    });
  }
  if (typeof row.scan_job_id !== "string" || !CANONICAL_UUID.test(row.scan_job_id)
    || typeof row.dispatch_key !== "string" || row.dispatch_key.length < 7
    || row.dispatch_key.length > 255) {
    throw persistenceError();
  }
  return Object.freeze({
    kind: "quarantined",
    versionId: expected.versionId,
    checksum: expected.checksum,
    processingVersionId: (row.processing_version_id as string).toLowerCase(),
    scanJobId: row.scan_job_id.toLowerCase(),
    dispatchKey: row.dispatch_key,
  });
}

function mediaTypeFormat(value: string | null): { format: LaunchDocumentFormat; mediaType: string } | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const format = URL_MEDIA_FORMATS.get(mediaType);
  return format ? { format, mediaType } : null;
}

async function readBoundedBody(response: Response, cap: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > cap) {
          overflow = true;
          break;
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already released; nothing else is required.
    }
    reader.releaseLock();
  }
  if (overflow) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function markFailed(
  repository: Pick<DocumentUrlIntakeRepository, "failUrlIntake">,
  request: FailDocumentUrlIntake,
): Promise<void> {
  try {
    await repository.failUrlIntake(freezeResult({ ...request }));
  } catch {
    // The request may already be terminal; the caller still receives the error.
  }
}

export type DocumentUrlIntakeDependencies = Readonly<{
  repository: DocumentUrlIntakeRepository;
  writer: FetchedDocumentObjectWriter;
  fetchImpl?: SafeHttpFetch;
  lookupImpl?: SafeHttpLookup;
  signal?: AbortSignal;
  createVersionId?: () => string;
}>;

/**
 * Authorized URL intake: records the request, fetches through the SSRF guard,
 * stores the verified bytes, and quarantines the version for scanning. Every
 * failure after the durable begin lands the request in a terminal state.
 */
export async function intakeDocumentFromUrl(
  rawInput: DocumentUrlIntakeInput,
  dependencies: DocumentUrlIntakeDependencies,
): Promise<DocumentUrlIntakeResult> {
  const normalized = normalizeIntakeInput(rawInput);
  const { input } = normalized;
  const failRequest = (state: FailDocumentUrlIntake["state"], reasonCode: string) =>
    markFailed(dependencies.repository, {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      documentId: input.documentId,
      state,
      reasonCode,
    });

  let rawBegin: unknown;
  try {
    rawBegin = await dependencies.repository.beginUrlIntake(freezeResult({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      urlSha256: normalized.urlSha256,
      normalizedUrl: normalized.normalizedUrl,
      requestedName: input.requestedName,
    }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
  const begin = parseBeginResult(rawBegin, normalized);
  if (begin.kind === "conflict") throw conflictError();
  if (begin.kind === "replay" && begin.state !== "fetching") {
    return freezeResult({
      kind: "replay",
      requestId: begin.requestId,
      documentId: begin.documentId,
      state: begin.state,
    });
  }

  let fetched: Awaited<ReturnType<typeof fetchSafeHttpUrl>>;
  try {
    fetched = await fetchSafeHttpUrl(normalized.normalizedUrl, {
      method: "GET",
      signal: dependencies.signal ?? null,
    }, {
      fetchImpl: dependencies.fetchImpl,
      lookupImpl: dependencies.lookupImpl,
      maxRedirects: MAX_REDIRECTS,
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      await failRequest("blocked_security", "unsafe_outbound_url");
      throw boundaryError("The document URL could not be fetched safely.");
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    await failRequest("failed", "fetch_failed");
    throw boundaryError("The document URL could not be fetched safely.");
  }

  const response = fetched.response;
  if (response.status !== 200) {
    await failRequest("rejected", "fetch_rejected");
    throw boundaryError("The document URL did not return a readable document.");
  }

  const resolved = mediaTypeFormat(response.headers.get("content-type"));
  if (!resolved) {
    await failRequest("rejected", "unsupported_media_type");
    throw boundaryError("The document URL returned an unsupported document type.");
  }
  const cap = resolved.format === "jpeg" || resolved.format === "png"
    ? IMAGE_MAX_FETCH_BYTES
    : DOCUMENT_MAX_FETCH_BYTES;
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declaredLength) && declaredLength > cap) {
    await failRequest("rejected", "content_too_large");
    throw boundaryError("The document URL returned a document that is too large.");
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(response, cap);
  } catch {
    await failRequest("failed", "fetch_failed");
    throw boundaryError("The document URL could not be fetched safely.");
  }
  if (!bytes || bytes.byteLength === 0) {
    await failRequest("rejected", bytes === null ? "content_too_large" : "empty_content");
    throw boundaryError("The document URL did not return a readable document.");
  }

  const checksum = sha256Hex(bytes);
  const versionId = (dependencies.createVersionId ?? randomUUID)().toLowerCase();
  if (!CANONICAL_UUID.test(versionId)) throw boundaryError();
  const objectKey = buildDocumentObjectKey({
    tenantId: input.tenantId,
    documentId: input.documentId,
    versionId,
    object: { kind: "original" },
  });

  try {
    await dependencies.writer.writeFetchedObject(freezeResult({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      versionId,
      objectKey,
      mediaType: resolved.mediaType,
      bytes,
    }));
  } catch {
    await failRequest("failed", "object_store_failed");
    throw boundaryError("The fetched document could not be stored safely.");
  }

  let rawFinalize: unknown;
  try {
    rawFinalize = await dependencies.repository.finalizeUrlIntake(freezeResult({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      documentId: input.documentId,
      versionId,
      format: resolved.format,
      mediaType: resolved.mediaType,
      declaredByteSize: bytes.byteLength,
      scannerPolicyVersion: input.scannerPolicyVersion,
      checksum,
      finalUrlSha256: sha256Hex(fetched.finalUrl),
      redirectCount: fetched.redirectCount,
    }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    await failRequest("failed", "finalize_rejected");
    throw persistenceError();
  }
  if (rawFinalize === undefined) {
    await failRequest("failed", "finalize_rejected");
    throw persistenceError();
  }
  const finalize = parseFinalizeResult(rawFinalize, { versionId, checksum });
  if (finalize.kind === "duplicate") {
    return freezeResult({
      kind: "duplicate",
      requestId: input.requestId,
      documentId: input.documentId,
      versionId: finalize.versionId,
      checksum: finalize.checksum,
      processingVersionId: finalize.processingVersionId,
    });
  }
  return freezeResult({
    kind: "quarantined",
    requestId: input.requestId,
    documentId: input.documentId,
    versionId: finalize.versionId,
    checksum: finalize.checksum,
    processingVersionId: finalize.processingVersionId,
    scanJobId: finalize.scanJobId as string,
    dispatchKey: finalize.dispatchKey as string,
  });
}

/**
 * Advisory duplicate lookup used by member surfaces before an intake begins;
 * the durable begin remains the authoritative dedupe decision.
 */
export async function lookupDocumentUrlSource(
  rawInput: DocumentUrlSourceLookup,
  dependencies: Readonly<{
    repository: Pick<DocumentUrlIntakeRepository, "lookupUrlSource">;
  }>,
): Promise<DocumentUrlSource | undefined> {
  const input = snapshotRecord(rawInput, ["tenantId", "workspaceId", "urlSha256"]);
  if (!input) throw boundaryError("The document URL lookup request is invalid.");
  const lookup = {
    tenantId: canonicalUuid(input.tenantId),
    workspaceId: canonicalUuid(input.workspaceId),
    urlSha256: typeof input.urlSha256 === "string" && /^[0-9a-f]{64}$/u.test(input.urlSha256)
      ? input.urlSha256
      : (() => { throw boundaryError("The document URL lookup request is invalid."); })(),
  };
  let result: unknown;
  try {
    result = await dependencies.repository.lookupUrlSource(freezeResult({ ...lookup }));
  } catch {
    throw persistenceError();
  }
  if (result === undefined) return undefined;
  const row = snapshotRecord(result, ["documentId", "normalizedUrl"]);
  if (!row || typeof row.documentId !== "string" || !CANONICAL_UUID.test(row.documentId)
    || typeof row.normalizedUrl !== "string" || row.normalizedUrl.length > MAX_URL_CHARACTERS) {
    throw persistenceError();
  }
  return freezeResult({
    documentId: row.documentId.toLowerCase(),
    normalizedUrl: row.normalizedUrl,
  });
}
