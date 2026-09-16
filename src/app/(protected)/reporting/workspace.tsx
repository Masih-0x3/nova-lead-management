"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { LearningPortfolioPanel, type LearningPortfolioSummary } from "@/components/learning/learning-portfolio-panel";
import { LearningProposalPanel } from "@/components/learning/learning-proposal-panel";
import { OutcomePortfolioPanel, type OutcomePortfolioItem } from "@/components/outcomes/outcome-portfolio-panel";
import { OutcomeReportPanel } from "@/components/outcomes/outcome-report-panel";
import { useDialogFocus } from "@/components/use-dialog-focus";
import type { LearningProposal } from "@/lib/outcomes/learning-proposal";
import type { OutcomeAttributionReport } from "@/lib/outcomes/outcome-attribution";

import { recordOutcomeAction, transitionLearningReviewAction } from "./actions";

const OUTCOME_OPTIONS = [
  ["copied", "Copied"], ["exported", "Exported"], ["sent_manually", "Sent manually"],
  ["delivery_unknown", "Delivery unknown"], ["bounced", "Bounced"], ["opted_out", "Opted out"],
  ["complaint", "Complaint"], ["replied", "Replied"], ["meeting_set", "Meeting set"],
  ["opportunity", "Opportunity"], ["won", "Won"], ["lost", "Lost"],
  ["not_interested", "Not interested"], ["disqualified", "Disqualified"], ["unknown", "Unknown"],
] as const;

const CHANNEL_OPTIONS = [
  ["email", "Email"], ["phone", "Phone"], ["sms", "SMS"], ["social", "Social"],
  ["in_person", "In person"], ["other", "Other"], ["none", "None"],
] as const;

