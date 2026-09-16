import type { Metadata } from "next";

import type { OutreachPortfolioItem } from "@/components/outreach/outreach-portfolio-panel";
import type { OutreachHistoryVersionSummary } from "@/components/outreach/outreach-history-panel";
import { PageShell } from "@/components/page-shell";
import { isTenantRoleCapable } from "@/lib/permissions";
import { createPostgresContactRepository } from "@/lib/contacts/repository";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import {
  getCurrentDraftView,
  listHandoffAttemptViews,
} from "@/lib/outreach/service";
import type { StoredOutreachDraft } from "@/lib/outreach/repository";
import { createPostgresOutreachRepository } from "@/lib/outreach/repository";
import { createPostgresStrategyRepository } from "@/lib/strategy/repository";
import { createPostgresSuppressionRepository } from "@/lib/suppressions/repository";
import { listSuppressionViews, type SuppressionView } from "@/lib/suppressions/service";
import { getTenantSession } from "@/lib/auth";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { OutreachWorkspace, type DraftDetail } from "./workspace";

export const metadata: Metadata = { title: "Outreach | Nova Trade Lead Management" };

const DESCRIPTION = "Draft review, approval, and copy/export handoffs — there is no send path.";

export default async function OutreachPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedVersionId = typeof params.draft === "string" ? params.draft : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return <SurfaceNotice route="/outreach" title="Outreach" description={DESCRIPTION} kind="unavailable" />;
  }
  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };

  const outcome = await loadSurface({
    route: "/outreach",
    permission: "outreach:read",
    action: "l07:outreach:read",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    load: async (db) => {
      const workspaceId = scope.workspaceId ?? "";
      const outreach = createPostgresOutreachRepository(db);
      const accounts = createPostgresDiscoveryRepository(db);
      const contacts = createPostgresContactRepository(db);
      const strategy = createPostgresStrategyRepository(db);
      const suppressions = createPostgresSuppressionRepository(db);

      const drafts = await outreach.listDraftVersions(scope.tenantId, workspaceId);
      const handoffs = await listHandoffAttemptViews({ outreach }, { tenantId: scope.tenantId, workspaceId });
      const suppressionViews = await listSuppressionViews(
        { repository: suppressions }, { tenantId: scope.tenantId, workspaceId });

      const accountIds = [...new Set(drafts.map((draft) => draft.accountId))];
      const contactVersionIds = drafts.map((draft) => draft.contactVersionId)
        .filter((value): value is string => value !== null);
      const playVersionIds = drafts.map((draft) => draft.playVersionId)
        .filter((value): value is string => value !== null);

      const accountNames = new Map<string, string>();
      for (const accountId of accountIds) {
        const account = await accounts.getAccount(scope.tenantId, workspaceId, accountId);
        accountNames.set(accountId, account?.displayName ?? "Unknown account");
      }
      const contactNames = new Map<string, { displayName: string; stableKey: string; suppression: string }>();
      for (const versionId of contactVersionIds) {
        const contact = await contacts.getContact(scope.tenantId, workspaceId, versionId);
        if (!contact) continue;
        const payload = contact.payload as {
          identity?: { displayName?: unknown };
          suppressionDisposition?: unknown;
        };
        contactNames.set(versionId, {
          displayName: typeof payload.identity?.displayName === "string" ? payload.identity.displayName : "Unnamed contact",
          stableKey: contact.stableKey,
          suppression: typeof payload.suppressionDisposition === "string" ? payload.suppressionDisposition : "unknown",
        });
      }
      const playNames = new Map<string, string>();
      for (const versionId of playVersionIds) {
        const play = await strategy.getLeadPlayVersion(
          { tenantId: scope.tenantId, workspaceId }, versionId).catch(() => null);
        const title = play && typeof (play.source as { title?: unknown }).title === "string"
          ? (play.source as { title: string }).title : versionId;
        playNames.set(versionId, title);
      }

      const currentStates = new Map<string, { stateHash: string; eligibleActions: readonly string[]; status: string }>();
      for (const draft of drafts) {
        const key = `${draft.accountId}:${draft.stableKey}`;
        if (currentStates.has(key)) continue;
        const current = await getCurrentDraftView(
          { outreach },
          { tenantId: scope.tenantId, workspaceId, accountId: draft.accountId, stableKey: draft.stableKey },
        ).catch(() => null);
        if (current) {
          currentStates.set(key, {
            stateHash: current.stateHash,
            eligibleActions: current.eligibleActions,
            status: current.reviewStatus,
          });
        }
      }

      const selected = selectedVersionId
        ? drafts.find((draft) => draft.draft.versionId === selectedVersionId) ?? null
        : null;

      return { drafts, handoffs, suppressionViews, accountNames, contactNames, playNames, currentStates, selected };
    },
  });

  if (outcome.state !== "ready") {
    return <SurfaceNotice route="/outreach" title="Outreach" description={DESCRIPTION} kind={outcome.kind} />;
  }
  if (session.workspaceId === null) {
    return <SurfaceNotice route="/outreach" title="Outreach" description={DESCRIPTION} kind="workspace-required" />;
  }
  const workspaceId = session.workspaceId;
  const data = outcome.data;

  const capabilities = {
    approve: isTenantRoleCapable(session.role, "outreach:approve"),
    copyExport: isTenantRoleCapable(session.role, "outreach:copy_export"),
    suppressions: isTenantRoleCapable(session.role, "outreach:edit"),
  };

  const latestByKey = latestRevisions(data.drafts);
  const items: OutreachPortfolioItem[] = data.drafts.map((draft) =>
    toPortfolioItem(draft, data, scope.tenantId, workspaceId, capabilities, latestByKey));

  const selectedDetail = data.selected
    ? toDraftDetail(data.selected, data, workspaceId, latestByKey, capabilities)
    : null;

  const historyVersions: OutreachHistoryVersionSummary[] = data.selected
    ? data.drafts
      .filter((draft) => draft.accountId === data.selected?.accountId && draft.stableKey === data.selected.stableKey)
      .map((draft) => toHistorySummary(draft, data, scope.tenantId, workspaceId, latestByKey))
      .sort((a, b) => b.version.revision - a.version.revision)
    : [];

  return (
    <PageShell title="Outreach" description={DESCRIPTION}>
      <OutreachWorkspace
        scope={{ tenantId: scope.tenantId, workspaceId }}
        drafts={items}
        detail={selectedDetail}
        history={historyVersions}
        suppressions={data.suppressionViews}
        capabilities={capabilities}
      />
    </PageShell>
  );
}

