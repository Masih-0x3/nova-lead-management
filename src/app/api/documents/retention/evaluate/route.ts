import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  documentPipelineBoundScope,
  documentPipelineDiscoveryScope,
  documentPipelineWorkerBody,
  runDocumentPipelineWorkerRoute,
  workerBodyLimit,
} from "@/lib/documents/pipeline-worker-route";
import {
  discoverDocumentRetentionSubjects,
  evaluateDocumentRetention,
} from "@/lib/documents/pipeline-service";
import { createPostgresDocumentPipelineRepository } from "@/lib/documents/postgres-pipeline-repository";
import { applyNoStoreHeaders } from "@/lib/http-cache";

/**
 * Sweeps versions whose retention deadline elapsed and records one evaluation
 * each. The evaluation scope's job id doubles as the deletion-request id when
 * the disposition stages a purge — a fresh uuid per subject is required.
 */
export async function POST(request: NextRequest) {
  const limit = workerBodyLimit(await documentPipelineWorkerBody(request), 25);
  return runDocumentPipelineWorkerRoute(
    request,
    "document_retention:evaluate",
    async (context) => {
      const subjects = await context.run(documentPipelineDiscoveryScope(), (db) =>
        discoverDocumentRetentionSubjects({ limit }, {
          repository: createPostgresDocumentPipelineRepository(db),
        }));
      const evaluated: {
        documentId: string;
        versionId: string;
        outcome: string;
      }[] = [];
      for (const subject of subjects) {
        const result = await context.run(
          documentPipelineBoundScope({
            tenantId: subject.tenantId,
            workspaceId: subject.workspaceId,
            jobId: randomUUID(),
          }),
          (db) => evaluateDocumentRetention(subject, {
            repository: createPostgresDocumentPipelineRepository(db),
          }),
        );
        evaluated.push({
          documentId: subject.documentId,
          versionId: subject.versionId,
          outcome: result.kind,
        });
      }
      return { status: "ok", discovered: subjects.length, evaluated };
    },
  );
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  ));
}
