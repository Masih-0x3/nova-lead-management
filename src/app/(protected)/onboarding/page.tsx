import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { Metadata } from "next";

import { OnboardingFrame } from "@/components/onboarding-frame";
import {
  OnboardingProgressPanel,
  type OnboardingProgressReadModel,
  type OnboardingProgressStep,
  type OnboardingProgressStepId,
} from "@/components/onboarding/onboarding-progress-panel";
import { getTenantSession } from "@/lib/auth";
import { isTenantRoleCapable } from "@/lib/permissions";
import {
  getAuthenticatedQuestionSession,
  listAuthenticatedUnderstandingVersions,
} from "@/lib/understanding/authenticated-service";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import {
  getAuthenticatedLeadPlayActivation,
  listAuthenticatedIcpVersions,
  listAuthenticatedLeadPlayVersions,
} from "@/lib/strategy/authenticated-service";
import { TenantAuthorizationError } from "@/lib/tenancy/authorize";
import { loadSurface, SurfaceNotice, PendingSeamNotice } from "../_lib/surface";

export const metadata: Metadata = { title: "Setup | Nova Trade Lead Management" };

const ONBOARDING_STEPS = [
  { id: "scope", label: "Scope" },
  { id: "policy", label: "Policy" },
  { id: "materials", label: "Materials" },
  { id: "progress", label: "Progress" },
  { id: "complete", label: "Complete" },
] as const;

type StepId = (typeof ONBOARDING_STEPS)[number]["id"];
const STEP_IDS = new Set<string>(ONBOARDING_STEPS.map((step) => step.id));

type WorkflowState = Readonly<{
  understandingCount: number;
  hasApprovedUnderstanding: boolean;
  hasQuestionSession: boolean;
  icpCount: number;
  icpInReview: boolean;
  hasApprovedIcp: boolean;
  playCount: number;
  playInReview: boolean;
  hasApprovedPlay: boolean;
  hasActivePlay: boolean;
}>;

export default async function OnboardingPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const rawStep = typeof params.step === "string" ? params.step : null;
  const step: StepId = rawStep !== null && STEP_IDS.has(rawStep) ? rawStep as StepId : "scope";

  const session = await getTenantSession({}).catch(() => null);
  if (!session) {
    return (
      <SurfaceNotice
        route="/onboarding?step=scope"
        title="Tenant setup"
        description="Guided onboarding for scope, policy, materials, and launch progress."
        kind="unavailable"
      />
    );
  }

  const workflow = await loadWorkflowState(session.tenantId, session.workspaceId);
  const stepIndex = ONBOARDING_STEPS.findIndex((item) => item.id === step);
  const previous = stepIndex > 0 ? ONBOARDING_STEPS[stepIndex - 1] : null;
  const next = stepIndex < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[stepIndex + 1] : null;
  const canUpload = isTenantRoleCapable(session.role, "knowledge:upload");

  return (
    <OnboardingFrame
      title={STEP_TITLES[step]}
      description={STEP_DESCRIPTIONS[step]}
      steps={[...ONBOARDING_STEPS]}
      currentStepId={step}
      savedLabel="All state is read live from the tenant-scoped services."
      backAction={previous && (
        <Link className="btn-glass col-span-2 min-h-11 w-full sm:w-auto" href={`/onboarding?step=${previous.id}`}>
          Back: {previous.label}
        </Link>
      )}
      nextAction={next ? (
        <Link className="btn-primary col-span-2 inline-flex min-h-11 w-full items-center justify-center sm:w-auto" href={`/onboarding?step=${next.id}`}>
          Continue: {next.label}
        </Link>
      ) : (
        <Link className="btn-primary col-span-2 inline-flex min-h-11 w-full items-center justify-center sm:w-auto" href="/knowledge">
          Open Knowledge
        </Link>
      )}
    >
      {step === "scope" && <ScopeStep session={session} />}
      {step === "policy" && <PolicyStep />}
      {step === "materials" && <MaterialsStep canUpload={canUpload} />}
      {step === "progress" && <ProgressStep workflow={workflow} session={session} />}
      {step === "complete" && <CompleteStep workflow={workflow} />}
    </OnboardingFrame>
  );
}

