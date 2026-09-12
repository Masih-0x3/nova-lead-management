import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody, qualificationDeps } from "@/app/api/_shared/l05-deps";
import { reviewQualification } from "@/lib/qualification/service";

/**
 * Human confirm/override of a qualification decision. Confirm preserves the
 * automated decision; override requires a reason-coded decision change. Both
 * are pinned by expectedQualificationHash.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const isOverride = record.action === "override";
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: isOverride ? "score:override" : "qualification:approve",
    action: isOverride ? "l05:qualification:override" : "l05:qualification:confirm",
    scopeClass: "workspace-required",
    resourceId: typeof record.versionId === "string" ? record.versionId : undefined,
    resourceType: "account_qualification",
    correlationId: `l05:qualification:review:${randomUUID()}`,
  }, async ({ session, db }) =>
    reviewQualification(
      qualificationDeps(db),
      { ...record, tenantId: session.tenantId, actorId: session.userId }));
}
