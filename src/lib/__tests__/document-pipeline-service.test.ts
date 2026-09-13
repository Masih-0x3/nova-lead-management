import { describe, expect, it } from "vitest";

import {
  applyDocumentDeletion,
  cancelDocumentExtraction,
  discoverDocumentDeletionRequests,
  discoverDocumentExtractionLeaseLosses,
  discoverDocumentRetentionSubjects,
  discoverDocumentScanLeaseLosses,
  documentExtractionInputHash,
  evaluateDocumentRetention,
  recoverDocumentExtractionLease,
  recoverDocumentScanLease,
  requestDocumentExtraction,
  submitDocumentDeletionRequest,
  type DocumentPipelineRepository,
} from "@/lib/documents";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const DELETION_REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const CHECKSUM = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const OBJECT_KEY = `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/original`;
type Repo = Partial<DocumentPipelineRepository>;

function persistenceBoundary(error: unknown): asserts error is { code: string } {
  expect(error).toMatchObject({ name: "DocumentIntakeError", code: "persistence_boundary_error" });
}

function intakeBoundary(error: unknown, code = "intake_boundary_error") {
  expect(error).toMatchObject({ name: "DocumentIntakeError", code });
}

describe("worker discovery sweeps", () => {
  it("returns validated scan lease-loss identifiers", async () => {
    const repository: Repo = {
      discoverScanLeaseLosses: async (limit) => {
        expect(limit).toBe(5);
        return [{ jobId: JOB_ID, tenantId: TENANT_ID, workspaceId: WORKSPACE_ID }];
      },
    };
    const losses = await discoverDocumentScanLeaseLosses({ limit: 5 }, { repository });
    expect(losses).toEqual([{ jobId: JOB_ID, tenantId: TENANT_ID, workspaceId: WORKSPACE_ID }]);
  });

  it("rejects out-of-range limits before touching the repository", async () => {
    const repository: Repo = {
      discoverScanLeaseLosses: async () => {
        throw new Error("must not be called");
      },
    };
    for (const limit of [0, 101, 1.5, "5", null]) {
      try {
        await discoverDocumentScanLeaseLosses(
          { limit: limit as number },
          { repository },
        );
        expect.unreachable();
      } catch (error) {
        intakeBoundary(error);
      }
    }
  });

  it("fails closed on malformed discovery rows", async () => {
    const repository: Repo = {
      discoverExtractionLeaseLosses: async () => [
        { jobId: "not-a-uuid", tenantId: TENANT_ID, workspaceId: WORKSPACE_ID },
      ],
    };
    try {
      await discoverDocumentExtractionLeaseLosses({ limit: 10 }, { repository });
      expect.unreachable();
    } catch (error) {
      persistenceBoundary(error);
    }
  });

  it("rejects discovery rows carrying extra keys", async () => {
    const repository: Repo = {
      discoverRetentionSubjects: async () => [{
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        tenant_id: TENANT_ID,
      }],
    };
    try {
      await discoverDocumentRetentionSubjects({ limit: 10 }, { repository });
      expect.unreachable();
    } catch (error) {
      persistenceBoundary(error);
    }
  });

  it("returns validated deletion request references", async () => {
    const repository: Repo = {
      discoverDeletionRequests: async () => [
        { requestId: REQUEST_ID, tenantId: TENANT_ID, workspaceId: WORKSPACE_ID },
      ],
    };
    const refs = await discoverDocumentDeletionRequests({ limit: 10 }, { repository });
    expect(refs).toEqual([
      { requestId: REQUEST_ID, tenantId: TENANT_ID, workspaceId: WORKSPACE_ID },
    ]);
  });
});

