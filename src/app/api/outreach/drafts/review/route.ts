import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { outreachDeps } from "@/app/api/_shared/l06-deps";
import { transitionOutreachDraftReviewRequest } from "@/lib/outreach/service";

/**
 * Transitions a draft through the shared human review queue
 * (qualification_review): draft → in_review → approved|rejected. Approval
 * binds recipient, channel, claims, sources, opt-out language, and CTA —
 * the copy/export gate re-verifies every binding at handoff time.
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
    permission: "outreach:approve",
    action: "l06:outreach:drafts:review",
    scopeClass: "workspace-required",
    resourceType: "outreach_draft",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:drafts:review:${randomUUID()}`,
  }, async ({ session, db }) => {
    const deps = await outreachDeps(db);
    return transitionOutreachDraftReviewRequest(deps, {
      ...record,
      tenantId: session.tenantId,
      actorId: session.userId,
      actorRole: record.actorRole ?? session.role,
    });
  });
}
