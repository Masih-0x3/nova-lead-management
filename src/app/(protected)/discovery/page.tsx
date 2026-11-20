import type { Metadata } from "next";

import type { DiscoveryPlanSummary } from "@/components/discovery/discovery-plans-panel";
import type { DiscoveryRunSummary } from "@/components/discovery/discovery-runs-panel";
import { PageShell } from "@/components/page-shell";
import { isTenantRoleCapable } from "@/lib/permissions";
import type { DiscoveryPlan } from "@/lib/discovery/discovery-plan";
import type { DiscoveryRun } from "@/lib/discovery/discovery-run";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  listDiscoveryPlanViews,
  listDiscoveryRunViews,
  type DiscoveryPlanView,
  type DiscoveryRunView,
} from "@/lib/discovery/service";
import { createPostgresStrategyRepository } from "@/lib/strategy/repository";
import { getAuthenticatedLeadPlayActivation } from "@/lib/strategy/authenticated-service";
import { getTenantSession } from "@/lib/auth";
import { randomUUID } from "node:crypto";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { DiscoveryWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Discovery | Nova Lead Management" };

const DESCRIPTION = "Discovery plans and runs bound to activated lead plays.";

export default async function DiscoveryPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedPlanId = typeof params.plan === "string" ? params.plan : null;
  const selectedRunId = typeof params.run === "string" ? params.run : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return <SurfaceNotice route="/discovery" title="Discovery" description={DESCRIPTION} kind="unavailable" />;
  }
  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };

  const outcome = await loadSurface({
    route: "/discovery",
    permission: "source:review",
    action: "l07:discovery:read",
    scopeClass: "workspace-optional",
    load: async (db) => {
      const repository = createPostgresDiscoveryRepository(db);
      const [plans, runs] = await Promise.all([
        listDiscoveryPlanViews(repository, scope),
        listDiscoveryRunViews(repository, scope),
      ]);
      const planRow = selectedPlanId ? await repository.getPlan(scope.tenantId, scope.workspaceId, selectedPlanId) : null;
      const runRow = selectedRunId ? await repository.getRun(scope.tenantId, scope.workspaceId, selectedRunId) : null;
      return { plans, runs, planRow, runRow };
    },
  });

  if (outcome.state !== "ready") {
    return <SurfaceNotice route="/discovery" title="Discovery" description={DESCRIPTION} kind={outcome.kind} />;
  }

  const capabilities = {
    plan: isTenantRoleCapable(session.role, "source:plan"),
    execute: isTenantRoleCapable(session.role, "source:execute"),
  };

  const deps = { correlationId: `l07:discovery:${randomUUID()}` };
  const activePlays = capabilities.plan ? await loadActivePlays(scope, deps) : [];

  const selectedPlan = outcome.data.planRow?.payload as DiscoveryPlan | undefined;
  const selectedRun = outcome.data.runRow?.payload as DiscoveryRun | undefined;

  return (
    <PageShell title="Discovery" description={DESCRIPTION}>
      <DiscoveryWorkspace
        scope={scope}
        plans={outcome.data.plans.map((view) => toPlanSummary(view, scope, capabilities))}
        runs={outcome.data.runs.map((view) =>
          toRunSummary(view, scope, new Map(outcome.data.plans.map((plan) => [plan.planId, plan])), capabilities))}
        capabilities={capabilities}
        selectedPlan={selectedPlan ?? null}
        selectedRun={selectedRun ?? null}
        runHash={outcome.data.runRow?.payload && typeof (outcome.data.runRow.payload as { runHash?: unknown }).runHash === "string"
          ? (outcome.data.runRow.payload as { runHash: string }).runHash
          : null}
        activePlays={activePlays}
      />
    </PageShell>
  );
}

