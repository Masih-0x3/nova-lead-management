"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import {
  acceptLocalTenantInvitationAction,
  type LocalInvitationActionResult,
} from "@/lib/tenancy/invitation-actions";

/**
 * Invite-facing acceptance control. Safe on memberless sessions: the action
 * binds the invitation to the session's verified identity hash, so mounting
 * this for a pending user grants nothing until acceptance succeeds. A
 * successful acceptance refreshes the route so the shell re-resolves the
 * now-active membership and app profile.
 */
export function InvitationAcceptControl() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<LocalInvitationActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await acceptLocalTenantInvitationAction({
        invitationId: data.get("invitationId"),
        requestId: crypto.randomUUID(),
      });
      setNotice(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="glass rounded-2xl p-5 text-left" aria-labelledby="local-invitation-accept-title">
      <p className="section-label">Invitation acceptance</p>
      <h2 id="local-invitation-accept-title" className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        Accept an invitation as the current session
      </h2>
      {open ? (
        <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
          <label className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Invitation UUID
            <input className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm" name="invitationId" type="text" required autoComplete="off" disabled={pending} />
          </label>
          <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            Acceptance binds to the current session&apos;s verified identity — the invitation&apos;s recipient hash must match.
          </p>
          <button className="btn-primary sm:w-fit" type="submit" disabled={pending}>{pending ? "Accepting…" : "Accept invitation"}</button>
        </form>
      ) : (
        <button type="button" className="btn-primary mt-4 sm:w-fit" onClick={() => { setNotice(null); setOpen(true); }}>
          Enter invitation id
        </button>
      )}
      {notice ? (
        <p className="mt-3 rounded-xl border p-4 text-sm" role={notice.ok ? "status" : "alert"} style={{ borderColor: "var(--surface-card-border)", color: notice.ok ? "var(--success-text)" : "var(--danger-text)" }}>
          {notice.message}
        </p>
      ) : null}
    </section>
  );
}
