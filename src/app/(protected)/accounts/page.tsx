import type { Metadata } from "next";

import type { AccountPortfolioItem, AccountQualificationSummary } from "@/components/accounts/account-portfolio-panel";
import { PageShell } from "@/components/page-shell";
import { isTenantRoleCapable } from "@/lib/permissions";
import type {
  AccountMergeEvent,
  AccountMergeMember,
  AccountResolution,
  AccountSourceObservation,
} from "@/lib/discovery/account-resolution";
import {
  listAccountPortfolio,
  listAccountResolutionViews,
} from "@/lib/discovery/account-service";
import type {
  AccountResolutionRow,
  MergeEventRow,
  MergeSnapshotRow,
} from "@/lib/discovery/repository";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import { createPostgresQualificationRepository } from "@/lib/qualification/repository";
import { listQualificationViews, type QualificationView } from "@/lib/qualification/service";
import { getTenantSession } from "@/lib/auth";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { AccountsWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Accounts | Nova Trade Lead Management" };

const DESCRIPTION = "Canonical account portfolio, resolution states, and merge history.";

export default async function AccountsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedAccountId = typeof params.account === "string" ? params.account : null;
  const selectedResolutionId = typeof params.resolution === "string" ? params.resolution : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return <SurfaceNotice route="/accounts" title="Accounts" description={DESCRIPTION} kind="unavailable" />;
  }
  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };
  const includeQualification = isTenantRoleCapable(session.role, "qualification:read");

  const outcome = await loadSurface({
    route: "/accounts",
    permission: "account:read",
    action: "l07:accounts:read",
    scopeClass: "workspace-required",
    load: async (db) => {
      const repository = createPostgresDiscoveryRepository(db);
      const workspaceId = scope.workspaceId ?? "";
      const [accounts, resolutions, mergeRows, snapshotRow, resolutionRows, accountRows] = await Promise.all([
        listAccountPortfolio(repository, { tenantId: scope.tenantId, workspaceId }),
        listAccountResolutionViews(repository, { tenantId: scope.tenantId, workspaceId }),
        repository.listMergeEvents(scope.tenantId, workspaceId),
        repository.getMergeSnapshot(scope.tenantId, workspaceId),
        repository.listResolutions(scope.tenantId, workspaceId),
        repository.listAccounts(scope.tenantId, workspaceId),
      ]);
      const qualifications = includeQualification
        ? await listQualificationViews(
          createPostgresQualificationRepository(db),
          { tenantId: scope.tenantId, workspaceId },
        )
        : [];
      const accountRow = selectedAccountId
        ? accountRows.find((row) => row.accountId === selectedAccountId) ?? null
        : null;
      return { accounts, resolutions, mergeRows, snapshotRow, resolutionRows, qualifications, accountRow, accountRows };
    },
  });

  if (outcome.state !== "ready") {
    return <SurfaceNotice route="/accounts" title="Accounts" description={DESCRIPTION} kind={outcome.kind} />;
  }
  if (session.workspaceId === null) {
    return <SurfaceNotice route="/accounts" title="Accounts" description={DESCRIPTION} kind="workspace-required" />;
  }
  const workspaceId = session.workspaceId;
  const { accounts, resolutions, mergeRows, snapshotRow, resolutionRows, qualifications, accountRow, accountRows } = outcome.data;

  const capabilities = {
    edit: isTenantRoleCapable(session.role, "account:edit"),
    merge: isTenantRoleCapable(session.role, "account:merge"),
    queue: isTenantRoleCapable(session.role, "queue:operate"),
  };

  const latestQualification = latestQualificationByAccount(qualifications);
  const items: AccountPortfolioItem[] = accounts.map((account) => {
    const qualification = latestQualification.get(account.accountId);
    return {
      tenantId: scope.tenantId,
      workspaceId,
      accountId: account.accountId,
      displayName: account.displayName ?? "Unnamed account",
      status: account.status,
      updatedAt: account.updatedAt,
      freshness: account.freshness,
      reviewNeeded: resolutions.some((resolution) =>
        resolution.state === "human_review"
        && (resolution.targetAccountId === account.accountId
          || resolution.candidateAccountIds.includes(account.accountId))),
      qualification: qualification ? toQualificationSummary(qualification) : null,
    };
  });

  const selectedResolutionRow = selectedResolutionId
    ? resolutionRows.find((row) => row.resolutionId === selectedResolutionId) ?? null
    : null;
  const selectedResolution = selectedResolutionRow
    ? toAccountResolution(selectedResolutionRow, scope.tenantId, workspaceId)
    : null;

  const snapshotMembers = snapshotRow ? parseMembers(snapshotRow) : [];
  const snapshotEvents = mergeRows.map((event) => toMergeEvent(event, scope.tenantId, workspaceId));
  const mergeSnapshot = snapshotRow
    ? {
      mergeVersion: 1 as const,
      tenantId: scope.tenantId,
      workspaceId,
      members: snapshotMembers,
      events: snapshotEvents,
      stateHash: `sha256:${snapshotRow.stateSha256}`,
    }
    : null;
  const selectedBinding = selectedAccountId
    ? snapshotMembers.find((member) => member.accountId === selectedAccountId) ?? null
    : null;
  const refsByAccount = new Map(accountRows.map((row) => [row.accountId, row.observationRefs]));
  const activeAccounts = accounts
    .filter((account) => account.status === "active")
    .map((account) => ({
      accountId: account.accountId,
      displayName: account.displayName ?? "Unnamed account",
      observationRefs: refsByAccount.get(account.accountId) ?? [],
    }));

  return (
    <PageShell title="Accounts" description={DESCRIPTION}>
      <AccountsWorkspace
        scope={{ tenantId: scope.tenantId, workspaceId }}
        accounts={items}
        resolutions={resolutions}
        selectedAccount={accountRow ? {
          accountId: accountRow.accountId,
          displayName: accountRow.displayName ?? "Unnamed account",
          observationRefs: accountRow.observationRefs,
        } : null}
        selectedResolution={selectedResolution}
        mergeSnapshot={mergeSnapshot}
        mergeStateHash={mergeSnapshot ? mergeSnapshot.stateHash : null}
        mergeBinding={selectedBinding}
        mergeEvents={snapshotEvents}
        activeAccounts={activeAccounts}
        capabilities={capabilities}
      />
    </PageShell>
  );
}

