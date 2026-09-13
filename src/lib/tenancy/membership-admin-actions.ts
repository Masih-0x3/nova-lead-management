"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  requireTenantSession,
  TenantSessionUnauthenticatedError,
  TenantSessionUnavailableError,
  type TenantSession,
} from "@/lib/auth";
import { withTenantDbContext, type DbClient } from "@/lib/db";
import {
  createLocalTenantMembershipAdministrationService,
  hashLocalAuthIdentitySelector,
  isLocalMembershipAdministrationAvailable,
} from "@/lib/tenancy/local-membership-administration";
import {
  createLocalInvitationDeliveryAdapter,
  createLocalTenantInvitationService,
} from "@/lib/tenancy/local-tenant-provisioning";
import { createLocalTenantLimitService } from "@/lib/tenancy/local-tenant-limits";
import { createPostgresTenantMembershipAdministrationService } from "@/lib/tenancy/postgres-membership-administration";
import { createPostgresTenantInvitationService } from "@/lib/tenancy/postgres-tenant-invitation";
import { createPostgresTenantLimitService } from "@/lib/tenancy/postgres-tenant-limits";
import {
  MembershipAdministrationError,
  type MembershipAdministrationErrorCode,
  type MembershipView,
} from "@/lib/tenancy/memberships";
import { TenantInvitationError } from "@/lib/tenancy/provisioning";
import type {
  TenantInvitationDeliveryState,
  TenantInvitationResultCode,
} from "@/lib/tenancy/types";
import { launchRoleSchema, membershipIdSchema } from "@/lib/tenancy/schemas";
import { runWithTenantContext, TenantContextError } from "@/lib/tenancy/context";

const requestIdSchema = z.string().uuid();
const inviteInputSchema = z.object({
  authSubjectId: z.string().uuid(),
  role: launchRoleSchema,
  requestId: requestIdSchema,
}).strict();
const assignRoleInputSchema = z.object({
  membershipId: membershipIdSchema,
  role: launchRoleSchema,
  requestId: requestIdSchema,
}).strict();
const membershipStateInputSchema = z.object({
  membershipId: membershipIdSchema,
  replacementOwnerMembershipId: membershipIdSchema.optional(),
  requestId: requestIdSchema,
}).strict();

export type LocalMembershipAdminActionResult =
  | Readonly<{
      ok: true;
      membership: MembershipView;
      /** Present on invite results — the durable invitation issued for relay to the invitee. */
      invitationId?: string;
      invitationExpiresAt?: string;
      deliveryState?: TenantInvitationDeliveryState;
      message: string;
    }>
  | Readonly<{ ok: false; code: LocalMembershipAdminActionErrorCode; message: string }>;

export type LocalMembershipAdminActionErrorCode =
  | "INVALID_INPUT"
  | "NOT_AUTHORIZED"
  | "LOCAL_MUTATIONS_UNAVAILABLE"
  | "MEMBERSHIP_UNAVAILABLE"
  | "CONFLICT"
  | "UNAVAILABLE";

export async function inviteLocalTenantMembershipAction(
  input: unknown,
): Promise<LocalMembershipAdminActionResult> {
  return executeLocalMembershipAction(input, inviteInputSchema, "invite", async (session, parsed) => {
    const identitySelectorHash = hashLocalAuthIdentitySelector(parsed.authSubjectId);
    return withTenantDbContext(async (db) => {
      const membershipService = createMembershipService(db);
      const membershipResult = await membershipService.invitePendingMember(session, {
        identitySelectorHash,
        role: parsed.role,
        workspaceId: null,
        reasonCode: "invitation",
        correlationId: `membership-invite:${parsed.requestId}`,
        idempotencyKey: `membership-invite.${parsed.requestId}`,
      });
      // Issue the durable invitation bound to the pending membership. The
      // member-context consume enforces the tenant's membership_invite quota;
      // delivery runs through the local adapter (no transport — the admin
      // relays the invitation id to the invitee).
      const invitationService = isLocalMembershipAdministrationAvailable()
        ? createLocalTenantInvitationService(db, {
            invitationDelivery: createLocalInvitationDeliveryAdapter(),
            limits: createLocalTenantLimitService(db),
          })
        : createPostgresTenantInvitationService({
            invitationDelivery: createLocalInvitationDeliveryAdapter(),
            limits: createPostgresTenantLimitService(),
          });
      const invitation = await invitationService.issueMembershipInvitation({
        tenantId: session.tenantId,
        membershipId: membershipResult.membership.membershipId,
        role: parsed.role,
        workspaceId: null,
        expectedIdentityRefHash: identitySelectorHash,
        actorMembershipId: session.membershipId,
        actorIdentityId: session.userId,
        idempotencyKey: `membership-invitation-issue.${parsed.requestId}`,
        correlationId: `membership-invitation-issue:${parsed.requestId}`,
      });
      return {
        ok: true,
        membership: membershipResult.membership,
        invitationId: invitation.invitationId,
        invitationExpiresAt: invitation.expiresAt,
        deliveryState: invitation.deliveryState,
        message: "Pending membership created and the invitation was issued. Relay the invitation id to the invitee so they can accept.",
      };
    });
  });
}