describe("lease recovery", () => {
  it("recovers a scan lease under the job-fenced scope", async () => {
    const seen: string[] = [];
    const repository: Repo = {
      recoverScanLease: async (jobId) => {
        seen.push(jobId);
        return { kind: "requeued", jobId, state: "queued" };
      },
    };
    const result = await recoverDocumentScanLease({ jobId: JOB_ID }, { repository });
    expect(result).toEqual({ kind: "requeued", jobId: JOB_ID, state: "queued" });
    expect(seen).toEqual([JOB_ID]);
  });

  it("passes an unavailable recovery through unchanged", async () => {
    const repository: Repo = {
      recoverExtractionLease: async () => ({ kind: "unavailable" }),
    };
    const result = await recoverDocumentExtractionLease({ jobId: JOB_ID }, { repository });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("rejects a recovery echo that does not match the job", async () => {
    const repository: Repo = {
      recoverScanLease: async () => ({
        kind: "requeued",
        jobId: "99999999-9999-4999-8999-999999999999",
        state: "queued",
      }),
    };
    try {
      await recoverDocumentScanLease({ jobId: JOB_ID }, { repository });
      expect.unreachable();
    } catch (error) {
      persistenceBoundary(error);
    }
  });
});

describe("evaluateDocumentRetention", () => {
  const subject = {
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    versionState: "ready",
    objectKey: OBJECT_KEY,
    checksum: CHECKSUM,
    isCurrentVersion: false,
    retentionExpiresAt: "2026-01-01T00:00:00.000Z",
    priorInputSha256: null,
    policyVersion: "document-retention-v1",
    legalHoldActive: false,
    supportHoldActive: false,
  };

  it("records a purge-eligible evaluation and returns the staged deletion request", async () => {
    const repository: Repo = {
      getRetentionSubject: async (input) => {
        expect(input).toEqual({ documentId: DOCUMENT_ID, versionId: VERSION_ID });
        return { kind: "subject", subject };
      },
      recordRetentionEvaluation: async (input) => {
        expect(input.disposition).toBe("purge_eligible");
        expect(input.reason).toBe("retention_elapsed");
        return {
          kind: "recorded_purge",
          documentId: DOCUMENT_ID,
          versionId: VERSION_ID,
          disposition: "purge_eligible",
          reason: "retention_elapsed",
          deletionRequestId: DELETION_REQUEST_ID,
        };
      },
    };
    const result = await evaluateDocumentRetention(
      { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, versionId: VERSION_ID },
      { repository, evaluatedAt: "2026-08-30T00:00:00.000Z" },
    );
    expect(result).toEqual({
      kind: "recorded_purge",
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      disposition: "purge_eligible",
      reason: "retention_elapsed",
      deletionRequestId: DELETION_REQUEST_ID,
    });
  });

  it("defers retention for a live legal hold without persisting", async () => {
    const repository: Repo = {
      getRetentionSubject: async () => ({
        kind: "subject",
        subject: { ...subject, legalHoldActive: true },
      }),
      recordRetentionEvaluation: async () => {
        throw new Error("must not persist a deferred evaluation");
      },
    };
    const result = await evaluateDocumentRetention(
      { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, versionId: VERSION_ID },
      { repository, evaluatedAt: "2026-08-30T00:00:00.000Z" },
    );
    expect(result).toMatchObject({
      kind: "deferred",
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      disposition: "retain",
      reason: "legal_hold_active",
    });
  });

  it("rejects a subject whose object key does not bind to the claimed identity", async () => {
    const repository: Repo = {
      getRetentionSubject: async () => ({
        kind: "subject",
        subject: {
          ...subject,
          objectKey: `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/99999999-9999-4999-8999-999999999999/original`,
        },
      }),
    };
    try {
      await evaluateDocumentRetention(
        { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, versionId: VERSION_ID },
        { repository },
      );
      expect.unreachable();
    } catch (error) {
      persistenceBoundary(error);
    }
  });
});

describe("applyDocumentDeletion", () => {
  const pendingRequest = {
    requestId: REQUEST_ID,
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    state: "pending",
    versionState: "deletion_pending",
    objectKey: OBJECT_KEY,
  };

  it("removes the object before recording the tombstone", async () => {
    const order: string[] = [];
    const repository: Repo = {
      getDeletionRequest: async () => ({ kind: "request", request: pendingRequest }),
      applyDeletion: async () => {
        order.push("apply");
        return { kind: "applied", requestId: REQUEST_ID, versionState: "deleted" };
      },
    };
    const remover = {
      deleteObject: async (request: { tenantId: string; objectKey: string }) => {
        order.push("delete");
        expect(request).toEqual({ tenantId: TENANT_ID, objectKey: OBJECT_KEY });
        return { objectKey: request.objectKey, removed: true };
      },
    };
    const result = await applyDocumentDeletion({ requestId: REQUEST_ID }, { repository, remover });
    expect(result).toEqual({ kind: "applied", requestId: REQUEST_ID, versionState: "deleted" });
    expect(order).toEqual(["delete", "apply"]);
  });

  it("never touches storage when the request is not pending", async () => {
    const repository: Repo = {
      getDeletionRequest: async () => ({
        kind: "request",
        request: { ...pendingRequest, state: "applied", versionState: "deleted" },
      }),
      applyDeletion: async () => ({
        kind: "replay", requestId: REQUEST_ID, versionState: "deleted",
      }),
    };
    const remover = {
      deleteObject: async () => {
        throw new Error("storage must not be touched for terminal requests");
      },
    };
    const result = await applyDocumentDeletion({ requestId: REQUEST_ID }, { repository, remover });
    expect(result).toEqual({ kind: "replay", requestId: REQUEST_ID, versionState: "deleted" });
  });

  it("fails closed when the recorded object key is not canonical for the version", async () => {
    const repository: Repo = {
      getDeletionRequest: async () => ({
        kind: "request",
        request: {
          ...pendingRequest,
          objectKey: `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/derivatives/99999999-9999-4999-8999-999999999999`,
        },
      }),
    };
    const remover = {
      deleteObject: async () => ({ objectKey: "x", removed: true }),
    };
    try {
      await applyDocumentDeletion({ requestId: REQUEST_ID }, { repository, remover });
      expect.unreachable();
    } catch (error) {
      persistenceBoundary(error);
    }
  });

  it("fails closed when the remover echoes a different object key", async () => {
    const repository: Repo = {
      getDeletionRequest: async () => ({ kind: "request", request: pendingRequest }),
      applyDeletion: async () => {
        throw new Error("must not record a tombstone after a bad removal echo");
      },
    };
    const remover = {
      deleteObject: async () => ({ objectKey: "tenants/evil", removed: true }),
    };
    try {
      await applyDocumentDeletion({ requestId: REQUEST_ID }, { repository, remover });
      expect.unreachable();
    } catch (error) {
      persistenceBoundary(error);
    }
  });
});

describe("submitDocumentDeletionRequest", () => {
  const input = {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    requestId: REQUEST_ID,
    reasonCode: "member_requested" as const,
  };

  it("returns the staged request", async () => {
    const repository: Repo = {
      requestDeletion: async (request) => {
        expect(request.requestId).toBe(REQUEST_ID);
        return { kind: "requested", requestId: REQUEST_ID, state: "deletion_pending" };
      },
    };
    const result = await submitDocumentDeletionRequest(input, { repository });
    expect(result).toEqual({
      kind: "requested", requestId: REQUEST_ID, state: "deletion_pending",
    });
  });

  it("maps an incident-hold denial to a typed error", async () => {
    const repository: Repo = {
      requestDeletion: async () => ({ kind: "denied", requestId: null, state: "retained_for_incident" }),
    };
    try {
      await submitDocumentDeletionRequest(input, { repository });
      expect.unreachable();
    } catch (error) {
      intakeBoundary(error, "incident_hold_active");
    }
  });

  it("maps replay to the recorded state without a new request id", async () => {
    const repository: Repo = {
      requestDeletion: async () => ({ kind: "replay", requestId: null, state: "ready" }),
    };
    const result = await submitDocumentDeletionRequest(input, { repository });
    expect(result).toEqual({ kind: "replay", requestId: null, state: "ready" });
  });
});

describe("requestDocumentExtraction", () => {
  const input = {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    jobId: JOB_ID,
    idempotencyKey: "extraction-request-0001",
    checksum: CHECKSUM,
    scannerPolicyVersion: "launch-v1",
    format: "txt" as const,
    mediaType: "text/plain",
  };

  it("queues a job with a deterministic input hash", async () => {
    const repository: Repo = {
      requestExtraction: async (request) => {
        expect(request.inputHash).toBe(documentExtractionInputHash({
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          versionId: VERSION_ID,
          checksum: CHECKSUM,
          scannerPolicyVersion: "launch-v1",
          parserId: request.parserId,
          parserVersion: request.parserVersion,
          format: "txt",
          mediaType: "text/plain",
          maxChunkUtf8Bytes: 1024 * 1024,
          maxBlocksPerChunk: 1024,
        }));
        return { kind: "queued", jobId: JOB_ID, versionId: VERSION_ID, state: "queued" };
      },
    };
    const result = await requestDocumentExtraction(input, { repository });
    expect(result).toEqual({
      kind: "queued", jobId: JOB_ID, versionId: VERSION_ID, state: "queued",
    });
  });

  it("rejects a media type that does not match the format's parser", async () => {
    const repository: Repo = {
      requestExtraction: async () => {
        throw new Error("must not be called");
      },
    };
    try {
      await requestDocumentExtraction(
        { ...input, mediaType: "application/pdf" },
        { repository },
      );
      expect.unreachable();
    } catch (error) {
      intakeBoundary(error, "type_mismatch");
    }
  });

  it("maps an idempotency conflict to a typed error", async () => {
    const repository: Repo = {
      requestExtraction: async () => ({ kind: "conflict" }),
    };
    try {
      await requestDocumentExtraction(input, { repository });
      expect.unreachable();
    } catch (error) {
      intakeBoundary(error, "idempotency_conflict");
    }
  });
});

describe("cancelDocumentExtraction", () => {
  it("returns the cancellation outcome", async () => {
    const repository: Repo = {
      cancelExtraction: async () => ({ kind: "cancel_requested", jobId: JOB_ID, state: "running" }),
    };
    const result = await cancelDocumentExtraction(
      { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, jobId: JOB_ID },
      { repository },
    );
    expect(result).toEqual({ kind: "cancel_requested", jobId: JOB_ID, state: "running" });
  });

  it("maps an ineligible job to an illegal-transition error", async () => {
    const repository: Repo = {
      cancelExtraction: async () => ({ kind: "unavailable" }),
    };
    try {
      await cancelDocumentExtraction(
        { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID, jobId: JOB_ID },
        { repository },
      );
      expect.unreachable();
    } catch (error) {
      intakeBoundary(error, "illegal_transition");
    }
  });
});
