import { NextRequest, NextResponse } from "next/server";

import { createLocalDocumentStore } from "@/lib/documents/local-storage-adapter";
import {
  claimDocumentExtractionJob,
  executeDocumentExtraction,
  finalizeDocumentExtraction,
} from "@/lib/documents/pipeline-service";
import {
  documentPipelineBoundScope,
  documentPipelineDiscoveryScope,
  documentPipelineWorkerBody,
  runDocumentPipelineWorkerRoute,
  workerBodyUuid,
} from "@/lib/documents/pipeline-worker-route";
import { createPostgresDocumentPipelineRepository } from "@/lib/documents/postgres-pipeline-repository";
import { applyNoStoreHeaders } from "@/lib/http-cache";

const STORE_ROOT_ENV = "NOVA_DOCUMENT_STORE_ROOT";
const SIGNING_SECRET_ENV = "NOVA_DOCUMENT_SIGNING_SECRET";

function localReader() {
  const rootDir = process.env[STORE_ROOT_ENV]?.trim() || ".data/document-objects";
  const signingSecret = process.env[SIGNING_SECRET_ENV]?.trim() ?? "";
  return createLocalDocumentStore({ rootDir, signingSecret });
}

/**
 * Claims one extraction job under a discovery scope, runs the parser pipeline
 * against the leased object, then finalizes under a scope bound to the issued
 * lease generation — the finalize RPC fences app.job_id +
 * app.lease_generation + the lease token digest.
 */
export async function POST(request: NextRequest) {
  const body = await documentPipelineWorkerBody(request);
  const targetJobId = workerBodyUuid(body, "jobId");
  return runDocumentPipelineWorkerRoute(
    request,
    "document_extraction:process",
    async (context, signal) => {
      const claim = await context.run(documentPipelineDiscoveryScope(), (db) =>
        claimDocumentExtractionJob({ jobId: targetJobId }, {
          repository: createPostgresDocumentPipelineRepository(db),
        }));
      if (claim.kind === "unavailable") return { status: "idle" };
      if (claim.kind === "already_persisted") {
        return {
          status: "ok",
          outcome: "already_persisted",
          jobId: claim.jobId,
          state: claim.jobState,
        };
      }
      const lease = claim.lease;
      const finalizeRequest = await executeDocumentExtraction(lease, {
        reader: localReader(),
        signal,
      });
      const persisted = await context.run(
        documentPipelineBoundScope({
          tenantId: lease.tenantId,
          workspaceId: lease.workspaceId,
          jobId: lease.jobId,
          leaseGeneration: lease.leaseGeneration,
        }),
        (db) => finalizeDocumentExtraction(finalizeRequest, {
          repository: createPostgresDocumentPipelineRepository(db),
        }),
      );
      if (persisted.kind === "unavailable") {
        return { status: "error", error: "finalize_rejected", jobId: lease.jobId };
      }
      return {
        status: "ok",
        outcome: persisted.kind,
        jobId: persisted.jobId,
        state: persisted.state,
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
