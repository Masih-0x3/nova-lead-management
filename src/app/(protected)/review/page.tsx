import type { Metadata } from "next";

import type { ReviewQueueSummary, ReviewWorkloadKind } from "@/components/review/review-overview-panel";
import { PageShell } from "@/components/page-shell";
import { isTenantRoleCapable } from "@/lib/permissions";
import type { AccountQualification } from "@/lib/qualification/account-qualification";
import { createPostgresQualificationRepository } from "@/lib/qualification/repository";
import type { ReviewQueue } from "@/lib/review/review-queue";
import { createPostgresReviewRepository } from "@/lib/review/repository";
import { getTenantSession } from "@/lib/auth";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { ReviewWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Review | Nova Trade Lead Management" };

const DESCRIPTION = "Human review queue for resolutions, qualification, and buying centers.";

const KIND_TO_WORKLOAD: Readonly<Record<string, ReviewWorkloadKind>> = {
  ambiguous_account_resolution: "account_and_qualification",
  qualification_review: "account_and_qualification",
  buying_center_review: "contact_and_buying_center",
};

export default async function ReviewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedItemId = typeof params.item === "string" ? params.item : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return <SurfaceNotice route="/review" title="Review" description={DESCRIPTION} kind="unavailable" />;
  }
  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };

  const outcome = await loadSurface({
    route: "/review",
    permission: "queue:read",
    action: "l07:review:read",
    scopeClass: "workspace-required",
    load: async (db) => {
      const repository = createPostgresReviewRepository(db);
      const workspaceId = scope.workspaceId ?? "";
      const queueRow = await repository.getQueue(scope.tenantId, workspaceId);
      const qualifications = isTenantRoleCapable(session.role, "qualification:read")
        ? await createPostgresQualificationRepository(db)
          .listQualifications(scope.tenantId, workspaceId)
        : [];
      return { queueRow, qualifications };
    },
  });

  if (outcome.state !== "ready") {
    return <SurfaceNotice route="/review" title="Review" description={DESCRIPTION} kind={outcome.kind} />;
  }
  if (session.workspaceId === null) {
    return <SurfaceNotice route="/review" title="Review" description={DESCRIPTION} kind="workspace-required" />;
  }
  const workspaceId = session.workspaceId;

  const now = new Date().toISOString();
  const queue = outcome.data.queueRow
    ? outcome.data.queueRow.payload as unknown as ReviewQueue
    : null;
  const items = queue?.items ?? [];

  const capabilities = {
    operate: isTenantRoleCapable(session.role, "queue:operate"),
    qualify: isTenantRoleCapable(session.role, "qualification:approve"),
    override: isTenantRoleCapable(session.role, "score:override"),
  };

  const queues = summarize(items, scope.tenantId, workspaceId, now);
  const selectedItem = selectedItemId
    ? items.find((item) => item.itemId === selectedItemId) ?? null
    : null;

  const selectedQualification = selectedItem?.kind === "qualification_review"
    ? outcome.data.qualifications.find(
      (row) => row.versionId === selectedItem.subject.versionId) ?? null
    : null;
  const qualificationRecord = selectedQualification
    ? selectedQualification.payload as unknown as AccountQualification
    : null;

  return (
    <PageShell title="Review" description={DESCRIPTION}>
      <ReviewWorkspace
        scope={{ tenantId: scope.tenantId, workspaceId }}
        queue={queue}
        queues={queues}
        actorId={session.userId}
        now={now}
        selectedItem={selectedItem}
        selectedQualification={qualificationRecord}
        capabilities={capabilities}
      />
    </PageShell>
  );
}

function summarize(
  items: readonly ReviewQueue["items"][number][],
  tenantId: string,
  workspaceId: string,
  now: string,
): readonly ReviewQueueSummary[] {
  const kinds: readonly ReviewWorkloadKind[] = [
    "document_extraction",
    "icp_and_play",
    "account_and_qualification",
    "contact_and_buying_center",
    "outreach",
    "controlled_learning",
  ];
  const nowEpoch = Date.parse(now);
  return Object.freeze(kinds.map((kind): ReviewQueueSummary => {
    const scoped = items.filter((item) =>
      (KIND_TO_WORKLOAD[item.kind] ?? null) === kind);
    const queuedItems = scoped.filter((item) => item.status === "queued");
    const claimed = scoped.filter((item) => item.status === "claimed");
    const overdue = claimed.filter((item) =>
      item.leaseExpiresAt !== null && Date.parse(item.leaseExpiresAt) <= nowEpoch);
    const oldestQueued = queuedItems.reduce<string | null>((oldest, item) =>
      oldest === null || Date.parse(item.enqueuedAt) < Date.parse(oldest) ? item.enqueuedAt : oldest, null);
    return {
      tenantId,
      workspaceId,
      kind,
      ready: queuedItems.length,
      claimed: claimed.length,
      blocked: overdue.length,
      overdue: overdue.length,
      oldestAgeMinutes: oldestQueued === null
        ? null
        : Math.max(0, Math.round((nowEpoch - Date.parse(oldestQueued)) / 60_000)),
      actions: { open: scoped.length > 0 ? "available" : "blocked" },
    };
  }));
}
