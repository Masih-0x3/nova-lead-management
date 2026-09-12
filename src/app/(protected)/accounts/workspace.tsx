"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { AccountMergeHistoryPanel } from "@/components/accounts/account-merge-history-panel";
import { AccountPortfolioPanel, type AccountPortfolioItem } from "@/components/accounts/account-portfolio-panel";
import { AccountResolutionPanel } from "@/components/accounts/account-resolution-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type {
  AccountMergeEvent,
  AccountMergeMember,
  AccountMergeSnapshot,
  AccountResolution,
} from "@/lib/discovery/account-resolution";
import type { ResolutionView } from "@/lib/discovery/account-service";

import {
  mergeAccountsAction,
  requestAccountReviewAction,
  unmergeAccountsAction,
} from "./actions";

type SelectedAccount = Readonly<{
  accountId: string;
  displayName: string;
  observationRefs: readonly string[];
}>;

export function AccountsWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string }>;
  accounts: readonly AccountPortfolioItem[];
  resolutions: readonly ResolutionView[];
  selectedAccount: SelectedAccount | null;
  selectedResolution: AccountResolution | null;
  mergeSnapshot: AccountMergeSnapshot | null;
  mergeStateHash: string | null;
  mergeBinding: AccountMergeMember | null;
  mergeEvents: readonly AccountMergeEvent[];
  activeAccounts: readonly Readonly<{ accountId: string; displayName: string; observationRefs: readonly string[] }>[];
  capabilities: Readonly<{ edit: boolean; merge: boolean; queue: boolean }>;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergePartnerId, setMergePartnerId] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [unmergeRequest, setUnmergeRequest] = useState<Readonly<{
    event: AccountMergeEvent;
  }> | null>(null);

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

  const mergePartners = props.activeAccounts.filter(
    (account) => account.accountId !== props.selectedAccount?.accountId,
  );

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      {props.accounts.length === 0 ? (
        <AccountPortfolioPanel state="empty" />
      ) : (
        <AccountPortfolioPanel
          state="ready"
          scope={props.scope}
          accounts={props.accounts}
          onSelect={(account) => router.push(`/accounts?account=${encodeURIComponent(account.accountId)}`)}
          onRequestReview={props.capabilities.queue
            ? (account) => setReviewTarget(account.accountId)
            : undefined}
        />
      )}

      {props.selectedAccount && (
        <section aria-labelledby="account-detail-title" className="glass rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="section-label">Selected account</p>
              <h2 id="account-detail-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                {props.selectedAccount.displayName}
              </h2>
            </div>
            {props.capabilities.merge && props.mergeStateHash !== null && mergePartners.length > 0 && (
              <button type="button" className="btn-glass min-h-11" onClick={() => setMergeOpen(!mergeOpen)}>
                {mergeOpen ? "Close merge" : "Merge into another account"}
              </button>
            )}
          </div>

          {mergeOpen && props.mergeStateHash !== null && (
            <form className="space-y-3" onSubmit={(event) => {
              event.preventDefault();
              const selected = props.selectedAccount;
              const partner = mergePartners.find((account) => account.accountId === mergePartnerId);
              if (!selected || !partner || props.mergeStateHash === null) return;
              run(mergeAccountsAction({
                survivorAccountId: partner.accountId,
                retiredAccountId: selected.accountId,
                evidenceObservationIds: [...partner.observationRefs, ...selected.observationRefs],
                expectedStateHash: props.mergeStateHash,
                reason: mergeReason,
              }), () => {
                setMergeOpen(false);
                setMergePartnerId("");
                setMergeReason("");
              });
            }}>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                This account is retired and redirected into the survivor. The merge stays reversible through the merge ledger below.
              </p>
              <label className="block text-sm">
                <span className="section-label">Surviving account</span>
                <select className="glass-input mt-1 w-full" value={mergePartnerId} required
                  onChange={(event) => setMergePartnerId(event.target.value)}>
                  <option value="" disabled>Select the account that survives</option>
                  {mergePartners.map((account) => (
                    <option key={account.accountId} value={account.accountId}>{account.displayName}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="section-label">Reason</span>
                <input className="glass-input mt-1 w-full" value={mergeReason} required
                  onChange={(event) => setMergeReason(event.target.value)}
                  placeholder="Why do these records describe one account?" />
              </label>
              <div className="flex justify-end">
                <button type="submit" className="btn-primary min-h-11" disabled={pending}>
                  {pending ? "Working…" : "Apply merge"}
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            <h3 className="section-label">Resolutions for this account</h3>
            {props.resolutions.filter((resolution) =>
              resolution.targetAccountId === props.selectedAccount?.accountId
              || resolution.candidateAccountIds.includes(props.selectedAccount?.accountId ?? "")).length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                No resolutions reference this account yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {props.resolutions
                  .filter((resolution) =>
                    resolution.targetAccountId === props.selectedAccount?.accountId
                    || resolution.candidateAccountIds.includes(props.selectedAccount?.accountId ?? ""))
                  .map((resolution) => (
                    <li key={resolution.resolutionId}>
                      <a
                        className="glass flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                        href={`/accounts?account=${encodeURIComponent(props.selectedAccount?.accountId ?? "")}&resolution=${encodeURIComponent(resolution.resolutionId)}`}
                      >
                        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{resolution.resolutionId}</span>
                        <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{resolution.state.replaceAll("_", " ")}</span>
                      </a>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {props.selectedResolution && (
        <AccountResolutionPanel
          state="ready"
          resolution={props.selectedResolution}
          mergeSnapshot={props.mergeSnapshot}
          onRequestReview={props.capabilities.queue && props.selectedResolution.state === "human_review"
            && (props.selectedResolution.targetAccountId !== null
              || props.selectedResolution.candidateAccountIds.length > 0)
            ? (resolution) => setReviewTarget(
              resolution.targetAccountId ?? resolution.candidateAccountIds[0] ?? null)
            : undefined}
          onRequestUnmerge={props.capabilities.merge && props.mergeStateHash !== null
            ? (request) => {
              const event = [...request.snapshot.events].reverse().find(
                (candidate) => candidate.survivorAccountId === request.survivorAccountId
                  && candidate.retiredAccountId === request.retiredAccountId
                  && candidate.action === "merge");
              if (event) setUnmergeRequest({ event });
            }
            : undefined}
        />
      )}

      {props.selectedAccount && props.mergeBinding && props.mergeEvents.length > 0 && (
        <AccountMergeHistoryPanel
          state="ready"
          tenantId={props.scope.tenantId}
          workspaceId={props.scope.workspaceId}
          currentBinding={props.mergeBinding}
          events={props.mergeEvents.filter((event) =>
            event.survivorAccountId === props.mergeBinding?.accountId
            || event.retiredAccountId === props.mergeBinding?.accountId)}
          unmergeAuthorized={props.capabilities.merge}
          onRequestUnmerge={props.capabilities.merge && props.mergeStateHash !== null
            ? (request) => setUnmergeRequest({ event: request.governingMergeEvent })
            : undefined}
        />
      )}

      <ConfirmDialog
        open={reviewTarget !== null}
        title="Queue a human review"
        message="Add this account to the review queue as an ambiguous account resolution?"
        confirmLabel="Queue review"
        busy={pending}
        onConfirm={() => {
          const accountId = reviewTarget;
          if (!accountId) return;
          run(requestAccountReviewAction({
            accountId,
            reason: "Operator requested a human resolution review from the accounts surface.",
          }), () => setReviewTarget(null));
        }}
        onCancel={() => { if (!pending) setReviewTarget(null); }}
      />

      <ConfirmDialog
        open={unmergeRequest !== null}
        title="Reverse this merge"
        message={unmergeRequest ? `Restore ${unmergeRequest.event.retiredAccountId} as an independent account? The reversal is recorded in the merge ledger.` : ""}
        confirmLabel="Reverse merge"
        busy={pending}
        onConfirm={() => {
          const request = unmergeRequest;
          const hash = props.mergeStateHash;
          if (!request || hash === null) {
            setNotice("The merge ledger state could not be read — unmerge is unavailable.");
            setUnmergeRequest(null);
            return;
          }
          run(unmergeAccountsAction({
            survivorAccountId: request.event.survivorAccountId,
            retiredAccountId: request.event.retiredAccountId,
            evidenceObservationIds: request.event.evidenceObservationIds,
            expectedStateHash: hash,
            reason: `Reversal of merge event ${request.event.eventId}.`,
          }), () => setUnmergeRequest(null));
        }}
        onCancel={() => { if (!pending) setUnmergeRequest(null); }}
      />
    </div>
  );
}
