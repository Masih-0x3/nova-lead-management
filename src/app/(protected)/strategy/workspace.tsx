"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { useDialogFocus } from "@/components/use-dialog-focus";
import { IcpReviewPanel } from "@/components/strategy/icp-review-panel";
import { LeadPlayPanel } from "@/components/strategy/lead-play-panel";
import {
  StrategyPortfolioPanel,
  type StrategyPortfolioSummary,
} from "@/components/strategy/strategy-portfolio-panel";
import type { IcpVersionView, LeadPlayVersionView } from "@/lib/strategy/service";
import type { LeadPlayActivationState, LeadPlaySimulationEligibilityReview } from "@/lib/strategy/lead-play-activation";
import type { LeadPlaySimulation } from "@/lib/strategy/lead-play-simulation";

import type { UnderstandingClaimOption } from "./page";
import { IcpAuthoringForm, LeadPlayAuthoringForm } from "./authoring";
import {
  reviewIcpAction,
  reviewPlayAction,
  reviewSimulationAction,
  simulatePlayAction,
  transitionActivationAction,
} from "./actions";

type Capabilities = Readonly<{
  icpEdit: boolean;
  icpApprove: boolean;
  playEdit: boolean;
  playApprove: boolean;
  playActivate: boolean;
}>;

export function StrategyWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>;
  summaries: readonly StrategyPortfolioSummary[];
  capabilities: Capabilities;
  approvedUnderstanding: Readonly<{ versionId: string; revision: number }> | null;
  approvedIcp: Readonly<{ versionId: string; revision: number; title: string }> | null;
  claims: readonly UnderstandingClaimOption[];
  selectedIcp: IcpVersionView | null;
  selectedPlay: LeadPlayVersionView | null;
  playSimulation: LeadPlaySimulation | null;
  playEligibility: LeadPlaySimulationEligibilityReview | null;
  playActivation: LeadPlayActivationState | null;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<Readonly<{
    kind: "icp" | "play";
    to: "in_review" | "approved" | "rejected";
    versionId: string;
    expectedReviewHash: string;
    title: string;
    confirmLabel: string;
  }> | null>(null);
  const [reason, setReason] = useState("");
  const [simulateDialog, setSimulateDialog] = useState(false);
  const [simulateRequests, setSimulateRequests] = useState("100");
  const [simulateSpend, setSimulateSpend] = useState("0");
  const [simulateAccounts, setSimulateAccounts] = useState("[]");
  const [eligibilityDialog, setEligibilityDialog] = useState(false);
  const [eligibilityDecision, setEligibilityDecision] = useState<"eligible" | "ineligible">("eligible");
  const [activationDialog, setActivationDialog] = useState<"activate" | "rollback" | null>(null);
  const [authoring, setAuthoring] = useState<"icp" | "play" | null>(null);

  const capabilities = props.capabilities;

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

  const openFor = (summary: StrategyPortfolioSummary) => {
    const key = summary.kind === "icp" ? "icp" : "play";
    router.push(`/strategy?${key}=${encodeURIComponent(summary.versionId)}`);
  };

  const icpProposal = props.selectedIcp?.proposal ?? null;
  const playProposal = props.selectedPlay?.proposal ?? null;
  const playActivation = props.playActivation;

  const icpActions = icpProposal === null ? {} : {
    onSubmitForReview: capabilities.icpEdit && icpProposal.review.status === "draft"
      ? () => setReviewDialog({
        kind: "icp", to: "in_review", versionId: icpProposal.versionId,
        expectedReviewHash: icpProposal.review.reviewHash,
        title: "Submit ICP for human review", confirmLabel: "Submit",
      })
      : undefined,
    onApprove: capabilities.icpApprove && icpProposal.review.status === "in_review"
      ? () => setReviewDialog({
        kind: "icp", to: "approved", versionId: icpProposal.versionId,
        expectedReviewHash: icpProposal.review.reviewHash,
        title: "Approve this ICP version", confirmLabel: "Approve",
      })
      : undefined,
    onReject: capabilities.icpApprove && icpProposal.review.status === "in_review"
      ? () => setReviewDialog({
        kind: "icp", to: "rejected", versionId: icpProposal.versionId,
        expectedReviewHash: icpProposal.review.reviewHash,
        title: "Reject this ICP version", confirmLabel: "Reject",
      })
      : undefined,
  };

  const submitReview = () => {
    const dialog = reviewDialog;
    if (!dialog) return;
    const action = dialog.kind === "icp" ? reviewIcpAction : reviewPlayAction;
    run(action({
      versionId: dialog.versionId,
      expectedReviewHash: dialog.expectedReviewHash,
      to: dialog.to,
      reason: reason.trim(),
    }), () => { setReviewDialog(null); setReason(""); });
  };

  const submitSimulate = () => {
    const play = playProposal;
    if (!play) return;
    let accounts: unknown;
    try {
      accounts = JSON.parse(simulateAccounts);
    } catch {
      setNotice("The accounts payload is not valid JSON.");
      return;
    }
    if (!Array.isArray(accounts)) {
      setNotice("The accounts payload must be a JSON array.");
      return;
    }
    const providerRequests = Number(simulateRequests);
    const spendCents = Math.round(Number(simulateSpend) * 100);
    if (!Number.isSafeInteger(providerRequests) || providerRequests < 0 || !Number.isSafeInteger(spendCents) || spendCents < 0) {
      setNotice("Estimates must be non-negative numbers.");
      return;
    }
    run(simulatePlayAction({
      playVersionId: play.versionId,
      providerRequests,
      spendCents,
      accounts,
    }), () => setSimulateDialog(false));
  };

  const submitEligibility = () => {
    const play = playProposal;
    const simulation = props.playSimulation;
    if (!play || !simulation) return;
    run(reviewSimulationAction({
      playVersionId: play.versionId,
      simulationId: simulation.simulationId,
      decision: eligibilityDecision,
      reason: reason.trim(),
    }), () => { setEligibilityDialog(false); setReason(""); });
  };

  const submitActivation = () => {
    const play = playProposal;
    const action = activationDialog;
    if (!play || !action || !playActivation) return;
    run(transitionActivationAction({
      stableKey: play.stableKey,
      playVersionId: play.versionId,
      expectedStateHash: playActivation.stateHash,
      action,
      reason: reason.trim(),
    }), () => { setActivationDialog(null); setReason(""); });
  };

  const playEligible = props.playSimulation !== null && props.playEligibility?.decision === "eligible";
  const canSimulate = capabilities.playEdit && playProposal !== null && playProposal.review.status === "approved";
  const canReviewSimulation = capabilities.playApprove && playProposal !== null
    && props.playSimulation !== null && props.playEligibility === null;

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      {(capabilities.icpEdit || capabilities.playEdit) && (
        <section aria-labelledby="strategy-authoring-title" className="glass rounded-2xl p-4 sm:p-5">
          <h2 id="strategy-authoring-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Authoring</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            New drafts are bound to the current approved understanding and ICP.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {capabilities.icpEdit && (
              <button type="button" className="btn-glass min-h-11" disabled={props.approvedUnderstanding === null}
                onClick={() => setAuthoring(authoring === "icp" ? null : "icp")}>
                {authoring === "icp" ? "Close ICP draft" : "New ICP draft"}
              </button>
            )}
            {capabilities.playEdit && (
              <button type="button" className="btn-glass min-h-11" disabled={props.approvedIcp === null}
                onClick={() => setAuthoring(authoring === "play" ? null : "play")}>
                {authoring === "play" ? "Close play draft" : "New lead-play draft"}
              </button>
            )}
          </div>
          {capabilities.icpEdit && props.approvedUnderstanding === null && (
            <p className="mt-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
              ICP authoring unlocks once an understanding version is approved on the Knowledge surface.
            </p>
          )}
          {capabilities.playEdit && props.approvedUnderstanding !== null && props.approvedIcp === null && (
            <p className="mt-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
              Lead-play authoring unlocks once an ICP version is approved.
            </p>
          )}
          {authoring === "icp" && props.approvedUnderstanding !== null && (
            <IcpAuthoringForm
              understandingVersionId={props.approvedUnderstanding.versionId}
              claims={props.claims}
              busy={pending}
              onDone={(message) => { setNotice(message); setAuthoring(null); router.refresh(); }}
            />
          )}
          {authoring === "play" && props.approvedIcp !== null && (
            <LeadPlayAuthoringForm
              icpVersionId={props.approvedIcp.versionId}
              icpTitle={props.approvedIcp.title}
              claims={props.claims}
              busy={pending}
              onDone={(message) => { setNotice(message); setAuthoring(null); router.refresh(); }}
            />
          )}
        </section>
      )}

      <section aria-labelledby="strategy-portfolio-section">
        <h2 id="strategy-portfolio-section" className="sr-only">Version portfolio</h2>
        {props.summaries.length === 0 ? (
          <StrategyPortfolioPanel state="empty" />
        ) : (
          <StrategyPortfolioPanel
            state="ready"
            scope={props.scope}
            versions={props.summaries}
            onOpen={openFor}
            onReview={openFor}
          />
        )}
      </section>

      {icpProposal !== null && props.selectedIcp !== null && (
        <section aria-labelledby="strategy-icp-detail" className="space-y-3">
          <h2 id="strategy-icp-detail" className="section-label">Selected ICP version</h2>
          <IcpReviewPanel state="ready" proposal={icpProposal} {...icpActions} />
        </section>
      )}

      {playProposal !== null && props.selectedPlay !== null && playActivation !== null && (
        <section aria-labelledby="strategy-play-detail" className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 id="strategy-play-detail" className="section-label">Selected lead-play version</h2>
            <div className="flex flex-col gap-2 sm:flex-row">
              {canSimulate && (
                <button type="button" className="btn-glass min-h-11" onClick={() => setSimulateDialog(true)}>
                  Run simulation
                </button>
              )}
              {canReviewSimulation && (
                <button type="button" className="btn-glass min-h-11" onClick={() => { setReason(""); setEligibilityDialog(true); }}>
                  Review simulation eligibility
                </button>
              )}
            </div>
          </div>
          <LeadPlayPanel
            state="ready"
            proposal={playProposal}
            simulation={props.playSimulation}
            simulationEligibility={props.playEligibility}
            activation={playActivation}
            onReview={capabilities.playEdit || capabilities.playApprove
              ? (action, proposal) => setReviewDialog({
                kind: "play", to: action, versionId: proposal.versionId,
                expectedReviewHash: proposal.review.reviewHash,
                title: action === "in_review" ? "Submit play for human review"
                  : action === "approved" ? "Approve this play version" : "Reject this play version",
                confirmLabel: action === "in_review" ? "Submit" : action === "approved" ? "Approve" : "Reject",
              })
              : undefined}
            onActivate={capabilities.playActivate ? () => { setReason(""); setActivationDialog("activate"); } : undefined}
            onRollback={capabilities.playActivate ? () => { setReason(""); setActivationDialog("rollback"); } : undefined}
          />
          {!playEligible && props.playSimulation !== null && props.playEligibility === null && !canReviewSimulation && (
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              The recorded simulation is awaiting a human eligibility review by an approver.
            </p>
          )}
        </section>
      )}

      <TextPromptDialog
        open={reviewDialog !== null}
        title={reviewDialog?.title ?? "Review decision"}
        message="Record a human review decision for this exact version. A short reason is required and stored in the audit trail."
        label="Decision reason"
        value={reason}
        confirmLabel={reviewDialog?.confirmLabel ?? "Record"}
        busy={pending}
        onChange={setReason}
        onConfirm={submitReview}
        onCancel={() => { if (!pending) { setReviewDialog(null); setReason(""); } }}
      />

      <SimulateDialog
        open={simulateDialog}
        busy={pending}
        requests={simulateRequests}
        spend={simulateSpend}
        accounts={simulateAccounts}
        onRequests={setSimulateRequests}
        onSpend={setSimulateSpend}
        onAccounts={setSimulateAccounts}
        onConfirm={submitSimulate}
        onCancel={() => { if (!pending) setSimulateDialog(false); }}
      />

      <EligibilityDialog
        open={eligibilityDialog}
        busy={pending}
        decision={eligibilityDecision}
        reason={reason}
        onDecision={setEligibilityDecision}
        onReason={setReason}
        onConfirm={submitEligibility}
        onCancel={() => { if (!pending) { setEligibilityDialog(false); setReason(""); } }}
      />

      <TextPromptDialog
        open={activationDialog !== null}
        title={activationDialog === "activate" ? "Activate this exact play version" : "Roll back to this exact play version"}
        message="Activation and rollback are explicit human transitions against the exact version and current activation state. A reason is required."
        label="Decision reason"
        value={reason}
        confirmLabel={activationDialog === "activate" ? "Activate" : "Roll back"}
        busy={pending}
        onChange={setReason}
        onConfirm={submitActivation}
        onCancel={() => { if (!pending) { setActivationDialog(null); setReason(""); } }}
      />
    </div>
  );
}

