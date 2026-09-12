import { randomUUID } from "node:crypto";
import type { Metadata } from "next";

import type { BusinessUnderstandingVersionSummary } from "@/components/knowledge/business-understanding-history-panel";
import { PageShell } from "@/components/page-shell";
import { getTenantSession } from "@/lib/auth";
import { isTenantRoleCapable } from "@/lib/permissions";
import { TenantAuthorizationError } from "@/lib/tenancy/authorize";
import {
  getAuthenticatedQuestionSession,
  listAuthenticatedQuestionAnswers,
  listAuthenticatedUnderstandingVersions,
} from "@/lib/understanding/authenticated-service";
import type { UnderstandingVersionView } from "@/lib/understanding/service";
import type { AdaptiveQuestionSession, QuestionAnswerRecord } from "@/lib/understanding/question-planner";

import { PendingSeamNotice, SurfaceNotice } from "../_lib/surface";
import { KnowledgeWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Knowledge | Nova Trade Lead Management" };

export default async function KnowledgePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const selectedVersionId = typeof params.version === "string" ? params.version : null;

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return (
      <SurfaceNotice
        route="/knowledge"
        title="Knowledge"
        description="Source materials, extraction review, evidence, and the business understanding."
        kind="unavailable"
      />
    );
  }

  const scope = { tenantId: session.tenantId, workspaceId: session.workspaceId };
  const deps = { correlationId: `l07:knowledge:${randomUUID()}` };

  let versions: readonly UnderstandingVersionView[] | null = null;
  let failure: "denied" | "error" | null = null;
  try {
    const result = await listAuthenticatedUnderstandingVersions(scope, deps);
    if (!result.ok) {
      failure = "error";
    } else {
      versions = result.value;
    }
  } catch (error) {
    failure = error instanceof TenantAuthorizationError ? "denied" : "error";
  }
  if (failure !== null) {
    return (
      <SurfaceNotice
        route="/knowledge"
        title="Knowledge"
        description="Source materials, extraction review, evidence, and the business understanding."
        kind={failure}
      />
    );
  }

  const ordered = [...(versions ?? [])].sort((left, right) =>
    Date.parse(right.stored.createdAt) - Date.parse(left.stored.createdAt)
      || right.stored.revision - left.stored.revision);
  const selected = ordered.find((view) => view.proposal.versionId === selectedVersionId) ?? ordered[0] ?? null;

  const capabilities = {
    edit: isTenantRoleCapable(session.role, "understanding:edit"),
    approve: isTenantRoleCapable(session.role, "understanding:approve"),
    answer: isTenantRoleCapable(session.role, "question:answer"),
  };

  let questionSession: AdaptiveQuestionSession | null = null;
  let questionAnswers: readonly QuestionAnswerRecord[] = [];
  if (selected) {
    const sessionRef = questionSessionRef(selected.proposal.versionId);
    try {
      const stored = await getAuthenticatedQuestionSession(scope, sessionRef, deps);
      if (stored.ok) {
        questionSession = stored.value.session;
        const answers = await listAuthenticatedQuestionAnswers(scope, sessionRef, deps);
        if (answers.ok) questionAnswers = answers.value;
      }
    } catch {
      questionSession = null;
      questionAnswers = [];
    }
  }

  const reviewHashByVersionId: Record<string, string> = {};
  for (const view of ordered) reviewHashByVersionId[view.proposal.versionId] = view.proposal.review.reviewHash;
  const summaries = ordered.map((view) => toSummary(view, ordered, capabilities));
  const proposal = selected?.proposal ?? null;

  return (
    <PageShell
      title="Knowledge"
      description="Business understanding review, adaptive questions, and source-material state for this tenant scope."
    >
      {proposal === null ? (
        <PendingSeamNotice
          title="No understanding version yet"
          description="No business-understanding version exists in this scope. Versions are produced by the extraction/understanding pipeline; source-material and extraction read seams are still pending, so nothing has been produced yet."
        />
      ) : (
        <KnowledgeWorkspace
          proposal={proposal}
          versions={summaries}
          reviewHashByVersionId={reviewHashByVersionId}
          scope={scope}
          capabilities={capabilities}
          questionSession={questionSession}
          questionAnswers={questionAnswers}
        />
      )}

      <section aria-labelledby="knowledge-materials-title" className="mt-5 space-y-3">
        <h2 id="knowledge-materials-title" className="section-label">Source materials &amp; extraction</h2>
        <PendingSeamNotice
          title="Document registry and extraction review seams pending"
          description="The document-intake and extraction-pipeline read seams (material list, extraction artifacts, evidence records) have not landed. Upload reservations exist as a service capability; this surface will list them once the registry read seam is available."
        />
      </section>
    </PageShell>
  );
}

function questionSessionRef(versionId: string): string {
  return `qs:${versionId}`;
}

function toSummary(
  view: UnderstandingVersionView,
  all: readonly UnderstandingVersionView[],
  capabilities: Readonly<{ approve: boolean }>,
): BusinessUnderstandingVersionSummary {
  const { proposal, stored } = view;
  const status = proposal.review.status;
  const approved = all.filter((candidate) => candidate.proposal.review.status === "approved");
  const governing = approved.reduce<UnderstandingVersionView | null>(
    (best, candidate) => best === null || candidate.proposal.revision > best.proposal.revision ? candidate : best,
    null,
  );
  const isCurrentApproved = governing?.proposal.versionId === proposal.versionId;
  const panelStatus = status === "superseded"
    ? "superseded"
    : status === "approved" ? (isCurrentApproved ? "current" : "approved") : "draft";
  const lastEvent = proposal.review.events.at(-1) ?? null;
  const currentApproved = governing !== null && governing.proposal.versionId !== proposal.versionId ? governing : null;
  const rollbackTarget = capabilities.approve && status === "approved" && !isCurrentApproved ? currentApproved : null;
  const evidenceCount = proposal.domains.reduce(
    (count, domain) => count + domain.facts.reduce((inner, fact) => inner + fact.citations.length, 0),
    0,
  );
  return {
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    versionId: proposal.versionId,
    proposalRef: proposal.proposalRef,
    revision: proposal.revision,
    status: panelStatus,
    evidenceCount,
    uncertaintyCount: proposal.uncertainties.length,
    questionCount: 0,
    recordedAt: stored.createdAt,
    lastReview: lastEvent === null ? null : {
      reviewerId: lastEvent.actor.actorId,
      reviewerLabel: lastEvent.actor.actorId,
      reviewedAt: lastEvent.at,
    },
    rollbackTargetVersionId: rollbackTarget ? rollbackTarget.proposal.versionId : null,
    actions: {
      open: true,
      review: capabilities.approve && status === "in_review",
      rollback: rollbackTarget !== null,
    },
  };
}
