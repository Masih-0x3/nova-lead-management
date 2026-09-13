"use client";

import { useState, useTransition, type FormEvent } from "react";

import { DataLifecyclePanel, type TenantDeletionJobView } from "@/components/admin/data-lifecycle-panel";
import {
  TenantLifecyclePanel,
  type TenantLifecycleSnapshot,
} from "@/components/admin/tenant-lifecycle-panel";
import { SupportAccessPanel } from "@/components/admin/support-access-panel";
import {
  approveTenantDeletionAction,
  cancelTenantDeletionAction,
  cancelTenantExportAction,
  decideTenantSupportAccessAction,
  requestTenantDeletionAction,
  requestTenantExportAction,
  requestTenantLifecycleTransitionAction,
  requestTenantSupportAccessAction,
  retryTenantDeletionAction,
  retryTenantExportAction,
  verifyTenantDeletionAction,
  type TenantOperationResult,
} from "@/lib/tenancy/tenant-operations-actions";
import {
  SUPPORT_ACCESS_GRANT_DATA_CLASSES,
  SUPPORT_ACCESS_GRANT_PERMISSIONS,
  type LaunchRole,
  type SupportAccessGrant,
  type TenantExportJob,
  type TenantPolicy,
} from "@/lib/tenancy/types";

type Editor =
  | Readonly<{ kind: "lifecycle"; requestId: string; toStatus: "suspended" | "active" | "archived"; snapshot: TenantLifecycleSnapshot }>
  | Readonly<{ kind: "support-request"; requestId: string }>
  | Readonly<{ kind: "support-decision"; requestId: string; grant: SupportAccessGrant; decision: "approve" | "revoke" }>
  | Readonly<{ kind: "export-request"; requestId: string }>
  | Readonly<{ kind: "export-job"; requestId: string; jobId: string; decision: "cancel" | "retry" }>
  | Readonly<{ kind: "deletion-request"; requestId: string }>
  | Readonly<{ kind: "deletion-job"; requestId: string; jobId: string; decision: "verify" | "approve" | "cancel" | "retry" }>
  | null;

