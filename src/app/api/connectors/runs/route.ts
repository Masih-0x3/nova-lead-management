import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { connectorDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresConnectorAuthorityRepository } from "@/lib/connectors/repository";
import { createSourceRun } from "@/lib/connectors/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.has("workspaceId") ? params.get("workspaceId") : null;
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "connector:read",
    action: "l05:connectors:runs:list",
    scopeClass: "workspace-optional",
    correlationId: `l05:connectors:runs:list:${randomUUID()}`,
  }, async ({ session, db }) => {
    const authority = createPostgresConnectorAuthorityRepository(db);
    const runs = await authority.listRuns(session.tenantId, workspaceId);
    return { runs };
  });
}

/**
 * Creates a queued, budget-reserved source run. Execution only proceeds
 * through the authorized fixture runner once a worker claims the unit lease;
 * there is no live provider path here.
 */
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
    permission: "connector:use",
    action: "l05:connectors:run:create",
    scopeClass: "workspace-optional",
    resourceWorkspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    resourceType: "source_run",
    correlationId: `l05:connectors:run:create:${randomUUID()}`,
  }, async ({ session, db }) =>
    createSourceRun(connectorDeps(db), { ...record, tenantId: session.tenantId }));
}
