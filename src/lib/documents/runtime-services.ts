import "server-only";

import { isProxy } from "node:util/types";

import type { DocumentStorageAdapter, MalwareScannerAdapter } from "./adapters";
import { createClamdScannerProvider } from "./clamd-scanner-provider";
import { DocumentIntakeError } from "./errors";
import type { UploadedDocumentReader } from "./intake-service";
import { createLocalDocumentScanner } from "./local-scanner-adapter";
import {
  createLocalDocumentStore,
  readLocalDocumentObject,
} from "./local-storage-adapter";
import type { DocumentObjectRemover } from "./pipeline-service";
import { ScannerProviderAdapter } from "./scanner-provider-adapter";
import { SupabaseDocumentStorageAdapter } from "./supabase-storage-adapter";
import { createSupabaseStorageClient } from "./supabase-storage-client";
import type { FetchedDocumentObjectWriter } from "./url-intake-service";

const STORAGE_BACKEND_ENV = "NOVA_DOCUMENT_STORAGE_BACKEND";
const SCANNER_BACKEND_ENV = "NOVA_DOCUMENT_SCANNER_BACKEND";
const LOCAL_ACCEPTANCE_ENV = "NOVA_DOCUMENT_LOCAL_ACCEPTANCE";
const STORE_ROOT_ENV = "NOVA_DOCUMENT_STORE_ROOT";
const SIGNING_SECRET_ENV = "NOVA_DOCUMENT_SIGNING_SECRET";
const UPLOAD_ORIGIN_ENV = "NOVA_DOCUMENT_UPLOAD_ORIGIN";
const SCANNER_POLICY_ENV = "NOVA_SCANNER_POLICY_VERSION";
const BLOCKED_CHECKSUMS_ENV = "NOVA_SCANNER_BLOCKED_SHA256";
const SUPABASE_ORIGIN_ENV = "NOVA_SUPABASE_STORAGE_ORIGIN";
const SUPABASE_BUCKET_ENV = "NOVA_SUPABASE_STORAGE_BUCKET";
const SUPABASE_ALLOWED_BUCKETS_ENV = "NOVA_SUPABASE_STORAGE_ALLOWED_BUCKETS";
const SUPABASE_ALLOWED_ORIGINS_ENV = "NOVA_SUPABASE_STORAGE_ALLOWED_ORIGINS";
const SUPABASE_SERVICE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";
const SUPABASE_TIMEOUT_ENV = "NOVA_SUPABASE_STORAGE_TIMEOUT_MS";
const SUPABASE_TLS_CA_FILE_ENV = "NOVA_SUPABASE_STORAGE_TLS_CA_FILE";
const CLAMD_HOST_ENV = "NOVA_CLAMD_HOST";
const CLAMD_PORT_ENV = "NOVA_CLAMD_PORT";
const CLAMD_CONNECT_TIMEOUT_ENV = "NOVA_CLAMD_CONNECT_TIMEOUT_MS";
const CLAMD_SCAN_TIMEOUT_ENV = "NOVA_CLAMD_SCAN_TIMEOUT_MS";
const SCANNER_APPROVED_ID_ENV = "NOVA_SCANNER_APPROVED_ID";
const SCANNER_APPROVED_VERSION_ENV = "NOVA_SCANNER_APPROVED_VERSION";

const SHA256_LIST_ITEM = /^[0-9a-f]{64}$/u;
const PORT_MAX = 65_535;
const DEFAULT_STORE_ROOT = ".data/document-objects";
const DEFAULT_CLAMD_PORT = 3310;
const DEFAULT_SCANNER_ID = "clamd-instream";

export type DocumentRuntimeStorage =
  DocumentStorageAdapter
  & UploadedDocumentReader
  & FetchedDocumentObjectWriter
  & DocumentObjectRemover;

export type DocumentUploadSink = Pick<
  ReturnType<typeof createLocalDocumentStore>,
  "verifyUploadCapability" | "acceptSignedUpload"
>;

export type DocumentRuntimeServices = Readonly<{
  storageBackend: "local" | "supabase";
  scannerBackend: "local" | "clamd";
  /** Combined object-store port: upload reservation, verified read, write, delete. */
  storage: DocumentRuntimeStorage;
  scanner: MalwareScannerAdapter;
  /**
   * The member-facing signed-upload receiver exists only for the explicitly
   * gated local backend; production uploads go straight to the provider's
   * signed URL, so this is null unless the local backend was selected.
   */
  uploadSink: DocumentUploadSink | null;
}>;

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function configurationError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "storage_boundary_error",
    "Document runtime services are not configured for a safe backend.",
  );
}

function envValue(env: RuntimeEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function requiredEnv(env: RuntimeEnv, name: string): string {
  const value = envValue(env, name);
  if (!value) throw configurationError();
  return value;
}

function boundedInt(
  env: RuntimeEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = envValue(env, name);
  if (!raw) return fallback;
  if (!/^[0-9]{1,10}$/u.test(raw)) throw configurationError();
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configurationError();
  }
  return value;
}

function csvList(env: RuntimeEnv, name: string): readonly string[] | null {
  const raw = envValue(env, name);
  if (!raw) return null;
  const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 && values.length <= 32 ? values : null;
}

/**
 * Resolves the document object-store + scanner wiring from the environment.
 * There is no implicit default: local adapters bind only under the explicit
 * local-acceptance gate, and any incomplete or contradictory production
 * configuration fails closed rather than silently degrading.
 */
