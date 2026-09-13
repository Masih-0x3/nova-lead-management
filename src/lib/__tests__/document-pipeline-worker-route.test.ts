vi.mock("server-only", () => ({}));

import { NextRequest } from "next/server";
import { vi } from "vitest";

import { describe, expect, it } from "vitest";

import {
  assertDocumentPipelineWorkerScope,
} from "@/lib/documents/pipeline-db";
import {
  documentPipelineBoundScope,
  documentPipelineDiscoveryScope,
  documentPipelineWorkerBody,
  workerBodyLimit,
  workerBodyUuid,
} from "@/lib/documents/pipeline-worker-route";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function request(body?: unknown) {
  return new NextRequest("https://worker.internal/api/documents/scan/process", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

describe("documentPipelineDiscoveryScope", () => {
  it("builds a null-tenant scope with a full job/run/lease identity", () => {
    const scope = documentPipelineDiscoveryScope();
    expect(scope.tenantId).toBeNull();
    expect(scope.workspaceId).toBeNull();
    expect(scope.jobId).toMatch(UUID);
    expect(scope.runId).toMatch(UUID);
    expect(scope.leaseId).toMatch(UUID);
    expect(scope.leaseGeneration).toBe(1);
    expect(() => assertDocumentPipelineWorkerScope({
      ...scope,
      action: "document_scan:process",
      principalKind: "cron",
      correlationId: "test-correlation",
    })).not.toThrow();
  });
});

describe("documentPipelineBoundScope", () => {
  it("binds tenant, workspace, job, and the issued lease generation", () => {
    const scope = documentPipelineBoundScope({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseGeneration: 7,
    });
    expect(scope).toMatchObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseGeneration: 7,
    });
    expect(scope.runId).toMatch(UUID);
    expect(scope.leaseId).toMatch(UUID);
    expect(() => assertDocumentPipelineWorkerScope({
      ...scope,
      action: "document_extraction:process",
      principalKind: "session",
      correlationId: "test-correlation",
    })).not.toThrow();
  });

  it("rejects a bound scope without a workspace", () => {
    expect(() => assertDocumentPipelineWorkerScope({
      tenantId: TENANT_ID,
      workspaceId: null,
      jobId: JOB_ID,
      runId: REQUEST_ID,
      leaseId: REQUEST_ID,
      leaseGeneration: 1,
      action: "document_scan:process",
      principalKind: "cron",
      correlationId: "test",
    })).toThrowError(expect.objectContaining({ name: "DocumentIntakeError" }));
  });
});

describe("worker body readers", () => {
  it("parses a plain JSON object once", async () => {
    const body = await documentPipelineWorkerBody(request({ jobId: JOB_ID, limit: 42 }));
    expect(workerBodyUuid(body, "jobId")).toBe(JOB_ID);
    expect(workerBodyLimit(body, 25)).toBe(42);
  });

  it("treats a missing or malformed body as empty", async () => {
    for (const req of [request(), request("not-json"), request([1, 2]), request("null")]) {
      const body = await documentPipelineWorkerBody(req);
      expect(workerBodyUuid(body, "jobId")).toBeNull();
      expect(workerBodyLimit(body, 25)).toBe(25);
    }
  });

  it("ignores non-canonical selector values", async () => {
    for (const value of ["NOT-A-UUID", JOB_ID.toUpperCase(), 42, {}, "  "]) {
      const body = await documentPipelineWorkerBody(request({ requestId: value }));
      if (typeof value === "string" && UUID.test(value)) {
        expect(workerBodyUuid(body, "requestId")).toBe(value.toLowerCase());
      } else {
        expect(workerBodyUuid(body, "requestId")).toBeNull();
      }
    }
  });

  it("clamps sweep limits into the 1..100 window", async () => {
    const cases: [number, number][] = [[0, 1], [1, 1], [100, 100], [500, 100], [-3, 1]];
    for (const [input, expected] of cases) {
      const body = await documentPipelineWorkerBody(request({ limit: input }));
      expect(workerBodyLimit(body, 25)).toBe(expected);
    }
    const fallback = await documentPipelineWorkerBody(request({ limit: 3.5 }));
    expect(workerBodyLimit(fallback, 25)).toBe(25);
  });
});
