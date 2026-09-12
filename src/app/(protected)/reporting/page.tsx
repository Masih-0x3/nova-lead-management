import type { Metadata } from "next";

import type { LearningPortfolioSummary } from "@/components/learning/learning-portfolio-panel";
import type { OutcomePortfolioItem } from "@/components/outcomes/outcome-portfolio-panel";
import { PageShell } from "@/components/page-shell";
import { isTenantRoleCapable } from "@/lib/permissions";
import { learningDeps, outcomeDeps } from "@/app/api/_shared/l06-deps";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import { createPostgresOutreachRepository } from "@/lib/outreach/repository";
import { createPostgresStrategyRepository } from "@/lib/strategy/repository";
import type { StoredLearningProposal } from "@/lib/learning/repository";
import type { StoredOutcomeVersion } from "@/lib/outcomes/repository";
import { buildAttributionReportView } from "@/lib/outcomes/service";
import { getTenantSession } from "@/lib/auth";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { ReportingWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Reporting | Nova Trade Lead Management" };

const DESCRIPTION = "Outcome capture, attribution reporting, and controlled learning proposals.";

export default async function ReportingPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedProposalId = typeof params.proposal === "string" ? params.proposal : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return <SurfaceNotice route="/reporting" title="Reporting" description={DESCRIPTION} kind="unavailable" />;
  }
  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };

  const outcome = await loadSurface({
    route: "/reporting",
    permission: "report:read",
    action: "l07:reporting:read",
    scopeClass: "workspace-required",
    load: async (db) => {
      const workspaceId = scope.workspaceId ?? "";
      const outcomes = outcomeDeps(db);
      const learning = learningDeps(db);
      const accounts = createPostgresDiscoveryRepository(db);
      const strategy = createPostgresStrategyRepository(db);
      const outreach = createPostgresOutreachRepository(db);

      const now = new Date();
      const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000);
      const [outcomeRows, proposalRows, accountRows, playRows, report] = await Promise.all([
        outcomes.outcomes.listVersions(scope.tenantId, workspaceId),
        learning.learning.listVersions(scope.tenantId, workspaceId),
        accounts.listAccounts(scope.tenantId, workspaceId),
        strategy.listLeadPlayVersions({ tenantId: scope.tenantId, workspaceId }),
        buildAttributionReportView(outcomes, {
          tenantId: scope.tenantId,
          workspaceId,
          reportKey: "rolling-90d",
          from: from.toISOString(),
          to: now.toISOString(),
        }).catch(() => null),
      ]);

      const draftVersionIds = outcomeRows.map((row) => row.draftVersionId)
        .filter((value): value is string => value !== null);
      const draftSubjects = new Map<string, string>();
      for (const versionId of draftVersionIds) {
        const row = outcomeRows.find((candidate) => candidate.draftVersionId === versionId);
        if (!row) continue;
        const draft = await outreach.getDraftVersion(scope.tenantId, workspaceId, row.accountId, versionId)
          .catch(() => null);
        if (draft) draftSubjects.set(versionId, draft.draft.subject);
      }

      const selected = selectedProposalId
        ? proposalRows.find((row) => row.proposal.versionId === selectedProposalId) ?? null
        : null;
      return { outcomeRows, proposalRows, accountRows, playRows, report, draftSubjects, selected };
    },
  });

  if (outcome.state !== "ready") {
    return <SurfaceNotice route="/reporting" title="Reporting" description={DESCRIPTION} kind={outcome.kind} />;
  }
  if (session.workspaceId === null) {
    return <SurfaceNotice route="/reporting" title="Reporting" description={DESCRIPTION} kind="workspace-required" />;
  }
  const workspaceId = session.workspaceId;
  const data = outcome.data;

  const capabilities = {
    record: isTenantRoleCapable(session.role, "outreach:edit"),
    review: isTenantRoleCapable(session.role, "outreach:approve"),
  };

  const accountNames = new Map(data.accountRows.map((row) => [row.accountId, row.displayName ?? "Unnamed account"]));
  const playNames = new Map(data.playRows.map((row) => [
    row.versionId,
    typeof (row.source as { title?: unknown }).title === "string"
      ? (row.source as { title: string }).title : row.stableKey,
  ]));

  const outcomes: OutcomePortfolioItem[] = data.outcomeRows.map((row) => toOutcomeItem(
    row, scope.tenantId, workspaceId, accountNames, playNames, data.draftSubjects, capabilities));
  const proposals: LearningPortfolioSummary[] = data.proposalRows.map((row) =>
    toProposalSummary(row, scope.tenantId, workspaceId, capabilities));

  return (
    <PageShell title="Reporting" description={DESCRIPTION}>
      <ReportingWorkspace
        scope={{ tenantId: scope.tenantId, workspaceId }}
        outcomes={outcomes}
        proposals={proposals}
        report={data.report}
        selectedProposal={data.selected?.proposal ?? null}
        accounts={data.accountRows
          .filter((row) => row.status === "active")
          .map((row) => ({ accountId: row.accountId, displayName: row.displayName ?? "Unnamed account" }))}
        plays={data.playRows.map((row) => ({
          playVersionId: row.versionId,
          displayName: typeof (row.source as { title?: unknown }).title === "string"
            ? (row.source as { title: string }).title : row.stableKey,
        }))}
        capabilities={capabilities}
      />
    </PageShell>
  );
}