const STEP_TITLES: Record<StepId, string> = {
  scope: "Confirm the tenant scope",
  policy: "Review the tenant policy",
  materials: "Add business materials",
  progress: "Launch progress",
  complete: "Ready for work",
};

const STEP_DESCRIPTIONS: Record<StepId, string> = {
  scope: "Verify the tenant, workspace, and role this setup applies to.",
  policy: "Review the active tenant policy flags that govern research, outreach, and retention.",
  materials: "Authorized source materials become immutable, evidence-ready records.",
  progress: "Live launch progress across intake, understanding, questions, and strategy approvals.",
  complete: "The workspace is ready. Continue into the product surfaces.",
};

function ScopeStep({ session }: Readonly<{ session: { tenantId: string; workspaceId: string | null; membershipId: string; role: string; email: string } }>) {
  return (
    <section className="glass rounded-2xl p-4 sm:p-5" aria-labelledby="onboarding-scope-title">
      <h2 id="onboarding-scope-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Resolved tenant scope
      </h2>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          ["Tenant", session.tenantId],
          ["Workspace", session.workspaceId ?? "Tenant-wide"],
          ["Role", session.role],
          ["Membership", session.membershipId],
          ["Signed in as", session.email],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border p-3" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)" }}>
            <dt className="section-label">{label}</dt>
            <dd className="mt-1 break-all text-sm font-medium" style={{ color: "var(--text-primary)" }}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

