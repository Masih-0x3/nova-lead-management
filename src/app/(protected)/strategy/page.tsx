import { randomUUID } from "node:crypto";
import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import type { StrategyPortfolioSummary } from "@/components/strategy/strategy-portfolio-panel";
import { getTenantSession } from "@/lib/auth";
import { isTenantRoleCapable } from "@/lib/permissions";
import { createPostgresStrategyRepository } from "@/lib/strategy/repository";
import { createLeadPlayActivationState } from "@/lib/strategy/lead-play-activation";
import type { LeadPlayActivationState, LeadPlaySimulationEligibilityReview } from "@/lib/strategy/lead-play-activation";
import type { LeadPlaySimulation } from "@/lib/strategy/lead-play-simulation";
import type { IcpVersionView, LeadPlayVersionView } from "@/lib/strategy/service";
import {
  getAuthenticatedLeadPlayActivation,
  listAuthenticatedIcpVersions,
  listAuthenticatedLeadPlayVersions,
} from "@/lib/strategy/authenticated-service";
import { listAuthenticatedUnderstandingVersions } from "@/lib/understanding/authenticated-service";
import type { UnderstandingVersionView } from "@/lib/understanding/service";
import { TenantAuthorizationError } from "@/lib/tenancy/authorize";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { StrategyWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Strategy | Nova Trade Lead Management" };

export type UnderstandingClaimOption = Readonly<{
  claimId: string;
  statement: string;
  domain: string;
  evidenceIds: readonly string[];
}>;

export default async function StrategyPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedIcpId = typeof params.icp === "string" ? params.icp : null;
  const selectedPlayId = typeof params.play === "string" ? params.play : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return (
      <SurfaceNotice
        route="/strategy"
        title="Strategy"
        description="ICP and lead-play versions bound to the approved understanding."
        kind="unavailable"
      />
    );
  }

  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };
  const deps = { correlationId: `l07:strategy:${randomUUID()}` };

  try {
    const [understanding, icps, plays] = await Promise.all([
      listAuthenticatedUnderstandingVersions(scope, deps),
      listAuthenticatedIcpVersions(scope, deps),
      listAuthenticatedLeadPlayVersions(scope, deps),
    ]);
    if (!understanding.ok || !icps.ok || !plays.ok) {
      return (
        <SurfaceNotice
          route="/strategy"
          title="Strategy"
          description="ICP and lead-play versions bound to the approved understanding."
          kind="error"
        />
      );
    }

    const approvedUnderstanding = pickApprovedUnderstanding(understanding.value);
    const claimOptions = approvedUnderstanding ? claimCatalog(approvedUnderstanding) : [];
    const selectedIcp = icps.value.find((view) => view.proposal.versionId === selectedIcpId) ?? null;
    const selectedPlay = plays.value.find((view) => view.proposal.versionId === selectedPlayId) ?? null;
    const approvedIcp = [...icps.value]
      .filter((view) => view.proposal.review.status === "approved")
      .sort((left, right) => right.proposal.revision - left.proposal.revision)[0] ?? null;

    const playDetail = selectedPlay ? await loadPlayDetail(scope, selectedPlay, deps) : null;

    const capabilities = {
      icpEdit: isTenantRoleCapable(session.role, "icp:edit"),
      icpApprove: isTenantRoleCapable(session.role, "icp:approve"),
      playEdit: isTenantRoleCapable(session.role, "play:edit"),
      playApprove: isTenantRoleCapable(session.role, "play:approve"),
      playActivate: isTenantRoleCapable(session.role, "play:activate"),
    };

    const summaries = [
      ...icps.value.map((view) => toIcpSummary(view, capabilities)),
      ...plays.value.map((view) => toPlaySummary(view, capabilities)),
    ];

    return (
      <PageShell
        title="Strategy"
        description="ICP and lead-play versions, review, simulation, and activation — all bound to the approved understanding."
      >
        <StrategyWorkspace
          scope={scope}
          summaries={summaries}
          capabilities={capabilities}
          approvedUnderstanding={approvedUnderstanding === null ? null : {
            versionId: approvedUnderstanding.proposal.versionId,
            revision: approvedUnderstanding.proposal.revision,
          }}
          approvedIcp={approvedIcp === null ? null : {
            versionId: approvedIcp.proposal.versionId,
            revision: approvedIcp.proposal.revision,
            title: approvedIcp.proposal.title,
          }}
          claims={claimOptions}
          selectedIcp={selectedIcp}
          selectedPlay={selectedPlay}
          playSimulation={playDetail?.simulation ?? null}
          playEligibility={playDetail?.eligibility ?? null}
          playActivation={playDetail?.activation ?? null}
        />
      </PageShell>
    );
  } catch (error) {
    return (
      <SurfaceNotice
        route="/strategy"
        title="Strategy"
        description="ICP and lead-play versions bound to the approved understanding."
        kind={error instanceof TenantAuthorizationError ? "denied" : "error"}
      />
    );
  }
}

