import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError } from "@/app/api/_shared/l05";
import { getConnectorGovernanceView } from "@/lib/connectors/service";
import { connectorDeps } from "@/app/api/_shared/l05-deps";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const query = request.nextUrl.searchParams;
  const workspaceId = query.has("workspaceId") ? query.get("workspaceId") : null;
  const unitId = query.get("unitId");
  if (!unitId) return privateJsonError("The request is invalid.", 400);
  return l05Route({
    selector: { tenantId: query.get("tenantId"), workspaceId },
    permission: "connector:read",
    action: "l05:connectors:run:read",
    scopeClass: "workspace-optional",
    resourceId: runId,
    resourceType: "source_run",
    correlationId: `l05:connectors:run:read:${randomUUID()}`,
  }, async ({ session, db }) => {
    const view = await getConnectorGovernanceView(connectorDeps(db), {
      authorizedTenantId: session.tenantId,
      authorizedWorkspaceId: workspaceId,
      runId,
      unitId,
    });
    if (!view) return { run: null };
    return { run: view };
  });
}
