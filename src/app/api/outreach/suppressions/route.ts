import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresSuppressionRepository } from "@/lib/suppressions/repository";
import {
  listSuppressionViews,
  recordSuppression,
} from "@/lib/suppressions/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const accountId = params.get("accountId");
  const contactStableKey = params.get("contactStableKey");
  return l05Route({
    selector: {
      tenantId: params.get("tenantId"),
      workspaceId: params.get("workspaceId"),
    },
    permission: "outreach:read",
    action: "l06:outreach:suppressions:list",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:suppressions:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    suppressions: await listSuppressionViews(
      { repository: createPostgresSuppressionRepository(db) },
      {
        tenantId: session.tenantId,
        workspaceId: params.get("workspaceId") ?? "",
        ...(accountId ? { accountId } : {}),
        ...(contactStableKey ? { contactStableKey } : {}),
      },
    ),
  }));
}

/**
 * Appends one protective suppression record (tenant-, account-, or
 * contact-scoped). Records are append-only and dominate eligibility for
 * generation and handoff; member_recorded entries carry no outcome link.
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
    permission: "outreach:edit",
    action: "l06:outreach:suppressions:record",
    scopeClass: "workspace-required",
    resourceType: "suppression_record",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:suppressions:record:${randomUUID()}`,
  }, async ({ session, db }) =>
    recordSuppression(
      { repository: createPostgresSuppressionRepository(db) },
      {
        ...record,
        tenantId: session.tenantId,
        actorId: session.userId,
        // Member-recorded only; outcome-derived records come from the
        // outcomes service so an outcome link is never caller-forged.
        source: { kind: "member_recorded", outcomeVersionId: null },
      },
    ));
}