type DraftData = Readonly<{
  handoffs: readonly Readonly<{ draftVersionId: string; status: string }>[];
  suppressionViews: readonly SuppressionView[];
  accountNames: ReadonlyMap<string, string>;
  contactNames: ReadonlyMap<string, { displayName: string; stableKey: string; suppression: string }>;
  playNames: ReadonlyMap<string, string>;
  currentStates: ReadonlyMap<string, { stateHash: string; eligibleActions: readonly string[]; status: string }>;
}>;

function latestRevisions(drafts: readonly StoredOutreachDraft[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const draft of drafts) {
    const key = `${draft.accountId}:${draft.stableKey}`;
    map.set(key, Math.max(map.get(key) ?? 0, draft.revision));
  }
  return map;
}

function suppressionStatus(
  draft: StoredOutreachDraft,
  data: DraftData,
): "clear" | "blocked" | "unknown" {
  const contact = draft.contactVersionId ? data.contactNames.get(draft.contactVersionId) : undefined;
  const contactSuppression = contact?.suppression;
  const anyAccountSuppression = data.suppressionViews.some((view) =>
    view.accountId === draft.accountId && view.disposition !== "clear");
  if (anyAccountSuppression || (contactSuppression !== undefined && contactSuppression !== "clear" && contactSuppression !== "unknown")) {
    return "blocked";
  }
  return contactSuppression === "clear" ? "clear" : "unknown";
}

