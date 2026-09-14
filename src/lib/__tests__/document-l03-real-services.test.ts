vi.mock("server-only", () => ({}));

// L03 real-service rehearsal suite — runs only inside the disposable podman
// stack provisioned by scripts/l03-real-services.mjs (NOVA_L03_REAL_SERVICES=1).
// Every assertion below exercises the production-capable wiring path:
//   resolveDocumentRuntimeServices -> Supabase Storage (private, HTTPS, real
//   service-role JWT) + clamd (real engine, real signature DB) -> the shared
//   adapter boundaries (reserveDocumentUpload / executeQuarantineScan).
// No mocks, no stubs, no transport seams.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

import { describe, expect, it, vi } from "vitest";

import {
  executeQuarantineScan,
  reserveDocumentUpload,
  type QuarantinedDocumentVersion,
} from "@/lib/documents";
import {
  executeDocumentExtraction,
  requestDocumentExtraction,
  type ClaimedExtractionLease,
  type RequestDocumentExtractionInput,
} from "@/lib/documents/pipeline-service";
import { resolveDocumentRuntimeServices } from "@/lib/documents/runtime-services";

const ENABLED = process.env.NOVA_L03_REAL_SERVICES === "1";

function req(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`rehearsal env ${name} is required`);
  return value;
}

const ORIGIN = ENABLED ? req("L03_STORAGE_ORIGIN") : "";
const BUCKET = ENABLED ? req("L03_BUCKET") : "";
const ANON_KEY = ENABLED ? req("L03_ANON_KEY") : "";
const CA = ENABLED ? readFileSync(req("L03_STORAGE_CA_FILE")) : Buffer.alloc(0);
const CLAMD_VERSION = ENABLED ? req("L03_CLAMD_VERSION") : "";
const POLICY = "launch-v1";

const TENANT_A = "11111111-1111-4111-8111-1111111111a1";
const TENANT_B = "99999999-9999-4999-8999-999999999999";
const WORKSPACE_A = "22222222-2222-4222-8222-2222222222a1";

const CLEAN_BYTES = new TextEncoder().encode("name,role\nAda,founder\n");
const EICAR_BYTES = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const DOC = (suffix: string) => `66666666-6666-4666-8666-6666666666${suffix}`;
const VER = (suffix: string) => `77777777-7777-4777-8777-7777777777${suffix}`;
const keyOf = (tenant: string, doc: string, ver: string) =>
  `tenants/${tenant}/documents/${doc}/versions/${ver}/original`;

function servicesEnv(overrides: Record<string, string> = {}) {
  return {
    NOVA_DOCUMENT_STORAGE_BACKEND: "supabase",
    NOVA_DOCUMENT_SCANNER_BACKEND: "clamd",
    NOVA_SUPABASE_STORAGE_ORIGIN: ORIGIN,
    NOVA_SUPABASE_STORAGE_BUCKET: BUCKET,
    SUPABASE_SERVICE_ROLE_KEY: req("L03_SERVICE_KEY"),
    NOVA_SUPABASE_STORAGE_TLS_CA_FILE: req("L03_STORAGE_CA_FILE"),
    NOVA_CLAMD_HOST: req("L03_CLAMD_HOST"),
    NOVA_CLAMD_PORT: req("L03_CLAMD_PORT"),
    NOVA_SCANNER_APPROVED_ID: "clamd-instream",
    NOVA_SCANNER_APPROVED_VERSION: CLAMD_VERSION,
    NOVA_SCANNER_POLICY_VERSION: POLICY,
    ...overrides,
  };
}

function quarantined(
  doc: string, ver: string, checksum: string, tenant: string = TENANT_A,
): QuarantinedDocumentVersion {
  return Object.freeze({
    tenantId: tenant,
    documentId: doc,
    versionId: ver,
    checksum,
    state: "quarantined" as const,
    objectKey: keyOf(tenant, doc, ver),
  });
}

