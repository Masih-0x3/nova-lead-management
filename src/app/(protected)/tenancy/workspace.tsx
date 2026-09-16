"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { StatusNotice } from "@/components/status-notice";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { getStatusToneColor } from "@/lib/status-tone";
import { canTransitionTenant } from "@/lib/tenancy/lifecycle";
import type { TenantStatus } from "@/lib/tenancy/types";
import { transitionTenantLifecycleAction } from "./actions";

type LifecycleTransition = Readonly<{
  id: "suspend" | "resume" | "archive";
  toStatus: TenantStatus;
  label: string;
  reasonCode: string;
  tone: "danger" | "neutral";
  dialogTitle: string;
  dialogMessage: string;
}>;

const TRANSITIONS: readonly LifecycleTransition[] = [
  {
    id: "suspend",
    toStatus: "suspended",
    label: "Suspend tenant",
    reasonCode: "admin_console_suspend",
    tone: "danger",
    dialogTitle: "Suspend tenant",
    dialogMessage: "Suspending pauses normal tenant operations until the tenant is resumed. Record the reason for the audit trail.",
  },
  {
    id: "resume",
    toStatus: "active",
    label: "Resume tenant",
    reasonCode: "admin_console_resume",
    tone: "neutral",
    dialogTitle: "Resume tenant",
    dialogMessage: "Resuming returns the tenant to active status. Record the reason for the audit trail.",
  },
  {
    id: "archive",
    toStatus: "archived",
    label: "Archive tenant",
    reasonCode: "admin_console_archive",
    tone: "danger",
    dialogTitle: "Archive tenant",
    dialogMessage: "Archiving is a terminal operational step: the tenant remains readable for status and export only. Record the reason for the audit trail.",
  },
];

export function TenantLifecycleControls(props: Readonly<{ status: TenantStatus }>) {
  const router = useRouter();
  const [pendingTransition, setPendingTransition] = useState<LifecycleTransition | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Readonly<{ tone: "danger" | "success"; text: string }> | null>(null);
  const [busy, startTransition] = useTransition();

  const available = TRANSITIONS.filter((transition) =>
    transition.toStatus !== props.status && canTransitionTenant(props.status, transition.toStatus).allowed);

  const confirm = () => {
    const transition = pendingTransition;
    if (transition === null) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonError("A reason is required for the audit trail.");
      return;
    }
    startTransition(async () => {
      const result = await transitionTenantLifecycleAction({
        expectedCurrentState: props.status,
        toStatus: transition.toStatus,
        reasonCode: transition.reasonCode,
        reason: trimmed,
      });
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.message });
        return;
      }
      setPendingTransition(null);
      setReason("");
      setReasonError(null);
      setNotice({ tone: "success", text: result.message });
      router.refresh();
    });
  };

  return (
    <div className="mt-4">
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        Current status: <strong style={{ color: "var(--text-primary)" }}>{props.status}</strong>
      </p>
      {available.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>
          No lifecycle transitions are available from the current status.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {available.map((transition) => (
            <button
              key={transition.id}
              type="button"
              className="btn-glass"
              style={transition.tone === "danger" ? { color: getStatusToneColor("danger") } : undefined}
              onClick={() => { setReason(""); setReasonError(null); setNotice(null); setPendingTransition(transition); }}
            >
              {transition.label}
            </button>
          ))}
        </div>
      )}
      {notice === null ? null : (
        <div className="mt-3">
          <StatusNotice notice={{ tone: notice.tone, text: notice.text }} />
        </div>
      )}
      <TextPromptDialog
        open={pendingTransition !== null}
        title={pendingTransition?.dialogTitle ?? "Tenant lifecycle"}
        message={pendingTransition?.dialogMessage ?? ""}
        label="Reason"
        value={reason}
        confirmLabel={pendingTransition?.label ?? "Confirm"}
        busy={busy}
        error={reasonError}
        onChange={(value) => { setReason(value); setReasonError(null); }}
        onConfirm={confirm}
        onCancel={() => { if (!busy) setPendingTransition(null); }}
      />
    </div>
  );
}
