import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { outcomeDeps } from "@/app/api/_shared/l06-deps";
import { buildAttributionReportView } from "@/lib/outcomes/service";

/**
 * Builds a content-addressed attribution report over persisted outcome
 * versions: correction chains resolve as-of the report window, outcomes
 * deduplicate by version, and groups aggregate by account, play, and
 * outreach draft version. Reports are derived, never persisted.
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
    permission: "outreach:read",
    action: "l06:outcomes:reports:build",
    scopeClass: "workspace-required",
    resourceType: "outcome_attribution_report",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outcomes:reports:${randomUUID()}`,
  }, async ({ session, db }) =>
    buildAttributionReportView(outcomeDeps(db), {
      ...record,
      tenantId: session.tenantId,
    }));
}
