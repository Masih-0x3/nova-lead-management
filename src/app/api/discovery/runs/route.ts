import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { discoveryDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  createDiscoveryRunService,
  listDiscoveryRunViews,
} from "@/lib/discovery/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.has("workspaceId") ? params.get("workspaceId") : null;
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "source:review",
    action: "l05:discovery:runs:list",
    scopeClass: "workspace-optional",
    correlationId: `l05:discovery:runs:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    runs: await listDiscoveryRunViews(
      createPostgresDiscoveryRepository(db),
      { tenantId: session.tenantId, workspaceId },
    ),
  }));
}

/** Creates a discovery run from a persisted plan under source:execute. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: "source:execute",
    action: "l05:discovery:run:create",
    scopeClass: "workspace-optional",
    resourceWorkspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    resourceType: "discovery_run",
    correlationId: `l05:discovery:run:create:${randomUUID()}`,
  }, async ({ session, db }) =>
    createDiscoveryRunService(discoveryDeps(db), { ...record, tenantId: session.tenantId }));
}
