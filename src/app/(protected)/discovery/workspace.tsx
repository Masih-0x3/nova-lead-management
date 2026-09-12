"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DiscoveryPlanPanel } from "@/components/discovery/discovery-plan-panel";
import { DiscoveryPlansPanel, type DiscoveryPlanSummary } from "@/components/discovery/discovery-plans-panel";
import { DiscoveryRunPanel } from "@/components/discovery/discovery-run-panel";
import { DiscoveryRunsPanel, type DiscoveryRunSummary } from "@/components/discovery/discovery-runs-panel";
import type { DiscoveryPlan } from "@/lib/discovery/discovery-plan";
import type { DiscoveryRun } from "@/lib/discovery/discovery-run";

import { createPlanAction, createRunAction, transitionRunAction } from "./actions";

type ActivePlay = Readonly<{
  stableKey: string;
  playVersionId: string;
  title: string;
  sourceKeys: readonly string[];
  limits: Readonly<{ maxAccounts: number; maxProviderRequests: number; maxSpendCents: number }>;
}>;

export function DiscoveryWorkspace(props: Readonly<{
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>;
  plans: readonly DiscoveryPlanSummary[];
  runs: readonly DiscoveryRunSummary[];
  capabilities: Readonly<{ plan: boolean; execute: boolean }>;
  selectedPlan: DiscoveryPlan | null;
  selectedRun: DiscoveryRun | null;
  runHash: string | null;
  activePlays: readonly ActivePlay[];
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [planDialog, setPlanDialog] = useState<DiscoveryPlanSummary | null>(null);
  const [cancelRunId, setCancelRunId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [playVersionId, setPlayVersionId] = useState("");

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

  const selectedPlay = props.activePlays.find((play) => play.playVersionId === playVersionId) ?? null;
  const cancellableSelected = props.selectedRun !== null && props.runHash !== null
    && (props.selectedRun.status === "planned" || props.selectedRun.status === "running");

  const startSelectedRun = () => {
    const selected = props.selectedRun;
    const hash = props.runHash;
    if (!selected || !hash) return;
    run(transitionRunAction({
      runId: selected.runId,
      expectedRunHash: hash,
      action: "start",
      reason: "Run started from the discovery console.",
    }));
  };

  return (
    <div className="space-y-5">
      <div aria-live="polite" role="status" className="sr-only">{notice}</div>
      {notice && (
        <p className="rounded-xl border px-4 py-3 text-sm" role="status" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          {notice}
        </p>
      )}

      {props.capabilities.plan && (
        <section aria-labelledby="discovery-create-title" className="glass rounded-2xl p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="discovery-create-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Plan creation</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                Plans are built from an activated lead play and inherit its evidence-bound source allowlist.
              </p>
            </div>
            <button type="button" className="btn-glass min-h-11" disabled={props.activePlays.length === 0}
              onClick={() => setCreateOpen(!createOpen)}>
              {createOpen ? "Close" : "New discovery plan"}
            </button>
          </div>
          {props.activePlays.length === 0 && (
            <p className="mt-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
              No activated lead play exists in this scope — activate a play on the Strategy surface first.
            </p>
          )}
          {createOpen && props.activePlays.length > 0 && (
            <form className="mt-4 space-y-3" onSubmit={(event) => {
              event.preventDefault();
              if (!selectedPlay) return;
              run(createPlanAction({
                playVersionId: selectedPlay.playVersionId,
                sourceKeys: selectedPlay.sourceKeys,
                limits: selectedPlay.limits,
              }), () => setCreateOpen(false));
            }}>
              <label className="block text-sm">
                <span className="section-label">Activated play</span>
                <select className="glass-input mt-1 w-full" value={playVersionId} required
                  onChange={(event) => setPlayVersionId(event.target.value)}>
                  <option value="" disabled>Select a play</option>
                  {props.activePlays.map((play) => (
                    <option key={play.playVersionId} value={play.playVersionId}>
                      {play.title} ({play.stableKey})
                    </option>
                  ))}
                </select>
              </label>
              {selectedPlay && (
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  Sources: {selectedPlay.sourceKeys.join(", ") || "none"} · caps {selectedPlay.limits.maxAccounts} accounts / {selectedPlay.limits.maxProviderRequests} requests / ${(selectedPlay.limits.maxSpendCents / 100).toFixed(2)}
                </p>
              )}
              <div className="flex justify-end">
                <button type="submit" className="btn-primary min-h-11" disabled={pending || selectedPlay === null}>
                  {pending ? "Working…" : "Create plan"}
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="discovery-plans-title" className="space-y-3">
        <h2 id="discovery-plans-title" className="section-label">Plans</h2>
        {props.plans.length === 0 ? (
          <p className="glass rounded-2xl p-5 text-sm" style={{ color: "var(--text-secondary)" }}>
            No discovery plans exist in this scope yet.
          </p>
        ) : (
          <DiscoveryPlansPanel
            state="ready"
            scope={props.scope}
            plans={props.plans}
            onOpen={(plan) => router.push(`/discovery?plan=${encodeURIComponent(plan.planId)}`)}
            onRun={(plan) => setPlanDialog(plan)}
          />
        )}
      </section>

      {props.selectedPlan && (
        <section aria-labelledby="discovery-plan-detail" className="space-y-3">
          <h2 id="discovery-plan-detail" className="section-label">Selected plan</h2>
          <DiscoveryPlanPanel
            state="ready"
            plan={props.selectedPlan}
            onCreateRun={props.capabilities.execute ? (plan) => run(createRunAction({ planId: plan.planId })) : undefined}
          />
        </section>
      )}

      <section aria-labelledby="discovery-runs-title" className="space-y-3">
        <h2 id="discovery-runs-title" className="section-label">Runs</h2>
        {props.runs.length === 0 ? (
          <p className="glass rounded-2xl p-5 text-sm" style={{ color: "var(--text-secondary)" }}>
            No discovery runs exist in this scope yet.
          </p>
        ) : (
          <DiscoveryRunsPanel
            state="ready"
            scope={props.scope}
            runs={props.runs}
            onOpen={(item) => router.push(`/discovery?run=${encodeURIComponent(item.runId)}`)}
            onCancel={(item) => router.push(`/discovery?run=${encodeURIComponent(item.runId)}`)}
          />
        )}
      </section>

      {props.selectedRun && (
        <section aria-labelledby="discovery-run-detail" className="space-y-3">
          <h2 id="discovery-run-detail" className="section-label">Selected run</h2>
          <DiscoveryRunPanel
            state="ready"
            run={props.selectedRun}
            onStart={props.capabilities.execute && props.runHash !== null ? startSelectedRun : undefined}
          />
          {props.capabilities.execute && cancellableSelected && (
            <div className="flex justify-end">
              <button type="button" className="btn-secondary min-h-11" onClick={() => setCancelRunId(props.selectedRun?.runId ?? null)}>
                Cancel run
              </button>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={planDialog !== null}
        title="Create a discovery run"
        message={planDialog ? `Create a run for plan ${planDialog.planId}? The run starts as "planned" and is started explicitly.` : ""}
        confirmLabel="Create run"
        busy={pending}
        onConfirm={() => {
          const plan = planDialog;
          if (!plan) return;
          run(createRunAction({ planId: plan.planId }), () => setPlanDialog(null));
        }}
        onCancel={() => { if (!pending) setPlanDialog(null); }}
      />

      <ConfirmDialog
        open={cancelRunId !== null}
        title="Cancel this run"
        message={cancelRunId ? `Cancel run ${cancelRunId}? The cancellation is recorded as an audited lifecycle event.` : ""}
        confirmLabel="Cancel run"
        busy={pending}
        onConfirm={() => {
          const runId = cancelRunId;
          const hash = props.runHash;
          if (!runId || !hash) {
            setNotice("The current run state could not be read — cancel is unavailable.");
            setCancelRunId(null);
            return;
          }
          run(transitionRunAction({
            runId,
            expectedRunHash: hash,
            action: "cancel",
            reason: "Run cancelled from the discovery console.",
          }), () => setCancelRunId(null));
        }}
        onCancel={() => { if (!pending) setCancelRunId(null); }}
      />
    </div>
  );
}
