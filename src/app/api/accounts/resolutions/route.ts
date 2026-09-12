import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { accountDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  listAccountResolutionViews,
  resolveAccountObservationsService,
} from "@/lib/discovery/account-service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "account:read",
    action: "l05:accounts:resolutions:list",
    scopeClass: "workspace-required",
    correlationId: `l05:accounts:resolutions:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    resolutions: await listAccountResolutionViews(
      createPostgresDiscoveryRepository(db),
      { tenantId: session.tenantId, workspaceId: workspaceId ?? "" },
    ),
  }));
}

/**
 * Resolves source observations against the durable candidate set. Outcomes:
 * auto_resolved (bound to a matched account), canonical_candidate (new
 * account materialized), human_review (receipt + review queue item).
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
    permission: "account:edit",
    action: "l05:accounts:resolve",
    scopeClass: "workspace-required",
    resourceType: "account_resolution",
    correlationId: `l05:accounts:resolve:${randomUUID()}`,
  }, async ({ session, db }) =>
    resolveAccountObservationsService(
      accountDeps(db), { ...record, tenantId: session.tenantId }));
}