/** Minimal bounded HTTPS client for raw provider calls (signed PUT, denial probes). */
function raw(
  method: string,
  target: string,
  options: Readonly<{
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
  }> = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method,
      ca: CA,
      headers: options.headers,
      signal: AbortSignal.timeout(15_000),
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > 1024 * 1024) {
          request.destroy(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function reserve(tenant: string, doc: string, ver: string, byteSize: number, mediaType: string) {
  const extension = mediaType === "text/plain" ? "txt" : "csv";
  return reserveDocumentUpload({
    tenantId: tenant,
    documentId: doc,
    versionId: ver,
    fileName: `rehearsal-upload.${extension}`,
    declaredMediaType: mediaType,
    declaredByteSize: byteSize,
  }, resolveDocumentRuntimeServices(servicesEnv()).storage);
}

async function writeObject(
  services: ReturnType<typeof resolveDocumentRuntimeServices>,
  doc: string,
  ver: string,
  bytes: Uint8Array,
  mediaType: string,
) {
  return services.storage.writeFetchedObject({
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    documentId: doc,
    versionId: ver,
    objectKey: keyOf(TENANT_A, doc, ver),
    mediaType,
    bytes,
  }) as Promise<{ objectKey: string }>;
}

const EXTRACTION_JOB = "88888888-8888-4888-8888-8888888888a1";

/**
 * Runs the production member request path and shapes the lease the claim RPC
 * would return. The in-memory repository stands in for
 * novatrade_request_document_extraction / novatrade_claim_document_extraction_job;
 * their clean-state + clean-scan-binding + lease-generation predicates are
 * proven on disposable Postgres by document-pipeline-l03-postgres.test.ts.
 */
async function extractionLease(
  doc: string,
  ver: string,
  checksum: string,
  mediaType: string,
): Promise<ClaimedExtractionLease> {
  const format = mediaType === "text/plain" ? "txt" : "csv";
  const captured: { input: RequestDocumentExtractionInput | null } = {
    input: null,
  };
  const request = await requestDocumentExtraction({
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    documentId: doc,
    versionId: ver,
    jobId: EXTRACTION_JOB,
    idempotencyKey: `l03-extract-${ver.slice(-2)}`,
    checksum,
    scannerPolicyVersion: POLICY,
    format,
    mediaType,
  }, {
    repository: {
      requestExtraction: async (input) => {
        captured.input = input;
        return {
          kind: "queued" as const,
          jobId: input.jobId,
          versionId: input.versionId,
          state: "queued" as const,
        };
      },
    },
  });
  const persisted = captured.input;
  if (!persisted || request.kind !== "queued") {
    throw new Error("extraction request fixture did not queue");
  }
  return {
    leaseToken: createHash("sha256").update(`lease-${EXTRACTION_JOB}`).digest("hex"),
    jobId: EXTRACTION_JOB,
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    documentId: doc,
    versionId: ver,
    objectKey: keyOf(TENANT_A, doc, ver),
    checksum,
    scannerPolicyVersion: POLICY,
    parserId: persisted.parserId,
    parserVersion: persisted.parserVersion,
    inputHash: persisted.inputHash,
    attempt: 1,
    maxAttempts: 3,
    leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    cancelRequested: false,
    versionState: "clean",
  };
}

describe.skipIf(!ENABLED)("L03 real-service rehearsal (supabase storage + clamd)", () => {
  it("reserves, uploads, reads, and scans a clean object end to end", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    expect(services.storageBackend).toBe("supabase");
    expect(services.scannerBackend).toBe("clamd");
    expect(services.uploadSink).toBeNull();

    const reservation = await reserve(
      TENANT_A, DOC("a1"), VER("a1"), CLEAN_BYTES.byteLength, "text/csv",
    );
    const expectedKey = keyOf(TENANT_A, DOC("a1"), VER("a1"));
    expect(reservation.objectKey).toBe(expectedKey);
    expect(reservation.visibility).toBe("private");
    expect(reservation.uploadUrl.startsWith(
      `${ORIGIN}/storage/v1/object/upload/sign/${BUCKET}/${expectedKey}?token=`,
    )).toBe(true);
    expect(Date.parse(reservation.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 300_000 + 5_000,
    );
    console.log(`REAL-SVC reservation bound to ${expectedKey}`);

    const put = await raw("PUT", reservation.uploadUrl, {
      headers: {
        "content-type": "text/csv",
        "content-length": String(CLEAN_BYTES.byteLength),
      },
      body: CLEAN_BYTES,
    });
    expect(put.status).toBe(200);
    console.log(`REAL-SVC signed PUT -> ${put.status}`);

    const read = await services.storage.readUploadedObject({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      documentId: DOC("a1"),
      versionId: VER("a1"),
      objectKey: expectedKey,
      maxBytes: 1_024,
    }) as { bytes: Uint8Array; mediaType: string; byteSize: number };
    expect(read.byteSize).toBe(CLEAN_BYTES.byteLength);
    expect(read.mediaType).toBe("text/csv");
    expect(Buffer.from(read.bytes).equals(Buffer.from(CLEAN_BYTES))).toBe(true);

    const scan = await executeQuarantineScan(
      quarantined(DOC("a1"), VER("a1"), sha256(CLEAN_BYTES)),
      POLICY,
      services.scanner,
    );
    expect(scan.version.state).toBe("clean");
    expect(scan.scan).toMatchObject({
      verdict: "clean",
      scannerAdapterId: "clamd-instream",
      scannerVersion: CLAMD_VERSION,
      scannedChecksum: sha256(CLEAN_BYTES),
      policyVersion: POLICY,
    });
    console.log(`REAL-SVC clean verdict via clamd ${CLAMD_VERSION}`);
  });

  it("detects the standard EICAR signature on real clamd", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    const doc = DOC("b1");
    const ver = VER("b1");
    const written = await writeObject(services, doc, ver, EICAR_BYTES, "text/plain");
    expect(written.objectKey).toBe(keyOf(TENANT_A, doc, ver));

    const scan = await executeQuarantineScan(
      quarantined(doc, ver, sha256(EICAR_BYTES)),
      POLICY,
      services.scanner,
    );
    expect(scan.version.state).toBe("infected");
    expect(scan.scan).toMatchObject({
      verdict: "infected",
      reasonCode: "malware_detected",
      scannedChecksum: sha256(EICAR_BYTES),
    });
    console.log("REAL-SVC EICAR -> infected (Eicar-Test-Signature)");
  });

  it("provider rejects a signed capability rebound to another object path", async () => {
    const reservation = await reserve(
      TENANT_A, DOC("c1"), VER("c1"), CLEAN_BYTES.byteLength, "text/csv",
    );
    const rebound = reservation.uploadUrl.replace(
      keyOf(TENANT_A, DOC("c1"), VER("c1")),
      keyOf(TENANT_A, DOC("c2"), VER("c2")),
    );
    expect(rebound).not.toBe(reservation.uploadUrl);
    const put = await raw("PUT", rebound, {
      headers: {
        "content-type": "text/csv",
        "content-length": String(CLEAN_BYTES.byteLength),
      },
      body: CLEAN_BYTES,
    });
    expect(put.status).toBe(400);
    expect(put.body.toString("utf8")).toContain("InvalidSignature");
    console.log("REAL-SVC rebound signed URL -> 400 InvalidSignature");
  });

  it("keeps quarantine objects unreachable without the service role", async () => {
    const objectKey = keyOf(TENANT_A, DOC("a1"), VER("a1"));
    const noAuth = await raw("GET",
      `${ORIGIN}/storage/v1/object/authenticated/${BUCKET}/${objectKey}`);
    expect(noAuth.status).not.toBe(200);
    const anon = await raw("GET",
      `${ORIGIN}/storage/v1/object/authenticated/${BUCKET}/${objectKey}`,
      { headers: { authorization: `Bearer ${ANON_KEY}` } });
    expect(anon.status).not.toBe(200);
    const publicPath = await raw("GET",
      `${ORIGIN}/storage/v1/object/public/${BUCKET}/${objectKey}`);
    expect(publicPath.status).not.toBe(200);
    console.log(
      `REAL-SVC private bucket: noAuth=${noAuth.status} anon=${anon.status} public=${publicPath.status}`,
    );
  });

  it("maps a refused clamd connection to a retryable scanner_error", async () => {
    // Write the object with the healthy bundle first, then scan through a
    // bundle pointed at a dead port: real ECONNREFUSED, not a stub.
    const writer = resolveDocumentRuntimeServices(servicesEnv());
    await writeObject(writer, DOC("e1"), VER("e1"), CLEAN_BYTES, "text/csv");
    const services = resolveDocumentRuntimeServices(
      servicesEnv({ NOVA_CLAMD_PORT: req("L03_CLAMD_DEAD_PORT") }),
    );
    const scan = await executeQuarantineScan(
      quarantined(DOC("e1"), VER("e1"), sha256(CLEAN_BYTES)),
      POLICY,
      services.scanner,
    );
    expect(scan.version.state).toBe("scanner_error");
    expect(scan.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_unavailable",
      retryable: true,
    });
    console.log("REAL-SVC dead clamd port -> provider_unavailable retryable");
  });

  it("refuses verdicts when the live engine is not the approved version", async () => {
    const writer = resolveDocumentRuntimeServices(servicesEnv());
    await writeObject(writer, DOC("e2"), VER("e2"), CLEAN_BYTES, "text/csv");
    const services = resolveDocumentRuntimeServices(
      servicesEnv({ NOVA_SCANNER_APPROVED_VERSION: "9.9.9" }),
    );
    const scan = await executeQuarantineScan(
      quarantined(DOC("e2"), VER("e2"), sha256(CLEAN_BYTES)),
      POLICY,
      services.scanner,
    );
    expect(scan.version.state).toBe("scanner_error");
    expect(scan.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_policy_error",
      retryable: false,
    });
    console.log("REAL-SVC unapproved engine version -> provider_policy_error");
  });

  it("fails closed when stored bytes drift from the leased checksum", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    const doc = DOC("d1");
    const ver = VER("d1");
    await writeObject(services, doc, ver, CLEAN_BYTES, "text/csv");
    const drifted = sha256(new TextEncoder().encode("different bytes"));
    const scan = await executeQuarantineScan(
      quarantined(doc, ver, drifted),
      POLICY,
      services.scanner,
    );
    expect(scan.version.state).toBe("scanner_error");
    expect(scan.scan.verdict).toBe("error");
    console.log("REAL-SVC checksum drift -> scanner_error (no verdict emitted)");
  });

  it("enforces tenant binding on delete and read against the live bucket", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    const foreignKey = keyOf(TENANT_B, DOC("e1"), VER("e1"));
    await expect(services.storage.deleteObject({
      tenantId: TENANT_A,
      objectKey: foreignKey,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
    await expect(services.storage.readUploadedObject({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      documentId: DOC("a1"),
      versionId: VER("a1"),
      objectKey: keyOf(TENANT_B, DOC("a1"), VER("a1")),
      maxBytes: 1_024,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
    console.log("REAL-SVC foreign-tenant key -> boundary error before network");
  });

  it("deletes a leased object and reports repeated deletes as absent", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    const doc = DOC("f1");
    const ver = VER("f1");
    const objectKey = keyOf(TENANT_A, doc, ver);
    await writeObject(services, doc, ver, CLEAN_BYTES, "text/csv");
    const first = await services.storage.deleteObject({ tenantId: TENANT_A, objectKey });
    const second = await services.storage.deleteObject({ tenantId: TENANT_A, objectKey });
    expect(first).toMatchObject({ objectKey, removed: true });
    expect(second).toMatchObject({ objectKey, removed: false });
    await expect(services.storage.readUploadedObject({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      documentId: doc,
      versionId: ver,
      objectKey,
      maxBytes: 1_024,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
    console.log("REAL-SVC delete -> removed:true then removed:false; read fails closed");
  });

  it("extracts cited content only after a real clean scan", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    const doc = DOC("7a");
    const ver = VER("7a");
    await writeObject(services, doc, ver, CLEAN_BYTES, "text/csv");

    const scan = await executeQuarantineScan(
      quarantined(doc, ver, sha256(CLEAN_BYTES)),
      POLICY,
      services.scanner,
    );
    expect(scan.version.state).toBe("clean");

    const lease = await extractionLease(doc, ver, sha256(CLEAN_BYTES), "text/csv");
    const finalize = await executeDocumentExtraction(lease, {
      reader: services.storage,
    });
    expect(
      finalize.outcome === "complete" || finalize.outcome === "review_required",
    ).toBe(true);
    expect(finalize.output).not.toBeNull();
    expect(finalize.output?.blockCount).toBeGreaterThan(0);
    const citations = finalize.output?.citations ?? [];
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].quote.length).toBeGreaterThan(0);
    expect(citations[0].sourceLocator).toBeTruthy();
    expect(finalize.output?.evidence?.length ?? 0).toBeGreaterThan(0);
    console.log(
      `REAL-SVC clean scan -> extraction outcome=${finalize.outcome} ` +
      `blocks=${finalize.output?.blockCount} citations=${citations.length}`,
    );
  });

  it("never reaches extraction or citations for infected or scanner-error outcomes", async () => {
    const writer = resolveDocumentRuntimeServices(servicesEnv());
    const doc = DOC("7b");
    const ver = VER("7b");
    await writeObject(writer, doc, ver, EICAR_BYTES, "text/plain");

    const infected = await executeQuarantineScan(
      quarantined(doc, ver, sha256(EICAR_BYTES)),
      POLICY,
      writer.scanner,
    );
    expect(infected.version.state).toBe("infected");

    // A refused/unreachable daemon lands on the same non-clean side.
    const deadServices = resolveDocumentRuntimeServices(
      servicesEnv({ NOVA_CLAMD_PORT: req("L03_CLAMD_DEAD_PORT") }),
    );
    const errored = await executeQuarantineScan(
      quarantined(doc, ver, sha256(EICAR_BYTES)),
      POLICY,
      deadServices.scanner,
    );
    expect(errored.version.state).toBe("scanner_error");

    // The production request RPC returns an empty result (mapped to
    // "unavailable") for any version not in clean/extraction_failed with a
    // bound clean scan; the member path rejects with illegal_transition and
    // no extraction job ever exists to lease or execute.
    const unavailableRepo = {
      requestExtraction: async () => ({ kind: "unavailable" as const }),
    };
    const deniedRequest = requestDocumentExtraction({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      documentId: doc,
      versionId: ver,
      jobId: "88888888-8888-4888-8888-8888888888b1",
      idempotencyKey: "l03-extract-denied-7b",
      checksum: sha256(EICAR_BYTES),
      scannerPolicyVersion: POLICY,
      format: "txt",
      mediaType: "text/plain",
    }, { repository: unavailableRepo });
    await expect(deniedRequest).rejects.toMatchObject({
      code: "illegal_transition",
    });

    // A forged lease that reaches the executor still cannot cite: the
    // executor re-reads the real object over HTTPS and re-verifies its
    // checksum against the lease before parsing.
    const forged = {
      ...(await extractionLease(doc, ver, sha256(EICAR_BYTES), "text/plain")),
      checksum: sha256(CLEAN_BYTES),
    };
    const forgedFinalize = await executeDocumentExtraction(forged, {
      reader: writer.storage,
    });
    expect(forgedFinalize.outcome).toBe("error");
    expect(forgedFinalize.errorCode).toBe("content_checksum_mismatch");
    expect(forgedFinalize.output).toBeNull();
    console.log(
      "REAL-SVC infected/error -> no extraction; forged lease -> " +
      "content_checksum_mismatch, no output",
    );
  });

  it("rejects a reservation request outside the capability contract", async () => {
    const services = resolveDocumentRuntimeServices(servicesEnv());
    await expect(services.storage.reserveUpload({
      objectKey: keyOf(TENANT_A, DOC("01"), VER("01")),
      expectedMediaType: "application/pdf",
      maxBytes: 128,
      expiresInSeconds: 600,
    } as never)).rejects.toMatchObject({ code: "storage_boundary_error" });
    console.log("REAL-SVC over-lived capability request -> boundary error");
  });
});