export function resolveDocumentRuntimeServices(
  env: RuntimeEnv = process.env,
): DocumentRuntimeServices {
  if (!env || typeof env !== "object" || isProxy(env)) throw configurationError();

  const storageBackend = envValue(env, STORAGE_BACKEND_ENV);
  const scannerBackend = envValue(env, SCANNER_BACKEND_ENV);
  if (
    (storageBackend !== "local" && storageBackend !== "supabase") ||
    (scannerBackend !== "local" && scannerBackend !== "clamd")
  ) {
    throw configurationError();
  }
  // The local scanner can only read local objects; pairing it with a remote
  // bucket would fabricate object_unreadable errors, so it is rejected here.
  if (scannerBackend === "local" && storageBackend !== "local") {
    throw configurationError();
  }
  const localSelected = storageBackend === "local" || scannerBackend === "local";
  if (localSelected && envValue(env, LOCAL_ACCEPTANCE_ENV) !== "1") {
    throw configurationError();
  }

  const policyVersion = requiredEnv(env, SCANNER_POLICY_ENV);

  if (storageBackend === "local") {
    const store = createLocalDocumentStore({
      rootDir: envValue(env, STORE_ROOT_ENV) || DEFAULT_STORE_ROOT,
      signingSecret: requiredEnv(env, SIGNING_SECRET_ENV),
      uploadOrigin: requiredEnv(env, UPLOAD_ORIGIN_ENV),
    });
    const scanner = scannerBackend === "local"
      ? createLocalDocumentScanner({
        rootDir: envValue(env, STORE_ROOT_ENV) || DEFAULT_STORE_ROOT,
        blockedChecksums: (envValue(env, BLOCKED_CHECKSUMS_ENV) || "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => SHA256_LIST_ITEM.test(value)),
      })
      : new ScannerProviderAdapter(
        createClamdScannerProvider({
          host: requiredEnv(env, CLAMD_HOST_ENV),
          port: boundedInt(env, CLAMD_PORT_ENV, DEFAULT_CLAMD_PORT, 1, PORT_MAX),
          connectTimeoutMs: boundedInt(
            env, CLAMD_CONNECT_TIMEOUT_ENV, 5_000, 100, 30_000,
          ),
          scanTimeoutMs: boundedInt(
            env, CLAMD_SCAN_TIMEOUT_ENV, 120_000, 1_000, 300_000,
          ),
          objectSource: (objectKey) =>
            readLocalDocumentObject(
              envValue(env, STORE_ROOT_ENV) || DEFAULT_STORE_ROOT,
              objectKey,
            ),
        }),
        {
          enabled: true,
          approvedScannerId: envValue(env, SCANNER_APPROVED_ID_ENV)
            || DEFAULT_SCANNER_ID,
          approvedScannerVersion: requiredEnv(env, SCANNER_APPROVED_VERSION_ENV),
          approvedPolicyVersion: policyVersion,
        },
      );
    return Object.freeze({
      storageBackend: "local",
      scannerBackend,
      storage: store,
      scanner,
      uploadSink: store,
    });
  }

  const serviceOrigin = requiredEnv(env, SUPABASE_ORIGIN_ENV);
  const bucket = requiredEnv(env, SUPABASE_BUCKET_ENV);
  const allowedBuckets = csvList(env, SUPABASE_ALLOWED_BUCKETS_ENV) ?? [bucket];
  const allowedOrigins = csvList(env, SUPABASE_ALLOWED_ORIGINS_ENV) ?? [serviceOrigin];
  const client = createSupabaseStorageClient({
    serviceOrigin,
    serviceRoleKey: requiredEnv(env, SUPABASE_SERVICE_KEY_ENV),
    bucket,
    requestTimeoutMs: boundedInt(env, SUPABASE_TIMEOUT_ENV, 10_000, 1_000, 60_000),
    ...(envValue(env, SUPABASE_TLS_CA_FILE_ENV)
      ? { tlsCaFile: envValue(env, SUPABASE_TLS_CA_FILE_ENV) }
      : {}),
  });
  const storage = new SupabaseDocumentStorageAdapter(client, {
    bucket,
    allowedBuckets,
    serviceOrigin,
    allowedOrigins,
  });
  const scanner = new ScannerProviderAdapter(
    createClamdScannerProvider({
      host: requiredEnv(env, CLAMD_HOST_ENV),
      port: boundedInt(env, CLAMD_PORT_ENV, DEFAULT_CLAMD_PORT, 1, PORT_MAX),
      connectTimeoutMs: boundedInt(
        env, CLAMD_CONNECT_TIMEOUT_ENV, 5_000, 100, 30_000,
      ),
      scanTimeoutMs: boundedInt(
        env, CLAMD_SCAN_TIMEOUT_ENV, 120_000, 1_000, 300_000,
      ),
      objectSource: (objectKey) =>
        client.readQuarantineObjectBytes({ objectKey }),
    }),
    {
      enabled: true,
      approvedScannerId: envValue(env, SCANNER_APPROVED_ID_ENV)
        || DEFAULT_SCANNER_ID,
      approvedScannerVersion: requiredEnv(env, SCANNER_APPROVED_VERSION_ENV),
      approvedPolicyVersion: policyVersion,
    },
  );

  return Object.freeze({
    storageBackend: "supabase",
    scannerBackend: "clamd",
    storage: Object.freeze({
      reserveUpload: (request: Parameters<typeof storage.reserveUpload>[0]) =>
        storage.reserveUpload(request),
      readUploadedObject: client.readUploadedObject,
      writeFetchedObject: client.writeFetchedObject,
      deleteObject: client.deleteObject,
    }),
    scanner,
    uploadSink: null,
  });
}

let cached: DocumentRuntimeServices | null = null;

/**
 * Process-wide runtime services. The environment is resolved once per process;
 * a misconfigured deployment fails on first use and stays failed, never
 * silently falling back to a weaker backend.
 */
export function documentRuntimeServices(): DocumentRuntimeServices {
  cached ??= resolveDocumentRuntimeServices(process.env);
  return cached;
}
