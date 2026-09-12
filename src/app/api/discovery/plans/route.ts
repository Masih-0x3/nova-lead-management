import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { discoveryDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  createDiscoveryPlanService,
  listDiscoveryPlanViews,
} from "@/lib/discovery/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.has("workspaceId") ? params.get("workspaceId") : null;
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "source:review",
    action: "l05:discovery:plans:list",
    scopeClass: "workspace-optional",
    correlationId: `l05:discovery:plans:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    plans: await listDiscoveryPlanViews(
      createPostgresDiscoveryRepository(db),
      { tenantId: session.tenantId, workspaceId },
    ),
  }));
}

/**
 * Builds a discovery plan from an approved play activation. The play authority
 * port fails closed when the strategy lane's durable records are unavailable.
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
    permission: "source:plan",
    action: "l05:discovery:plan:create",
    scopeClass: "workspace-optional",
    resourceWorkspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    resourceType: "discovery_plan",
    correlationId: `l05:discovery:plan:create:${randomUUID()}`,
  }, async ({ session, db }) =>
    createDiscoveryPlanService(discoveryDeps(db), { ...record, tenantId: session.tenantId }));
}
