import type { Metadata } from "next";

import type { ContactPortfolioItem } from "@/components/contacts/contact-portfolio-panel";
import { PageShell } from "@/components/page-shell";
import { isTenantRoleCapable } from "@/lib/permissions";
import type { ContactRecord } from "@/lib/contacts/contact-record";
import type { BuyingCenterRow, ContactVersionRow } from "@/lib/contacts/repository";
import { createPostgresContactRepository } from "@/lib/contacts/repository";
import { listBuyingCenterViews } from "@/lib/contacts/service";
import { getTenantSession } from "@/lib/auth";

import { loadSurface, SurfaceNotice } from "../_lib/surface";
import { ContactsWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Contacts | Nova Trade Lead Management" };

const DESCRIPTION = "Governed contacts and buying-center hypotheses for the active workspace.";

export default async function ContactsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedVersionId = typeof params.contact === "string" ? params.contact : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return <SurfaceNotice route="/contacts" title="Contacts" description={DESCRIPTION} kind="unavailable" />;
  }
  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };

  const outcome = await loadSurface({
    route: "/contacts",
    permission: "contact:read",
    action: "l07:contacts:read",
    scopeClass: "workspace-required",
    load: async (db) => {
      const repository = createPostgresContactRepository(db);
      const workspaceId = scope.workspaceId ?? "";
      const [contactRows, centers, centerRows] = await Promise.all([
        repository.listContacts(scope.tenantId, workspaceId),
        listBuyingCenterViews(repository, { tenantId: scope.tenantId, workspaceId }),
        repository.listCenters(scope.tenantId, workspaceId),
      ]);
      return { contactRows, centers, centerRows };
    },
  });

  if (outcome.state !== "ready") {
    return <SurfaceNotice route="/contacts" title="Contacts" description={DESCRIPTION} kind={outcome.kind} />;
  }
  if (session.workspaceId === null) {
    return <SurfaceNotice route="/contacts" title="Contacts" description={DESCRIPTION} kind="workspace-required" />;
  }
  const workspaceId = session.workspaceId;

  const capabilities = {
    approve: isTenantRoleCapable(session.role, "contact:approve"),
    centerApprove: isTenantRoleCapable(session.role, "buying_center:approve"),
    queue: isTenantRoleCapable(session.role, "queue:operate"),
  };

  const contacts = outcome.data.contactRows.map((row) => toPortfolioItem(row, scope.tenantId, workspaceId));
  const selectedRow = selectedVersionId
    ? outcome.data.contactRows.find((row) => row.versionId === selectedVersionId) ?? null
    : null;
  const selectedRecord = selectedRow ? (selectedRow.payload as ContactRecord) : null;

  return (
    <PageShell title="Contacts" description={DESCRIPTION}>
      <ContactsWorkspace
        scope={{ tenantId: scope.tenantId, workspaceId }}
        contacts={contacts}
        centers={outcome.data.centers}
        selectedRecord={selectedRecord}
        selectedHashes={selectedRow ? {
          versionId: selectedRow.versionId,
          accountId: selectedRow.accountId,
          contentHash: selectedRecord?.contentHash ?? "",
          reviewHash: selectedRecord && typeof selectedRecord.review === "object"
            ? (selectedRecord.review as { reviewHash?: string }).reviewHash ?? ""
            : "",
        } : null}
        centerHashes={centerHashes(outcome.data.centerRows)}
        capabilities={capabilities}
      />
    </PageShell>
  );
}

function toPortfolioItem(
  row: ContactVersionRow,
  tenantId: string,
  workspaceId: string,
): ContactPortfolioItem {
  const record = row.payload as ContactRecord;
  const eligible = record.review?.eligibility?.contactUse === "allowed";
  const needsReview = record.review?.status === "draft" || record.review?.status === "in_review";
  return {
    tenantId,
    workspaceId,
    accountId: row.accountId,
    stableKey: row.stableKey,
    versionId: row.versionId,
    identity: record.identity,
    roleHypothesis: record.roleHypothesis,
    source: {
      connectorKey: record.sourceReceipt?.connectorKey ?? row.connectorKey,
      sourceVersionId: record.sourceReceipt?.sourceVersionId ?? "",
    },
    freshness: record.freshness,
    permittedUse: {
      sourcePolicy: record.permittedUse?.sourcePolicy,
      channelAuthorization: record.permittedUse?.channelAuthorization,
      consentSignal: record.permittedUse?.consentSignal,
    },
    suppressionDisposition: record.suppressionDisposition,
    review: { status: row.reviewStatus, needed: needsReview },
    actions: {
      select: "available",
      review: eligible && needsReview ? "available" : "blocked",
    },
  };
}

function centerHashes(rows: readonly BuyingCenterRow[]): ReadonlyMap<string, {
  accountId: string;
  contentHash: string;
  reviewHash: string;
}> {
  const map = new Map<string, { accountId: string; contentHash: string; reviewHash: string }>();
  for (const row of rows) {
    const payload = row.payload as { contentHash?: unknown; review?: unknown };
    const review = typeof payload.review === "object" && payload.review !== null
      ? payload.review as { reviewHash?: unknown } : {};
    map.set(row.versionId, {
      accountId: row.accountId,
      contentHash: typeof payload.contentHash === "string" ? payload.contentHash : `sha256:${row.contentSha256}`,
      reviewHash: typeof review.reviewHash === "string" ? review.reviewHash : `sha256:${row.reviewSha256}`,
    });
  }
  return map;
}