export function TenantOperationsControls({
  lifecycleSnapshot,
  lifecycleMutations,
  supportGrant,
  supportScope,
  actorAuthIdentityId,
  supportAsOf,
  supportMutations,
  dataLifecycle,
  actorRole,
  dataMutations,
}: Readonly<{
  lifecycleSnapshot: TenantLifecycleSnapshot | null;
  lifecycleMutations: boolean;
  supportGrant: SupportAccessGrant | null;
  supportScope: Readonly<{ tenantId: string; workspaceId: string | null }>;
  actorAuthIdentityId: string;
  supportAsOf: string;
  supportMutations: boolean;
  dataLifecycle: Readonly<{
    policy: TenantPolicy | null;
    exportJob: TenantExportJob | null;
    deletionJob: TenantDeletionJobView | null;
    policyAuthorizations: Readonly<{ "data:export"?: boolean; "data:delete"?: boolean }>;
  }>;
  actorRole: LaunchRole;
  dataMutations: boolean;
}>) {
  const [editor, setEditor] = useState<Editor>(null);
  const [notice, setNotice] = useState<TenantOperationResult | null>(null);
  const [pending, startTransition] = useTransition();

  const authorizations = lifecycleMutations
    ? { read: true, request_suspend: true, request_resume: true, request_archive: true }
    : { read: true };
  const supportAuthorizations = supportMutations
    ? { request: true, approve: true, revoke: true }
    : {};

  const beginSuspend = lifecycleMutations
    ? (snapshot: TenantLifecycleSnapshot) => {
        setNotice(null);
        setEditor({ kind: "lifecycle", requestId: crypto.randomUUID(), toStatus: "suspended", snapshot });
      }
    : undefined;
  const beginResume = lifecycleMutations
    ? (snapshot: TenantLifecycleSnapshot, target: "tenant" | "workspace") => {
        if (target !== "tenant") return;
        setNotice(null);
        setEditor({ kind: "lifecycle", requestId: crypto.randomUUID(), toStatus: "active", snapshot });
      }
    : undefined;
  const beginArchive = lifecycleMutations
    ? (snapshot: TenantLifecycleSnapshot) => {
        setNotice(null);
        setEditor({ kind: "lifecycle", requestId: crypto.randomUUID(), toStatus: "archived", snapshot });
      }
    : undefined;
  const beginExportRequest = dataMutations
    ? () => {
        setNotice(null);
        setEditor({ kind: "export-request", requestId: crypto.randomUUID() });
      }
    : undefined;
  const beginExportJob = dataMutations
    ? (decision: "cancel" | "retry") => (jobId: string) => {
        setNotice(null);
        setEditor({ kind: "export-job", requestId: crypto.randomUUID(), jobId, decision });
      }
    : undefined;
  // Deletion requests only make sense once the tenant is archived; the service
  // rechecks the lifecycle gate regardless.
  const beginDeletionRequest = dataMutations && lifecycleSnapshot?.tenant.status === "archived"
    ? () => {
        setNotice(null);
        setEditor({ kind: "deletion-request", requestId: crypto.randomUUID() });
      }
    : undefined;
  const beginDeletionJob = dataMutations
    ? (decision: "verify" | "approve" | "cancel" | "retry") => (jobId: string) => {
        setNotice(null);
        setEditor({ kind: "deletion-job", requestId: crypto.randomUUID(), jobId, decision });
      }
    : undefined;
  const beginSupportRequest = supportMutations
    ? () => {
        setNotice(null);
        setEditor({ kind: "support-request", requestId: crypto.randomUUID() });
      }
    : undefined;
  const beginSupportDecision = supportMutations
    ? (decision: "approve" | "revoke") => (grant: SupportAccessGrant) => {
        setNotice(null);
        setEditor({ kind: "support-decision", requestId: crypto.randomUUID(), grant, decision });
      }
    : undefined;

  return (
    <div className="space-y-5" data-local-tenant-operations={lifecycleMutations || supportMutations ? "enabled" : "read-only"}>
      {lifecycleSnapshot === null ? (
        <section className="glass-heavy rounded-2xl p-5" role="status" aria-labelledby="lifecycle-empty-title">
          <p className="section-label">Administration · Tenant lifecycle</p>
          <h2 id="lifecycle-empty-title" className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Tenant lifecycle unavailable</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            The tenant lifecycle snapshot could not be verified for this scope. No lifecycle request controls are shown.
          </p>
        </section>
      ) : (
        <TenantLifecyclePanel
          state="ready"
          snapshot={lifecycleSnapshot}
          authorizations={authorizations}
          onRequestResume={beginResume}
          onRequestSuspend={beginSuspend}
          onRequestArchive={beginArchive}
        />
      )}

      {dataLifecycle.policy === null ? (
        <section className="glass-heavy rounded-2xl p-5" role="status" aria-labelledby="data-lifecycle-empty-title">
          <p className="section-label">Administration · Data lifecycle</p>
          <h2 id="data-lifecycle-empty-title" className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Data lifecycle unavailable</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            The canonical retention policy for this tenant could not be verified. No export or deletion controls are shown.
          </p>
        </section>
      ) : (
        <>
          <DataLifecyclePanel
            state="ready"
            tenantId={supportScope.tenantId}
            workspaceId={null}
            actorRole={actorRole}
            policy={dataLifecycle.policy}
            exportJob={dataLifecycle.exportJob}
            deletionJob={dataLifecycle.deletionJob}
            policyAuthorizations={dataMutations ? dataLifecycle.policyAuthorizations : {}}
            onRequestExport={beginExportRequest}
            onCancelExport={beginExportJob ? beginExportJob("cancel") : undefined}
            onRetryExport={beginExportJob ? beginExportJob("retry") : undefined}
            onRequestDeletion={beginDeletionRequest}
            onCancelDeletion={beginDeletionJob ? beginDeletionJob("cancel") : undefined}
            onRetryDeletion={beginDeletionJob ? beginDeletionJob("retry") : undefined}
          />
          <DeletionDecisionStrip
            job={dataLifecycle.deletionJob}
            actorAuthIdentityId={actorAuthIdentityId}
            actorRole={actorRole}
            authorized={dataMutations && dataLifecycle.policyAuthorizations["data:delete"] === true}
            onVerify={beginDeletionJob ? beginDeletionJob("verify") : undefined}
            onApprove={beginDeletionJob ? beginDeletionJob("approve") : undefined}
          />
        </>
      )}

      <section className="glass rounded-2xl p-4 sm:p-5" aria-labelledby="support-access-surface-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="section-label">Administration · Support access</p>
            <h3 id="support-access-surface-title" className="mt-1 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
              Support access grant
            </h3>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {supportGrant
                ? "The most recent grant for this tenant is shown below."
                : "No support access grant has been recorded for this tenant."}
            </p>
          </div>
          {supportMutations && beginSupportRequest ? (
            <button type="button" className="btn-primary sm:w-fit" onClick={beginSupportRequest}>
              Request support access
            </button>
          ) : null}
        </div>
      </section>

      {supportGrant ? (
        <SupportAccessPanel
          state="ready"
          grant={supportGrant}
          scope={supportScope}
          actorAuthIdentityId={actorAuthIdentityId}
          asOf={supportAsOf}
          actionAuthorizations={supportAuthorizations}
          onRequest={beginSupportRequest}
          onApprove={beginSupportDecision ? beginSupportDecision("approve") : undefined}
          onRevoke={beginSupportDecision ? beginSupportDecision("revoke") : undefined}
        />
      ) : (
        <SupportAccessPanel state="empty" />
      )}

      {!lifecycleMutations && !supportMutations ? (
        <p className="glass rounded-xl border p-4 text-sm" role="status" style={{ borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          Tenant lifecycle and support access are read-only for this role. Mutations require an owner or administrator membership.
        </p>
      ) : null}

      {editor ? (
        <section className="glass-heavy rounded-2xl p-5" aria-labelledby="tenant-operation-editor-title">
          <p className="section-label">Tenant operation request</p>
          <h2 id="tenant-operation-editor-title" className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            {editorTitle(editor)}
          </h2>
          {editor.kind === "lifecycle" ? (
            <LifecycleForm editor={editor} pending={pending} submit={(input) => run(input)} />
          ) : editor.kind === "support-request" ? (
            <SupportRequestForm editor={editor} pending={pending} submit={(input) => run(input)} />
          ) : editor.kind === "support-decision" ? (
            <SupportDecisionForm editor={editor} pending={pending} submit={(input) => run(input)} />
          ) : editor.kind === "export-request" ? (
            <ExportRequestForm pending={pending} submit={(input) => run(input)} requestId={editor.requestId} />
          ) : editor.kind === "export-job" ? (
            <ExportJobForm editor={editor} pending={pending} submit={(input) => run(input)} />
          ) : editor.kind === "deletion-request" ? (
            <DeletionRequestForm pending={pending} submit={(input) => run(input)} requestId={editor.requestId} />
          ) : (
            <DeletionJobForm editor={editor} pending={pending} submit={(input) => run(input)} />
          )}
          <button type="button" className="mt-3 text-sm font-semibold" disabled={pending} onClick={() => setEditor(null)}>
            Cancel
          </button>
        </section>
      ) : null}

      {notice ? (
        <div className="rounded-xl border p-4 text-sm" role={notice.ok ? "status" : "alert"} style={{ borderColor: "var(--surface-card-border)", color: notice.ok ? "var(--success-text)" : "var(--danger-text)" }}>
          <p>{notice.message}</p>
        </div>
      ) : null}
    </div>
  );

  function run(input: Promise<TenantOperationResult>) {
    startTransition(async () => {
      const result = await input;
      setNotice(result);
      if (result.ok) setEditor(null);
    });
  }
}

function editorTitle(editor: NonNullable<Editor>): string {
  switch (editor.kind) {
    case "lifecycle":
      return editor.toStatus === "suspended"
        ? "Request tenant suspension"
        : editor.toStatus === "archived" ? "Request tenant archive" : "Request tenant resume";
    case "support-request": return "Request support access";
    case "support-decision": return editor.decision === "approve" ? "Approve support grant" : "Revoke support grant";
    case "export-request": return "Request tenant export";
    case "export-job": return editor.decision === "cancel" ? "Cancel export request" : "Retry export";
    case "deletion-request": return "Request tenant deletion";
    case "deletion-job":
      switch (editor.decision) {
        case "verify": return "Verify deletion request";
        case "approve": return "Approve and schedule deletion";
        case "cancel": return "Cancel deletion request";
        case "retry": return "Retry deletion";
      }
  }
}

function LifecycleForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "lifecycle" }>;
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
}>) {
  const verb = editor.toStatus === "suspended"
    ? "suspension"
    : editor.toStatus === "archived" ? "archive" : "resume";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit(requestTenantLifecycleTransitionAction({
      toStatus: editor.toStatus,
      expectedCurrentState: editor.snapshot.tenant.status,
      reasonCode: data.get("reasonCode"),
      reason: data.get("reason"),
      requestId: editor.requestId,
    }));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        {editor.toStatus === "suspended"
          ? "Suspension blocks worker starts, business mutations, and new support elevation until the tenant is resumed. The change is journaled and audited against lifecycle version "
          : editor.toStatus === "archived"
            ? "Archiving retires the tenant from active operation; deletion can only be requested from this state. The change is journaled and audited against lifecycle version "
            : "Resuming restores the tenant to active operation. The change is journaled and audited against lifecycle version "}
        {editor.snapshot.lifecycleVersion}.
      </p>
      <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Reason code
        <input className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm" name="reasonCode" type="text" required autoComplete="off" disabled={pending} placeholder="operations.suspend" pattern="[a-z][a-z0-9._\-]{2,79}" />
      </label>
      <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Reason
        <textarea className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" name="reason" required rows={2} maxLength={500} disabled={pending} />
      </label>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>
        {pending ? "Submitting…" : `Request ${verb}`}
      </button>
    </form>
  );
}

function SupportRequestForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "support-request" }>;
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
}>) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const toIso = (name: string): string => {
      const value = data.get(name);
      const epoch = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(epoch) ? new Date(epoch).toISOString() : "invalid";
    };
    submit(requestTenantSupportAccessAction({
      supportPrincipalRef: data.get("supportPrincipalRef"),
      reasonCode: data.get("reasonCode"),
      reason: data.get("reason"),
      startsAt: toIso("startsAt"),
      expiresAt: toIso("expiresAt"),
      permissions: data.getAll("permissions"),
      dataClasses: data.getAll("dataClasses"),
      requestId: editor.requestId,
    }));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Support principal reference
        <input className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm" name="supportPrincipalRef" type="text" required autoComplete="off" disabled={pending} />
      </label>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        The opaque reference the support operator supplied. It resolves to an active platform-support principal — never to a member.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Reason code
          <input className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm" name="reasonCode" type="text" required autoComplete="off" disabled={pending} placeholder="incident.review" pattern="[a-z][a-z0-9._\-]{2,79}" />
        </label>
        <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Reason
          <input className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" name="reason" type="text" required maxLength={500} disabled={pending} />
        </label>
        <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Starts at (UTC)
          <input className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" name="startsAt" type="datetime-local" required disabled={pending} />
        </label>
        <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Expires at (UTC)
          <input className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" name="expiresAt" type="datetime-local" required disabled={pending} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Requested permissions
          <select multiple size={8} className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" name="permissions" required disabled={pending}>
            {SUPPORT_ACCESS_GRANT_PERMISSIONS.map((permission) => (
              <option key={permission} value={permission}>{permission}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Data classes
          <select multiple size={8} className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" name="dataClasses" required disabled={pending}>
            {SUPPORT_ACCESS_GRANT_DATA_CLASSES.map((dataClass) => (
              <option key={dataClass} value={dataClass}>{dataClass}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        The grant carries no authority until a different member approves it. The window is hard-bounded and every decision is audited.
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>{pending ? "Requesting…" : "Request grant"}</button>
    </form>
  );
}

function SupportDecisionForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "support-decision" }>;
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
}>) {
  const approve = editor.decision === "approve";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(decideTenantSupportAccessAction({
      grantId: editor.grant.id,
      decision: editor.decision,
      requestId: editor.requestId,
    }));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="break-all font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{editor.grant.id}</p>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        {approve
          ? "Approval activates the grant inside its recorded window and least-content scope. The decision is audited."
          : "Revocation is terminal — the grant cannot be reactivated. The decision is audited."}
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>
        {pending ? "Applying…" : approve ? "Approve grant" : "Revoke grant"}
      </button>
    </form>
  );
}

