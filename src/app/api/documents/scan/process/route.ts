import { NextRequest, NextResponse } from "next/server";

import {
  claimDocumentScanJob,
  executeDocumentScan,
  persistDocumentScanResult,
} from "@/lib/documents/intake-service";
import { createLocalDocumentScanner } from "@/lib/documents/local-scanner-adapter";
import {
  documentPipelineBoundScope,
  documentPipelineDiscoveryScope,
  documentPipelineWorkerBody,
  runDocumentPipelineWorkerRoute,
  workerBodyUuid,
} from "@/lib/documents/pipeline-worker-route";
import { createPostgresDocumentIntakeRepository } from "@/lib/documents/postgres-intake-repository";
import { applyNoStoreHeaders } from "@/lib/http-cache";

const STORE_ROOT_ENV = "NOVA_DOCUMENT_STORE_ROOT";
const BLOCKED_CHECKSUMS_ENV = "NOVA_SCANNER_BLOCKED_SHA256";

function localScanner() {
  const rootDir = process.env[STORE_ROOT_ENV]?.trim() || ".data/document-objects";
  const blockedChecksums = (process.env[BLOCKED_CHECKSUMS_ENV] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/u.test(value));
  return createLocalDocumentScanner({ rootDir, blockedChecksums });
}

/**
 * Claims one scan job under a discovery scope, runs the quarantine scan, then
 * persists the verdict under a second scope bound to the issued lease
 * generation — the persist RPC fences on app.job_id + app.lease_generation +
 * the lease token digest, so claim and persist can never share a scope.
 */
export async function POST(request: NextRequest) {
  const body = await documentPipelineWorkerBody(request);
  const targetJobId = workerBodyUuid(body, "jobId");
  return runDocumentPipelineWorkerRoute(
    request,
    "document_scan:process",
    async (context) => {
      const claim = await context.run(documentPipelineDiscoveryScope(), (db) =>
        claimDocumentScanJob({ jobId: targetJobId }, {
          repository: createPostgresDocumentIntakeRepository(db),
        }));
      if (claim.kind === "unavailable") return { status: "idle" };
      if (claim.kind === "already_persisted") {
        return {
          status: "ok",
          outcome: "already_persisted",
          jobId: claim.result.jobId,
          state: claim.result.state,
        };
      }
      const lease = claim.lease;
      const persistRequest = await executeDocumentScan(lease, {
        scanner: localScanner(),
      });
      const persisted = await context.run(
        documentPipelineBoundScope({
          tenantId: lease.tenantId,
          workspaceId: lease.workspaceId,
          jobId: lease.jobId,
          leaseGeneration: lease.leaseGeneration,
        }),
        (db) => persistDocumentScanResult(persistRequest, {
          repository: createPostgresDocumentIntakeRepository(db),
        }),
      );
      return {
        status: "ok",
        outcome: persisted.state,
        jobId: persisted.jobId,
        retryScheduled: persisted.retryScheduled,
      };
    },
  );
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  ));
}
