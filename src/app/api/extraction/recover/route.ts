import { NextRequest, NextResponse } from "next/server";

import {
  documentPipelineBoundScope,
  documentPipelineDiscoveryScope,
  documentPipelineWorkerBody,
  runDocumentPipelineWorkerRoute,
  workerBodyLimit,
} from "@/lib/documents/pipeline-worker-route";
import {
  discoverDocumentExtractionLeaseLosses,
  recoverDocumentExtractionLease,
} from "@/lib/documents/pipeline-service";
import { createPostgresDocumentPipelineRepository } from "@/lib/documents/postgres-pipeline-repository";
import { applyNoStoreHeaders } from "@/lib/http-cache";

/**
 * Sweeps for extraction jobs whose lease expired while still running and
 * recovers each under a bound scope keyed to that job.
 */
export async function POST(request: NextRequest) {
  const limit = workerBodyLimit(await documentPipelineWorkerBody(request), 25);
  return runDocumentPipelineWorkerRoute(
    request,
    "document_extraction:recover",
    async (context) => {
      const losses = await context.run(documentPipelineDiscoveryScope(), (db) =>
        discoverDocumentExtractionLeaseLosses({ limit }, {
          repository: createPostgresDocumentPipelineRepository(db),
        }));
      const recovered: { jobId: string; outcome: string }[] = [];
      for (const loss of losses) {
        const result = await context.run(
          documentPipelineBoundScope({
            tenantId: loss.tenantId,
            workspaceId: loss.workspaceId,
            jobId: loss.jobId,
          }),
          (db) => recoverDocumentExtractionLease({ jobId: loss.jobId }, {
            repository: createPostgresDocumentPipelineRepository(db),
          }),
        );
        if (result.kind !== "unavailable") {
          recovered.push({ jobId: result.jobId, outcome: result.kind });
        }
      }
      return { status: "ok", discovered: losses.length, recovered };
    },
  );
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  ));
}
