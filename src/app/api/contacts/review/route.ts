import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { contactDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { transitionContactReview } from "@/lib/contacts/service";

/**
 * Human review transition for a contact record version. The expected hashes
 * (versionId + contentHash + reviewHash) pin the exact reviewed document.
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
    permission: "contact:approve",
    action: "l05:contacts:review",
    scopeClass: "workspace-required",
    resourceId: typeof record.versionId === "string" ? record.versionId : undefined,
    resourceType: "contact_record",
    requirePolicy: (policy) => policy.contactResearchEnabled === true,
    correlationId: `l05:contacts:review:${randomUUID()}`,
  }, async ({ session, db }) =>
    transitionContactReview(
      contactDeps(db),
      { ...record, tenantId: session.tenantId, actorId: session.userId }));
}
