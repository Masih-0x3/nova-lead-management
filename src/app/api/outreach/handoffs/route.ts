import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { outreachDeps } from "@/app/api/_shared/l06-deps";
import { createPostgresOutreachRepository } from "@/lib/outreach/repository";
import {
  listHandoffAttemptViews,
  requestOutreachHandoff,
} from "@/lib/outreach/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const filter: { accountId?: string; stableKey?: string; contactStableKey?: string } = {};
  const accountId = params.get("accountId");
  const stableKey = params.get("stableKey");
  const contactStableKey = params.get("contactStableKey");
  if (accountId) filter.accountId = accountId;
  if (stableKey) filter.stableKey = stableKey;
  if (contactStableKey) filter.contactStableKey = contactStableKey;
  return l05Route({
    selector: {
      tenantId: params.get("tenantId"),
      workspaceId: params.get("workspaceId"),
    },
    permission: "outreach:read",
    action: "l06:outreach:handoffs:list",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:handoffs:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    attempts: await listHandoffAttemptViews(
      { outreach: createPostgresOutreachRepository(db) },
      { tenantId: session.tenantId, workspaceId: params.get("workspaceId") ?? "" },
      filter,
    ),
  }));
}

/**
 * Requests a copy/export release for an approved draft. Every gate is
 * fail-closed and recorded as an immutable attempt: recipient binding,
 * suppression, quiet hours, frequency cap, evidence freshness, and the
 * policy decision. Released attempts return a caller-attested receipt only —
 * no send, provider, or delivery path exists.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const action = record.action;
  if (action !== "copy" && action !== "export") {
    return privateJsonError("action must be copy or export.", 400);
  }
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: "outreach:copy_export",
    action: `l06:outreach:handoffs:${action}`,
    scopeClass: "workspace-required",
    resourceType: "outreach_handoff_attempt",
    requirePolicy: (policy) => policy.copyExportEnabled === true,
    correlationId: `l06:outreach:handoffs:${action}:${randomUUID()}`,
  }, async ({ session, db }) => {
    const deps = await outreachDeps(db);
    return requestOutreachHandoff(deps, {
      ...record,
      tenantId: session.tenantId,
      action,
      actorId: session.userId,
    });
  });
}
