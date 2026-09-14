import "server-only";

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isProxy } from "node:util/types";

import { DocumentIntakeError } from "./errors";
import type { UploadedDocumentReader } from "./intake-service";
import { buildDocumentObjectKey } from "./object-keys";
import type { DocumentObjectRemover } from "./pipeline-service";
import type {
  SupabasePrivateStorageBucketClient,
  SupabasePrivateUploadReservationRequest,
  SupabaseStorageClientLike,
} from "./supabase-storage-adapter";
import type { FetchedDocumentObjectWriter } from "./url-intake-service";
import { DOCUMENT_MAX_BYTES } from "./validation";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUARANTINE_OBJECT_KEY = new RegExp(
  `^tenants/${CANONICAL_UUID.source.slice(1, -1)}/documents/${CANONICAL_UUID.source.slice(1, -1)}/versions/${CANONICAL_UUID.source.slice(1, -1)}(?:/original|/derivatives/${CANONICAL_UUID.source.slice(1, -1)})$`,
  "u",
);
const SAFE_BUCKET_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/u;
const SAFE_MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const JWT_SEGMENT = /^[A-Za-z0-9_-]{8,8192}$/u;
const API_PREFIX = "/storage/v1";
const JSON_RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SIGNED_UPLOAD_CLOCK_SKEW_MS = 5_000;
const MAX_CA_BUNDLE_BYTES = 1024 * 1024;

export type SupabaseStorageHttpRequest = Readonly<{
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path including the /storage/v1 API prefix; only validated bucket/key segments are appended. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxResponseBytes: number;
  timeoutMs: number;
}>;

export type SupabaseStorageHttpResponse = Readonly<{
  status: number;
  body: Uint8Array;
}>;

export type SupabaseStorageTransport = (
  request: SupabaseStorageHttpRequest,
) => Promise<SupabaseStorageHttpResponse>;

export type SupabaseStorageClientOptions = Readonly<{
  /** Exact https origin (no port, no path) of the storage gateway. */
  serviceOrigin: string;
  serviceRoleKey: string;
  /** The single private quarantine bucket this client may address. */
  bucket: string;
  requestTimeoutMs?: number;
  /** Optional PEM bundle for a private/self-signed CA (local rehearsal only). */
  tlsCaFile?: string;
  /** Test seam; production callers leave this unset so node:https is used. */
  transport?: SupabaseStorageTransport;
}>;

export type SupabaseDocumentStorageClient =
  SupabaseStorageClientLike
  & UploadedDocumentReader
  & FetchedDocumentObjectWriter
  & DocumentObjectRemover
  & Readonly<{
    /** Raw bounded private read for the scanner provider; null only when absent. */
    readQuarantineObjectBytes(
      request: Readonly<{ objectKey: string }>,
    ): Promise<Uint8Array | null>;
  }>;

function boundaryError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "storage_boundary_error",
    "The storage provider could not complete the operation safely.",
  );
}

function dataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    if (required.some((key) => !Object.hasOwn(descriptors, key))) return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function exactServiceOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      value !== url.origin ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.hostname
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === "string" && CANONICAL_UUID.test(value)
    ? value.toLowerCase()
    : null;
}

function parseJsonRecord(body: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || isProxy(parsed) || Array.isArray(parsed)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return parsed as Record<string, unknown>;
}

function decodeSignedUploadToken(
  token: string,
  expectedUrlPath: string,
  expiresAtMs: number,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !JWT_SEGMENT.test(part))) {
    return false;
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = dataRecord(JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    ) as unknown, ["url", "upsert", "scope", "iat", "exp"], ["owner"]);
  } catch {
    return false;
  }
  if (
    !payload ||
    payload.url !== expectedUrlPath ||
    payload.upsert !== false ||
    payload.scope !== "upload" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp)
  ) {
    return false;
  }
  const expMs = (payload.exp as number) * 1_000;
  const iatMs = (payload.iat as number) * 1_000;
  const now = Date.now();
  // The issued capability must be usable now and must never outlive the
  // requested window by more than clock skew; a longer-lived token would be a
  // capability the application did not ask for.
  return expMs > now &&
    expMs <= expiresAtMs + SIGNED_UPLOAD_CLOCK_SKEW_MS &&
    iatMs <= now + SIGNED_UPLOAD_CLOCK_SKEW_MS;
}

function isNotFound(response: SupabaseStorageHttpResponse): boolean {
  if (response.status === 404) return true;
  const parsed = parseJsonRecord(response.body);
  return parsed !== null && (parsed.code === "NoSuchKey" || parsed.error === "not_found");
}