/**
 * Two-person deletion governance: the panel deliberately has no verify/approve
 * slots, so the decision strip lives here — visible only while a job awaits a
 * decision the current actor is eligible to make. The service re-enforces
 * requester/verifier independence.
 */
function DeletionDecisionStrip({
  job,
  actorAuthIdentityId,
  actorRole,
  authorized,
  onVerify,
  onApprove,
}: Readonly<{
  job: TenantDeletionJobView | null;
  actorAuthIdentityId: string;
  actorRole: LaunchRole;
  authorized: boolean;
  onVerify?: (jobId: string) => void;
  onApprove?: (jobId: string) => void;
}>) {
  if (!authorized || job === null || !onVerify || !onApprove) return null;
  const canVerify = job.status === "requested"
    && job.requestedByAuthIdentityId !== actorAuthIdentityId;
  const canApprove = job.status === "verified"
    && actorRole === "owner"
    && job.requestedByAuthIdentityId !== actorAuthIdentityId
    && job.verifiedByAuthIdentityId !== actorAuthIdentityId;
  if (!canVerify && !canApprove) return null;

  return (
    <section className="rounded-2xl border p-4 sm:p-5" aria-labelledby="deletion-decision-title"
      style={{ borderColor: "var(--warning-border)", background: "var(--warning-bg)" }}>
      <p className="section-label">Deletion governance</p>
      <h3 id="deletion-decision-title" className="mt-1 text-base font-semibold" style={{ color: "var(--warning-text)" }}>
        {canVerify ? "A deletion request awaits independent verification" : "A verified deletion awaits owner approval"}
      </h3>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--warning-text)" }}>
        {canVerify
          ? "A different owner or admin must verify the request before it can be scheduled."
          : "An owner who did not request or verify must approve to schedule primary deletion."}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {canVerify ? (
          <button type="button" className="btn-primary sm:w-fit" onClick={() => onVerify(job.id)}>
            Verify deletion request
          </button>
        ) : null}
        {canApprove ? (
          <button type="button" className="btn-primary sm:w-fit" onClick={() => onApprove(job.id)}>
            Approve and schedule deletion
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ExportRequestForm({
  pending,
  submit,
  requestId,
}: Readonly<{
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
  requestId: string;
}>) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(requestTenantExportAction({ requestId }));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        Requests a portable JSON copy of this tenant&apos;s data. The request is journaled, quota-metered, and audited; the local runtime produces the artifact inline and the artifact expires under the retention policy.
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>
        {pending ? "Requesting…" : "Request export"}
      </button>
    </form>
  );
}

function ExportJobForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "export-job" }>;
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
}>) {
  const cancel = editor.decision === "cancel";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { jobId: editor.jobId, requestId: editor.requestId };
    submit(cancel ? cancelTenantExportAction(input) : retryTenantExportAction(input));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="break-all font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{editor.jobId}</p>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        {cancel
          ? "Cancellation stops the export before release. The decision is audited."
          : "The failed export re-enters the retry window inside its retry budget. The local runtime executes it inline."}
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>
        {pending ? "Applying…" : cancel ? "Cancel export" : "Retry export"}
      </button>
    </form>
  );
}

