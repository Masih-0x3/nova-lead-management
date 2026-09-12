"use server";

import {
  accountDeps,
  reviewDeps,
} from "@/app/api/_shared/l05-deps";
import { applyAccountMergeTransition } from "@/lib/discovery/account-service";
import { enqueueItem } from "@/lib/review/service";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";

export async function requestAccountReviewAction(input: Readonly<{
  accountId: string;
  resolutionId?: string;
  reason: string;
}>): Promise<SurfaceActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A review reason is required." };
  }
  return runSurfaceAction({
    permission: "queue:operate",
    action: "l07:accounts:request-review",
    scopeClass: "workspace-required",
    resourceType: "review_queue",
    revalidate: ["/accounts", "/review"],
  }, async (db, session) => {
    const result = await enqueueItem(reviewDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      kind: "ambiguous_account_resolution",
      priority: "normal",
      subject: { subjectId: input.accountId, versionId: input.resolutionId ?? null },
      reason,
    });
    return result.replayed
      ? "A review item for this account already exists."
      : "The account was queued for human review.";
  });
}

export async function mergeAccountsAction(input: Readonly<{
  survivorAccountId: string;
  retiredAccountId: string;
  evidenceObservationIds: readonly string[];
  expectedStateHash: string;
  reason: string;
}>): Promise<SurfaceActionResult> {
  return mergeTransition(input, "merge");
}

export async function unmergeAccountsAction(input: Readonly<{
  survivorAccountId: string;
  retiredAccountId: string;
  evidenceObservationIds: readonly string[];
  expectedStateHash: string;
  reason: string;
}>): Promise<SurfaceActionResult> {
  return mergeTransition(input, "unmerge");
}

async function mergeTransition(
  input: Readonly<{
    survivorAccountId: string;
    retiredAccountId: string;
    evidenceObservationIds: readonly string[];
    expectedStateHash: string;
    reason: string;
  }>,
  action: "merge" | "unmerge",
): Promise<SurfaceActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  if (input.evidenceObservationIds.length === 0) {
    return {
      ok: false,
      kind: "invalid",
      message: "At least one evidence observation must back the identity change.",
    };
  }
  return runSurfaceAction({
    permission: "account:merge",
    action: `l07:accounts:${action}`,
    scopeClass: "workspace-required",
    resourceType: "canonical_account",
    revalidate: ["/accounts", "/contacts", "/review"],
  }, async (db, session) => {
    await applyAccountMergeTransition(accountDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      survivorAccountId: input.survivorAccountId,
      retiredAccountId: input.retiredAccountId,
      evidenceObservationIds: input.evidenceObservationIds,
      expectedStateHash: input.expectedStateHash,
      action,
      actorId: session.userId,
      reason,
    });
    return action === "merge" ? "The accounts were merged." : "The merge was reversed.";
  });
}
