import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { accountDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  applyAccountMergeTransition,
  listMergeHistory,
} from "@/lib/discovery/account-service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "account:read",
    action: "l05:accounts:merges:list",
    scopeClass: "workspace-required",
    correlationId: `l05:accounts:merges:list:${randomUUID()}`,
  }, async ({ session, db }) => ({
    merges: await listMergeHistory(
      createPostgresDiscoveryRepository(db),
      { tenantId: session.tenantId, workspaceId: workspaceId ?? "" },
    ),
  }));
}

/**
 * Applies a human merge/unmerge transition. The merge ledger is reversible:
 * provenance is appended, never rewritten, and the transition requires the
 * expected state hash plus evidence references from both accounts.
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
    permission: "account:merge",
    action: "l05:accounts:merge",
    scopeClass: "workspace-required",
    resourceType: "canonical_account",
    correlationId: `l05:accounts:merge:${randomUUID()}`,
  }, async ({ session, db }) =>
    applyAccountMergeTransition(
      accountDeps(db),
      { ...record, tenantId: session.tenantId, actorId: session.userId }));
}
