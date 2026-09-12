"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { AdaptiveQuestionPanel } from "@/components/knowledge/adaptive-question-panel";
import { BusinessUnderstandingHistoryPanel, type BusinessUnderstandingVersionSummary } from "@/components/knowledge/business-understanding-history-panel";
import { BusinessUnderstandingReviewPanel } from "@/components/knowledge/business-understanding-review-panel";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { BusinessUnderstandingProposal } from "@/lib/understanding/business-understanding";
import type { AdaptiveQuestionSession, PlannedAdaptiveQuestion, QuestionAnswerRecord } from "@/lib/understanding/question-planner";

import { answerQuestionAction, reviewUnderstandingAction } from "./actions";

type Capabilities = Readonly<{
  edit: boolean;
  approve: boolean;
  answer: boolean;
}>;

export function KnowledgeWorkspace(props: Readonly<{
  proposal: BusinessUnderstandingProposal;
  versions: readonly BusinessUnderstandingVersionSummary[];
  reviewHashByVersionId: Readonly<Record<string, string>>;
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>;
  capabilities: Capabilities;
  questionSession: AdaptiveQuestionSession | null;
  questionAnswers: readonly QuestionAnswerRecord[];
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<Readonly<{
    to: "in_review" | "approved" | "rejected";
    title: string;
    confirmLabel: string;
  }> | null>(null);
  const [rollbackDialog, setRollbackDialog] = useState<BusinessUnderstandingVersionSummary | null>(null);
  const [reason, setReason] = useState("");
  const [answerDialog, setAnswerDialog] = useState<PlannedAdaptiveQuestion | null>(null);
  const [answerText, setAnswerText] = useState("");

  const run = (action: Promise<Readonly<{ ok: boolean; message: string }>>, close: () => void) => {
    startTransition(async () => {
      const result = await action;
      setNotice(result.message);
      if (result.ok) {
        close();
        router.refresh();
      }
    });
  };

  const submitReview = (to: "in_review" | "approved" | "rejected") => {
    run(reviewUnderstandingAction({
      versionId: props.proposal.versionId,
      expectedReviewHash: props.proposal.review.reviewHash,
      to,
      reason: reason.trim(),
    }), () => { setReviewDialog(null); setReason(""); });
  };

  const submitAnswer = (disposition: "answered" | "deferred") => {
    const question = answerDialog;
    const session = props.questionSession;
    if (!question || !session) return;
    run(answerQuestionAction({
      sessionRef: session.sessionRef,
      questionRef: question.questionRef,
      uncertaintyId: question.uncertaintyId,
      questionIdentity: question.questionIdentity,
      decisionKey: question.decisionKey,
      disposition,
      answerText: disposition === "answered" ? answerText.trim() : null,
    }), () => { setAnswerDialog(null); setAnswerText(""); });
  };

  const submitSkip = (question: PlannedAdaptiveQuestion) => {
    const session = props.questionSession;
    if (!session) return;
    run(answerQuestionAction({
      sessionRef: session.sessionRef,
      questionRef: question.questionRef,
      uncertaintyId: question.uncertaintyId,
      questionIdentity: question.questionIdentity,
      decisionKey: question.decisionKey,
      disposition: "deferred",
      answerText: null,
    }), () => undefined);
  };

  const submitRollback = (summary: BusinessUnderstandingVersionSummary) => {
    const targetVersionId = summary.rollbackTargetVersionId;
    if (!targetVersionId) return;
    const expectedReviewHash = props.reviewHashByVersionId[targetVersionId];
    if (!expectedReviewHash) return;
    run(reviewUnderstandingAction({
      versionId: targetVersionId,
      expectedReviewHash,
      to: "superseded",
      reason: `Rollback requested: restore revision ${summary.revision} as the governing version.`,
      replacementVersionId: summary.versionId,
    }), () => setRollbackDialog(null));
  };

  const reviewCapabilities = {
    onSubmitForReview: props.capabilities.edit && props.proposal.review.status === "draft"
      ? () => setReviewDialog({ to: "in_review", title: "Submit for human review", confirmLabel: "Submit" })
      : undefined,
    onApprove: props.capabilities.approve && props.proposal.review.status === "in_review"
      ? () => setReviewDialog({ to: "approved", title: "Approve this version", confirmLabel: "Approve" })
      : undefined,
    onReject: props.capabilities.approve && props.proposal.review.status === "in_review"
      ? () => setReviewDialog({ to: "rejected", title: "Reject this version", confirmLabel: "Reject" })
      : undefined,
  };

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      <section aria-labelledby="knowledge-understanding-title" className="space-y-4">
        <h2 id="knowledge-understanding-title" className="section-label">Business understanding</h2>
        <BusinessUnderstandingReviewPanel state="ready" proposal={props.proposal} {...reviewCapabilities} />
      </section>

      <section aria-labelledby="knowledge-questions-title" className="space-y-4">
        <h2 id="knowledge-questions-title" className="section-label">Adaptive questions</h2>
        {props.questionSession ? (
          <AdaptiveQuestionPanel
            state="ready"
            session={props.questionSession}
            answerHistory={props.questionAnswers}
            onAnswer={props.capabilities.answer ? (question) => { setAnswerText(""); setAnswerDialog(question); } : undefined}
            onSkip={props.capabilities.answer ? submitSkip : undefined}
          />
        ) : (
          <section className="glass rounded-2xl p-5" role="status" aria-labelledby="knowledge-questions-pending">
            <h3 id="knowledge-questions-pending" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              No question session yet
            </h3>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Adaptive question sessions are produced by the question planner from the understanding&apos;s
              uncertainty registry. The planner input seam (agent-produced question candidates) has not
              landed, so this surface shows sessions only after one exists for the selected version.
            </p>
          </section>
        )}
      </section>

      <section aria-labelledby="knowledge-history-title" className="space-y-4">
        <h2 id="knowledge-history-title" className="section-label">Version history</h2>
        <BusinessUnderstandingHistoryPanel
          state="ready"
          scope={props.scope}
          versions={props.versions}
          onOpen={(summary) => router.push(`/knowledge?version=${encodeURIComponent(summary.versionId)}`)}
          onReview={(summary) => router.push(`/knowledge?version=${encodeURIComponent(summary.versionId)}`)}
          onRollback={(summary) => setRollbackDialog(summary)}
        />
      </section>

      <TextPromptDialog
        open={reviewDialog !== null}
        title={reviewDialog?.title ?? "Review decision"}
        message="Record a human review decision for this understanding version. A short reason is required and stored in the audit trail."
        label="Decision reason"
        value={reason}
        confirmLabel={reviewDialog?.confirmLabel ?? "Record"}
        busy={pending}
        onChange={setReason}
        onConfirm={() => { if (reviewDialog) submitReview(reviewDialog.to); }}
        onCancel={() => { if (!pending) { setReviewDialog(null); setReason(""); } }}
      />

      <TextPromptDialog
        open={answerDialog !== null}
        title="Record answer"
        message={answerDialog ? `${answerDialog.prompt}` : ""}
        label="Answer"
        value={answerText}
        confirmLabel="Record answer"
        busy={pending}
        onChange={setAnswerText}
        onConfirm={() => submitAnswer("answered")}
        onCancel={() => { if (!pending) { setAnswerDialog(null); setAnswerText(""); } }}
      />

      <ConfirmDialog
        open={rollbackDialog !== null}
        title="Request rollback"
        message={rollbackDialog
          ? `Supersede the current approved version and restore revision ${rollbackDialog.revision} as the governing version. This is recorded as an audit event.`
          : ""}
        confirmLabel="Request rollback"
        busy={pending}
        onConfirm={() => { if (rollbackDialog) submitRollback(rollbackDialog); }}
        onCancel={() => { if (!pending) setRollbackDialog(null); }}
      />
    </div>
  );
}
