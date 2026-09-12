"use server";

import { createHash, randomUUID } from "node:crypto";

import { learningDeps, outcomeDeps } from "@/app/api/_shared/l06-deps";
import { transitionLearningReview } from "@/lib/learning/service";
import { recordOutcome } from "@/lib/outcomes/service";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";

const OUTCOMES = new Set([
  "copied", "exported", "sent_manually", "delivery_unknown", "bounced", "unknown_bounce",
  "opted_out", "complaint", "replied", "meeting_set", "opportunity", "won", "lost",
  "not_interested", "disqualified", "unknown",
]);
const CHANNELS = new Set(["email", "phone", "sms", "social", "in_person", "other", "none"]);
const LEARNING_TARGETS = new Set(["in_review", "approved", "rejected"]);

export async function recordOutcomeAction(input: Readonly<{
  accountId: string;
  playVersionId: string;
  outcome: string;
  channel: string;
  occurredAt: string;
  notes: string;
  outreachDraftVersionId?: string;
}>): Promise<SurfaceActionResult> {
  if (!OUTCOMES.has(input.outcome)) {
    return { ok: false, kind: "invalid", message: "Choose a valid outcome." };
  }
  if (!CHANNELS.has(input.channel)) {
    return { ok: false, kind: "invalid", message: "Choose a valid channel." };
  }
  const occurred = Date.parse(input.occurredAt);
  if (!Number.isFinite(occurred)) {
    return { ok: false, kind: "invalid", message: "The occurred-at time is invalid." };
  }
  return runSurfaceAction({
    permission: "outreach:edit",
    action: "l07:reporting:outcome:record",
    scopeClass: "workspace-required",
    resourceType: "outcome_record",
    revalidate: "/reporting",
  }, async (db, session) => {
    const notes = input.notes.trim();
    const sourceId = `member-note:${randomUUID()}`;
    const result = await recordOutcome(outcomeDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? "",
      accountId: input.accountId,
      playVersionId: input.playVersionId,
      stableKey: `outcome:${randomUUID()}`,
      outcome: input.outcome,
      channel: input.channel,
      occurredAt: new Date(occurred).toISOString(),
      notes: notes.length === 0 ? "Member-recorded outcome." : notes,
      source: {
        kind: "member_observation",
        sourceId,
        sourceVersionId: sourceId,
        sourceContentHash: `sha256:${createHash("sha256").update(notes || "member-recorded outcome").digest("hex")}`,
        sourceReceiptHash: `sha256:${createHash("sha256").update(sourceId).digest("hex")}`,
        observedAt: new Date().toISOString(),
      },
      recordedBy: session.userId,
      outreachDraftVersionId: input.outreachDraftVersionId,
      attribution: {
        kind: input.outreachDraftVersionId ? "direct" : "unknown",
        confidenceBasisPoints: input.outreachDraftVersionId ? 10_000 : 0,
        rationale: input.outreachDraftVersionId
          ? "Attributed to the outreach draft selected by the operator."
          : "No outreach draft was attributed by the operator.",
      },
    });
    return result.created ? "The outcome was recorded." : "An identical outcome already existed.";
  });
}

export async function transitionLearningReviewAction(input: Readonly<{
  accountId: string;
  playVersionId: string;
  versionId: string;
  to: "in_review" | "approved" | "rejected";
  expectedReviewHash?: string;
  reason: string;
}>): Promise<SurfaceActionResult> {
  if (!LEARNING_TARGETS.has(input.to)) {
    return { ok: false, kind: "invalid", message: "Unsupported review transition." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  return runSurfaceAction({
    permission: "outreach:approve",
    action: `l07:reporting:learning:${input.to}`,
    scopeClass: "workspace-required",
    resourceType: "learning_proposal",
    revalidate: "/reporting",
  }, async (db, session) => {
    await transitionLearningReview(learningDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId ?? "",
      accountId: input.accountId,
      playVersionId: input.playVersionId,
      versionId: input.versionId,
      to: input.to,
      actorId: session.userId,
      reason,
      expectedReviewHash: input.expectedReviewHash,
    });
    return `Learning proposal moved to ${input.to.replace("_", " ")}.`;
  });
}
