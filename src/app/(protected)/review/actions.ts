"use server";

import {
  qualificationDeps,
  reviewDeps,
} from "@/app/api/_shared/l05-deps";
import { reviewQualification } from "@/lib/qualification/service";
import { transitionItem } from "@/lib/review/service";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";

const QUEUE_ACTIONS = new Set(["claim", "release", "resolve"]);
const RESOLUTIONS = new Set(["confirmed", "dismissed", "changes_requested"]);

export async function transitionQueueItemAction(input: Readonly<{
  itemId: string;
  action: "claim" | "release" | "resolve";
  reason: string;
  resolution?: Readonly<{ decision: "confirmed" | "dismissed" | "changes_requested"; note: string }>;
}>): Promise<SurfaceActionResult> {
  if (!QUEUE_ACTIONS.has(input.action)) {
    return { ok: false, kind: "invalid", message: "Unsupported queue transition." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  if (input.action === "resolve"
    && (!input.resolution || !RESOLUTIONS.has(input.resolution.decision))) {
    return { ok: false, kind: "invalid", message: "A resolution decision is required to resolve an item." };
  }
  return runSurfaceAction({
    permission: "queue:operate",
    action: `l07:review:queue:${input.action}`,
    scopeClass: "workspace-required",
    resourceType: "review_queue",
    revalidate: "/review",
  }, async (db, session) => {
    await transitionItem(reviewDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      itemId: input.itemId,
      action: input.action,
      actorId: session.userId,
      reason,
      resolution: input.action === "resolve" ? input.resolution : undefined,
    });
    return input.action === "claim"
      ? "The item is now claimed by you."
      : input.action === "release" ? "The item was released back to the queue." : "The item was resolved.";
  });
}

export async function reviewQualificationAction(input: Readonly<{
  accountId: string;
  versionId: string;
  expectedQualificationHash: string;
  action: "confirm" | "override";
  decision?: "qualified" | "needs_review" | "unqualified";
  reason: string;
}>): Promise<SurfaceActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  if (input.action === "override" && input.decision === undefined) {
    return { ok: false, kind: "invalid", message: "An override requires a replacement decision." };
  }
  return runSurfaceAction({
    permission: input.action === "override" ? "score:override" : "qualification:approve",
    action: `l07:review:qualification:${input.action}`,
    scopeClass: "workspace-required",
    resourceType: "account_qualification",
    revalidate: ["/review", "/accounts"],
  }, async (db, session) => {
    await reviewQualification(qualificationDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      accountId: input.accountId,
      versionId: input.versionId,
      expectedQualificationHash: input.expectedQualificationHash,
      action: input.action,
      decision: input.decision,
      actorId: session.userId,
      reason,
    });
    return input.action === "confirm"
      ? "The qualification was confirmed."
      : "The qualification decision was overridden.";
  });
}
