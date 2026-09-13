"use client";

import { useState, useTransition, type FormEvent } from "react";

import { InvitationAcceptControl } from "@/components/admin/invitation-accept-control";
import { MembershipAdminPanel } from "@/components/admin/membership-admin-panel";
import {
  assignLocalTenantMembershipRoleAction,
  disableLocalTenantMembershipAction,
  inviteLocalTenantMembershipAction,
  reactivateLocalTenantMembershipAction,
  removeLocalTenantMembershipAction,
  revokeLocalTenantMembershipAction,
  type LocalMembershipAdminActionResult,
} from "@/lib/tenancy/membership-admin-actions";
import type { MembershipHistoryView, MembershipView } from "@/lib/tenancy/memberships";
import { LAUNCH_ROLES, type LaunchRole } from "@/lib/tenancy/types";

type StateOperation = "disable" | "reactivate" | "revoke" | "remove";

const STATE_OPERATION_LABEL: Readonly<Record<StateOperation, string>> = Object.freeze({
  disable: "Suspend member",
  reactivate: "Reactivate member",
  revoke: "Revoke invitation",
  remove: "Remove member",
});

const STATE_ACTION: Readonly<Record<StateOperation, (input: unknown) => Promise<LocalMembershipAdminActionResult>>> = Object.freeze({
  disable: disableLocalTenantMembershipAction,
  reactivate: reactivateLocalTenantMembershipAction,
  revoke: revokeLocalTenantMembershipAction,
  remove: removeLocalTenantMembershipAction,
});

type Editor =
  | Readonly<{ kind: "invite"; requestId: string }>
  | Readonly<{ kind: "role"; requestId: string; membership: MembershipView }>
  | Readonly<{ kind: "state"; requestId: string; membership: MembershipView; operation: StateOperation }>
  | null;

export function LocalMembershipAdminControls({
  actor,
  memberships,
  history,
  mutationsEnabled,
}: Readonly<{
  actor: MembershipView;
  memberships: readonly MembershipView[];
  history: readonly MembershipHistoryView[];
  mutationsEnabled: boolean;
}>) {
  const [editor, setEditor] = useState<Editor>(null);
  const [notice, setNotice] = useState<LocalMembershipAdminActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const beginInvite = mutationsEnabled
    ? () => {
        setNotice(null);
        setEditor({ kind: "invite", requestId: crypto.randomUUID() });
      }
    : undefined;
  const beginRoleChange = mutationsEnabled
    ? (membership: MembershipView) => {
        setNotice(null);
        setEditor({ kind: "role", requestId: crypto.randomUUID(), membership });
      }
    : undefined;
  const beginStateTransition = mutationsEnabled
    ? (operation: StateOperation) => (membership: MembershipView) => {
        setNotice(null);
        setEditor({ kind: "state", requestId: crypto.randomUUID(), membership, operation });
      }
    : undefined;

  return (
    <div className="space-y-5" data-local-membership-mutations={mutationsEnabled ? "enabled" : "read-only"}>
      {!mutationsEnabled ? (
        <p className="glass rounded-xl border p-4 text-sm" role="status" style={{ borderColor: "var(--surface-card-border)", color: "var(--text-secondary)" }}>
          Membership administration is read-only for this role. Invitation, role, and state controls require an owner or administrator.
        </p>
      ) : null}

      <MembershipAdminPanel
        state="ready"
        actor={actor}
        memberships={memberships}
        history={history}
        policyAuthorizations={mutationsEnabled
          ? { "membership:invite": true, "role:assign": true, "membership:manage": true }
          : {}}
        onInvite={beginInvite}
        onChangeRole={beginRoleChange}
        onSuspend={beginStateTransition ? beginStateTransition("disable") : undefined}
        onReactivate={beginStateTransition ? beginStateTransition("reactivate") : undefined}
        onRevoke={beginStateTransition ? beginStateTransition("revoke") : undefined}
        onRemove={beginStateTransition ? beginStateTransition("remove") : undefined}
      />

      {editor ? (
        <section className="glass-heavy rounded-2xl p-5" aria-labelledby="local-membership-editor-title">
          <p className="section-label">Local canonical change</p>
          <h2 id="local-membership-editor-title" className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            {editor.kind === "invite" ? "Invite member" : editor.kind === "role" ? "Assign tenant role" : STATE_OPERATION_LABEL[editor.operation]}
          </h2>
          {editor.kind === "invite" ? (
            <InviteForm editor={editor} pending={pending} submit={(input) => run(input)} />
          ) : editor.kind === "role" ? (
            <RoleForm editor={editor} pending={pending} submit={(input) => run(input)} />
          ) : (
            <StateConfirmForm editor={editor} pending={pending} submit={(input) => run(input)} />
          )}
          <button type="button" className="mt-3 text-sm font-semibold" disabled={pending} onClick={() => setEditor(null)}>
            Cancel
          </button>
        </section>
      ) : null}

      {notice ? (
        <div className="rounded-xl border p-4 text-sm" role={notice.ok ? "status" : "alert"} style={{ borderColor: "var(--surface-card-border)", color: notice.ok ? "var(--success-text)" : "var(--danger-text)" }}>
          <p>{notice.message}</p>
          {notice.ok && notice.invitationId ? (
            <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
              Invitation id (relay to the invitee): <span className="font-mono break-all">{notice.invitationId}</span>
              {notice.invitationExpiresAt ? <> — expires {notice.invitationExpiresAt}</> : null}
            </p>
          ) : null}
        </div>
      ) : null}

      {mutationsEnabled ? <InvitationAcceptControl /> : null}
    </div>
  );

  function run(input: Promise<LocalMembershipAdminActionResult>) {
    startTransition(async () => {
      const result = await input;
      setNotice(result);
      if (result.ok) setEditor(null);
    });
  }
}

function InviteForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "invite" }>;
  pending: boolean;
  submit: (input: Promise<LocalMembershipAdminActionResult>) => void;
}>) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit(inviteLocalTenantMembershipAction({
      authSubjectId: data.get("authSubjectId"),
      role: data.get("role"),
      requestId: editor.requestId,
    }));
  }

  return (
    <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
      <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Verified Auth subject UUID
        <input className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm" name="authSubjectId" type="text" required autoComplete="off" disabled={pending} />
      </label>
      <RoleSelect defaultRole="researcher" pending={pending} />
      <p className="text-xs sm:col-span-2" style={{ color: "var(--text-tertiary)" }}>
        This stores a domain-separated identity hash, creates a pending membership, and issues a durable invitation. Access is granted only when the invitee accepts with the matching verified identity.
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>{pending ? "Inviting…" : "Issue invitation"}</button>
    </form>
  );
}

function RoleForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "role" }>;
  pending: boolean;
  submit: (input: Promise<LocalMembershipAdminActionResult>) => void;
}>) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit(assignLocalTenantMembershipRoleAction({
      membershipId: editor.membership.membershipId,
      role: data.get("role"),
      requestId: editor.requestId,
    }));
  }

  return (
    <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
      <p className="break-all font-mono text-xs sm:col-span-2" style={{ color: "var(--text-secondary)" }}>{editor.membership.membershipId}</p>
      <RoleSelect defaultRole={editor.membership.role ?? "researcher"} pending={pending} />
      <button className="btn-primary sm:w-fit sm:self-end" type="submit" disabled={pending}>{pending ? "Assigning…" : "Assign role"}</button>
    </form>
  );
}

function StateConfirmForm({
  editor,
  pending,
  submit,
}: Readonly<{
  editor: Extract<Editor, { kind: "state" }>;
  pending: boolean;
  submit: (input: Promise<LocalMembershipAdminActionResult>) => void;
}>) {
  const label = STATE_OPERATION_LABEL[editor.operation];

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(STATE_ACTION[editor.operation]({
      membershipId: editor.membership.membershipId,
      requestId: editor.requestId,
    }));
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
      <p className="break-all font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{editor.membership.membershipId}</p>
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        {editor.operation === "remove"
          ? "Removal is terminal for this tenant membership and cannot be undone. The change is journaled and audited."
          : "This change applies to the canonical tenant membership and is journaled and audited."}
      </p>
      <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>{pending ? "Applying…" : label}</button>
    </form>
  );
}

function RoleSelect({ defaultRole, pending }: Readonly<{ defaultRole: LaunchRole; pending: boolean }>) {
  return (
    <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
      Canonical role
      <select className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" name="role" defaultValue={defaultRole} disabled={pending}>
        {LAUNCH_ROLES.map((role) => <option key={role} value={role}>{formatRole(role)}</option>)}
      </select>
    </label>
  );
}

function formatRole(role: LaunchRole): string {
  return role.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
