import "server-only";

import type { TenantSession } from "@/lib/auth";
import type { DbClient } from "@/lib/db/index";
import {
  createLocalTenantMembershipAdministrationService,
  isLocalMembershipAdministrationAvailable,
} from "@/lib/tenancy/local-membership-administration";
import type { MembershipHistoryView, MembershipView } from "@/lib/tenancy/memberships";
import {
  createTenantQueryRepository,
  type MembershipDirectoryEntry,
  type RoleBinding,
} from "@/lib/tenancy/queries";
import type { MembershipStatus } from "@/lib/tenancy/types";

export type MembershipDirectory = Readonly<{
  memberships: readonly MembershipView[];
  history: readonly MembershipHistoryView[];
  actor: MembershipView;
}>;

export const CURRENT_MEMBERSHIP_STATUSES = new Set<MembershipStatus>([
  "pending",
  "active",
  "suspended",
  "disabled",
]);
const TERMINAL_MEMBERSHIP_STATUSES = new Set<MembershipStatus>([
  "revoked",
  "removed",
  "expired",
]);

/**
 * Canonical tenant membership snapshot. Prefers the local membership
 * administration service when its auth-identity seam is available; otherwise
 * falls back to a validated read-only projection of the directory +
 * role-binding tables. Throws on any inconsistent snapshot — callers render
 * the typed failure state rather than a partial directory.
 */
export async function loadMembershipDirectory(
  db: DbClient,
  session: TenantSession,
): Promise<MembershipDirectory> {
  if (isLocalMembershipAdministrationAvailable()) {
    const service = createLocalTenantMembershipAdministrationService(db);
    const memberships = await service.listCurrent(session);
    const history = await service.listHistory(session);
    return validateDirectory(session, memberships, history);
  }
  return loadReadOnlyDirectory(session, createTenantQueryRepository(db));
}

export function isLocalMembershipMutationAvailable(): boolean {
  return isLocalMembershipAdministrationAvailable();
}

async function loadReadOnlyDirectory(
  session: TenantSession,
  repository: ReturnType<typeof createTenantQueryRepository>,
): Promise<MembershipDirectory> {
  const snapshotAt = Date.now();
  const [memberships, roleBindings] = await Promise.all([
    repository.listMembershipDirectory(session.tenantId, session.membershipId, session.userId),
    repository.listRoleBindings(session.tenantId),
  ]);
  return projectReadOnlyDirectory(session, memberships, roleBindings, snapshotAt);
}

function projectReadOnlyDirectory(
  session: TenantSession,
  memberships: readonly MembershipDirectoryEntry[],
  roleBindings: readonly RoleBinding[],
  snapshotAt: number,
): MembershipDirectory {
  const membershipIds = new Set(memberships.map((membership) => membership.id));
  const actorIdentityMatches = memberships.filter((membership) => membership.actorIdentityMatches);
  if (membershipIds.size !== memberships.length
    || actorIdentityMatches.length !== 1
    || actorIdentityMatches[0].id !== session.membershipId
    || new Set(roleBindings.map((binding) => binding.id)).size !== roleBindings.length
    || memberships.some((membership) => membership.tenantId !== session.tenantId)
    || roleBindings.some((binding) => binding.tenantId !== session.tenantId
      || !membershipIds.has(binding.membershipId)
      || !validRoleBindingTime(binding, snapshotAt)
      || (binding.assignedByMembershipId !== null && !membershipIds.has(binding.assignedByMembershipId)))) {
    throw new Error("Invalid tenant member snapshot.");
  }

  const current: MembershipView[] = [];
  const history: MembershipHistoryView[] = [];
  for (const membership of memberships) {
    const bindings = roleBindings.filter((binding) => binding.membershipId === membership.id);
    const currentBindings = bindings.filter((binding) => binding.revokedAt === null);
    if (currentBindings.length > 1) throw new Error("Invalid tenant member snapshot.");
    if (TERMINAL_MEMBERSHIP_STATUSES.has(membership.status) && currentBindings.length !== 0) {
      throw new Error("Invalid tenant member snapshot.");
    }
    const roleBinding = currentBindings[0] ?? null;
    const view: MembershipView = {
      tenantId: membership.tenantId,
      membershipId: membership.id,
      status: membership.status,
      role: roleBinding?.role ?? null,
      workspaceId: membership.workspaceId,
    };
    if (CURRENT_MEMBERSHIP_STATUSES.has(membership.status)) current.push(view);
    history.push({
      ...view,
      roleBindings: bindings.map((binding) => ({
        id: binding.id,
        role: binding.role,
        revokedAt: binding.revokedAt,
        reasonCode: binding.reasonCode,
      })),
    });
  }

  const actorBinding = roleBindings.filter((binding) => binding.id === session.roleBindingId
    && binding.membershipId === session.membershipId && binding.revokedAt === null);
  if (actorBinding.length !== 1 || actorBinding[0].role !== session.role) {
    throw new Error("Invalid tenant member snapshot.");
  }
  return validateDirectory(session, current, history);
}

function validRoleBindingTime(binding: RoleBinding, snapshotAt: number): boolean {
  const createdAt = Date.parse(binding.createdAt);
  const validFrom = Date.parse(binding.validFrom);
  const revokedAt = binding.revokedAt === null ? null : Date.parse(binding.revokedAt);
  return Number.isFinite(createdAt) && createdAt <= snapshotAt
    && Number.isFinite(validFrom) && createdAt <= validFrom && validFrom <= snapshotAt
    && (revokedAt === null || (Number.isFinite(revokedAt) && revokedAt >= validFrom && revokedAt <= snapshotAt));
}

function validateDirectory(
  session: TenantSession,
  memberships: readonly MembershipView[],
  history: readonly MembershipHistoryView[],
): MembershipDirectory {
  const currentById = new Map(memberships.map((membership) => [membership.membershipId, membership]));
  const historyById = new Map(history.map((membership) => [membership.membershipId, membership]));
  if (currentById.size !== memberships.length
    || historyById.size !== history.length
    || memberships.some((membership) => membership.tenantId !== session.tenantId)
    || history.some((membership) => membership.tenantId !== session.tenantId)
    || memberships.some((membership) => !CURRENT_MEMBERSHIP_STATUSES.has(membership.status))) {
    throw new Error("Invalid tenant member snapshot.");
  }

  for (const membership of memberships) {
    const historical = historyById.get(membership.membershipId);
    if (!historical || !sameMembershipFacts(membership, historical)) {
      throw new Error("Invalid tenant member snapshot.");
    }
  }
  for (const historical of history) {
    const current = currentById.get(historical.membershipId);
    const terminal = TERMINAL_MEMBERSHIP_STATUSES.has(historical.status);
    if ((terminal && current !== undefined)
      || (!terminal && (current === undefined || !sameMembershipFacts(current, historical)))) {
      throw new Error("Invalid tenant member snapshot.");
    }
  }

  const actors = memberships.filter((membership) => membership.membershipId === session.membershipId);
  if (actors.length !== 1 || actors[0].status !== "active" || actors[0].role !== session.role
    || actors[0].workspaceId !== null) {
    throw new Error("Invalid tenant member snapshot.");
  }
  return { memberships, history, actor: actors[0] };
}

function sameMembershipFacts(
  current: MembershipView,
  historical: MembershipHistoryView,
): boolean {
  return historical.tenantId === current.tenantId
    && historical.membershipId === current.membershipId
    && historical.status === current.status
    && historical.role === current.role
    && historical.workspaceId === current.workspaceId;
}