function toPortfolioItem(
  draft: StoredOutreachDraft,
  data: DraftData,
  tenantId: string,
  workspaceId: string,
  capabilities: Readonly<{ approve: boolean; copyExport: boolean }>,
  latestByKey: ReadonlyMap<string, number>,
): OutreachPortfolioItem {
  const key = `${draft.accountId}:${draft.stableKey}`;
  const current = data.currentStates.get(key);
  const isLatest = latestByKey.get(key) === draft.revision;
  const status = draft.draft.review.status;
  const blockedAttempt = data.handoffs.some((attempt) =>
    attempt.draftVersionId === draft.draft.versionId && attempt.status === "blocked");
  const policyStatus = !isLatest ? "stale"
    : blockedAttempt ? "blocked"
      : status === "approved" ? "ready" : "blocked";
  const eligible = current?.eligibleActions ?? [];
  const actions: ("open" | "review" | "copy" | "export")[] = ["open"];
  if (capabilities.approve && (status === "draft" || status === "in_review")) actions.push("review");
  if (capabilities.copyExport && isLatest) {
    if (eligible.includes("copy")) actions.push("copy");
    if (eligible.includes("export")) actions.push("export");
  }
  return {
    tenantId,
    workspaceId,
    draftId: draft.stableKey,
    subject: draft.draft.subject,
    account: { accountId: draft.accountId, displayName: data.accountNames.get(draft.accountId) ?? "Unknown account" },
    contact: {
      contactId: draft.contactVersionId ?? "",
      displayName: draft.contactVersionId
        ? data.contactNames.get(draft.contactVersionId)?.displayName ?? "Unknown contact"
        : "No contact bound",
    },
    play: {
      playId: draft.playVersionId ?? "",
      displayName: draft.playVersionId ? data.playNames.get(draft.playVersionId) ?? "Unknown play" : "No play bound",
      versionId: draft.playVersionId ?? "",
    },
    version: {
      versionId: draft.draft.versionId,
      revision: draft.revision,
      label: `v${draft.revision}`,
    },
    draftStatus: status,
    reviewStatus: status === "draft" ? "not_requested" : status === "in_review" ? "pending" : status,
    policyStatus,
    suppressionStatus: suppressionStatus(draft, data),
    citationStatus: draft.draft.validation.claims.length > 0 ? "ready" : "incomplete",
    updatedAt: draft.createdAt,
    eligibleActions: actions,
  };
}

function toHistorySummary(
  draft: StoredOutreachDraft,
  data: DraftData,
  tenantId: string,
  workspaceId: string,
  latestByKey: ReadonlyMap<string, number>,
): OutreachHistoryVersionSummary {
  const item = toPortfolioItem(draft, data, tenantId, workspaceId, { approve: false, copyExport: true }, latestByKey);
  const lastReview = draft.draft.review.events.at(-1);
  return {
    tenantId,
    workspaceId,
    draftId: draft.stableKey,
    version: {
      versionId: draft.draft.versionId,
      revision: draft.revision,
      label: `v${draft.revision}`,
      supersedesVersionId: draft.draft.supersedesVersionId,
    },
    account: item.account,
    contact: item.contact,
    play: item.play,
    versionState: latestByKey.get(`${draft.accountId}:${draft.stableKey}`) === draft.revision ? "current" : "superseded",
    reviewStatus: item.reviewStatus === "not_requested" ? "draft" : item.reviewStatus === "pending" ? "in_review" : item.reviewStatus,
    citationStatus: item.citationStatus,
    policyStatus: item.policyStatus,
    suppressionStatus: item.suppressionStatus,
    createdAt: draft.createdAt,
    lastReview: lastReview ? {
      reviewerId: typeof lastReview.actor === "object" && lastReview.actor !== null
        && typeof (lastReview.actor as { actorId?: unknown }).actorId === "string"
        ? (lastReview.actor as { actorId: string }).actorId : "",
      reviewerLabel: "Reviewer",
      reviewedAt: lastReview.at,
    } : null,
    actions: {
      open: true,
      copy: item.eligibleActions.includes("copy"),
      export: item.eligibleActions.includes("export"),
    },
  };
}

