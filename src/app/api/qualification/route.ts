import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody, qualificationDeps } from "@/app/api/_shared/l05-deps";
import { createPostgresQualificationRepository } from "@/lib/qualification/repository";
import {
  evaluateQualification,
  listQualificationViews,
} from "@/lib/qualification/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  const accountId = params.get("accountId");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "qualification:read",
    action: "l05:qualification:list",
    scopeClass: "workspace-required",
    correlationId: `l05:qualification:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    qualifications: await listQualificationViews(
      createPostgresQualificationRepository(db),
      {
        tenantId: session.tenantId,
        workspaceId: workspaceId ?? "",
        ...(accountId ? { accountId } : {}),
      },
    ),
  }));
}

/**
 * Evaluates a play-specific qualification snapshot with factor-level
 * rationale and citations. needs_review decisions are enqueued to the
 * durable review queue automatically.
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
    permission: "score:recompute",
    action: "l05:qualification:evaluate",
    scopeClass: "workspace-required",
    resourceType: "account_qualification",
    correlationId: `l05:qualification:evaluate:${randomUUID()}`,
  }, async ({ session, db }) =>
    evaluateQualification(qualificationDeps(db), { ...record, tenantId: session.tenantId }));
}
