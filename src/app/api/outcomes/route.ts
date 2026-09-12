import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { outcomeDeps } from "@/app/api/_shared/l06-deps";
import {
  listOutcomeVersionViews,
  recordOutcome,
} from "@/lib/outcomes/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const accountId = params.get("accountId");
  const playVersionId = params.get("playVersionId");
  const stableKey = params.get("stableKey");
  return l05Route({
    selector: {
      tenantId: params.get("tenantId"),
      workspaceId: params.get("workspaceId"),
    },
    permission: "outreach:read",
    action: "l06:outcomes:list",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outcomes:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    outcomes: await listOutcomeVersionViews(outcomeDeps(db), {
      tenantId: session.tenantId,
      workspaceId: params.get("workspaceId") ?? "",
      ...(accountId ? { accountId } : {}),
      ...(playVersionId ? { playVersionId } : {}),
      ...(stableKey ? { stableKey } : {}),
    }),
  }));
}

/**
 * Records one manually-observed outcome version (or a correcting revision
 * when correctionReason is present). Sources are member observations or
 * approved imports only — the service never infers delivery and never
 * mutates suppression or strategy state implicitly.
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
    action: "l06:outcomes:record",
    scopeClass: "workspace-required",
    resourceType: "outcome_record",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outcomes:record:${randomUUID()}`,
  }, async ({ session, db }) =>
    recordOutcome(outcomeDeps(db), {
      ...record,
      tenantId: session.tenantId,
      recordedBy: session.userId,
    }));
}
