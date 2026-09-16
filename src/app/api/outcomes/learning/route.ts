import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody } from "@/app/api/_shared/l05-deps";
import { learningDeps } from "@/app/api/_shared/l06-deps";
import {
  listLearningProposalViews,
  proposeLearning,
} from "@/lib/learning/service";

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
    action: "l06:learning:list",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:learning:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    proposals: await listLearningProposalViews(learningDeps(db), {
      tenantId: session.tenantId,
      workspaceId: params.get("workspaceId") ?? "",
      ...(accountId ? { accountId } : {}),
      ...(playVersionId ? { playVersionId } : {}),
      ...(stableKey ? { stableKey } : {}),
    }),
  }));
}

/**
 * Builds one versioned, reversible learning proposal from persisted outcome
 * records. The proposal names its cohort, metric, target policy hash,
 * expected impact, uncertainties, and rollback — it never activates or
 * mutates a play policy.
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
    action: "l06:learning:propose",
    scopeClass: "workspace-required",
    resourceType: "learning_proposal",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:learning:propose:${randomUUID()}`,
  }, async ({ session, db }) =>
    proposeLearning(learningDeps(db), {
      ...record,
      tenantId: session.tenantId,
    }));
}