function SimulateDialog(props: Readonly<{
  open: boolean;
  busy: boolean;
  requests: string;
  spend: string;
  accounts: string;
  onRequests: (value: string) => void;
  onSpend: (value: string) => void;
  onAccounts: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus({ open: props.open, dialogRef, onClose: () => { if (!props.busy) props.onCancel(); } });
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={props.busy ? undefined : props.onCancel} />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="simulate-dialog-title" tabIndex={-1}
        className="glass-heavy relative z-10 max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl p-5">
        <h2 id="simulate-dialog-title" className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Run advisory simulation</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Simulations are deterministic and advisory. The account observation payload is normally produced by the
          discovery lane; provide it as a JSON array of {`{ accountId, observations: [...] }`} records.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="section-label">Provider requests</span>
            <input type="number" min={0} value={props.requests} onChange={(event) => props.onRequests(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border px-3" style={{ borderColor: "var(--surface-card-border)", background: "var(--surface-muted)", color: "var(--text-primary)" }} />
          </label>
          <label className="block text-sm">
            <span className="section-label">Spend estimate (USD)</span>
            <input type="number" min={0} step="0.01" value={props.spend} onChange={(event) => props.onSpend(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border px-3" style={{ borderColor: "var(--surface-card-border)", background: "var(--surface-muted)", color: "var(--text-primary)" }} />
          </label>
        </div>
        <label className="mt-3 block text-sm">
          <span className="section-label">Accounts JSON</span>
          <textarea value={props.accounts} onChange={(event) => props.onAccounts(event.target.value)} rows={8}
            className="mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs"
            style={{ borderColor: "var(--surface-card-border)", background: "var(--surface-muted)", color: "var(--text-primary)" }}
            aria-describedby="simulate-accounts-help" />
        </label>
        <p id="simulate-accounts-help" className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
          Each account: {`{ "accountId": "...", "observations": [{ "observationId": "...", "sourceKey": "...", "hypothesisId": "...", "assessment": "supported|contradicted|ambiguous", "rationaleRefs": [{ "claimId": "...", "evidenceId": "..." }], "uncertaintyIds": [] }] }`}.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-glass min-h-11" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button type="button" className="btn-primary min-h-11" disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? "Working…" : "Record simulation"}
          </button>
        </div>
      </section>
    </div>
  );
}

function EligibilityDialog(props: Readonly<{
  open: boolean;
  busy: boolean;
  decision: "eligible" | "ineligible";
  reason: string;
  onDecision: (value: "eligible" | "ineligible") => void;
  onReason: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus({ open: props.open, dialogRef, onClose: () => { if (!props.busy) props.onCancel(); } });
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={props.busy ? undefined : props.onCancel} />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="eligibility-dialog-title" tabIndex={-1}
        className="glass-heavy relative z-10 w-full max-w-md rounded-2xl p-5">
        <h2 id="eligibility-dialog-title" className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Simulation eligibility review</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          A human approver records whether the stored simulation result is eligible to support activation.
        </p>
        <fieldset className="mt-4">
          <legend className="section-label">Decision</legend>
          <div className="mt-2 flex gap-3">
            {(["eligible", "ineligible"] as const).map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-2 rounded-xl border px-3" style={{ borderColor: "var(--surface-card-border)" }}>
                <input type="radio" name="eligibility-decision" checked={props.decision === option}
                  onChange={() => props.onDecision(option)} />
                <span className="text-sm capitalize" style={{ color: "var(--text-primary)" }}>{option}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 block text-sm">
          <span className="section-label">Decision reason</span>
          <textarea value={props.reason} onChange={(event) => props.onReason(event.target.value)} rows={3}
            className="mt-1 w-full rounded-xl border px-3 py-2"
            style={{ borderColor: "var(--surface-card-border)", background: "var(--surface-muted)", color: "var(--text-primary)" }} />
        </label>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-glass min-h-11" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button type="button" className="btn-primary min-h-11" disabled={props.busy || props.reason.trim().length === 0} onClick={props.onConfirm}>
            {props.busy ? "Working…" : "Record eligibility"}
          </button>
        </div>
      </section>
    </div>
  );
}
