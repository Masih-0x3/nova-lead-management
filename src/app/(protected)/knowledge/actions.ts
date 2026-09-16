"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { getTenantSession } from "@/lib/auth";
import { TenantAuthorizationError } from "@/lib/tenancy/authorize";
import {
  recordAuthenticatedQuestionAnswer,
  transitionAuthenticatedUnderstandingReview,
} from "@/lib/understanding/authenticated-service";
import type { AnswerDisposition } from "@/lib/understanding/question-planner";
import type { BusinessUnderstandingReviewStatus } from "@/lib/understanding/business-understanding";

export type KnowledgeActionResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; message: string }>;

function failure(error: unknown, fallback: string): KnowledgeActionResult {
  if (error instanceof TenantAuthorizationError) {
    return { ok: false, message: "This action is not allowed for your tenant role." };
  }
  return { ok: false, message: fallback };
}

function serviceFailure(code: string): KnowledgeActionResult {
  if (code === "STALE_VERSION" || code === "VERSION_CONFLICT" || code === "PERSISTENCE_CONFLICT") {
    return { ok: false, message: "The record changed since it was loaded. Reload and retry." };
  }
  if (code === "NOT_FOUND") return { ok: false, message: "The record is not available." };
  return { ok: false, message: `The service rejected the request (${code}).` };
}

const REVIEW_TARGETS = new Set(["in_review", "approved", "rejected", "superseded"]);

export async function reviewUnderstandingAction(input: Readonly<{
  versionId: string;
  expectedReviewHash: string;
  to: string;
  reason: string;
  replacementVersionId?: string | null;
}>): Promise<KnowledgeActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!REVIEW_TARGETS.has(input.to)) return { ok: false, message: "The review transition is invalid." };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length === 0) return { ok: false, message: "A decision reason is required." };
  try {
    const result = await transitionAuthenticatedUnderstandingReview(
      { tenantId: session.tenantId, workspaceId: session.workspaceId },
      {
        versionId: input.versionId,
        expectedReviewHash: input.expectedReviewHash,
        to: input.to as Exclude<BusinessUnderstandingReviewStatus, "draft">,
        reason,
        actor: { kind: "human", actorId: session.userId },
        replacementVersionId: input.replacementVersionId ?? null,
      },
      { correlationId: `l07:knowledge:understanding-review:${randomUUID()}` },
    );
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/knowledge");
    revalidatePath("/onboarding");
    return { ok: true, message: "Review decision recorded." };
  } catch (error) {
    return failure(error, "The review decision could not be recorded.");
  }
}

const ANSWER_DISPOSITIONS = new Set<AnswerDisposition>([
  "answered", "corrected", "deferred", "dismissed", "unknown", "not_applicable",
]);

export async function answerQuestionAction(input: Readonly<{
  sessionRef: string;
  questionRef: string;
  uncertaintyId: string;
  questionIdentity: string;
  decisionKey: string;
  disposition: string;
  answerText?: string | null;
}>): Promise<KnowledgeActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!ANSWER_DISPOSITIONS.has(input.disposition as AnswerDisposition)) {
    return { ok: false, message: "The answer disposition is invalid." };
  }
  try {
    const result = await recordAuthenticatedQuestionAnswer(
      { tenantId: session.tenantId, workspaceId: session.workspaceId },
      {
        answerId: `answer:${randomUUID()}`,
        sessionRef: input.sessionRef,
        questionRef: input.questionRef,
        uncertaintyId: input.uncertaintyId,
        questionIdentity: input.questionIdentity,
        decisionKey: input.decisionKey,
        disposition: input.disposition as AnswerDisposition,
        answerText: input.answerText ?? null,
      },
      { correlationId: `l07:knowledge:answer:${randomUUID()}` },
    );
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/knowledge");
    return { ok: true, message: "Answer recorded." };
  } catch (error) {
    return failure(error, "The answer could not be recorded.");
  }
}
