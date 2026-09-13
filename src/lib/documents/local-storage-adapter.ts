import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";

import type { DocumentStorageAdapter, StorageUploadRequest } from "./adapters";
import { DocumentIntakeError } from "./errors";
import type { UploadedDocumentReader } from "./intake-service";
import type { DocumentObjectRemover } from "./pipeline-service";
import type { FetchedDocumentObjectWriter } from "./url-intake-service";
import { DOCUMENT_MAX_BYTES } from "./validation";

const CANONICAL_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OBJECT_KEY = new RegExp(
  `^tenants/(${CANONICAL_UUID})/documents/(${CANONICAL_UUID})/versions/(${CANONICAL_UUID})(?:/original|/derivatives/(${CANONICAL_UUID}))$`,
  "u",
);
const SAFE_MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,15}$/u;
const SIGNING_SECRET_MIN_CHARS = 32;
const META_SUFFIX = ".meta.json";

export type LocalDocumentStoreOptions = Readonly<{
  rootDir: string;
  signingSecret: string;
  /** Required to mint upload URLs; the receive path works without it. */
  uploadOrigin?: string;
  now?: () => number;
}>;

export type LocalUploadCapability = Readonly<{
  objectKey: string;
  mediaType: string;
  byteSize: number;
  expiresAt: string;
}>;

export type LocalUploadAcceptance = Readonly<{
  objectKey: string;
  byteSize: number;
}>;

function boundaryError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "storage_boundary_error",
    "The local document object store could not complete the operation safely.",
  );
}

function dataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
      || required.some((key) => !Object.hasOwn(descriptors, key))) {
      return null;
    }
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

function exactUploadOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.pathname !== "/" || url.search !== "" || url.hash !== "" || !url.hostname) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function resolveObjectPath(rootDir: string, objectKey: string): string {
  if (typeof objectKey !== "string" || !OBJECT_KEY.test(objectKey)) {
    throw new DocumentIntakeError(
      "unsafe_object_key",
      "Document object keys must be canonical tenant-bound storage paths.",
    );
  }
  const resolved = path.resolve(rootDir, ...objectKey.split("/"));
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw boundaryError();
  return resolved;
}

/**
 * Reads raw object bytes by canonical key for worker-side consumers (scanner,
 * re-extraction) whose port does not carry the member-facing identity fields.
 * The key itself is the authority boundary; a missing or oversized object
 * returns null rather than throwing so callers can pick a retryable verdict.
 */
export async function readLocalDocumentObject(
  rootDir: string,
  objectKey: unknown,
): Promise<Uint8Array | null> {
  if (typeof rootDir !== "string" || rootDir.length === 0 || rootDir.length > 512) {
    throw boundaryError();
  }
  const objectPath = resolveObjectPath(rootDir, typeof objectKey === "string" ? objectKey : "");
  try {
    const fileStat = await stat(objectPath);
    if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > DOCUMENT_MAX_BYTES) {
      return null;
    }
    return new Uint8Array(await readFile(objectPath));
  } catch {
    return null;
  }
}

