"use server";

import { contactDeps, reviewDeps } from "@/app/api/_shared/l05-deps";
import {
  transitionBuyingCenterReviewService,
  transitionContactReview,
} from "@/lib/contacts/service";
import { enqueueItem } from "@/lib/review/service";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";

const CONTACT_REVIEW_TARGETS = new Set(["in_review", "approved", "rejected"]);

export async function transitionContactReviewAction(input: Readonly<{
  accountId: string;
  versionId: string;
  expectedVersionId: string;
  expectedContentHash: string;
  expectedReviewHash: string;
  to: "in_review" | "approved" | "rejected";
  reason: string;
}>): Promise<SurfaceActionResult> {
  if (!CONTACT_REVIEW_TARGETS.has(input.to)) {
    return { ok: false, kind: "invalid", message: "Unsupported review transition." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  return runSurfaceAction({
    permission: "contact:approve",
    action: `l07:contacts:review:${input.to}`,
    scopeClass: "workspace-required",
    resourceType: "contact_record",
    revalidate: ["/contacts", "/review"],
  }, async (db, session) => {
    await transitionContactReview(contactDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      accountId: input.accountId,
      versionId: input.versionId,
      expectedVersionId: input.expectedVersionId,
      expectedContentHash: input.expectedContentHash,
      expectedReviewHash: input.expectedReviewHash,
      to: input.to,
      actorId: session.userId,
      reason,
    });
    return `Contact review moved to ${input.to.replace("_", " ")}.`;
  });
}

export async function transitionBuyingCenterReviewAction(input: Readonly<{
  accountId: string;
  versionId: string;
  expectedVersionId: string;
  expectedContentHash: string;
  expectedReviewHash: string;
  to: "in_review" | "approved" | "rejected";
  reason: string;
}>): Promise<SurfaceActionResult> {
  if (!CONTACT_REVIEW_TARGETS.has(input.to)) {
    return { ok: false, kind: "invalid", message: "Unsupported review transition." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  return runSurfaceAction({
    permission: "buying_center:approve",
    action: `l07:buying-center:review:${input.to}`,
    scopeClass: "workspace-required",
    resourceType: "buying_center",
    revalidate: ["/contacts", "/review"],
  }, async (db, session) => {
    await transitionBuyingCenterReviewService(contactDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      accountId: input.accountId,
      versionId: input.versionId,
      expectedVersionId: input.expectedVersionId,
      expectedContentHash: input.expectedContentHash,
      expectedReviewHash: input.expectedReviewHash,
      to: input.to,
      actorId: session.userId,
      reason,
    });
    return `Buying-center review moved to ${input.to.replace("_", " ")}.`;
  });
}

export async function requestContactReviewAction(input: Readonly<{
  accountId: string;
  versionId: string;
  reason: string;
}>): Promise<SurfaceActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A review reason is required." };
  }
  return runSurfaceAction({
    permission: "queue:operate",
    action: "l07:contacts:request-review",
    scopeClass: "workspace-required",
    resourceType: "review_queue",
    revalidate: ["/contacts", "/review"],
  }, async (db, session) => {
    const result = await enqueueItem(reviewDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      kind: "buying_center_review",
      priority: "normal",
      subject: { subjectId: input.accountId, versionId: input.versionId },
      reason,
    });
    return result.replayed
      ? "A review item for this contact already exists."
      : "The contact was queued for human review.";
  });
}
