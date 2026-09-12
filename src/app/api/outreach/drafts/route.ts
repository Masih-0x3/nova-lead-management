import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { outreachDeps } from "@/app/api/_shared/l06-deps";
import { createPostgresOutreachRepository } from "@/lib/outreach/repository";
import {
  generateOutreachDraft,
  listOutreachDraftViews,
} from "@/lib/outreach/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const accountId = params.get("accountId");
  return l05Route({
    selector: {
      tenantId: params.get("tenantId"),
      workspaceId: params.get("workspaceId"),
    },
    permission: "outreach:read",
    action: "l06:outreach:drafts:list",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:drafts:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    drafts: await listOutreachDraftViews(
      { outreach: createPostgresOutreachRepository(db) },
      { tenantId: session.tenantId, workspaceId: params.get("workspaceId") ?? "" },
      accountId ? { accountId } : {},
    ),
  }));
}

/**
 * Generates one citation-backed draft version from approved tenant facts and
 * account evidence through the bounded fixture runtime. No send path exists:
 * drafts become eligible for human review and copy/export only.
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
    permission: "outreach:draft",
    action: "l06:outreach:drafts:generate",
    scopeClass: "workspace-required",
    resourceType: "outreach_draft",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:drafts:generate:${randomUUID()}`,
  }, async ({ session, db }) => {
    const deps = await outreachDeps(db);
    return generateOutreachDraft(deps, {
      ...record,
      tenantId: session.tenantId,
      actorId: session.userId,
    });
  });
}