export function createLocalDocumentStore(
  options: LocalDocumentStoreOptions,
): DocumentStorageAdapter & UploadedDocumentReader & FetchedDocumentObjectWriter
  & DocumentObjectRemover & Readonly<{
    verifyUploadCapability(query: unknown): LocalUploadCapability;
    acceptSignedUpload(input: unknown): Promise<LocalUploadAcceptance>;
  }> {
  const config = dataRecord(options, ["rootDir", "signingSecret"], ["uploadOrigin", "now"]);
  const rootDir = typeof config?.rootDir === "string" && config.rootDir.length > 0
    && config.rootDir.length <= 512 ? path.resolve(config.rootDir) : null;
  const signingSecret = typeof config?.signingSecret === "string"
    && config.signingSecret.length >= SIGNING_SECRET_MIN_CHARS
    && config.signingSecret.length <= 256 ? config.signingSecret : null;
  const uploadOrigin = config?.uploadOrigin === undefined
    || config.uploadOrigin === null ? null : exactUploadOrigin(config.uploadOrigin);
  const now = typeof config?.now === "function" ? config.now : () => Date.now();
  if (rootDir === null || signingSecret === null) throw boundaryError();
  if (config?.uploadOrigin !== undefined && config.uploadOrigin !== null
    && uploadOrigin === null) throw boundaryError();

  function signatureFor(
    objectKey: string,
    mediaType: string,
    byteSize: number,
    expiresAtMs: number,
  ): string {
    return createHmac("sha256", signingSecret as string)
      .update(`v1\n${objectKey}\n${mediaType}\n${byteSize}\n${expiresAtMs}`)
      .digest("hex");
  }

  async function writeObject(
    objectPath: string,
    objectKey: string,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, bytes);
    await writeFile(`${objectPath}${META_SUFFIX}`, JSON.stringify({
      objectKey,
      mediaType,
      byteSize: bytes.byteLength,
    }));
  }

  async function removeObject(objectPath: string): Promise<void> {
    try {
      await unlink(objectPath);
    } catch {
      // Missing objects are already gone; removal stays idempotent.
    }
    try {
      await unlink(`${objectPath}${META_SUFFIX}`);
    } catch {
      // Sidecar removal is best-effort when the object itself is absent.
    }
  }

  return Object.freeze({
    async reserveUpload(request: StorageUploadRequest): Promise<unknown> {
      const input = dataRecord(request, ["objectKey", "expectedMediaType", "maxBytes", "expiresInSeconds"]);
      if (uploadOrigin === null) throw boundaryError();
      const expiresInSeconds = typeof input?.expiresInSeconds === "number"
        && Number.isSafeInteger(input.expiresInSeconds)
        && input.expiresInSeconds >= 1 && input.expiresInSeconds <= 300
        ? input.expiresInSeconds : null;
      const maxBytes = typeof input?.maxBytes === "number" && Number.isSafeInteger(input.maxBytes)
        && input.maxBytes >= 1 && input.maxBytes <= DOCUMENT_MAX_BYTES ? input.maxBytes : null;
      const mediaType = typeof input?.expectedMediaType === "string"
        && SAFE_MEDIA_TYPE.test(input.expectedMediaType) ? input.expectedMediaType : null;
      const objectKey = typeof input?.objectKey === "string" ? input.objectKey : null;
      if (expiresInSeconds === null || maxBytes === null || mediaType === null
        || objectKey === null) throw boundaryError();
      resolveObjectPath(rootDir as string, objectKey);

      const expiresAtMs = now() + expiresInSeconds * 1000;
      const signature = signatureFor(objectKey, mediaType, maxBytes, expiresAtMs);
      const uploadUrl = new URL("/api/documents/upload", `${uploadOrigin}/`);
      uploadUrl.searchParams.set("key", objectKey);
      uploadUrl.searchParams.set("mt", mediaType);
      uploadUrl.searchParams.set("bytes", String(maxBytes));
      uploadUrl.searchParams.set("expires", String(expiresAtMs));
      uploadUrl.searchParams.set("sig", signature);
      return Object.freeze({
        objectKey,
        uploadUrl: uploadUrl.toString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        visibility: "private" as const,
      });
    },

    async readUploadedObject(request: Readonly<{
      tenantId: string;
      workspaceId: string;
      documentId: string;
      versionId: string;
      objectKey: string;
      maxBytes: number;
    }>): Promise<unknown> {
      const input = dataRecord(request, [
        "tenantId", "workspaceId", "documentId", "versionId", "objectKey", "maxBytes",
      ]);
      const maxBytes = typeof input?.maxBytes === "number" && Number.isSafeInteger(input.maxBytes)
        && input.maxBytes >= 1 && input.maxBytes <= DOCUMENT_MAX_BYTES ? input.maxBytes : null;
      if (!input || maxBytes === null
        || typeof input.tenantId !== "string" || typeof input.workspaceId !== "string"
        || typeof input.documentId !== "string" || typeof input.versionId !== "string") {
        throw boundaryError();
      }
      const objectKey = input.objectKey as string;
      const expectedKey = `tenants/${(input.tenantId as string).toLowerCase()}/documents/${
        (input.documentId as string).toLowerCase()}/versions/${(input.versionId as string).toLowerCase()}/original`;
      if (objectKey !== expectedKey) throw boundaryError();
      const objectPath = resolveObjectPath(rootDir as string, objectKey);

      let meta: Record<string, unknown> | null;
      let bytes: Uint8Array;
      try {
        const rawMeta = await readFile(`${objectPath}${META_SUFFIX}`, "utf8");
        meta = dataRecord(JSON.parse(rawMeta), ["objectKey", "mediaType", "byteSize"]);
      } catch {
        throw boundaryError();
      }
      try {
        const fileStat = await stat(objectPath);
        if (!fileStat.isFile() || fileStat.size > maxBytes || fileStat.size < 1) {
          throw boundaryError();
        }
        bytes = new Uint8Array(await readFile(objectPath));
      } catch (error) {
        if (error instanceof DocumentIntakeError) throw error;
        throw boundaryError();
      }
      if (!meta || meta.objectKey !== objectKey || meta.byteSize !== bytes.byteLength
        || typeof meta.mediaType !== "string" || !SAFE_MEDIA_TYPE.test(meta.mediaType)
        || bytes.byteLength > maxBytes) {
        throw boundaryError();
      }
      return Object.freeze({
        objectKey,
        bytes,
        mediaType: meta.mediaType,
        byteSize: bytes.byteLength,
      });
    },

    async writeFetchedObject(request: Readonly<{
      tenantId: string;
      workspaceId: string;
      documentId: string;
      versionId: string;
      objectKey: string;
      mediaType: string;
      bytes: Uint8Array;
    }>): Promise<unknown> {
      const input = dataRecord(request, [
        "tenantId", "workspaceId", "documentId", "versionId", "objectKey", "mediaType", "bytes",
      ]);
      const mediaType = typeof input?.mediaType === "string" && SAFE_MEDIA_TYPE.test(input.mediaType)
        ? input.mediaType : null;
      if (!input || mediaType === null
        || !(input.bytes instanceof Uint8Array) || isProxy(input.bytes)
        || input.bytes.byteLength < 1 || input.bytes.byteLength > DOCUMENT_MAX_BYTES) {
        throw boundaryError();
      }
      const objectPath = resolveObjectPath(rootDir as string, input.objectKey as string);
      try {
        await writeObject(objectPath, input.objectKey as string, mediaType, new Uint8Array(input.bytes));
      } catch {
        throw boundaryError();
      }
      return Object.freeze({ objectKey: input.objectKey, byteSize: input.bytes.byteLength });
    },

    async deleteObject(request: Readonly<{ tenantId: string; objectKey: string }>): Promise<unknown> {
      const input = dataRecord(request, ["tenantId", "objectKey"]);
      if (!input || typeof input.tenantId !== "string") throw boundaryError();
      const objectKey = input.objectKey as string;
      if (!objectKey.startsWith(`tenants/${input.tenantId.toLowerCase()}/`)) throw boundaryError();
      const objectPath = resolveObjectPath(rootDir as string, objectKey);
      let removed = false;
      try {
        removed = (await stat(objectPath)).isFile();
      } catch {
        removed = false;
      }
      await removeObject(objectPath);
      return Object.freeze({ objectKey, removed });
    },

    verifyUploadCapability(query: unknown): LocalUploadCapability {
      const input = dataRecord(query, ["key", "mt", "bytes", "expires", "sig"]);
      const byteSize = typeof input?.bytes === "string" && DECIMAL.test(input.bytes)
        ? Number.parseInt(input.bytes, 10) : Number.NaN;
      const expiresAtMs = typeof input?.expires === "string" && DECIMAL.test(input.expires)
        ? Number.parseInt(input.expires, 10) : Number.NaN;
      if (!input || typeof input.key !== "string" || typeof input.mt !== "string"
        || !SAFE_MEDIA_TYPE.test(input.mt)
        || typeof input.sig !== "string" || !SIGNATURE_HEX.test(input.sig)
        || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > DOCUMENT_MAX_BYTES
        || !Number.isSafeInteger(expiresAtMs)) {
        throw new DocumentIntakeError("malformed_signature", "The upload capability is malformed.");
      }
      const objectKey = input.key;
      resolveObjectPath(rootDir as string, objectKey);
      const expected = signatureFor(objectKey, input.mt, byteSize, expiresAtMs);
      const provided = Buffer.from(input.sig, "utf8");
      const wanted = Buffer.from(expected, "utf8");
      if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)
        || expiresAtMs <= now() || expiresAtMs > now() + 300_000 + 60_000) {
        throw new DocumentIntakeError("malformed_signature", "The upload capability is invalid.");
      }
      return Object.freeze({
        objectKey,
        mediaType: input.mt,
        byteSize,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    },

    async acceptSignedUpload(input: unknown): Promise<LocalUploadAcceptance> {
      const body = dataRecord(input, ["capability", "bytes", "contentType"]);
      const capability = dataRecord(body?.capability, ["objectKey", "mediaType", "byteSize", "expiresAt"]);
      if (!body || !capability
        || !(body.bytes instanceof Uint8Array) || isProxy(body.bytes)
        || typeof body.contentType !== "string"
        || typeof capability.objectKey !== "string"
        || typeof capability.mediaType !== "string" || !SAFE_MEDIA_TYPE.test(capability.mediaType)
        || !Number.isSafeInteger(capability.byteSize) || (capability.byteSize as number) < 1
        || (capability.byteSize as number) > DOCUMENT_MAX_BYTES
        || typeof capability.expiresAt !== "string"
        || !Number.isFinite(Date.parse(capability.expiresAt))
        || Date.parse(capability.expiresAt) <= now()) {
        throw boundaryError();
      }
      const bytes = body.bytes;
      if (bytes.byteLength !== capability.byteSize) {
        throw new DocumentIntakeError("size_mismatch", "The uploaded object does not match its reservation size.");
      }
      if (body.contentType !== capability.mediaType) {
        throw new DocumentIntakeError("type_mismatch", "The uploaded object media type is not its reservation.");
      }
      const objectKey = capability.objectKey as string;
      const objectPath = resolveObjectPath(rootDir as string, objectKey);
      try {
        await writeObject(objectPath, objectKey, capability.mediaType, new Uint8Array(bytes));
      } catch {
        throw boundaryError();
      }
      return Object.freeze({ objectKey, byteSize: bytes.byteLength });
    },
  });
}
