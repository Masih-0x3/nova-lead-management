"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { QualificationReviewPanel } from "@/components/qualification/qualification-review-panel";
import { ReviewOverviewPanel, type ReviewQueueSummary } from "@/components/review/review-overview-panel";
import { ReviewQueuePanel } from "@/components/review/review-queue-panel";
import { useDialogFocus } from "@/components/use-dialog-focus";
import type { QualificationDecision, AccountQualification } from "@/lib/qualification/account-qualification";
import type { ReviewQueue, ReviewQueueItem } from "@/lib/review/review-queue";

import { reviewQualificationAction, transitionQueueItemAction } from "./actions";

export function ReviewWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string }>;
  queue: ReviewQueue | null;
  queues: readonly ReviewQueueSummary[];
  actorId: string;
  now: string;
  selectedItem: ReviewQueueItem | null;
  selectedQualification: AccountQualification | null;
  capabilities: Readonly<{ operate: boolean; qualify: boolean; override: boolean }>;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [queueTransition, setQueueTransition] = useState<Readonly<{
    item: ReviewQueueItem;
    action: "claim" | "release" | "resolve";
  }> | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolutionDecision, setResolutionDecision] = useState<"confirmed" | "dismissed" | "changes_requested">("confirmed");
  const [overrideDecision, setOverrideDecision] = useState<QualificationDecision | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const resolveDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus({
    open: queueTransition?.action === "resolve",
    dialogRef: resolveDialogRef,
    onClose: () => { if (!pending) setQueueTransition(null); },
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

  const transitionMessage = (action: string, item: ReviewQueueItem) =>
    action === "claim"
      ? `Claim ${item.kind.replaceAll("_", " ")} ${item.itemId}?`
      : action === "release"
        ? `Release ${item.itemId} back to the queue?`
        : `Resolve ${item.itemId} with a recorded decision?`;

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      {props.queues.every((queue) => queue.ready + queue.claimed === 0) ? (
        <ReviewOverviewPanel state="empty" />
      ) : (
        <ReviewOverviewPanel
          state="ready"
          scope={props.scope}
          queues={props.queues}
          onOpenQueue={() => {
            document.getElementById("review-queue")?.scrollIntoView({ block: "start" });
          }}
        />
      )}

      <section id="review-queue" aria-labelledby="review-queue-title" className="space-y-3">
        <h2 id="review-queue-title" className="section-label">Queue</h2>
        {props.queue === null || props.queue.items.length === 0 ? (
          <p className="glass rounded-2xl p-5 text-sm" role="status" style={{ color: "var(--text-secondary)" }}>
            The review queue is empty — nothing is waiting for a human decision.
          </p>
        ) : (
          <ReviewQueuePanel
            state="ready"
            queue={props.queue}
            actorId={props.actorId}
            now={props.now}
            onClaim={props.capabilities.operate
              ? (item) => setQueueTransition({ item, action: "claim" })
              : undefined}
            onRelease={props.capabilities.operate
              ? (item) => setQueueTransition({ item, action: "release" })
              : undefined}
            onResolve={props.capabilities.operate
              ? (item) => setQueueTransition({ item, action: "resolve" })
              : undefined}
          />
        )}
        {props.queue !== null && props.queue.items.length > 0 && (
          <nav aria-label="Open a review item" className="flex flex-wrap gap-2 pt-1">
            {props.queue.items.filter((item) => item.status !== "resolved").map((item) => (
              <a key={item.itemId}
                href={`/review?item=${encodeURIComponent(item.itemId)}`}
                className="btn-glass inline-flex min-h-11 items-center text-xs focus-visible:outline-2 focus-visible:outline-offset-2"
                aria-current={props.selectedItem?.itemId === item.itemId ? "true" : undefined}>
                {item.kind.replaceAll("_", " ")}
              </a>
            ))}
          </nav>
        )}
      </section>

      {props.selectedItem && (
        <section aria-labelledby="review-item-title" className="glass rounded-2xl p-4 sm:p-5">
          <p className="section-label">Selected item</p>
          <h2 id="review-item-title" className="mt-1 text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            {props.selectedItem.kind.replaceAll("_", " ")}
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt style={{ color: "var(--text-tertiary)" }}>Item</dt><dd className="font-mono text-xs">{props.selectedItem.itemId}</dd></div>
            <div><dt style={{ color: "var(--text-tertiary)" }}>Subject</dt><dd className="font-mono text-xs">{props.selectedItem.subject.versionId}</dd></div>
            <div><dt style={{ color: "var(--text-tertiary)" }}>Status</dt><dd>{props.selectedItem.status}</dd></div>
            <div><dt style={{ color: "var(--text-tertiary)" }}>Reason</dt><dd>{props.selectedItem.reason}</dd></div>
          </dl>
        </section>
      )}

      {props.selectedQualification && (
        <section aria-labelledby="qualification-detail-title" className="space-y-3">
          <h2 id="qualification-detail-title" className="section-label">Qualification detail</h2>
          <QualificationReviewPanel
            state="ready"
            qualification={props.selectedQualification}
            onConfirm={props.capabilities.qualify ? () => setConfirmOpen(true) : undefined}
            onOverride={props.capabilities.override
              ? (decision) => setOverrideDecision(decision)
              : undefined}
          />
        </section>
      )}

      <ConfirmDialog
        open={queueTransition !== null && queueTransition.action !== "resolve"}
        title="Update queue item"
        message={queueTransition && queueTransition.action !== "resolve"
          ? transitionMessage(queueTransition.action, queueTransition.item) : ""}
        confirmLabel="Apply"
        busy={pending}
        onConfirm={() => {
          const target = queueTransition;
          if (!target) return;
          run(transitionQueueItemAction({
            itemId: target.item.itemId,
            action: target.action,
            reason: `Operator ${target.action}ed the item from the review surface.`,
          }), () => setQueueTransition(null));
        }}
        onCancel={() => { if (!pending) setQueueTransition(null); }}
      />

      {queueTransition?.action === "resolve" && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
          onClick={(event) => { if (!pending && event.target === event.currentTarget) setQueueTransition(null); }}>
          <div ref={resolveDialogRef} role="dialog" aria-modal="true" aria-labelledby="resolve-dialog-title"
            tabIndex={-1} className="glass-lg w-full max-w-sm rounded-2xl p-6">
            <h3 id="resolve-dialog-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Resolve queue item
            </h3>
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
              {transitionMessage("resolve", queueTransition.item)}
            </p>
            <form className="mt-4 space-y-3" onSubmit={(event) => {
              event.preventDefault();
              const target = queueTransition;
              const note = resolutionNote.trim();
              if (!target || note.length === 0) {
                setNotice("A resolution note is required.");
                return;
              }
              run(transitionQueueItemAction({
                itemId: target.item.itemId,
                action: "resolve",
                reason: `Resolved: ${resolutionDecision.replaceAll("_", " ")}`,
                resolution: { decision: resolutionDecision, note },
              }), () => {
                setQueueTransition(null);
                setResolutionNote("");
              });
            }}>
              <label className="block text-sm">
                <span className="section-label">Resolution decision</span>
                <select className="glass-input mt-1 w-full" value={resolutionDecision}
                  onChange={(event) => setResolutionDecision(event.target.value as typeof resolutionDecision)}>
                  <option value="confirmed">Confirmed</option>
                  <option value="dismissed">Dismissed</option>
                  <option value="changes_requested">Changes requested</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="section-label">Resolution note</span>
                <input className="glass-input mt-1 w-full" value={resolutionNote} required
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder="What was decided, and why?" />
              </label>
              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" className="btn-glass text-xs" disabled={pending}
                  onClick={() => setQueueTransition(null)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs" disabled={pending}>
                  {pending ? "Working..." : "Resolve item"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Confirm qualification"
        message="Confirm the automated qualification decision as reviewed?"
        confirmLabel="Confirm"
        busy={pending}
        onConfirm={() => {
          const qualification = props.selectedQualification;
          if (!qualification) return;
          run(reviewQualificationAction({
            accountId: qualification.accountId,
            versionId: qualification.versionId,
            expectedQualificationHash: qualification.qualificationHash,
            action: "confirm",
            reason: "Reviewer confirmed the automated qualification decision.",
          }), () => setConfirmOpen(false));
        }}
        onCancel={() => { if (!pending) setConfirmOpen(false); }}
      />

      <ConfirmDialog
        open={overrideDecision !== null}
        title="Override qualification"
        message={overrideDecision ? `Override the decision to "${overrideDecision.replaceAll("_", " ")}"? The override is recorded as a human judgment.` : ""}
        confirmLabel="Apply override"
        busy={pending}
        onConfirm={() => {
          const qualification = props.selectedQualification;
          const decision = overrideDecision;
          if (!qualification || !decision) return;
          run(reviewQualificationAction({
            accountId: qualification.accountId,
            versionId: qualification.versionId,
            expectedQualificationHash: qualification.qualificationHash,
            action: "override",
            decision,
            reason: `Reviewer overrode the automated decision to ${decision.replaceAll("_", " ")}.`,
          }), () => setOverrideDecision(null));
        }}
        onCancel={() => { if (!pending) setOverrideDecision(null); }}
      />
    </div>
  );
}