export async function assignLocalTenantMembershipRoleAction(
  input: unknown,
): Promise<LocalMembershipAdminActionResult> {
  return executeLocalMembershipAction(input, assignRoleInputSchema, "assign-role", async (session, parsed) => {
    const result = await withTenantDbContext(async (db) => {
      const service = createMembershipService(db);
      return service.assignMemberRole(session, {
        membershipId: parsed.membershipId,
        role: parsed.role,
        reasonCode: "role_change",
        correlationId: `membership-role:${parsed.requestId}`,
        idempotencyKey: `membership-role.${parsed.requestId}`,
      });
    });
    return {
      ok: true,
      membership: result.membership,
      message: "The canonical tenant role was updated locally.",
    };
  });
}

const MEMBERSHIP_STATE_OPERATIONS = {
  disable: {
    method: "disableMember",
    reasonCode: "membership_disable",
    message: "The member was suspended.",
  },
  reactivate: {
    method: "reactivateMember",
    reasonCode: "membership_reactivate",
    message: "The member was reactivated.",
  },
  revoke: {
    method: "revokeMember",
    reasonCode: "membership_revoke",
    message: "The pending membership was revoked.",
  },
  remove: {
    method: "removeMember",
    reasonCode: "membership_remove",
    message: "The member was removed.",
  },
} as const;

type MembershipStateOperation = keyof typeof MEMBERSHIP_STATE_OPERATIONS;

export async function disableLocalTenantMembershipAction(
  input: unknown,
): Promise<LocalMembershipAdminActionResult> {
  return executeMembershipStateAction(input, "disable");
}

export async function reactivateLocalTenantMembershipAction(
  input: unknown,
): Promise<LocalMembershipAdminActionResult> {
  return executeMembershipStateAction(input, "reactivate");
}

export async function revokeLocalTenantMembershipAction(
  input: unknown,
): Promise<LocalMembershipAdminActionResult> {
  return executeMembershipStateAction(input, "revoke");
}

export async function removeLocalTenantMembershipAction(
  input: unknown,
): Promise<LocalMembershipAdminActionResult> {
  return executeMembershipStateAction(input, "remove");
}

async function executeMembershipStateAction(
  input: unknown,
  operation: MembershipStateOperation,
): Promise<LocalMembershipAdminActionResult> {
  const spec = MEMBERSHIP_STATE_OPERATIONS[operation];
  return executeLocalMembershipAction(input, membershipStateInputSchema, operation, async (session, parsed) => {
    const result = await withTenantDbContext(async (db) => {
      const service = createMembershipService(db);
      return service[spec.method](session, {
        membershipId: parsed.membershipId,
        ...(parsed.replacementOwnerMembershipId === undefined
          ? {}
          : { replacementOwnerMembershipId: parsed.replacementOwnerMembershipId }),
        reasonCode: spec.reasonCode,
        correlationId: `membership-${operation}:${parsed.requestId}`,
        idempotencyKey: `membership-${operation}.${parsed.requestId}`,
      });
    });
    return {
      ok: true,
      membership: result.membership,
      message: spec.message,
    };
  });
}

/** Backend dispatch: the SQLite compat service locally, the proven Postgres twin when DATABASE_URL is set. */
function createMembershipService(db: DbClient) {
  return isLocalMembershipAdministrationAvailable()
    ? createLocalTenantMembershipAdministrationService(db)
    : createPostgresTenantMembershipAdministrationService();
}

