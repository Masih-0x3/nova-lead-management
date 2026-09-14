"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import {
  type AppUser,
  type AppUserStatus,
  type TenantSessionSelector,
} from "@/lib/app-users";
import { requirePermission } from "@/lib/auth";
import { withTenantDbContext } from "@/lib/db";
import {
  ensureDbReady,
  listLocationMarkets,
  type UserMarketAccess,
} from "@/lib/db/queries";
import { isAppRole, type AppRole } from "@/lib/permissions";
import {
  assertTenantResourceOwnership,
  requireTenantPermission,
  TenantAuthorizationError,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  createLocalTenantMembershipAdministrationService,
  isLocalMembershipAdministrationAvailable,
} from "@/lib/tenancy/local-membership-administration";
import { createPostgresTenantMembershipAdministrationService } from "@/lib/tenancy/postgres-membership-administration";
import { createTenantQueryRepository, type Membership } from "@/lib/tenancy/queries";
import type { TenantSession } from "@/lib/auth";

export async function listUsersAction() {
  await requirePermission("users:manage");
  // app_users is platform-global and cannot be projected safely into a tenant
  // directory. The canonical membership page owns the supported read path.
  return unavailableUserResult();
}

export async function listTerritoryMarketsAction() {
  await requirePermission("users:manage");
  await ensureDbReady();
  return listLocationMarkets();
}

export async function listUserMarketAccessAction(userIds: string[]) {
  await requirePermission("users:manage");
  void userIds;
  // user_market_access has no tenant ownership key, so caller-provided user
  // IDs must not authorize a platform-global lookup.
  return unavailableUserResult();
}

export async function createUserAction(
  input: { email: string; displayName?: string; role?: AppRole },
): Promise<{ error: string } | { success: true; user: AppUser; welcomeEmailSent: true }> {
  await requirePermission("users:manage");
  void input;
  // A provider invite creates a platform identity before tenant membership is
  // established. Keep this closed until one canonical adapter owns both steps.
  return unavailableUserResult();
}

export async function updateUserRoleAction(userId: string, role: AppRole, selector: TenantSessionSelector = {}): Promise<{
  error: string;
} | {
  success: true;
}> {
  const actor = await requirePermission("users:manage");
  if (!isAppRole(role)) return unavailableUserResult();
  const tenantSession = await authorizedTenantSession(actor.userId, selector, "role:assign", "users.role");
  const requestId = randomUUID();

  return runWithTenantContext(tenantSession, `user-role:${requestId}`, () =>
    withTenantDbContext(async (db) => {
      const targetMembership = await resolveCanonicalMembershipTarget(db, tenantSession, userId);
      if (!targetMembership) return unavailableUserResult();

      const service = isLocalMembershipAdministrationAvailable()
        ? createLocalTenantMembershipAdministrationService(db)
        : createPostgresTenantMembershipAdministrationService();
      try {
        await service.assignMemberRole(tenantSession, {
          membershipId: targetMembership.id,
          role,
          reasonCode: "role_change",
          correlationId: `user-role:${requestId}`,
          idempotencyKey: `user-role.${requestId}`,
        });
      } catch {
        return unavailableUserResult();
      }
      revalidateUsersPage();
      return { success: true };
    }));
}

export async function updateUserStatusAction(userId: string, status: AppUserStatus, selector: TenantSessionSelector = {}): Promise<{
  error: string;
} | {
  success: true;
}> {
  const actor = await requirePermission("users:manage");
  if (status !== "active" && status !== "disabled") return unavailableUserResult();
  const tenantSession = await authorizedTenantSession(actor.userId, selector, "membership:manage", "users.status");
  const requestId = randomUUID();

  return runWithTenantContext(tenantSession, `user-status:${requestId}`, () =>
    withTenantDbContext(async (db) => {
      const targetMembership = await resolveCanonicalMembershipTarget(db, tenantSession, userId);
      if (!targetMembership) return unavailableUserResult();

      // The platform-global app_users row is never mutated here: disabling is
      // scoped to the tenant membership (pending members are revoked, active
      // members disabled; only disabled memberships can be reactivated).
      const operation = status === "disabled"
        ? (targetMembership.status === "active" ? "disable" : targetMembership.status === "pending" ? "revoke" : null)
        : (targetMembership.status === "disabled" ? "reactivate" : null);
      if (operation === null) return unavailableUserResult();

      const service = isLocalMembershipAdministrationAvailable()
        ? createLocalTenantMembershipAdministrationService(db)
        : createPostgresTenantMembershipAdministrationService();
      try {
        await service[
          operation === "disable" ? "disableMember"
            : operation === "revoke" ? "revokeMember"
            : "reactivateMember"
        ](tenantSession, {
          membershipId: targetMembership.id,
          reasonCode: `membership_${operation}`,
          correlationId: `user-status:${requestId}`,
          idempotencyKey: `user-status.${requestId}`,
        });
      } catch {
        return unavailableUserResult();
      }
      revalidateUsersPage();
      return { success: true };
    }));
}

