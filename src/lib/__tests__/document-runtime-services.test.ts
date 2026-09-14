vi.mock("server-only", () => ({}));

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentRuntimeServices } from "@/lib/documents/runtime-services";

const STORAGE_BACKEND = "NOVA_DOCUMENT_STORAGE_BACKEND";
const SCANNER_BACKEND = "NOVA_DOCUMENT_SCANNER_BACKEND";
const LOCAL_ACCEPTANCE = "NOVA_DOCUMENT_LOCAL_ACCEPTANCE";
const SUPABASE_URL = "NOVA_SUPABASE_STORAGE_ORIGIN";
const SUPABASE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const SUPABASE_BUCKET = "NOVA_SUPABASE_STORAGE_BUCKET";
const SCANNER_ID = "NOVA_SCANNER_APPROVED_ID";
const SCANNER_VERSION = "NOVA_SCANNER_APPROVED_VERSION";
const SCANNER_POLICY = "NOVA_SCANNER_POLICY_VERSION";
const CLAMD_HOST = "NOVA_CLAMD_HOST";
const CLAMD_PORT = "NOVA_CLAMD_PORT";
const LOCAL_ROOT = "NOVA_DOCUMENT_STORE_ROOT";
const LOCAL_SECRET = "NOVA_DOCUMENT_SIGNING_SECRET";
const LOCAL_ORIGIN = "NOVA_DOCUMENT_UPLOAD_ORIGIN";

const MANAGED_ENV_KEYS = [
  STORAGE_BACKEND, SCANNER_BACKEND, SUPABASE_URL, SUPABASE_KEY, SUPABASE_BUCKET,
  SCANNER_ID, SCANNER_VERSION, SCANNER_POLICY, CLAMD_HOST, CLAMD_PORT,
  LOCAL_ROOT, LOCAL_SECRET, LOCAL_ORIGIN, LOCAL_ACCEPTANCE,
] as const;

const PRODUCTION_ENV: Readonly<Record<string, string>> = {
  [STORAGE_BACKEND]: "supabase",
  [SCANNER_BACKEND]: "clamd",
  [SUPABASE_URL]: "https://storage.rehearsal.test",
  [SUPABASE_KEY]: `service-role-jwt-${"k".repeat(64)}`,
  [SUPABASE_BUCKET]: "nova-quarantine",
  [SCANNER_ID]: "clamd-instream",
  [SCANNER_VERSION]: "1.5.4",
  [SCANNER_POLICY]: "launch-v1",
  [CLAMD_HOST]: "127.0.0.1",
  [CLAMD_PORT]: "3310",
};

let localRoot = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  localRoot = await mkdtemp(path.join(tmpdir(), "nova-rt-env-"));
  savedEnv = Object.fromEntries(
    MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
});

afterEach(async () => {
  for (const key of MANAGED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(localRoot, { recursive: true, force: true });
});

function localEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [STORAGE_BACKEND]: "local",
    [SCANNER_BACKEND]: "local",
    [LOCAL_ACCEPTANCE]: "1",
    [SCANNER_POLICY]: "launch-v1",
    [LOCAL_ROOT]: localRoot,
    [LOCAL_SECRET]: `local-signing-${"s".repeat(40)}`,
    [LOCAL_ORIGIN]: "https://uploads.rehearsal.test",
    ...overrides,
  };
}

describe("document runtime service selection", () => {
  it("fails closed when no storage backend is selected", () => {
    expect(() => resolveDocumentRuntimeServices({}))
      .toThrowError(expect.objectContaining({ code: "storage_boundary_error" }));
  });

  it.each([
    { label: "garbage storage backend", env: { [STORAGE_BACKEND]: "s3", [SCANNER_BACKEND]: "local" } },
    { label: "garbage scanner backend", env: { [STORAGE_BACKEND]: "local", [SCANNER_BACKEND]: "s3" } },
    {
      label: "local mode without the acceptance gate",
      env: { [STORAGE_BACKEND]: "local", [SCANNER_BACKEND]: "local" },
    },
    {
      label: "production storage with local scanner",
      env: { ...PRODUCTION_ENV, [SCANNER_BACKEND]: "local" },
    },
  ])("fails closed on $label", ({ env }) => {
    expect(() => resolveDocumentRuntimeServices(env))
      .toThrowError(expect.objectContaining({ code: "storage_boundary_error" }));
  });

  it.each([
    { label: "service role key", remove: SUPABASE_KEY },
    { label: "private bucket", remove: SUPABASE_BUCKET },
    { label: "approved scanner version", remove: SCANNER_VERSION },
    { label: "scanner policy version", remove: SCANNER_POLICY },
  ])("fails closed when supabase+clamd mode is missing the $label", ({ remove }) => {
    const env = { ...PRODUCTION_ENV };
    delete (env as Record<string, string>)[remove];
    expect(() => resolveDocumentRuntimeServices(env))
      .toThrowError(expect.objectContaining({ code: "storage_boundary_error" }));
  });

  it("fails closed when the supabase URL is not HTTPS", () => {
    expect(() => resolveDocumentRuntimeServices({
      ...PRODUCTION_ENV,
      [SUPABASE_URL]: "http://storage.rehearsal.test",
    })).toThrowError(expect.objectContaining({ code: "storage_boundary_error" }));
  });

  it("selects the production-capable supabase + clamd bundle", () => {
    const services = resolveDocumentRuntimeServices(PRODUCTION_ENV);
    expect(services.storageBackend).toBe("supabase");
    expect(services.scannerBackend).toBe("clamd");
    expect(services.uploadSink).toBeNull();
    expect(typeof services.storage.reserveUpload).toBe("function");
    expect(typeof services.storage.readUploadedObject).toBe("function");
    expect(typeof services.storage.writeFetchedObject).toBe("function");
    expect(typeof services.storage.deleteObject).toBe("function");
    expect(typeof services.scanner.scan).toBe("function");
  });

  it("selects local adapters only behind the explicit acceptance gate", () => {
    const services = resolveDocumentRuntimeServices(localEnv());
    expect(services.storageBackend).toBe("local");
    expect(services.scannerBackend).toBe("local");
    expect(services.uploadSink).not.toBeNull();
  });

  it("supports local storage with a real clamd scanner under the acceptance gate", () => {
    const services = resolveDocumentRuntimeServices(localEnv({
      [SCANNER_BACKEND]: "clamd",
      [SCANNER_ID]: "clamd-instream",
      [SCANNER_VERSION]: "1.5.4",
      [SCANNER_POLICY]: "launch-v1",
      [CLAMD_HOST]: "127.0.0.1",
      [CLAMD_PORT]: "3310",
    }));
    expect(services.storageBackend).toBe("local");
    expect(services.scannerBackend).toBe("clamd");
    expect(services.uploadSink).not.toBeNull();
  });

  it("never exposes the local upload sink under the supabase backend", () => {
    const services = resolveDocumentRuntimeServices({
      ...PRODUCTION_ENV,
      [LOCAL_ACCEPTANCE]: "1",
      [LOCAL_ROOT]: localRoot,
      [LOCAL_SECRET]: `local-signing-${"s".repeat(40)}`,
      [LOCAL_ORIGIN]: "https://uploads.rehearsal.test",
    });
    expect(services.uploadSink).toBeNull();
  });
});