function httpsTransport(
  origin: string,
  tlsCa: Buffer | undefined,
): SupabaseStorageTransport {
  const url = new URL(origin);
  return (request) => new Promise((resolve, reject) => {
    const wire = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        servername: url.hostname,
        path: request.path,
        method: request.method,
        headers: request.headers,
        ...(tlsCa ? { ca: tlsCa } : {}),
        signal: AbortSignal.timeout(request.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > request.maxResponseBytes) {
            wire.destroy(new Error("storage_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve(Object.freeze({
            status: res.statusCode ?? 0,
            body: new Uint8Array(Buffer.concat(chunks)),
          }));
        });
        res.on("error", reject);
      },
    );
    wire.on("error", reject);
    if (request.body && request.body.byteLength > 0) wire.write(request.body);
    wire.end();
  });
}

export function createSupabaseStorageClient(
  options: SupabaseStorageClientOptions,
): SupabaseDocumentStorageClient {
  const config = dataRecord(options, ["serviceOrigin", "serviceRoleKey", "bucket"], [
    "requestTimeoutMs",
    "tlsCaFile",
    "transport",
  ]);
  if (!config) throw boundaryError();
  const serviceOrigin = exactServiceOrigin(config.serviceOrigin);
  const bucket = typeof config?.bucket === "string" && SAFE_BUCKET_NAME.test(config.bucket)
    ? config.bucket
    : null;
  const serviceRoleKey = typeof config?.serviceRoleKey === "string"
    && config.serviceRoleKey.length >= 32
    && config.serviceRoleKey.length <= 4_096
    && !/[\u0000-\u0020\u007f]/u.test(config.serviceRoleKey)
    ? config.serviceRoleKey
    : null;
  const timeoutMs = config?.requestTimeoutMs === undefined
    ? DEFAULT_REQUEST_TIMEOUT_MS
    : typeof config.requestTimeoutMs === "number"
        && Number.isSafeInteger(config.requestTimeoutMs)
        && config.requestTimeoutMs >= 1_000
        && config.requestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
      ? config.requestTimeoutMs
      : null;
  if (!serviceOrigin || !serviceRoleKey || !bucket || timeoutMs === null) {
    throw boundaryError();
  }
  const pinnedBucket = bucket;

  let tlsCa: Buffer | undefined;
  if (config.tlsCaFile !== undefined) {
    if (typeof config.tlsCaFile !== "string" || !config.tlsCaFile) throw boundaryError();
    try {
      // This is an operator-provisioned runtime trust bundle, not a build asset.
      tlsCa = readFileSync(/* turbopackIgnore: true */ config.tlsCaFile);
    } catch {
      throw boundaryError();
    }
    if (tlsCa.byteLength === 0 || tlsCa.byteLength > MAX_CA_BUNDLE_BYTES) {
      throw boundaryError();
    }
  }

  const transport = typeof config.transport === "function"
    ? config.transport
    : httpsTransport(serviceOrigin, tlsCa);
  const authorization = `Bearer ${serviceRoleKey}`;

  async function send(
    request: Readonly<{
      method: SupabaseStorageHttpRequest["method"];
      pathSuffix: string;
      headers?: Readonly<Record<string, string>>;
      body?: Uint8Array;
      maxResponseBytes: number;
    }>,
  ): Promise<SupabaseStorageHttpResponse> {
    try {
      return await transport({
        method: request.method,
        path: `${API_PREFIX}${request.pathSuffix}`,
        headers: { authorization, ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        maxResponseBytes: request.maxResponseBytes,
        timeoutMs: timeoutMs as number,
      });
    } catch {
      throw boundaryError();
    }
  }

  function requireBucket(value: unknown): string {
    // The client is pinned to one configured quarantine bucket; any other
    // bucket name — caller-supplied or provider-returned — is a violation.
    if (value !== pinnedBucket) throw boundaryError();
    return pinnedBucket;
  }

  function requireQuarantineKey(objectKey: unknown): string {
    if (typeof objectKey !== "string" || !QUARANTINE_OBJECT_KEY.test(objectKey)) {
      throw boundaryError();
    }
    return objectKey;
  }

  function parseReservationMetadata(value: unknown) {
    const metadata = dataRecord(value, [
      "tenantId", "documentId", "versionId", "objectClass",
      "expectedMediaType", "maxBytes",
    ]);
    if (
      !metadata ||
      canonicalUuid(metadata.tenantId) === null ||
      canonicalUuid(metadata.documentId) === null ||
      canonicalUuid(metadata.versionId) === null ||
      metadata.objectClass !== "quarantine-original" ||
      typeof metadata.expectedMediaType !== "string" ||
      !SAFE_MEDIA_TYPE.test(metadata.expectedMediaType) ||
      !Number.isSafeInteger(metadata.maxBytes) ||
      (metadata.maxBytes as number) < 1 ||
      (metadata.maxBytes as number) > DOCUMENT_MAX_BYTES
    ) {
      return null;
    }
    return Object.freeze({
      tenantId: metadata.tenantId,
      documentId: metadata.documentId,
      versionId: metadata.versionId,
      objectClass: "quarantine-original" as const,
      expectedMediaType: metadata.expectedMediaType,
      maxBytes: metadata.maxBytes as number,
    });
  }

  async function createSignedUploadReservation(
    bucket: string,
    request: SupabasePrivateUploadReservationRequest,
  ): Promise<unknown> {
    const parsed = dataRecord(request, [
      "bucket", "objectKey", "expiresAt", "visibility", "upsert", "metadata",
    ]);
    const expiresAtMs = typeof parsed?.expiresAt === "string"
      ? Date.parse(parsed.expiresAt)
      : Number.NaN;
    const metadata = parseReservationMetadata(parsed?.metadata);
    if (
      !parsed ||
      parsed.bucket !== bucket ||
      !metadata ||
      parsed.visibility !== "private" ||
      parsed.upsert !== false ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now() ||
      expiresAtMs > Date.now() + 300_000 + SIGNED_UPLOAD_CLOCK_SKEW_MS
    ) {
      throw boundaryError();
    }
    const objectKey = requireQuarantineKey(parsed.objectKey);

    const response = await send({
      method: "POST",
      pathSuffix: `/object/upload/sign/${bucket}/${objectKey}`,
      headers: {
        "x-upsert": "false",
        "x-metadata": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64"),
        "content-type": metadata.expectedMediaType,
      },
      maxResponseBytes: JSON_RESPONSE_MAX_BYTES,
    });
    if (response.status !== 200) throw boundaryError();

    const body = dataRecord(parseJsonRecord(response.body), ["url", "token"]);
    if (
      !body ||
      typeof body.url !== "string" ||
      typeof body.token !== "string" ||
      body.url !== `/object/upload/sign/${bucket}/${objectKey}?token=${body.token}` ||
      !decodeSignedUploadToken(
        body.token,
        `${bucket}/${objectKey}`,
        expiresAtMs,
      )
    ) {
      throw boundaryError();
    }

    return Object.freeze({
      data: Object.freeze({
        bucket,
        objectKey,
        signedUrl: `${serviceOrigin}${API_PREFIX}${body.url}`,
        expiresAt: parsed.expiresAt,
        visibility: "private" as const,
        upsert: false as const,
        metadata,
      }),
      error: null,
    });
  }

  async function readObjectInfo(
    bucket: string,
    objectKey: string,
  ): Promise<Readonly<{ size: number; contentType: string }>> {
    const response = await send({
      method: "GET",
      pathSuffix: `/object/info/authenticated/${bucket}/${objectKey}`,
      maxResponseBytes: JSON_RESPONSE_MAX_BYTES,
    });
    if (response.status !== 200) throw boundaryError();
    const info = dataRecord(
      parseJsonRecord(response.body),
      ["size", "content_type"],
      ["id", "name", "version", "bucket_id", "cache_control", "etag", "metadata",
        "last_modified", "created_at", "archived_at", "is_delete_marker", "is_versioned"],
    );
    if (
      !info ||
      !Number.isSafeInteger(info.size) ||
      (info.size as number) < 1 ||
      (info.size as number) > DOCUMENT_MAX_BYTES ||
      typeof info.content_type !== "string" ||
      !SAFE_MEDIA_TYPE.test(info.content_type)
    ) {
      throw boundaryError();
    }
    return Object.freeze({
      size: info.size as number,
      contentType: info.content_type,
    });
  }

  async function downloadObject(
    bucket: string,
    objectKey: string,
    maxBytes: number,
  ): Promise<Uint8Array | null> {
    const response = await send({
      method: "GET",
      pathSuffix: `/object/authenticated/${bucket}/${objectKey}`,
      maxResponseBytes: Math.min(maxBytes, DOCUMENT_MAX_BYTES) + 1,
    });
    if (isNotFound(response)) return null;
    if (response.status !== 200) throw boundaryError();
    if (response.body.byteLength < 1 || response.body.byteLength > maxBytes) {
      throw boundaryError();
    }
    return response.body;
  }

  async function readUploadedObject(
    request: Readonly<{
      tenantId: string;
      workspaceId: string;
      documentId: string;
      versionId: string;
      objectKey: string;
      maxBytes: number;
    }>,
  ): Promise<unknown> {
    const input = dataRecord(request, [
      "tenantId", "workspaceId", "documentId", "versionId", "objectKey", "maxBytes",
    ]);
    const tenantId = canonicalUuid(input?.tenantId);
    const workspaceId = canonicalUuid(input?.workspaceId);
    const documentId = canonicalUuid(input?.documentId);
    const versionId = canonicalUuid(input?.versionId);
    if (
      !input || !tenantId || !workspaceId || !documentId || !versionId ||
      typeof input.objectKey !== "string" ||
      !Number.isSafeInteger(input.maxBytes) ||
      (input.maxBytes as number) < 1 ||
      (input.maxBytes as number) > DOCUMENT_MAX_BYTES
    ) {
      throw boundaryError();
    }
    const expectedKey = buildDocumentObjectKey({
      tenantId,
      documentId,
      versionId,
      object: { kind: "original" },
    });
    if (input.objectKey !== expectedKey) throw boundaryError();
    const info = await readObjectInfo(pinnedBucket, expectedKey);
    if (info.size > (input.maxBytes as number)) throw boundaryError();
    const bytes = await downloadObject(pinnedBucket, expectedKey, input.maxBytes as number);
    if (bytes === null || bytes.byteLength !== info.size) throw boundaryError();
    return Object.freeze({
      objectKey: expectedKey,
      bytes,
      mediaType: info.contentType,
      byteSize: bytes.byteLength,
    });
  }

  async function writeFetchedObject(
    request: Readonly<{
      tenantId: string;
      workspaceId: string;
      documentId: string;
      versionId: string;
      objectKey: string;
      mediaType: string;
      bytes: Uint8Array;
    }>,
  ): Promise<unknown> {
    const input = dataRecord(request, [
      "tenantId", "workspaceId", "documentId", "versionId", "objectKey",
      "mediaType", "bytes",
    ]);
    const tenantId = canonicalUuid(input?.tenantId);
    const workspaceId = canonicalUuid(input?.workspaceId);
    const documentId = canonicalUuid(input?.documentId);
    const versionId = canonicalUuid(input?.versionId);
    if (
      !input || !tenantId || !workspaceId || !documentId || !versionId ||
      typeof input.objectKey !== "string" ||
      typeof input.mediaType !== "string" ||
      !SAFE_MEDIA_TYPE.test(input.mediaType) ||
      !(input.bytes instanceof Uint8Array) ||
      isProxy(input.bytes) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > DOCUMENT_MAX_BYTES
    ) {
      throw boundaryError();
    }
    const expectedKey = buildDocumentObjectKey({
      tenantId,
      documentId,
      versionId,
      object: { kind: "original" },
    });
    if (input.objectKey !== expectedKey) throw boundaryError();
    const bytes = input.bytes;
    const metadata = {
      tenantId,
      documentId,
      versionId,
      objectClass: "quarantine-original",
      expectedMediaType: input.mediaType,
      maxBytes: bytes.byteLength,
    };
    const response = await send({
      method: "POST",
      pathSuffix: `/object/${pinnedBucket}/${expectedKey}`,
      headers: {
        "x-upsert": "false",
        "x-metadata": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64"),
        "content-type": input.mediaType as string,
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
      maxResponseBytes: JSON_RESPONSE_MAX_BYTES,
    });
    if (response.status !== 200) throw boundaryError();
    const body = dataRecord(parseJsonRecord(response.body), ["Key"], ["Id"]);
    if (!body || body.Key !== `${pinnedBucket}/${expectedKey}`) throw boundaryError();
    return Object.freeze({ objectKey: expectedKey, byteSize: bytes.byteLength });
  }

  async function deleteObject(
    request: Readonly<{ tenantId: string; objectKey: string }>,
  ): Promise<unknown> {
    const input = dataRecord(request, ["tenantId", "objectKey"]);
    const tenantId = canonicalUuid(input?.tenantId);
    if (!input || !tenantId || typeof input.objectKey !== "string") {
      throw boundaryError();
    }
    const objectKey = requireQuarantineKey(input.objectKey);
    if (!objectKey.startsWith(`tenants/${tenantId}/`)) throw boundaryError();
    const response = await send({
      method: "DELETE",
      pathSuffix: `/object/${pinnedBucket}/${objectKey}`,
      maxResponseBytes: JSON_RESPONSE_MAX_BYTES,
    });
    if (isNotFound(response)) {
      return Object.freeze({ objectKey, removed: false });
    }
    if (response.status !== 200) throw boundaryError();
    return Object.freeze({ objectKey, removed: true });
  }

  return Object.freeze({
    storage: Object.freeze({
      from(bucketName: unknown): SupabasePrivateStorageBucketClient {
        const checked = requireBucket(bucketName);
        return Object.freeze({
          createSignedUploadReservation: (
            request: SupabasePrivateUploadReservationRequest,
          ) => createSignedUploadReservation(checked, request),
        });
      },
    }),
    readUploadedObject,
    writeFetchedObject,
    deleteObject,
    async readQuarantineObjectBytes(
      request: Readonly<{ objectKey: string }>,
    ): Promise<Uint8Array | null> {
      const input = dataRecord(request, ["objectKey"]);
      if (!input) throw boundaryError();
      const objectKey = requireQuarantineKey(input.objectKey);
      return downloadObject(pinnedBucket, objectKey, DOCUMENT_MAX_BYTES);
    },
  });
}
