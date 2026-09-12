import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { connectorDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { registerFixtureConnectorAccount } from "@/lib/connectors/service";

/**
 * Registers a fixture/local connector account inside the tenant scope. Live
 * provider credentials are never accepted on this path — credential-ref
 * connectors stay on their existing key-gated flow.
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
    permission: "connector:manage",
    action: "l05:connectors:account:create",
    scopeClass: "workspace-optional",
    resourceWorkspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    resourceType: "connector_account",
    correlationId: `l05:connectors:account:create:${randomUUID()}`,
  }, async ({ session, db }) =>
    registerFixtureConnectorAccount(
      connectorDeps(db), { ...record, tenantId: session.tenantId }));
}
