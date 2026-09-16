import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { accountDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  listAccountPortfolio,
  registerCanonicalAccount,
} from "@/lib/discovery/account-service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "account:read",
    action: "l05:accounts:list",
    scopeClass: "workspace-required",
    correlationId: `l05:accounts:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    accounts: await listAccountPortfolio(
      createPostgresDiscoveryRepository(db),
      { tenantId: session.tenantId, workspaceId: workspaceId ?? "" },
    ),
  }));
}

/** Registers a canonical account directly (manual/agent curated). */
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
    action: "l05:accounts:create",
    scopeClass: "workspace-required",
    resourceType: "canonical_account",
    requirePolicy: (policy) => policy.sourceResearchEnabled === true,
    correlationId: `l05:accounts:create:${randomUUID()}`,
  }, async ({ session, db }) =>
    registerCanonicalAccount(accountDeps(db), { ...record, tenantId: session.tenantId }));
}