async function PolicyStep() {
  const outcome = await loadSurface({
    route: "/onboarding?step=policy",
    permission: "tenant:read",
    action: "l07:onboarding:policy",
    scopeClass: "workspace-optional",
    load: (db, session) =>
      createTenantQueryRepository(db).getCurrentTenantPolicy(session.tenantId),
  });
  if (outcome.state !== "ready") {
    return <PolicyNotice kind={outcome.kind} />;
  }
  const policy = outcome.data;
  if (!policy) {
    return (
      <PendingSeamNotice
        title="No tenant policy yet"
        description="No tenant policy record exists for this tenant. An owner or admin can create one from Tenant admin; onboarding steps that depend on policy decisions stay blocked until then."
      />
    );
  }
  const flagEntries = Object.entries(policy).filter(([, value]) => typeof value === "boolean");
  return (
    <section className="glass rounded-2xl p-4 sm:p-5" aria-labelledby="onboarding-policy-title">
      <h2 id="onboarding-policy-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Active tenant policy
      </h2>
      <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
        Read live from the canonical policy record. Manage it from Tenant admin.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Policy flags">
        {flagEntries.map(([key, value]) => (
          <li key={key} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2" style={{ background: "var(--surface-muted)", borderColor: "var(--surface-card-border)" }}>
            <span className="break-words text-sm" style={{ color: "var(--text-secondary)" }}>{key}</span>
            <span className="shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide" style={{ borderColor: value ? "var(--success-border)" : "var(--surface-card-border)", color: value ? "var(--success-text)" : "var(--text-tertiary)", background: value ? "var(--success-bg)" : "var(--surface-muted)" }}>
              {value ? "On" : "Off"}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs" style={{ color: "var(--text-tertiary)" }}>
        <Link href="/tenancy" className="underline">Open Tenant admin</Link> to review or change policy and limits.
      </p>
    </section>
  );
}

function PolicyNotice({ kind }: Readonly<{ kind: "unavailable" | "workspace-required" | "denied" | "error" }>) {
  const copy = kind === "denied"
    ? { title: "Policy read denied", body: "Your tenant role or the current tenant policy does not allow reading this record." }
    : kind === "error"
      ? { title: "Policy read failed", body: "The tenant policy read failed. Reload to retry." }
      : { title: "Tenant scope unavailable", body: "A canonical tenant scope could not be verified." };
  return (
    <section className="glass rounded-2xl p-5" role="alert" aria-labelledby="onboarding-policy-notice">
      <h2 id="onboarding-policy-notice" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{copy.title}</h2>
      <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{copy.body}</p>
    </section>
  );
}

function MaterialsStep({ canUpload }: Readonly<{ canUpload: boolean }>) {
  return (
    <section className="glass rounded-2xl p-4 sm:p-5" aria-labelledby="onboarding-materials-title">
      <h2 id="onboarding-materials-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Source materials
      </h2>
      <div className="mt-4">
        <PendingSeamNotice
          title="Material registry read seam pending"
          description={canUpload
            ? "Document intake upload reservations are available through the intake service, but the document registry list/read seam has not landed yet, so uploaded materials cannot be listed here. No upload control is shown until the registry read seam exists."
            : "Your role cannot upload materials. The document registry read seam has not landed yet, so uploaded materials cannot be listed here."}
        />
      </div>
    </section>
  );
}

function ProgressStep({ workflow, session }: Readonly<{ workflow: WorkflowState | null; session: { tenantId: string; workspaceId: string | null } }>) {
  if (!workflow) {
    return (
      <section className="glass rounded-2xl p-5" role="alert" aria-labelledby="onboarding-progress-error">
        <h2 id="onboarding-progress-error" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Progress unavailable</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          The tenant-scoped workflow reads failed or were denied for this role. Reload or continue to the individual surfaces.
        </p>
      </section>
    );
  }
  const model = buildProgressModel(session.tenantId, session.workspaceId, workflow);
  return (
    <OnboardingProgressPanel state="ready" progress={model} />
  );
}

function CompleteStep({ workflow }: Readonly<{ workflow: WorkflowState | null }>) {
  const complete = workflow !== null && workflow.hasApprovedPlay && workflow.hasActivePlay;
  return (
    <section className="glass rounded-2xl p-4 sm:p-5" aria-labelledby="onboarding-complete-title">
      <h2 id="onboarding-complete-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        {complete ? "Launch complete" : "Setup still in progress"}
      </h2>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {complete
          ? "An approved lead play is active for this scope. Discovery, contacts, review, and outreach surfaces are ready."
          : "Continue through the workspace surfaces — knowledge, strategy, and the review queues finish the launch path."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/knowledge" className="btn-glass min-h-11">Knowledge</Link>
        <Link href="/strategy" className="btn-glass min-h-11">Strategy</Link>
        <Link href="/discovery" className="btn-glass min-h-11">Discovery</Link>
        <Link href="/review" className="btn-glass min-h-11">Review</Link>
      </div>
    </section>
  );
}

type SessionScope = Readonly<{ tenantId: string; workspaceId: string | null }>;

async function loadWorkflowState(tenantId: string, workspaceId: string | null): Promise<WorkflowState | null> {
  const scope = { tenantId, workspaceId } satisfies SessionScope;
  const deps = { correlationId: `l07:onboarding:${randomUUID()}` };
  try {
    const [understanding, icp, plays] = await Promise.all([
      listAuthenticatedUnderstandingVersions(scope, deps).catch(() => null),
      listAuthenticatedIcpVersions(scope, deps).catch(() => null),
      listAuthenticatedLeadPlayVersions(scope, deps).catch(() => null),
    ]);
    if (!understanding?.ok || !icp?.ok || !plays?.ok) return null;

    const approvedUnderstanding = understanding.value.some((view) => view.proposal.review.status === "approved");
    const approvedPlay = plays.value.find((view) => view.proposal.review.status === "approved");
    const activation = approvedPlay
      ? await getAuthenticatedLeadPlayActivation(scope, approvedPlay.stored.stableKey, deps).catch(() => null)
      : null;
    const questionSession = await loadQuestionSessionPresence(scope, understanding.value, deps);

    return {
      understandingCount: understanding.value.length,
      hasApprovedUnderstanding: approvedUnderstanding,
      hasQuestionSession: questionSession,
      icpCount: icp.value.length,
      icpInReview: icp.value.some((view) => view.proposal.review.status === "in_review"),
      hasApprovedIcp: icp.value.some((view) => view.proposal.review.status === "approved"),
      playCount: plays.value.length,
      playInReview: plays.value.some((view) => view.proposal.review.status === "in_review"),
      hasApprovedPlay: approvedPlay !== undefined,
      hasActivePlay: activation?.ok === true && activation.value !== null && activation.value.state.active !== null,
    };
  } catch (error) {
    if (error instanceof TenantAuthorizationError) return null;
    return null;
  }
}

async function loadQuestionSessionPresence(
  scope: SessionScope,
  versions: readonly { proposal: { versionId: string } }[],
  deps: { correlationId: string },
): Promise<boolean> {
  const latest = versions[0];
  if (!latest) return false;
  try {
    const result = await getAuthenticatedQuestionSession(scope, `qs:${latest.proposal.versionId}`, deps);
    return result.ok;
  } catch {
    return false;
  }
}

function buildProgressModel(tenantId: string, workspaceId: string | null, workflow: WorkflowState): OnboardingProgressReadModel {
  const step = (id: OnboardingProgressStepId, label: string, description: string, status: OnboardingProgressStep["status"], statusDetail: string): OnboardingProgressStep => ({
    id, label, description, status, statusDetail,
    completedAt: status === "complete" ? new Date().toISOString() : null,
    navigation: { decision: "allowed", label: "Open" },
  });

  const steps: OnboardingProgressStep[] = [
    step("source_intake", "Source intake", "Authorized materials uploaded for extraction.",
      workflow.hasApprovedUnderstanding ? "complete" : "in_progress",
      workflow.hasApprovedUnderstanding
        ? "An approved understanding exists — materials were processed."
        : "Document registry read seam pending — materials cannot be listed yet."),
    step("extraction_review", "Extraction review", "Claims, evidence, and citations reviewed.",
      workflow.hasApprovedUnderstanding ? "complete" : "in_progress",
      workflow.hasApprovedUnderstanding
        ? "Extraction produced an approved understanding."
        : "Extraction registry read seam pending."),
    step("business_understanding", "Understanding", "Business understanding reviewed and approved.",
      workflow.hasApprovedUnderstanding ? "complete" : workflow.understandingCount > 0 ? "in_progress" : "not_started",
      workflow.hasApprovedUnderstanding
        ? "An approved understanding version governs strategy."
        : workflow.understandingCount > 0
          ? `${workflow.understandingCount} version${workflow.understandingCount === 1 ? "" : "s"} — approval pending.`
          : "No understanding version exists yet."),
    step("adaptive_questions", "Adaptive questions", "Uncertainty questions answered.",
      workflow.hasQuestionSession ? "in_progress" : workflow.hasApprovedUnderstanding ? "ready" : "not_started",
      workflow.hasQuestionSession
        ? "A question session is in progress for the current version."
        : workflow.hasApprovedUnderstanding
          ? "Ready — the planner seam produces the first session."
          : "Requires an understanding version first."),
    step("icp_approval", "ICP approval", "ICP version reviewed and approved.",
      workflow.hasApprovedIcp ? "complete" : workflow.icpInReview ? "in_progress" : workflow.icpCount > 0 ? "ready" : workflow.hasApprovedUnderstanding ? "ready" : "not_started",
      workflow.hasApprovedIcp
        ? "An approved ICP governs plays."
        : workflow.icpInReview
          ? "An ICP version is in human review."
          : workflow.icpCount > 0
            ? `${workflow.icpCount} version${workflow.icpCount === 1 ? "" : "s"} — approval pending.`
            : "Requires an approved understanding."),
    step("lead_play_approval", "Lead play", "Play approved, simulated, and activated.",
      workflow.hasActivePlay ? "complete" : workflow.playInReview ? "in_progress" : workflow.playCount > 0 ? "ready" : workflow.hasApprovedIcp ? "ready" : "not_started",
      workflow.hasActivePlay
        ? "A lead play is active for this scope."
        : workflow.playInReview
          ? "A play version is in human review."
          : workflow.playCount > 0
            ? `${workflow.playCount} version${workflow.playCount === 1 ? "" : "s"} — approval or activation pending.`
            : "Requires an approved ICP."),
  ];

  return {
    workflowRef: `onboarding:${tenantId}`,
    workspaceLabel: workspaceId ?? "Tenant-wide",
    updatedAt: new Date().toISOString(),
    steps,
  };
}