export async function removeUserAction(
  userId: string,
  selector: TenantSessionSelector = {},
) {
  const actor = await requirePermission("users:manage");
  const tenantSession = await authorizedTenantSession(actor.userId, selector, "membership:manage", "users.remove");
  const requestId = randomUUID();

  return runWithTenantContext(tenantSession, `user-remove:${requestId}`, () =>
    withTenantDbContext(async (db) => {
      const targetMembership = await resolveCanonicalMembershipTarget(db, tenantSession, userId);
      if (!targetMembership) return unavailableUserResult();

      // app_users and Supabase identities are platform-global and are never
      // touched: removal applies only to the canonical tenant membership.
      const service = isLocalMembershipAdministrationAvailable()
        ? createLocalTenantMembershipAdministrationService(db)
        : createPostgresTenantMembershipAdministrationService();
      try {
        await service.removeMember(tenantSession, {
          membershipId: targetMembership.id,
          reasonCode: "membership_remove",
          correlationId: `user-remove:${requestId}`,
          idempotencyKey: `user-remove.${requestId}`,
        });
      } catch {
        return unavailableUserResult();
      }
      revalidateUsersPage();
      return { success: true };
    }));
}

export async function updateUserTeamAction(
  userId: string,
  input: { isTeamLead?: boolean; teamLeadUserId?: string | null; teamLabel?: string | null },
): Promise<{
  error: string;
} | {
  success: true;
  user: AppUser;
}> {
  await requirePermission("users:manage");
  void userId;
  void input;
  // Team fields live on the platform-global app_users row. Fail closed until
  // the canonical tenant/workspace membership model exposes this mutation.
  return unavailableUserResult();
}

export async function updateUserMarketAccessAction(
  userId: string,
  input: { marketIds: string[] },
): Promise<{
  error: string;
} | {
  success: true;
  access: UserMarketAccess[];
}> {
  await requirePermission("users:manage");
  void userId;
  void input;
  // user_market_access is keyed to the platform-global app_users identity and
  // has no canonical tenant ownership boundary. Keep this tenant-facing path
  // closed until a tenant-scoped market-membership adapter owns the mutation.
  return unavailableUserResult();
}

export async function resetUserPasswordAction(userId: string): Promise<{
  error: string;
} | {
  success: true;
  resetEmailSent: true;
}> {
  await requirePermission("users:manage");
  void userId;
  // Password recovery is platform identity administration. A tenant-facing
  // action must not look up or email an arbitrary platform user.
  return unavailableUserResult();
}

function unavailableUserResult(): { error: string } {
  return { error: "User not found or unavailable." };
}

async function authorizedTenantSession(
  actorUserId: string,
  selector: TenantSessionSelector,
  permission: "membership:manage" | "role:assign",
  action: string,
): Promise<TenantSession> {
  const tenantSession = await requireTenantPermission(selector, permission, {
    action,
    // Compatibility remains conditional on the independently resolved legacy
    // administration boundary and the canonical conservative conditional rule
    // (owner/admin only). The identities are correlated immediately below
    // before any target lookup or side effect.
    policyEvaluator: (context) => ({
      allowed: actorUserId.length > 0 && (context.role === "owner" || context.role === "admin"),
      context,
    }),
  });
  if (actorUserId !== tenantSession.userId) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
  return tenantSession;
}

async function resolveCanonicalMembershipTarget(
  db: Parameters<typeof createTenantQueryRepository>[0],
  tenantSession: TenantSession,
  userId: string,
): Promise<Membership | null> {
  await ensureDbReady();
  const memberships = await createTenantQueryRepository(db).listMemberships(tenantSession.tenantId);
  const targetMemberships = memberships.filter((membership) => (
    membership.tenantId === tenantSession.tenantId && membership.authIdentityId === userId
  ));
  if (targetMemberships.length !== 1) return null;

  const targetMembership = targetMemberships[0];
  try {
    assertTenantResourceOwnership(tenantSession, {
      tenantId: targetMembership.tenantId,
      workspaceId: targetMembership.workspaceId,
      resourceId: targetMembership.id,
      resourceType: "tenant_membership",
    }, "workspace-optional");
  } catch {
    return null;
  }
  return targetMembership;
}

function revalidateUsersPage(): void {
  try {
    revalidatePath("/users");
  } catch {
    // The mutation already committed; cache invalidation must not rewrite a truthful success.
  }
}