function DeletionRequestForm({
  pending,
  submit,
  requestId,
}: Readonly<{
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
  requestId: string;
}>) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(requestTenantDeletionAction({ requestId }));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="text-xs font-semibold leading-relaxed" style={{ color: "var(--danger-text)" }}>
        Requests deletion of the archived tenant. A different owner or admin must verify, and a distinct owner must approve, before primary deletion is scheduled. Cancellation is possible until the run starts.
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>
        {pending ? "Requesting…" : "Request deletion"}
      </button>
    </form>
  );
}

function DeletionJobForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "deletion-job" }>;
  pending: boolean;
  submit: (input: Promise<TenantOperationResult>) => void;
}>) {
  const copy = {
    verify: "Verification records that a second member reviewed the request. The decision is audited.",
    approve: "Approval schedules primary deletion under the retention policy. The decision is audited.",
    cancel: "Cancellation is only possible before the run starts; an archived tenant stays archived. The decision is audited.",
    retry: "The failed deletion re-enters the retry window inside its retry budget. The decision is audited.",
  } as const;
  const labels = {
    verify: "Verify request",
    approve: "Approve and schedule",
    cancel: "Cancel deletion",
    retry: "Retry deletion",
  } as const;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { jobId: editor.jobId, requestId: editor.requestId };
    submit(
      editor.decision === "verify" ? verifyTenantDeletionAction(input)
        : editor.decision === "approve" ? approveTenantDeletionAction(input)
        : editor.decision === "cancel" ? cancelTenantDeletionAction(input)
        : retryTenantDeletionAction(input),
    );
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="break-all font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{editor.jobId}</p>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>{copy[editor.decision]}</p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>
        {pending ? "Applying…" : labels[editor.decision]}
      </button>
    </form>
  );
}