async function executeLocalMembershipAction<T extends { requestId: string }>(
  input: unknown,
  schema: z.ZodType<T>,
  operation: "invite" | "assign-role" | MembershipStateOperation,
  execute: (session: TenantSession, parsed: T) => Promise<LocalMembershipAdminActionResult>,
): Promise<LocalMembershipAdminActionResult> {
  try {
    const session = await requireTenantSession({});
    if (session.workspaceId !== null || (session.role !== "owner" && session.role !== "admin")) {
      return failure("NOT_AUTHORIZED");
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");

    const result = await runWithTenantContext(
      session,
      `membership-admin:${operation}:${parsed.data.requestId}`,
      () => execute(session, parsed.data),
    );
    if (result.ok) {
      try {
        revalidatePath("/users");
      } catch {
        // The mutation already committed; cache invalidation must not rewrite a truthful success.
      }
    }
    return result;
  } catch (error) {
    return mapFailure(error);
  }
}

function mapFailure(error: unknown): LocalMembershipAdminActionResult {
  if (error instanceof TenantSessionUnauthenticatedError
    || error instanceof TenantSessionUnavailableError
    || error instanceof TenantContextError) {
    return failure("NOT_AUTHORIZED");
  }
  if (error instanceof TenantInvitationError) {
    return failure(mapInvitationFailureCode(error.code));
  }
  if (!(error instanceof MembershipAdministrationError)) return failure("UNAVAILABLE");
  const code: MembershipAdministrationErrorCode = error.code;
  if (code === "INVALID_INPUT") return failure("INVALID_INPUT");
  if (code === "TARGET_NOT_FOUND_OR_FORBIDDEN") return failure("MEMBERSHIP_UNAVAILABLE");
  if (code === "PERMISSION_DENIED" || code === "POLICY_BLOCKED" || code === "TENANT_SCOPE_REQUIRED"
    || code === "TENANT_SCOPE_MISMATCH" || code === "WORKSPACE_SCOPE_INVALID") {
    return failure("NOT_AUTHORIZED");
  }
  if (code === "STATE_CONFLICT" || code === "OWNER_GUARD" || code === "DUPLICATE_PENDING_INVITE"
    || code === "DUPLICATE_CURRENT_MEMBERSHIP" || code === "IDEMPOTENCY_CONFLICT"
    || code === "MUTATION_IN_PROGRESS") {
    return failure("CONFLICT");
  }
  return failure("UNAVAILABLE");
}

function mapInvitationFailureCode(code: TenantInvitationResultCode): LocalMembershipAdminActionErrorCode {
  if (code === "INVALID_INPUT") return "INVALID_INPUT";
  if (code === "INVITATION_NOT_AUTHORIZED") return "NOT_AUTHORIZED";
  if (code === "PROVISIONING_IDEMPOTENCY_CONFLICT" || code === "PROVISIONING_IN_PROGRESS"
    || code === "PROVISIONING_CONFLICT") {
    return "CONFLICT";
  }
  // Target, tenant-state, and recipient failures collapse to one code so the
  // response never discloses whether the membership or tenant exists.
  if (code === "INVITE_NOT_FOUND" || code === "INVITE_RECIPIENT_MISMATCH" || code === "INVITE_REVOKED"
    || code === "INVITE_EXPIRED" || code === "INVITE_ALREADY_ACCEPTED" || code === "TENANT_STATE_BLOCKED"
    || code === "PROVISIONING_STATE_BLOCKED") {
    return "MEMBERSHIP_UNAVAILABLE";
  }
  return "UNAVAILABLE";
}

function failure(code: LocalMembershipAdminActionErrorCode): LocalMembershipAdminActionResult {
  const message: Readonly<Record<LocalMembershipAdminActionErrorCode, string>> = {
    INVALID_INPUT: "The membership request is invalid.",
    NOT_AUTHORIZED: "Membership administration is unavailable for this session.",
    LOCAL_MUTATIONS_UNAVAILABLE: "Membership changes are read-only when PostgreSQL is configured.",
    MEMBERSHIP_UNAVAILABLE: "The membership is unavailable.",
    CONFLICT: "The membership changed or this request conflicts with its current state.",
    UNAVAILABLE: "The membership request could not be completed.",
  };
  return { ok: false, code, message: message[code] };
}
