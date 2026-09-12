import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { discoveryDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  appendDiscoveryBatchService,
  getDiscoveryRunView,
  transitionDiscoveryRunService,
} from "@/lib/discovery/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const query = request.nextUrl.searchParams;
  const workspaceId = query.has("workspaceId") ? query.get("workspaceId") : null;
  return l05Route({
    selector: { tenantId: query.get("tenantId"), workspaceId },
    permission: "source:review",
    action: "l05:discovery:run:read",
    scopeClass: "workspace-optional",
    resourceId: runId,
    resourceType: "discovery_run",
    correlationId: `l05:discovery:run:read:${randomUUID()}`,
  }, async ({ session, db }) => ({
    run: await getDiscoveryRunView(
      createPostgresDiscoveryRepository(db),
      { tenantId: session.tenantId, workspaceId },
      runId,
    ),
  }));
}

/**
 * Lifecycle transition (start/complete/fail/cancel) or observation batch
 * append, both optimistic-concurrency controlled by expectedRunHash.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const mode = record.mode === "append_observations" ? "append" : "transition";
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: "source:execute",
    action: `l05:discovery:run:${mode}`,
    scopeClass: "workspace-optional",
    resourceWorkspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    resourceId: runId,
    resourceType: "discovery_run",
    correlationId: `l05:discovery:run:${mode}:${randomUUID()}`,
  }, async ({ session, db }) => {
    const input = { ...record, tenantId: session.tenantId, runId };
    if (mode === "append") {
      return appendDiscoveryBatchService(discoveryDeps(db), input);
    }
    return transitionDiscoveryRunService(discoveryDeps(db), input);
  });
}
