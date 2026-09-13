"use server";

import { z } from "zod";

import {
  createAppUserForAuthUser,
  getAppUserByUserId,
} from "@/lib/app-users";
import { getSession, type SessionLookupResult } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isLocalMembershipAdministrationAvailable } from "@/lib/tenancy/local-membership-administration";
import {
  createLocalAuthUserProvisioner,
  createLocalTenantInvitationService,
} from "@/lib/tenancy/local-tenant-provisioning";
import { createPostgresTenantInvitationService } from "@/lib/tenancy/postgres-tenant-invitation";
import { TenantInvitationError } from "@/lib/tenancy/provisioning";
import type { TenantInvitationResultCode } from "@/lib/tenancy/types";
import { createSupabaseAuthUserProvisioner } from "@/lib/tenancy/supabase-auth-provisioning";
import { tenantInvitationIdSchema } from "@/lib/tenancy/schemas";
import type { LaunchRole } from "@/lib/tenancy/types";

const acceptInputSchema = z.object({
  invitationId: tenantInvitationIdSchema,
  requestId: z.string().uuid(),
}).strict();

export type LocalInvitationActionErrorCode =
  | "INVALID_INPUT"
  | "NOT_AUTHORIZED"
  | "LOCAL_MUTATIONS_UNAVAILABLE"
  | "INVITATION_UNAVAILABLE"
  | "CONFLICT"
  | "UNAVAILABLE";

export type LocalInvitationActionResult =
  | Readonly<{ ok: true; tenantId: string; role: string; message: string }>
  | Readonly<{ ok: false; code: LocalInvitationActionErrorCode; message: string }>;

/**
 * Invite-facing acceptance: the caller's verified session subject is the
 * accepting identity — the command body carries only the invitation id
 * capability. No tenant context is required or assumed; the service binds the
 * durable invitation to the identity hash and activates the membership.
 */
export async function acceptLocalTenantInvitationAction(
  input: unknown,
): Promise<LocalInvitationActionResult> {
  try {
    const session = await getSession({ allowInactive: true });
    if (!session) return failure("NOT_AUTHORIZED");

    const parsed = acceptInputSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");

    const authUserProvisioner = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
      ? createSupabaseAuthUserProvisioner()
      : createLocalAuthUserProvisioner();
    const service = isLocalMembershipAdministrationAvailable()
      ? createLocalTenantInvitationService(await getDb(), { authUserProvisioner })
      : createPostgresTenantInvitationService({ authUserProvisioner });
    const result = await service.acceptInvitation(session.userId, {
      invitationId: parsed.data.invitationId,
      idempotencyKey: `invitation-accept.${parsed.data.requestId}`,
      correlationId: `invitation-accept:${parsed.data.requestId}`,
    });
    // The accepted membership alone does not admit the legacy session gate:
    // ensure the app_users profile exists and is active so the tenant session
    // can resolve. Persisted rows are never rewritten — an existing active or
    // disabled status is a deliberate platform state.
    await ensureAcceptedAppProfile(session, result.role);
    return {
      ok: true,
      tenantId: result.tenantId,
      role: result.role,
      message: "The invitation was accepted and the membership is active.",
    };
  } catch (error) {
    return mapFailure(error);
  }
}

function compatAppRole(role: LaunchRole): "admin" | "researcher" {
  return role === "owner" || role === "admin" ? "admin" : "researcher";
}

async function ensureAcceptedAppProfile(
  session: SessionLookupResult,
  role: LaunchRole,
): Promise<void> {
  if (!isLocalMembershipAdministrationAvailable()) {
    // app_users is deny-all under the runtime role: the insert-if-missing
    // runs inside the SECURITY DEFINER, which never rewrites a persisted row.
    const db = await getDb();
    await db
      .prepare("SELECT public.novatrade_app_user_ensure_active(?::uuid, ?, ?, ?)")
      .run(session.userId, session.email, session.displayName, compatAppRole(role));
    return;
  }
  const existing = await getAppUserByUserId(session.userId);
  if (existing) return;
  await createAppUserForAuthUser({
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    role: compatAppRole(role),
    status: "active",
    createdBy: null,
  });
}

function mapFailure(error: unknown): LocalInvitationActionResult {
  if (!(error instanceof TenantInvitationError)) return failure("UNAVAILABLE");
  return failure(mapInvitationFailureCode(error.code));
}

function mapInvitationFailureCode(code: TenantInvitationResultCode): LocalInvitationActionErrorCode {
  if (code === "INVALID_INPUT") return "INVALID_INPUT";
  if (code === "INVITATION_NOT_AUTHORIZED") return "NOT_AUTHORIZED";
  if (code === "PROVISIONING_IDEMPOTENCY_CONFLICT" || code === "PROVISIONING_IN_PROGRESS"
    || code === "PROVISIONING_CONFLICT") {
    return "CONFLICT";
  }
  // Not-found, wrong-recipient, revoked, expired, already-accepted, and
  // tenant/target-state failures all collapse to one non-enumerating result —
  // the response never discloses whether the invitation or tenant exists.
  if (code === "INVITE_NOT_FOUND" || code === "INVITE_RECIPIENT_MISMATCH" || code === "INVITE_REVOKED"
    || code === "INVITE_EXPIRED" || code === "INVITE_ALREADY_ACCEPTED" || code === "TENANT_STATE_BLOCKED"
    || code === "PROVISIONING_STATE_BLOCKED") {
    return "INVITATION_UNAVAILABLE";
  }
  return "UNAVAILABLE";
}

function failure(code: LocalInvitationActionErrorCode): LocalInvitationActionResult {
  const message: Readonly<Record<LocalInvitationActionErrorCode, string>> = {
    INVALID_INPUT: "The invitation request is invalid.",
    NOT_AUTHORIZED: "An authenticated session is required to accept an invitation.",
    LOCAL_MUTATIONS_UNAVAILABLE: "Invitation acceptance is read-only when PostgreSQL is configured.",
    INVITATION_UNAVAILABLE: "The invitation is not available.",
    CONFLICT: "The invitation changed or this request conflicts with its current state.",
    UNAVAILABLE: "The invitation request could not be completed.",
  };
  return { ok: false, code, message: message[code] };
}
