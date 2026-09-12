"use server";

import { outreachDeps } from "@/app/api/_shared/l06-deps";
import {
  requestOutreachHandoff,
  transitionOutreachDraftReviewRequest,
} from "@/lib/outreach/service";
import { recordSuppression } from "@/lib/suppressions/service";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";

const REVIEW_TARGETS = new Set(["in_review", "approved", "rejected"]);

export async function transitionDraftReviewAction(input: Readonly<{
  accountId: string;
  versionId: string;
  expectedReviewHash: string;
  to: "in_review" | "approved" | "rejected";
  reason: string;
  selfApproveConfirmed?: boolean;
}>): Promise<SurfaceActionResult> {
  if (!REVIEW_TARGETS.has(input.to)) {
    return { ok: false, kind: "invalid", message: "Unsupported review transition." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  return runSurfaceAction({
    permission: "outreach:approve",
    action: `l07:outreach:review:${input.to}`,
    scopeClass: "workspace-required",
    resourceType: "outreach_draft",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    revalidate: ["/outreach", "/review"],
  }, async (db, session) => {
    await transitionOutreachDraftReviewRequest(await outreachDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? "",
      accountId: input.accountId,
      versionId: input.versionId,
      expectedReviewHash: input.expectedReviewHash,
      to: input.to,
      actorId: session.userId,
      actorRole: session.role,
      reason,
      selfApproveConfirmed: input.selfApproveConfirmed === true,
    });
    return `Draft review moved to ${input.to.replace("_", " ")}.`;
  });
}

export async function handoffDraftAction(input: Readonly<{
  accountId: string;
  stableKey: string;
  action: "copy" | "export";
  contactVersionId: string;
  recipientTimezone: string;
  idempotencyKey: string;
  expectedDraftStateHash?: string;
  expectedDraftVersionId?: string;
  expectedDraftReviewHash?: string;
  expectedContactContentHash?: string;
  expectedContactReviewHash?: string;
}>): Promise<SurfaceActionResult> {
  if (input.action !== "copy" && input.action !== "export") {
    return { ok: false, kind: "invalid", message: "Only copy and export handoffs exist — there is no send path." };
  }
  if (input.recipientTimezone.trim().length === 0) {
    return { ok: false, kind: "invalid", message: "The recipient timezone is required." };
  }
  return runSurfaceAction({
    permission: "outreach:copy_export",
    action: `l07:outreach:handoff:${input.action}`,
    scopeClass: "workspace-required",
    resourceType: "outreach_handoff",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    revalidate: "/outreach",
  }, async (db, session) => {
    const result = await requestOutreachHandoff(await outreachDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? "",
      accountId: input.accountId,
      stableKey: input.stableKey,
      action: input.action,
      actorId: session.userId,
      idempotencyKey: input.idempotencyKey,
      recipientTimezone: input.recipientTimezone,
      contactVersionId: input.contactVersionId,
      expectedDraftStateHash: input.expectedDraftStateHash,
      expectedDraftVersionId: input.expectedDraftVersionId,
      expectedDraftReviewHash: input.expectedDraftReviewHash,
      expectedContactContentHash: input.expectedContactContentHash,
      expectedContactReviewHash: input.expectedContactReviewHash,
    });
    return result.status === "released"
      ? `The ${input.action} handoff was released.`
      : `The ${input.action} handoff was blocked (${result.blockCode ?? "policy"}).`;
  });
}

export async function recordSuppressionAction(input: Readonly<{
  accountId?: string | null;
  contactStableKey?: string | null;
  disposition: string;
  reason: string;
}>): Promise<SurfaceActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0 || input.disposition.trim().length === 0) {
    return { ok: false, kind: "invalid", message: "A disposition and reason are required." };
  }
  return runSurfaceAction({
    permission: "outreach:edit",
    action: "l07:outreach:suppression:record",
    scopeClass: "workspace-required",
    resourceType: "suppression_record",
    revalidate: ["/outreach", "/contacts"],
  }, async (db, session) => {
    const deps = await outreachDeps(db);
    await recordSuppression({ repository: deps.suppressions, audit: deps.audit }, {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? "",
      accountId: input.accountId ?? null,
      contactStableKey: input.contactStableKey ?? null,
      disposition: input.disposition,
      reason,
      actorId: session.userId,
    });
    return "The suppression was recorded.";
  });
}
