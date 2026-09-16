"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { OutreachHistoryPanel, type OutreachHistoryVersionSummary } from "@/components/outreach/outreach-history-panel";
import { OutreachPortfolioPanel, type OutreachPortfolioItem } from "@/components/outreach/outreach-portfolio-panel";
import { OutreachReviewPanel } from "@/components/outreach/outreach-review-panel";
import { useDialogFocus } from "@/components/use-dialog-focus";
import type { SuppressionView } from "@/lib/suppressions/service";

import {
  handoffDraftAction,
  recordSuppressionAction,
  transitionDraftReviewAction,
} from "./actions";

export type DraftDetail = Readonly<{
  accountId: string;
  stableKey: string;
  versionId: string;
  revision: number;
  contactVersionId: string | null;
  stateHash: string | null;
  reviewHash: string;
  draft: Readonly<{
    versionLabel: string;
    status: "draft" | "in_review" | "approved" | "rejected";
    statusLabel: string;
    subject: string;
    body: string;
  }>;
  claims: readonly Readonly<{
    claimId: string;
    statement: string;
    material: true;
    support: "current" | "stale" | "conflicted" | "uncertain";
    evidence: readonly Readonly<{
      evidenceId: string;
      sourceLabel: string;
      quote: string;
      locator: string;
      status: "current" | "stale" | "conflicted";
    }>[];
  }>[];
  uncertainties: readonly Readonly<{
    uncertaintyId: string;
    statement: string;
    impact: string;
  }>[];
  approval: Readonly<{
    status: "pending" | "approved" | "rejected";
    label: string;
    decidedAtLabel: string | null;
  }>;
  policy: Readonly<{
    result: "allow" | "deny";
    reasons: readonly Readonly<{ code: string; label: string; detail: string }>[];
  }>;
  eligibleActions: readonly ("copy" | "export")[];
  canReview: boolean;
}>;