export function ReportingWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string }>;
  outcomes: readonly OutcomePortfolioItem[];
  proposals: readonly LearningPortfolioSummary[];
  report: OutcomeAttributionReport | null;
  selectedProposal: LearningProposal | null;
  accounts: readonly Readonly<{ accountId: string; displayName: string }>[];
  plays: readonly Readonly<{ playVersionId: string; displayName: string }>[];
  capabilities: Readonly<{ record: boolean; review: boolean }>;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [playVersionId, setPlayVersionId] = useState("");
  const [outcomeValue, setOutcomeValue] = useState("replied");
  const [channel, setChannel] = useState("email");
  const [occurredAt, setOccurredAt] = useState("");
  const [notes, setNotes] = useState("");
  const [learningTransition, setLearningTransition] = useState<"in_review" | "approved" | "rejected" | null>(null);
  const entryDialogRef = useRef<HTMLDivElement>(null);

  useDialogFocus({
    open: entryOpen,
    dialogRef: entryDialogRef,
    onClose: () => { if (!pending) setEntryOpen(false); },
  });

  const run = (action: Promise<Readonly<{ ok: boolean; message: string }>>, close?: () => void) => {
    startTransition(async () => {
      const result = await action;
      setNotice(result.message);
      if (result.ok) {
        close?.();
        router.refresh();
      }
    });
  };

  const proposal = props.selectedProposal;

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      {props.capabilities.record && (
        <section aria-labelledby="record-outcome-title" className="glass rounded-2xl p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="record-outcome-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Outcome capture</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                Record what a human observed after copy/export work. Outcomes feed reporting and learning.
              </p>
            </div>
            <button type="button" className="btn-primary min-h-11" onClick={() => setEntryOpen(true)}>
              Record an outcome
            </button>
          </div>
        </section>
      )}

      <section aria-labelledby="outcomes-title" className="space-y-3">
        <h2 id="outcomes-title" className="section-label">Outcome history</h2>
        {props.outcomes.length === 0 ? (
          <OutcomePortfolioPanel state="empty" />
        ) : (
          <OutcomePortfolioPanel
            state="ready"
            scope={props.scope}
            outcomes={props.outcomes}
          />
        )}
      </section>

      {props.report && (
        <section aria-labelledby="report-title" className="space-y-3">
          <h2 id="report-title" className="section-label">Attribution — last 90 days</h2>
          <OutcomeReportPanel state="ready" report={props.report} />
        </section>
      )}

      <section aria-labelledby="learning-title" className="space-y-3">
        <h2 id="learning-title" className="section-label">Learning proposals</h2>
        {props.proposals.length === 0 ? (
          <p className="glass rounded-2xl p-5 text-sm" role="status" style={{ color: "var(--text-secondary)" }}>
            No learning proposals exist yet — they are derived from measured outcome cohorts.
          </p>
        ) : (
          <LearningPortfolioPanel
            state="ready"
            scope={props.scope}
            proposals={props.proposals}
            onOpen={(item) => router.push(`/reporting?proposal=${encodeURIComponent(item.versionId)}`)}
            onReview={props.capabilities.review
              ? (item) => router.push(`/reporting?proposal=${encodeURIComponent(item.versionId)}`)
              : undefined}
          />
        )}
      </section>

      {proposal && (
        <section aria-labelledby="learning-detail-title" className="space-y-3">
          <h2 id="learning-detail-title" className="section-label">Selected proposal</h2>
          <LearningProposalPanel
            state="ready"
            proposal={proposal}
            onSubmitForReview={props.capabilities.review ? () => setLearningTransition("in_review") : undefined}
            onApprove={props.capabilities.review ? () => setLearningTransition("approved") : undefined}
            onReject={props.capabilities.review ? () => setLearningTransition("rejected") : undefined}
          />
        </section>
      )}

      {entryOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
          onClick={(event) => { if (!pending && event.target === event.currentTarget) setEntryOpen(false); }}>
          <div ref={entryDialogRef} role="dialog" aria-modal="true" aria-labelledby="outcome-dialog-title"
            tabIndex={-1} className="glass-lg max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl p-6">
            <h3 id="outcome-dialog-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Record an outcome
            </h3>
            <form className="mt-4 space-y-3" onSubmit={(event) => {
              event.preventDefault();
              run(recordOutcomeAction({
                accountId,
                playVersionId,
                outcome: outcomeValue,
                channel,
                occurredAt: occurredAt || new Date().toISOString(),
                notes,
              }), () => {
                setEntryOpen(false);
                setNotes("");
              });
            }}>
              <label className="block text-sm">
                <span className="section-label">Account</span>
                <select className="glass-input mt-1 w-full" value={accountId} required
                  onChange={(event) => setAccountId(event.target.value)}>
                  <option value="" disabled>Select an account</option>
                  {props.accounts.map((account) => (
                    <option key={account.accountId} value={account.accountId}>{account.displayName}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="section-label">Lead play</span>
                <select className="glass-input mt-1 w-full" value={playVersionId} required
                  onChange={(event) => setPlayVersionId(event.target.value)}>
                  <option value="" disabled>Select a play</option>
                  {props.plays.map((play) => (
                    <option key={play.playVersionId} value={play.playVersionId}>{play.displayName}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="section-label">Outcome</span>
                  <select className="glass-input mt-1 w-full" value={outcomeValue}
                    onChange={(event) => setOutcomeValue(event.target.value)}>
                    {OUTCOME_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="section-label">Channel</span>
                  <select className="glass-input mt-1 w-full" value={channel}
                    onChange={(event) => setChannel(event.target.value)}>
                    {CHANNEL_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              <label className="block text-sm">
                <span className="section-label">Occurred at</span>
                <input type="datetime-local" className="glass-input mt-1 w-full" value={occurredAt}
                  onChange={(event) => setOccurredAt(event.target.value)} />
              </label>
              <label className="block text-sm">
                <span className="section-label">Notes</span>
                <textarea className="glass-input mt-1 w-full" rows={3} value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="What did you observe?" />
              </label>
              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" className="btn-glass text-xs" disabled={pending}
                  onClick={() => setEntryOpen(false)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs" disabled={pending}>
                  {pending ? "Working..." : "Record outcome"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={learningTransition !== null}
        title="Update learning proposal"
        message={learningTransition ? `Move proposal ${proposal?.versionId ?? ""} to "${learningTransition.replace("_", " ")}"?` : ""}
        confirmLabel="Apply"
        busy={pending}
        onConfirm={() => {
          const to = learningTransition;
          if (!proposal || !to) return;
          run(transitionLearningReviewAction({
            accountId: proposal.accountId,
            playVersionId: proposal.target?.currentPlayVersionId ?? proposal.playVersionId ?? "",
            versionId: proposal.versionId,
            to,
            expectedReviewHash: proposal.review.reviewHash,
            reason: `Reviewer moved the learning proposal to ${to.replace("_", " ")}.`,
          }), () => setLearningTransition(null));
        }}
        onCancel={() => { if (!pending) setLearningTransition(null); }}
      />
    </div>
  );
}
