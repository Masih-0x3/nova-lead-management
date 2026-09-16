import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { contactDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import {
  listContactViews,
  registerContactRecord,
  supersedeContactRecord,
} from "@/lib/contacts/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  const accountId = params.get("accountId");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "contact:read",
    action: "l05:contacts:list",
    scopeClass: "workspace-required",
    correlationId: `l05:contacts:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    contacts: await listContactViews(contactDeps(db).repository, {
      tenantId: session.tenantId,
      workspaceId: workspaceId ?? "",
      ...(accountId ? { accountId } : {}),
    }),
  }));
}

/**
 * Registers a contact record (v1) or supersedes an approved predecessor
 * (revision n+1 when predecessorVersionId is present). No outreach is sent;
 * records carry provenance, permitted use, freshness, and suppression state.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const supersede = typeof record.predecessorVersionId === "string";
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: supersede ? "contact:edit" : "contact:research",
    action: supersede ? "l05:contacts:supersede" : "l05:contacts:register",
    scopeClass: "workspace-required",
    resourceType: "contact_record",
    requirePolicy: (policy) => policy.contactResearchEnabled === true,
    correlationId: `l05:contacts:register:${randomUUID()}`,
  }, async ({ session, db }) => {
    const input = { ...record, tenantId: session.tenantId };
    if (supersede) return supersedeContactRecord(contactDeps(db), input);
    return registerContactRecord(contactDeps(db), input);
  });
}