function toOutcomeItem(
  row: StoredOutcomeVersion,
  tenantId: string,
  workspaceId: string,
  accountNames: ReadonlyMap<string, string>,
  playNames: ReadonlyMap<string, string>,
  draftSubjects: ReadonlyMap<string, string>,
  capabilities: Readonly<{ record: boolean }>,
): OutcomePortfolioItem {
  const record = row.record;
  const eligible: ("open" | "correct")[] = ["open"];
  if (capabilities.record) eligible.push("correct");
  return {
    tenantId,
    workspaceId,
    stableKey: row.stableKey,
    versionId: record.versionId,
    account: {
      accountId: row.accountId,
      displayName: accountNames.get(row.accountId) ?? "Unknown account",
    },
    play: {
      versionId: row.playVersionId,
      displayName: playNames.get(row.playVersionId) ?? "Unknown play",
    },
    outreach: row.draftVersionId
      ? { versionId: row.draftVersionId, subject: draftSubjects.get(row.draftVersionId) ?? "Outreach draft" }
      : null,
    outcome: record.outcome,
    channel: record.channel,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
    revision: row.revision,
    attributionKind: record.attribution.kind,
    correctionNeeded: false,
    eligibleActions: eligible,
  };
}

function toProposalSummary(
  row: StoredLearningProposal,
  tenantId: string,
  workspaceId: string,
  capabilities: Readonly<{ review: boolean }>,
): LearningPortfolioSummary {
  const proposal = row.proposal;
  const highest = proposal.uncertainties.reduce<number | null>(
    (max, item) => max === null || item.severity > max ? item.severity : max, null);
  const readiness = proposal.review.status === "approved" ? "ready"
    : proposal.review.status === "rejected" ? "blocked" : "needs_review";
  const eligible: ("open" | "review")[] = ["open"];
  if (capabilities.review
    && (proposal.review.status === "draft" || proposal.review.status === "in_review")) {
    eligible.push("review");
  }
  return {
    tenantId,
    workspaceId,
    accountId: row.accountId,
    stableKey: row.stableKey,
    versionId: proposal.versionId,
    revision: row.revision,
    createdAt: row.createdAt,
    cohort: {
      cohortId: proposal.cohort.cohortId,
      windowStart: proposal.cohort.windowStart,
      windowEnd: proposal.cohort.windowEnd,
      denominator: proposal.cohort.denominator,
    },
    metric: {
      metricKey: proposal.metric.metricKey,
      numerator: proposal.metric.numerator,
      denominator: proposal.metric.denominator,
      valueBasisPoints: proposal.metric.valueBasisPoints,
    },
    change: proposal.change,
    uncertainty: {
      count: proposal.uncertainties.length,
      highestSeverity: highest,
      headline: proposal.uncertainties[0]?.statement ?? null,
    },
    expectedImpact: {
      metricKey: proposal.expectedImpact.metricKey,
      direction: proposal.expectedImpact.direction,
      estimateBasisPoints: proposal.expectedImpact.estimateBasisPoints,
      lowerBoundBasisPoints: proposal.expectedImpact.lowerBoundBasisPoints,
      upperBoundBasisPoints: proposal.expectedImpact.upperBoundBasisPoints,
      horizonDays: proposal.expectedImpact.horizonDays,
    },
    rollback: {
      restorePlayVersionId: proposal.rollback.restorePlayVersionId,
      triggerMetricKey: proposal.rollback.triggerMetricKey,
      triggerThresholdBasisPoints: proposal.rollback.triggerThresholdBasisPoints,
      readiness,
    },
    readiness,
    reviewStatus: proposal.review.status,
    eligibleActions: eligible,
  };
}

