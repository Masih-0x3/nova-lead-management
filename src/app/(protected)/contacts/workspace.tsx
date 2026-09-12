"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ContactGovernancePanel } from "@/components/contacts/contact-governance-panel";
import { ContactPortfolioPanel, type ContactPortfolioItem } from "@/components/contacts/contact-portfolio-panel";
import type { ContactRecord } from "@/lib/contacts/contact-record";
import type { BuyingCenterView } from "@/lib/contacts/service";

import {
  requestContactReviewAction,
  transitionBuyingCenterReviewAction,
  transitionContactReviewAction,
} from "./actions";

type CenterHashes = ReadonlyMap<string, Readonly<{
  accountId: string;
  contentHash: string;
  reviewHash: string;
}>>;

export function ContactsWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string }>;
  contacts: readonly ContactPortfolioItem[];
  centers: readonly BuyingCenterView[];
  selectedRecord: ContactRecord | null;
  selectedHashes: Readonly<{
    versionId: string;
    accountId: string;
    contentHash: string;
    reviewHash: string;
  }> | null;
  centerHashes: CenterHashes;
  capabilities: Readonly<{ approve: boolean; centerApprove: boolean; queue: boolean }>;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [contactTransition, setContactTransition] = useState<"in_review" | "approved" | "rejected" | null>(null);
  const [centerTransition, setCenterTransition] = useState<Readonly<{
    versionId: string;
    to: "in_review" | "approved" | "rejected";
  }> | null>(null);
  const [queueTarget, setQueueTarget] = useState<ContactPortfolioItem | null>(null);

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

  const transitionLabel = (to: string) =>
    to === "in_review" ? "Request review" : to === "approved" ? "Approve" : "Reject";

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      {props.contacts.length === 0 ? (
        <ContactPortfolioPanel state="empty" />
      ) : (
        <ContactPortfolioPanel
          state="ready"
          scope={props.scope}
          contacts={props.contacts}
          onSelect={(contact) => router.push(`/contacts?contact=${encodeURIComponent(contact.versionId)}`)}
          onRequestReview={props.capabilities.queue
            ? (contact) => setQueueTarget(contact)
            : undefined}
        />
      )}

      {props.selectedRecord && props.selectedHashes && (
        <section aria-labelledby="contact-detail-title" className="space-y-3">
          <h2 id="contact-detail-title" className="section-label">Selected contact</h2>
          <ContactGovernancePanel
            state="ready"
            record={props.selectedRecord}
            asOf={new Date().toISOString()}
            onReview={props.capabilities.approve
              ? () => setContactTransition(
                props.selectedRecord?.review.status === "draft" ? "in_review" : "approved")
              : undefined}
          />
          {props.capabilities.approve && (
            <div className="flex flex-wrap justify-end gap-2">
              {(["in_review", "approved", "rejected"] as const)
                .filter((to) => to !== props.selectedRecord?.review.status)
                .map((to) => (
                  <button key={to} type="button" className="btn-glass min-h-11" disabled={pending}
                    onClick={() => setContactTransition(to)}>
                    {transitionLabel(to)}
                  </button>
                ))}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="buying-centers-title" className="space-y-3">
        <h2 id="buying-centers-title" className="section-label">Buying centers</h2>
        {props.centers.length === 0 ? (
          <p className="glass rounded-2xl p-5 text-sm" style={{ color: "var(--text-secondary)" }}>
            No buying-center hypotheses exist in this workspace yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {props.centers.map((center) => {
              const hashes = props.centerHashes.get(center.versionId);
              const actionable = props.capabilities.centerApprove && hashes !== undefined
                && (center.reviewStatus === "draft" || center.reviewStatus === "in_review");
              return (
                <li key={center.versionId} className="glass rounded-2xl p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                        {center.stableKey} · revision {center.revision}
                      </p>
                      <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
                        {center.hypothesisCount} hypotheses · {center.verifiedContactCount} verified contacts · {center.reviewStatus.replace("_", " ")}
                      </p>
                    </div>
                    {actionable && (
                      <div className="flex flex-wrap gap-2">
                        {(center.reviewStatus === "draft" ? (["in_review"] as const)
                          : (["approved", "rejected"] as const)).map((to) => (
                          <button key={to} type="button" className="btn-glass min-h-11 text-xs" disabled={pending}
                            onClick={() => setCenterTransition({ versionId: center.versionId, to })}>
                            {transitionLabel(to)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <ul className="mt-3 space-y-1" aria-label="Hypotheses">
                    {center.hypotheses.map((hypothesis, index) => (
                      <li key={index} className="text-xs" style={{ color: "var(--text-secondary)" }}>
                        {hypothesis.role} — confidence {Math.round(hypothesis.confidence * 100)}%
                        {hypothesis.verifiedContact ? " · verified contact bound" : " · hypothesis only"}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={contactTransition !== null}
        title={`${transitionLabel(contactTransition ?? "in_review")} contact`}
        message={contactTransition ? `Move this contact version to "${contactTransition.replace("_", " ")}"? The transition is recorded on the review ledger.` : ""}
        confirmLabel={transitionLabel(contactTransition ?? "in_review")}
        busy={pending}
        onConfirm={() => {
          const hashes = props.selectedHashes;
          const to = contactTransition;
          if (!hashes || !to || hashes.reviewHash === "" || hashes.contentHash === "") {
            setNotice("The contact hashes could not be read — the transition is unavailable.");
            setContactTransition(null);
            return;
          }
          run(transitionContactReviewAction({
            accountId: hashes.accountId,
            versionId: hashes.versionId,
            expectedVersionId: hashes.versionId,
            expectedContentHash: hashes.contentHash,
            expectedReviewHash: hashes.reviewHash,
            to,
            reason: `Operator moved the contact review to ${to.replace("_", " ")}.`,
          }), () => setContactTransition(null));
        }}
        onCancel={() => { if (!pending) setContactTransition(null); }}
      />

      <ConfirmDialog
        open={centerTransition !== null}
        title="Update buying-center review"
        message={centerTransition ? `Move this buying-center version to "${centerTransition.to.replace("_", " ")}"?` : ""}
        confirmLabel="Apply transition"
        busy={pending}
        onConfirm={() => {
          const target = centerTransition;
          const hashes = target ? props.centerHashes.get(target.versionId) : undefined;
          if (!target || !hashes) {
            setNotice("The buying-center hashes could not be read — the transition is unavailable.");
            setCenterTransition(null);
            return;
          }
          run(transitionBuyingCenterReviewAction({
            accountId: hashes.accountId,
            versionId: target.versionId,
            expectedVersionId: target.versionId,
            expectedContentHash: hashes.contentHash,
            expectedReviewHash: hashes.reviewHash,
            to: target.to,
            reason: `Operator moved the buying-center review to ${target.to.replace("_", " ")}.`,
          }), () => setCenterTransition(null));
        }}
        onCancel={() => { if (!pending) setCenterTransition(null); }}
      />

      <ConfirmDialog
        open={queueTarget !== null}
        title="Queue a human review"
        message={queueTarget ? `Add contact ${queueTarget.stableKey} to the review queue?` : ""}
        confirmLabel="Queue review"
        busy={pending}
        onConfirm={() => {
          const target = queueTarget;
          if (!target) return;
          run(requestContactReviewAction({
            accountId: target.accountId,
            versionId: target.versionId,
            reason: "Operator requested a human review from the contacts surface.",
          }), () => setQueueTarget(null));
        }}
        onCancel={() => { if (!pending) setQueueTarget(null); }}
      />
    </div>
  );
}