export function OutreachWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string }>;
  drafts: readonly OutreachPortfolioItem[];
  detail: DraftDetail | null;
  history: readonly OutreachHistoryVersionSummary[];
  suppressions: readonly SuppressionView[];
  capabilities: Readonly<{ approve: boolean; copyExport: boolean; suppressions: boolean }>;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewTransition, setReviewTransition] = useState<"in_review" | "approved" | "rejected" | null>(null);
  const [handoffAction, setHandoffAction] = useState<"copy" | "export" | null>(null);
  const [suppressOpen, setSuppressOpen] = useState(false);
  const [suppressDisposition, setSuppressDisposition] = useState("opt_out");
  const [suppressReason, setSuppressReason] = useState("");
  const [suppressAccountId, setSuppressAccountId] = useState("");
  const handoffDialogRef = useRef<HTMLDivElement>(null);
  const suppressDialogRef = useRef<HTMLDivElement>(null);
  const timezoneId = useId();

  useDialogFocus({
    open: handoffAction !== null,
    dialogRef: handoffDialogRef,
    onClose: () => { if (!pending) setHandoffAction(null); },
  });
  useDialogFocus({
    open: suppressOpen,
    dialogRef: suppressDialogRef,
    onClose: () => { if (!pending) setSuppressOpen(false); },
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

  const detail = props.detail;
  const reviewLabel = (to: string) =>
    to === "in_review" ? "Request review" : to === "approved" ? "Approve draft" : "Reject draft";

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      <p className="glass rounded-2xl px-4 py-3 text-xs" role="note" style={{ color: "var(--text-secondary)" }}>
        Outreach is review, approval, copy, and export only — no send path exists anywhere in this surface.
      </p>

      {props.drafts.length === 0 ? (
        <OutreachPortfolioPanel state="empty" />
      ) : (
        <OutreachPortfolioPanel
          state="ready"
          scope={props.scope}
          drafts={props.drafts}
          onOpen={(draft) => router.push(`/outreach?draft=${encodeURIComponent(draft.version.versionId)}`)}
          onReview={props.capabilities.approve
            ? (draft) => router.push(`/outreach?draft=${encodeURIComponent(draft.version.versionId)}`)
            : undefined}
          onCopy={props.capabilities.copyExport
            ? (draft) => {
              router.push(`/outreach?draft=${encodeURIComponent(draft.version.versionId)}`);
              setHandoffAction("copy");
            }
            : undefined}
          onExport={props.capabilities.copyExport
            ? (draft) => {
              router.push(`/outreach?draft=${encodeURIComponent(draft.version.versionId)}`);
              setHandoffAction("export");
            }
            : undefined}
        />
      )}

      {detail && (
        <section aria-labelledby="draft-detail-title" className="space-y-3">
          <h2 id="draft-detail-title" className="section-label">Selected draft</h2>
          <OutreachReviewPanel
            draft={detail.draft}
            claims={detail.claims}
            uncertainties={detail.uncertainties}
            approval={detail.approval}
            policy={detail.policy}
            eligibleActions={detail.eligibleActions}
            onAction={(action) => setHandoffAction(action)}
          />
          {detail.canReview && (
            <div className="flex flex-wrap justify-end gap-2">
              {(["in_review", "approved", "rejected"] as const)
                .filter((to) => to !== detail.draft.status)
                .map((to) => (
                  <button key={to} type="button" className="btn-glass min-h-11 text-xs" disabled={pending}
                    onClick={() => setReviewTransition(to)}>
                    {reviewLabel(to)}
                  </button>
                ))}
            </div>
          )}
        </section>
      )}

      {detail && props.history.length > 0 && (
        <section aria-labelledby="draft-history-title" className="space-y-3">
          <h2 id="draft-history-title" className="section-label">Version history</h2>
          <OutreachHistoryPanel
            state="ready"
            scope={props.scope}
            draftId={detail.stableKey}
            versions={props.history}
            onOpen={(summary) => router.push(`/outreach?draft=${encodeURIComponent(summary.version.versionId)}`)}
            onCopy={props.capabilities.copyExport ? () => setHandoffAction("copy") : undefined}
            onExport={props.capabilities.copyExport ? () => setHandoffAction("export") : undefined}
          />
        </section>
      )}

      <section aria-labelledby="suppressions-title" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="suppressions-title" className="section-label">Suppressions</h2>
          {props.capabilities.suppressions && (
            <button type="button" className="btn-glass min-h-11 text-xs" onClick={() => setSuppressOpen(true)}>
              Record suppression
            </button>
          )}
        </div>
        {props.suppressions.length === 0 ? (
          <p className="glass rounded-2xl p-5 text-sm" role="status" style={{ color: "var(--text-secondary)" }}>
            No suppression records exist in this workspace.
          </p>
        ) : (
          <ul className="space-y-2">
            {props.suppressions.map((view) => (
              <li key={view.recordId} className="glass rounded-xl px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                    {view.disposition.replaceAll("_", " ")}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{view.recordedAt}</span>
                </div>
                <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{view.reason}</p>
                <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {view.accountId ?? "tenant-wide"}{view.contactStableKey ? ` · ${view.contactStableKey}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={reviewTransition !== null}
        title={reviewLabel(reviewTransition ?? "in_review")}
        message={reviewTransition ? `Move draft ${detail?.draft.versionLabel ?? ""} to "${reviewTransition.replace("_", " ")}"?` : ""}
        confirmLabel={reviewLabel(reviewTransition ?? "in_review")}
        busy={pending}
        onConfirm={() => {
          const to = reviewTransition;
          if (!detail || !to) return;
          run(transitionDraftReviewAction({
            accountId: detail.accountId,
            versionId: detail.versionId,
            expectedReviewHash: detail.reviewHash,
            to,
            reason: `Reviewer moved the draft to ${to.replace("_", " ")}.`,
          }), () => setReviewTransition(null));
        }}
        onCancel={() => { if (!pending) setReviewTransition(null); }}
      />

      {handoffAction !== null && detail && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
          onClick={(event) => { if (!pending && event.target === event.currentTarget) setHandoffAction(null); }}>
          <div ref={handoffDialogRef} role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title"
            tabIndex={-1} className="glass-lg w-full max-w-sm rounded-2xl p-6">
            <h3 id="handoff-dialog-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {handoffAction === "copy" ? "Copy handoff" : "Export handoff"}
            </h3>
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
              The handoff produces a {handoffAction === "copy" ? "copy receipt" : "export receipt"} only — it never sends anything.
            </p>
            <form className="mt-4 space-y-3" onSubmit={(event) => {
              event.preventDefault();
              const action = handoffAction;
              if (!detail.contactVersionId || !action) {
                setNotice("This draft has no bound contact — the handoff is unavailable.");
                setHandoffAction(null);
                return;
              }
              run(handoffDraftAction({
                accountId: detail.accountId,
                stableKey: detail.stableKey,
                action,
                contactVersionId: detail.contactVersionId,
                recipientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                idempotencyKey: crypto.randomUUID(),
                expectedDraftStateHash: detail.stateHash ?? undefined,
                expectedDraftVersionId: detail.versionId,
                expectedDraftReviewHash: detail.reviewHash,
              }), () => setHandoffAction(null));
            }}>
              <p className="text-xs" id={timezoneId} style={{ color: "var(--text-tertiary)" }}>
                Recipient timezone defaults to your local zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}); quiet hours are evaluated against it.
              </p>
              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" className="btn-glass text-xs" disabled={pending}
                  onClick={() => setHandoffAction(null)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs" disabled={pending || detail.contactVersionId === null}>
                  {pending ? "Working..." : `Request ${handoffAction}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {suppressOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
          onClick={(event) => { if (!pending && event.target === event.currentTarget) setSuppressOpen(false); }}>
          <div ref={suppressDialogRef} role="dialog" aria-modal="true" aria-labelledby="suppress-dialog-title"
            tabIndex={-1} className="glass-lg w-full max-w-sm rounded-2xl p-6">
            <h3 id="suppress-dialog-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Record a suppression
            </h3>
            <form className="mt-4 space-y-3" onSubmit={(event) => {
              event.preventDefault();
              run(recordSuppressionAction({
                accountId: suppressAccountId.trim() === "" ? null : suppressAccountId.trim(),
                disposition: suppressDisposition,
                reason: suppressReason,
              }), () => {
                setSuppressOpen(false);
                setSuppressReason("");
                setSuppressAccountId("");
              });
            }}>
              <label className="block text-sm">
                <span className="section-label">Disposition</span>
                <select className="glass-input mt-1 w-full" value={suppressDisposition}
                  onChange={(event) => setSuppressDisposition(event.target.value)}>
                  <option value="opt_out">Opt out</option>
                  <option value="do_not_contact">Do not contact</option>
                  <option value="complaint">Complaint</option>
                  <option value="hard_bounce">Hard bounce</option>
                  <option value="soft_bounce">Soft bounce</option>
                  <option value="source_prohibited">Source prohibited</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="section-label">Account scope (optional)</span>
                <input className="glass-input mt-1 w-full" value={suppressAccountId}
                  onChange={(event) => setSuppressAccountId(event.target.value)}
                  placeholder="Account UUID — leave empty for workspace-wide" />
              </label>
              <label className="block text-sm">
                <span className="section-label">Reason</span>
                <input className="glass-input mt-1 w-full" value={suppressReason} required
                  onChange={(event) => setSuppressReason(event.target.value)}
                  placeholder="Why is this contact suppressed?" />
              </label>
              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" className="btn-glass text-xs" disabled={pending}
                  onClick={() => setSuppressOpen(false)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs" disabled={pending}>
                  {pending ? "Working..." : "Record suppression"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
