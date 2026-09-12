import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { learningDeps } from "@/app/api/_shared/l06-deps";
import { transitionLearningReview } from "@/lib/learning/service";

/**
 * Transitions a learning proposal through human review
 * (draft → in_review → approved|rejected). Approval records intent only;
 * the proposed change still requires a separate, explicit application and
 * every proposal carries its rollback binding.
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
    action: "l06:learning:review",
    scopeClass: "workspace-required",
    resourceType: "learning_proposal",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:learning:review:${randomUUID()}`,
  }, async ({ session, db }) =>
    transitionLearningReview(learningDeps(db), {
      ...record,
      tenantId: session.tenantId,
      actorId: session.userId,
    }));
}