function latestQualificationByAccount(
  views: readonly QualificationView[],
): ReadonlyMap<string, QualificationView> {
  const byAccount = new Map<string, QualificationView>();
  for (const view of views) {
    const existing = byAccount.get(view.accountId);
    if (!existing || Date.parse(view.evaluatedAt) > Date.parse(existing.evaluatedAt)) {
      byAccount.set(view.accountId, view);
    }
  }
  return byAccount;
}

function toQualificationSummary(view: QualificationView): AccountQualificationSummary {
  return {
    versionId: view.versionId,
    weightedScore: view.weightedScore,
    decision: view.decision,
    uncertainty: view.highUncertaintyFactors.length > 0 ? "high" : view.factorCount > 0 ? "low" : "none",
    reviewStatus: view.reviewStatus,
    evaluatedAt: view.evaluatedAt,
  };
}

function toAccountResolution(
  row: AccountResolutionRow,
  tenantId: string,
  workspaceId: string,
): AccountResolution {
  const observations = row.observations
    .filter((value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value))
    .map((value) => ({ tenantId, workspaceId, ...value }) as AccountSourceObservation);
  return {
    resolutionVersion: 1,
    tenantId,
    workspaceId,
    resolutionId: row.resolutionId,
    resolutionHash: `sha256:${row.resolutionSha256}`,
    state: row.state,
    ruleId: row.ruleId as AccountResolution["ruleId"],
    targetAccountId: row.targetAccountId,
    canonicalCandidateId: row.canonicalCandidateId,
    candidateAccountIds: row.candidateAccountIds,
    observations,
  };
}

function parseMembers(row: MergeSnapshotRow): readonly AccountMergeMember[] {
  return row.members.filter((value): value is AccountMergeMember =>
    typeof value === "object" && value !== null
    && typeof (value as { accountId?: unknown }).accountId === "string") as readonly AccountMergeMember[];
}

function toMergeEvent(
  row: MergeEventRow,
  tenantId: string,
  workspaceId: string,
): AccountMergeEvent {
  return {
    tenantId,
    workspaceId,
    eventId: row.eventId,
    action: row.action,
    survivorAccountId: row.survivorAccountId,
    retiredAccountId: row.retiredAccountId,
    evidenceObservationIds: row.evidenceObservationIds,
    actor: {
      kind: "human",
      actorId: typeof row.actor.actorId === "string" ? row.actor.actorId : "",
    },
    at: row.at,
    reason: row.reason,
  };
}
