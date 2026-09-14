import { NextRequest, NextResponse } from "next/server";

import {
  documentPipelineBoundScope,
  documentPipelineDiscoveryScope,
  documentPipelineWorkerBody,
  runDocumentPipelineWorkerRoute,
  workerBodyLimit,
  workerBodyUuid,
} from "@/lib/documents/pipeline-worker-route";
import {
  applyDocumentDeletion,
  discoverDocumentDeletionRequests,
} from "@/lib/documents/pipeline-service";
import { createPostgresDocumentPipelineRepository } from "@/lib/documents/postgres-pipeline-repository";
import { documentRuntimeServices } from "@/lib/documents/runtime-services";
import { applyNoStoreHeaders } from "@/lib/http-cache";

/**
 * Applies pending deletion requests: the bound scope's job id must equal the
 * request id (the apply RPC fences on it), and physical object removal happens
 * before the tombstone is recorded.
 */
export async function POST(request: NextRequest) {
  const body = await documentPipelineWorkerBody(request);
  const limit = workerBodyLimit(body, 25);
  const targetRequestId = workerBodyUuid(body, "requestId");
  return runDocumentPipelineWorkerRoute(
    request,
    "document_retention:delete",
    async (context) => {
      const requests = await context.run(documentPipelineDiscoveryScope(), (db) =>
        discoverDocumentDeletionRequests({ limit }, {
          repository: createPostgresDocumentPipelineRepository(db),
        }));
      const applied: { requestId: string; outcome: string }[] = [];
      for (const requestRef of requests) {
        if (targetRequestId !== null && requestRef.requestId !== targetRequestId) {
          continue;
        }
        const result = await context.run(
          documentPipelineBoundScope({
            tenantId: requestRef.tenantId,
            workspaceId: requestRef.workspaceId,
            jobId: requestRef.requestId,
          }),
          (db) => applyDocumentDeletion({ requestId: requestRef.requestId }, {
            repository: createPostgresDocumentPipelineRepository(db),
            remover: documentRuntimeServices().storage,
          }),
        );
        applied.push({ requestId: requestRef.requestId, outcome: result.kind });
      }
      return { status: "ok", discovered: requests.length, applied };
    },
  );
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  ));
}
