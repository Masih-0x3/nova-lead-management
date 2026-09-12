import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { contactDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import {
  listBuyingCenterViews,
  registerBuyingCenter,
  transitionBuyingCenterReviewService,
} from "@/lib/contacts/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  const accountId = params.get("accountId");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "buying_center:read",
    action: "l05:buying-centers:list",
    scopeClass: "workspace-required",
    correlationId: `l05:buying-centers:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    buyingCenters: await listBuyingCenterViews(contactDeps(db).repository, {
      tenantId: session.tenantId,
      workspaceId: workspaceId ?? "",
      ...(accountId ? { accountId } : {}),
    }),
  }));
}

/**
 * Registers a versioned buying-center hypothesis map for an account+play.
 * Hypotheses stay distinct from verified contacts: optional
 * contactVersionRef links a hypothesis to an approved contact version.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const isReview = typeof record.versionId === "string" && typeof record.to === "string";
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: isReview ? "buying_center:approve" : "buying_center:edit",
    action: isReview ? "l05:buying-centers:review" : "l05:buying-centers:register",
    scopeClass: "workspace-required",
    resourceId: typeof record.versionId === "string" ? record.versionId : undefined,
    resourceType: "buying_center",
    requirePolicy: (policy) => policy.contactResearchEnabled === true,
    correlationId: `l05:buying-centers:${randomUUID()}`,
  }, async ({ session, db }) => {
    const input = { ...record, tenantId: session.tenantId };
    if (isReview) {
      return transitionBuyingCenterReviewService(
        contactDeps(db), { ...input, actorId: session.userId });
    }
    return registerBuyingCenter(contactDeps(db), input);
  });
}