function toDraftDetail(
  draft: StoredOutreachDraft,
  data: DraftData,
  workspaceId: string,
  latestByKey: ReadonlyMap<string, number>,
  capabilities: Readonly<{ approve: boolean; copyExport: boolean }>,
): DraftDetail {
  const claims = draft.draft.validation.claims.map((claim) => ({
    claimId: claim.claimId,
    statement: claim.text,
    material: true as const,
    support: claim.uncertainty !== null ? "uncertain" as const : "current" as const,
    evidence: claim.evidenceIds.map((evidenceId) => {
      const record = evidenceRecords(draft).get(evidenceId);
      return {
        evidenceId,
        sourceLabel: record?.sourceLabel ?? evidenceId,
        quote: record?.quote ?? "",
        locator: record?.locator ?? "",
        status: (record?.status ?? "current") as "current" | "stale" | "conflicted",
      };
    }),
  }));
  const key = `${draft.accountId}:${draft.stableKey}`;
  const current = data.currentStates.get(key);
  const isLatest = latestByKey.get(key) === draft.revision;
  const status = draft.draft.review.status;
  const lastDecision = draft.draft.review.events.at(-1);
  const eligible = current?.eligibleActions ?? [];
  return {
    accountId: draft.accountId,
    stableKey: draft.stableKey,
    versionId: draft.draft.versionId,
    revision: draft.revision,
    contactVersionId: draft.contactVersionId,
    stateHash: current?.stateHash ?? null,
    reviewHash: draft.draft.review.reviewHash,
    draft: {
      versionLabel: `v${draft.revision}`,
      status,
      statusLabel: status.replaceAll("_", " "),
      subject: draft.draft.subject,
      body: draft.draft.body,
    },
    claims,
    uncertainties: draft.draft.validation.claims
      .filter((claim) => claim.uncertainty !== null)
      .map((claim) => ({
        uncertaintyId: claim.claimId,
        statement: claim.uncertainty ?? "",
        impact: `Claim ${claim.claimId}`,
      })),
    approval: {
      status: status === "approved" ? "approved" as const : status === "rejected" ? "rejected" as const : "pending" as const,
      label: status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending",
      decidedAtLabel: lastDecision && (status === "approved" || status === "rejected") ? lastDecision.at : null,
    },
    policy: {
      result: status === "approved" ? "allow" as const : "deny" as const,
      reasons: [],
    },
    eligibleActions: (capabilities.copyExport && isLatest
      ? eligible.filter((action): action is "copy" | "export" => action === "copy" || action === "export")
      : []),
    canReview: capabilities.approve && isLatest && (status === "draft" || status === "in_review"),
  };
}

function evidenceRecords(
  draft: StoredOutreachDraft,
): ReadonlyMap<string, { sourceLabel: string; quote: string; locator: string; status: string }> {
  const map = new Map<string, { sourceLabel: string; quote: string; locator: string; status: string }>();
  for (const record of draft.evidencePayload.evidence) {
    if (typeof record !== "object" || record === null) continue;
    const entry = record as Record<string, unknown>;
    const evidenceId = typeof entry.evidenceId === "string" ? entry.evidenceId : null;
    if (!evidenceId) continue;
    map.set(evidenceId, {
      sourceLabel: typeof entry.sourceLabel === "string" ? entry.sourceLabel
        : typeof entry.source === "string" ? entry.source : evidenceId,
      quote: typeof entry.quote === "string" ? entry.quote : "",
      locator: typeof entry.locator === "string" ? entry.locator : "",
      status: typeof entry.status === "string" ? entry.status
        : typeof entry.freshness === "string" ? entry.freshness : "current",
    });
  }
  return map;
}