async function loadActivePlays(
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
  deps: Readonly<{ correlationId: string }>,
): Promise<readonly Readonly<{
  stableKey: string;
  playVersionId: string;
  title: string;
  sourceKeys: readonly string[];
  limits: Readonly<{ maxAccounts: number; maxProviderRequests: number; maxSpendCents: number }>;
}>[]> {
  // Activation state is authoritative for plan creation (the play-authority port
  // fails closed on anything but an active activation).
  const reads = await loadSurface({
    route: "/discovery",
    permission: "play:read",
    action: "l07:discovery:plays",
    scopeClass: "workspace-optional",
    load: async (db) => createPostgresStrategyRepository(db).listLeadPlayVersions(scope),
  });
  if (reads.state !== "ready") return [];
  const plays: { stableKey: string; playVersionId: string; title: string; sourceKeys: readonly string[]; limits: { maxAccounts: number; maxProviderRequests: number; maxSpendCents: number } }[] = [];
  for (const stored of reads.data) {
    const activation = await getAuthenticatedLeadPlayActivation(scope, stored.stableKey, deps).catch(() => null);
    if (!activation?.ok || activation.value === null || activation.value.state.active === null) continue;
    if (activation.value.state.active.versionId !== stored.versionId) continue;
    const source = stored.source as { bounds?: unknown; sourceAllowlist?: unknown; title?: unknown };
    const bounds = source.bounds as { maxAccounts?: unknown; maxProviderRequests?: unknown; maxSpendCents?: unknown } | undefined;
    plays.push({
      stableKey: stored.stableKey,
      playVersionId: stored.versionId,
      title: typeof source.title === "string" ? source.title : stored.stableKey,
      sourceKeys: Array.isArray(source.sourceAllowlist)
        ? source.sourceAllowlist.filter((item): item is string => typeof item === "string") : [],
      limits: {
        maxAccounts: typeof bounds?.maxAccounts === "number" ? bounds.maxAccounts : 50,
        maxProviderRequests: typeof bounds?.maxProviderRequests === "number" ? bounds.maxProviderRequests : 500,
        maxSpendCents: typeof bounds?.maxSpendCents === "number" ? bounds.maxSpendCents : 0,
      },
    });
  }
  return plays;
}

function toPlanSummary(
  view: DiscoveryPlanView,
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
  capabilities: Readonly<{ execute: boolean }>,
): DiscoveryPlanSummary {
  const canRun = capabilities.execute && view.allowedActions.includes("create_run");
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    planId: view.planId,
    status: view.status,
    reviewStatus: view.reviewStatus,
    binding: {
      playStableKey: view.playStableKey,
      playVersionId: view.playVersionId,
      playRevision: view.playRevision,
      sourceKeys: view.sourceKeys,
    },
    caps: view.limits,
    freshness: { state: "current", asOf: view.createdAt },
    readiness: { review: "not_required", run: canRun ? "ready" : "blocked" },
    allowedActions: { open: true, review: false, run: canRun },
  };
}

function toRunSummary(
  view: DiscoveryRunView,
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
  plansById: ReadonlyMap<string, DiscoveryPlanView>,
  capabilities: Readonly<{ execute: boolean }>,
): DiscoveryRunSummary {
  const plan = plansById.get(view.planId);
  const canOperate = capabilities.execute;
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    runId: view.runId,
    status: view.status,
    binding: {
      planId: view.planId,
      playStableKey: plan?.playStableKey ?? "",
      playVersionId: view.playVersionId,
      sourceKeys: plan?.sourceKeys ?? [],
    },
    budget: { usedCents: view.budget.spendCents, capCents: view.budget.maxSpendCents },
    tasks: { completed: view.completedTasks, total: view.totalTasks },
    lease: { state: "not_required", expiresAt: null },
    recoveryNeeded: view.recoveryNeeded,
    allowedActions: {
      open: true,
      recover: canOperate && view.recoveryNeeded,
      cancel: canOperate && view.allowedActions.includes("cancel"),
    },
    updatedAt: view.updatedAt,
  };
}