type StrategyDeps = Readonly<{ correlationId: string }>;

async function loadPlayDetail(
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
  play: LeadPlayVersionView,
  deps: StrategyDeps,
): Promise<Readonly<{
  simulation: LeadPlaySimulation | null;
  eligibility: LeadPlaySimulationEligibilityReview | null;
  activation: LeadPlayActivationState;
}> | null> {
  const storedActivation = await getAuthenticatedLeadPlayActivation(
    scope, play.stored.stableKey, deps,
  ).catch(() => null);
  let activation: LeadPlayActivationState | null = storedActivation?.ok && storedActivation.value
    ? storedActivation.value.state
    : null;
  if (activation === null) {
    const created = createLeadPlayActivationState({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      stableKey: play.stored.stableKey,
      createdAt: play.stored.createdAt,
    });
    activation = created.ok ? created.state : null;
  }
  if (activation === null) return null;

  const reads = await loadSurface({
    route: "/strategy",
    permission: "play:read",
    action: "l07:strategy:play-detail",
    load: async (db) => {
      const repository = createPostgresStrategyRepository(db);
      const simulation = await repository.getLatestSimulationForPlay(scope, play.proposal.versionId);
      const eligibility = simulation
        ? await repository.getLatestSimulationReview(scope, play.proposal.versionId, simulation.simulationId)
        : null;
      return { simulation, eligibility };
    },
  });
  return {
    simulation: reads.state === "ready" ? reads.data.simulation?.simulation ?? null : null,
    eligibility: reads.state === "ready" ? reads.data.eligibility?.review ?? null : null,
    activation,
  };
}

function pickApprovedUnderstanding(
  versions: readonly UnderstandingVersionView[],
): UnderstandingVersionView | null {
  return [...versions]
    .filter((view) => view.proposal.review.status === "approved")
    .sort((left, right) => right.proposal.revision - left.proposal.revision)[0] ?? null;
}

function claimCatalog(view: UnderstandingVersionView): readonly UnderstandingClaimOption[] {
  return view.proposal.domains.flatMap((domain) =>
    domain.facts.map((fact) => ({
      claimId: fact.claimId,
      statement: fact.statement,
      domain: domain.domain,
      evidenceIds: fact.citations.map((citation) => citation.evidenceId),
    })));
}

function toIcpSummary(
  view: IcpVersionView,
  capabilities: Readonly<{ icpApprove: boolean }>,
): StrategyPortfolioSummary {
  const { proposal, stored } = view;
  return {
    kind: "icp",
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    stableKey: stored.stableKey,
    versionId: proposal.versionId,
    revision: proposal.revision,
    title: proposal.title,
    lifecycle: proposal.review.status === "superseded" ? "superseded"
      : proposal.review.status === "approved" ? "active" : "draft",
    reviewStatus: proposal.review.status,
    evidenceReadiness: proposal.understanding.status === "approved" ? "ready" : "blocked",
    exclusionCount: proposal.exclusions.length,
    actions: {
      open: true,
      review: capabilities.icpApprove && proposal.review.status === "in_review",
      rollback: false,
    },
    rollbackTargetVersionId: null,
    budgetPolicy: null,
  };
}

function toPlaySummary(
  view: LeadPlayVersionView,
  capabilities: Readonly<{ playApprove: boolean }>,
): StrategyPortfolioSummary {
  const { proposal, stored } = view;
  return {
    kind: "lead_play",
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    stableKey: stored.stableKey,
    versionId: proposal.versionId,
    revision: proposal.revision,
    title: proposal.title,
    lifecycle: proposal.review.status === "superseded" ? "superseded"
      : proposal.review.status === "approved" ? "active" : "draft",
    reviewStatus: proposal.review.status,
    evidenceReadiness: proposal.icp.status === "approved" ? "ready" : "blocked",
    exclusionCount: 0,
    actions: {
      open: true,
      review: capabilities.playApprove && proposal.review.status === "in_review",
      rollback: false,
    },
    rollbackTargetVersionId: null,
    budgetPolicy: {
      maxAccounts: proposal.bounds.maxAccounts,
      maxProviderRequests: proposal.bounds.maxProviderRequests,
      maxSpendCents: proposal.bounds.maxSpendCents,
      outreachMode: "draft_only",
    },
  };
}
