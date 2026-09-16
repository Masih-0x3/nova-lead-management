/**
 * T-037 Postgres twin of the membership-administration backend
 * (local-membership-administration.ts). The canonical service stays the
 * source of business behavior — validation, hashing, journal semantics,
 * result shaping, and error codes — while this module supplies the
 * Postgres-backed repository, idempotency port, audit port, and transaction
 * coordinator.
 *
 * Every write goes through the SECURITY DEFINER functions in migration
 * 202609120010 under a member context installed by withTenantDbContext; the
 * functions re-validate the transaction-local member GUCs and bind tenant,
 * actor-membership, and actor-binding facts to the accepted context. Reads
 * (listMemberships / getMembership / findByIdentitySelectorHash /
 * getWorkspace) ride the owner/admin member-select policies on
 * memberships, role bindings, and workspaces exactly like the T-035 grant
 * reads — a workspace-scoped member sees only their accepted-context slice.
 *
 * The coordinator captures the transaction-start instant and exposes it as
 * the service clock: pg_catalog.transaction_timestamp() is exactly the
 * now() the memberships guard trigger stamps into updated_at, so the
 * canonical contract's `updatedAt === effectiveAt` equality holds at
 * millisecond precision without weakening the guard.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import { withTenantDbContext } from "@/lib/db";
import {
  createTenantMembershipAdministrationService,
  hashAuthIdentitySelector,
  MembershipAdministrationError,
  type ApplyMembershipMutationInput,
  type ApplyMembershipMutationResult,
  type MembershipAdministrationRepository,
  type MembershipAdministrationTransactionScope,
  type MembershipIdempotencyPort,
  type MembershipMutationJournalEntry,
  type MembershipRecord,
  type MembershipSnapshot,
  type RoleBindingRecord,
  type TenantMembershipAdministrationService,
  type WorkspaceRecord,
} from "@/lib/tenancy/memberships";
import type { LaunchRole, MembershipStatus } from "@/lib/tenancy/types";
import type { TenantPolicyEvaluator } from "@/lib/tenancy/authorize";

type Row = Record<string, unknown>;

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MEMBERSHIP_STATUSES = new Set([
  "pending", "active", "suspended", "disabled", "revoked", "removed", "expired",
]);
const LAUNCH_ROLES = new Set([
  "owner", "admin", "strategist_manager", "researcher", "reviewer",
  "outreach_operator", "analyst_read_only",
]);
const MEMBERSHIP_POLICY_ACTIONS = new Set([
  "membership.invite",
  "membership.assign_role",
  "membership.assign_workspace",
  "membership.disable",
  "membership.reactivate",
  "membership.revoke",
  "membership.remove",
  "membership.list.current",
  "membership.list.history",
]);

export interface PostgresMembershipAdministrationOptions {
  readonly clock?: () => Date;
  readonly policyEvaluator?: TenantPolicyEvaluator;
}

function malformed(): MembershipAdministrationError {
  return new MembershipAdministrationError("MALFORMED_REPOSITORY_RESULT");
}

function stateConflict(): MembershipAdministrationError {
  return new MembershipAdministrationError("STATE_CONFLICT");
}

function transactionFailed(): MembershipAdministrationError {
  return new MembershipAdministrationError("TRANSACTION_FAILED");
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw malformed();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredString(value);
}

function requiredTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw malformed();
    return value.toISOString();
  }
  if (typeof value === "string" && CANONICAL_TIMESTAMP.test(value)) return value;
  throw malformed();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredTimestamp(value);
}

function requiredRole(value: unknown): LaunchRole {
  const role = requiredString(value);
  if (!LAUNCH_ROLES.has(role)) throw malformed();
  return role as LaunchRole;
}

function requiredStatus(value: unknown): MembershipStatus {
  const status = requiredString(value);
  if (!MEMBERSHIP_STATUSES.has(status)) throw malformed();
  return status as MembershipStatus;
}

/** Validates a snapshot returned by the definer snapshot builder. */
function mapSnapshot(value: unknown): MembershipSnapshot {
  if (typeof value !== "object" || value === null) throw malformed();
  const raw = value as Row;
  const membership = raw.membership as Row | null;
  const bindings = raw.roleBindings;
  if (!membership || !Array.isArray(bindings)) throw malformed();
  const roleBindings = bindings.map((binding): RoleBindingRecord => {
    const row = binding as Row;
    return {
      id: requiredString(row.id),
      tenantId: requiredString(row.tenantId),
      membershipId: requiredString(row.membershipId),
      role: requiredRole(row.role),
      createdAt: requiredTimestamp(row.createdAt),
      validFrom: requiredTimestamp(row.validFrom),
      revokedAt: nullableTimestamp(row.revokedAt),
      assignedByMembershipId: nullableString(row.assignedByMembershipId),
      reasonCode: requiredString(row.reasonCode),
    };
  });
  const currentRaw = raw.currentRoleBinding;
  const current = currentRaw == null
    ? null
    : roleBindings.find((binding) => binding.id === requiredString((currentRaw as Row).id)) ?? null;
  if (currentRaw != null && current === null) throw malformed();
  const open = roleBindings.filter((binding) => binding.revokedAt === null);
  if (open.length > 1) throw malformed();
  if ((open[0] ?? null) !== current) throw malformed();
  const record: MembershipRecord = {
    id: requiredString(membership.id),
    tenantId: requiredString(membership.tenantId),
    authIdentityId: nullableString(membership.authIdentityId),
    pendingIdentityRefHash: nullableString(membership.pendingIdentityRefHash),
    workspaceId: nullableString(membership.workspaceId),
    status: requiredStatus(membership.status),
    invitedByMembershipId: nullableString(membership.invitedByMembershipId),
    createdAt: requiredTimestamp(membership.createdAt),
    updatedAt: requiredTimestamp(membership.updatedAt),
  };
  return { membership: record, roleBindings, currentRoleBinding: current };
}

function mapMembershipRow(row: Row): MembershipRecord {
  return {
    id: requiredString(row.id),
    tenantId: requiredString(row.tenant_id),
    authIdentityId: nullableString(row.auth_identity_id),
    pendingIdentityRefHash: nullableString(row.pending_identity_ref_hash),
    workspaceId: nullableString(row.workspace_id),
    status: requiredStatus(row.status),
    invitedByMembershipId: nullableString(row.invited_by_membership_id),
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  };
}

function mapBindingRow(row: Row): RoleBindingRecord {
  return {
    id: requiredString(row.id),
    tenantId: requiredString(row.tenant_id),
    membershipId: requiredString(row.membership_id),
    role: requiredRole(row.role),
    createdAt: requiredTimestamp(row.created_at),
    validFrom: requiredTimestamp(row.valid_from),
    revokedAt: nullableTimestamp(row.revoked_at),
    assignedByMembershipId: nullableString(row.assigned_by_membership_id),
    reasonCode: requiredString(row.reason_code),
  };
}

async function callRecord<T>(db: DbClient, name: string, payload: unknown): Promise<T | null> {
  const rows = await db
    .prepare(`SELECT record FROM public.${name}(?)`)
    .all<{ record: T | null }>(JSON.stringify(payload));
  if (rows.length === 0) return null;
  return rows[0].record;
}

async function callOutcome(db: DbClient, name: string, payload: unknown): Promise<string> {
  const rows = await db
    .prepare(`SELECT outcome FROM public.${name}(?)`)
    .all<{ outcome: string }>(JSON.stringify(payload));
  if (rows.length !== 1 || typeof rows[0].outcome !== "string") throw transactionFailed();
  return rows[0].outcome;
}

async function callApplied(db: DbClient, name: string, payload: unknown): Promise<boolean> {
  const rows = await db
    .prepare(`SELECT applied FROM public.${name}(?)`)
    .all<{ applied: boolean }>(JSON.stringify(payload));
  return rows.length === 1 && rows[0].applied === true;
}

function createRepository(db: DbClient): MembershipAdministrationRepository {
  const getSnapshot = async (tenantId: string, membershipId: string): Promise<MembershipSnapshot | null> => {
    const row = await db.prepare(
      `SELECT id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id,
              status, invited_by_membership_id, created_at, updated_at
       FROM public.tenant_memberships WHERE tenant_id = ? AND id = ?`,
    ).get<Row>(tenantId, membershipId);
    if (!row) return null;
    const roles = await db.prepare(
      `SELECT id, tenant_id, membership_id, role, created_at, valid_from, revoked_at,
              assigned_by_membership_id, reason_code
       FROM public.tenant_role_bindings
       WHERE tenant_id = ? AND membership_id = ?
       ORDER BY valid_from ASC, id ASC`,
    ).all<Row>(tenantId, membershipId);
    const roleBindings = roles.map(mapBindingRow);
    const open = roleBindings.filter((binding) => binding.revokedAt === null);
    if (open.length > 1) throw malformed();
    return { membership: mapMembershipRow(row), roleBindings, currentRoleBinding: open[0] ?? null };
  };

  return {
    async listMemberships(tenantId) {
      const rows = await db.prepare(
        `SELECT id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id,
                status, invited_by_membership_id, created_at, updated_at
         FROM public.tenant_memberships WHERE tenant_id = ? ORDER BY id ASC`,
      ).all<Row>(tenantId);
      const snapshots: MembershipSnapshot[] = [];
      for (const row of rows) {
        const value = await getSnapshot(tenantId, requiredString(row.id));
        if (!value) throw malformed();
        snapshots.push(value);
      }
      return snapshots;
    },
    getMembership: getSnapshot,
    async findByIdentitySelectorHash(tenantId, selectorHash) {
      const pending = await db.prepare(
        `SELECT id FROM public.tenant_memberships
         WHERE tenant_id = ? AND pending_identity_ref_hash = ?
           AND status NOT IN ('revoked', 'removed', 'expired')
         ORDER BY id ASC`,
      ).all<{ id: unknown }>(tenantId, selectorHash);
      const active = await db.prepare(
        `SELECT id, auth_identity_id FROM public.tenant_memberships
         WHERE tenant_id = ? AND auth_identity_id IS NOT NULL
           AND status NOT IN ('revoked', 'removed', 'expired')
         ORDER BY id ASC`,
      ).all<{ id: unknown; auth_identity_id: unknown }>(tenantId);
      const matches = [
        ...pending.map((row) => requiredString(row.id)),
        ...active
          .filter((row) => hashAuthIdentitySelector(row.auth_identity_id) === selectorHash)
          .map((row) => requiredString(row.id)),
      ];
      if (matches.length === 0) return null;
      if (matches.length !== 1) throw malformed();
      const value = await getSnapshot(tenantId, matches[0]);
      if (!value) throw malformed();
      return { snapshot: value, selectorHash };
    },
    async getWorkspace(tenantId, workspaceId) {
      const row = await db.prepare(
        "SELECT id, tenant_id, status FROM public.workspaces WHERE tenant_id = ? AND id = ?",
      ).get<Row>(tenantId, workspaceId);
      if (!row) return null;
      return {
        id: requiredString(row.id),
        tenantId: requiredString(row.tenant_id),
        status: requiredString(row.status),
      } as WorkspaceRecord;
    },
    async createPendingMembership(input) {
      const record = await callRecord<unknown>(db, "novatrade_membership_create_pending", {
        membershipId: input.membershipId,
        tenantId: input.tenantId,
        pendingIdentityRefHash: input.pendingIdentityRefHash,
        workspaceId: input.workspaceId,
        invitedByMembershipId: input.invitedByMembershipId,
        role: input.role,
        effectiveAt: input.effectiveAt,
      });
      if (record === null) throw transactionFailed();
      return mapSnapshot(record);
    },
    async applyMutation(tenantId, input: ApplyMembershipMutationInput): Promise<ApplyMembershipMutationResult> {
      const rows = await db.prepare(
        `SELECT outcome, target, replacement FROM public.novatrade_membership_apply_mutation(?)`,
      ).all<{ outcome: string; target: unknown; replacement: unknown }>(JSON.stringify({
        targetMembershipId: input.targetMembershipId,
        actorMembershipId: input.actorMembershipId,
        expectedStatus: input.expectedStatus,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.roleChange !== undefined ? { roleChange: input.roleChange } : {}),
        ...(input.replacementOwnerMembershipId !== undefined
          ? { replacementOwnerMembershipId: input.replacementOwnerMembershipId } : {}),
        expectedWorkspaceId: input.expectedWorkspaceId,
        expectedCurrentRoleBindingId: input.expectedCurrentRoleBindingId,
        expectedCurrentRole: input.expectedCurrentRole,
        effectiveAt: input.effectiveAt,
      }));
      if (rows.length !== 1 || typeof rows[0].outcome !== "string") throw transactionFailed();
      const { outcome, target, replacement } = rows[0];
      if (outcome === "state_conflict") throw stateConflict();
      if (outcome === "owner_guard") throw new MembershipAdministrationError("OWNER_GUARD");
      if (outcome !== "applied" || target == null) throw transactionFailed();
      return { target: mapSnapshot(target), replacement: replacement == null ? null : mapSnapshot(replacement) };
    },
  };
}

function createIdempotencyPort(db: DbClient): MembershipIdempotencyPort {
  return {
    async find(idempotencyKeyHash) {
      const record = await callRecord<Row>(db, "novatrade_membership_journal_find", {
        idempotencyKeyHash,
      });
      if (record === null) return null;
      const entry: MembershipMutationJournalEntry = {
        idempotencyKeyHash: requiredString(record.idempotencyKeyHash),
        inputHash: requiredString(record.inputHash),
        tenantId: requiredString(record.tenantId),
        actorMembershipId: requiredString(record.actorMembershipId),
        actorRoleBindingId: requiredString(record.actorRoleBindingId),
        operation: requiredString(record.operation) as MembershipMutationJournalEntry["operation"],
        targetMembershipId: nullableString(record.targetMembershipId),
        replacementMembershipId: nullableString(record.replacementMembershipId),
        result: record.result as MembershipMutationJournalEntry["result"],
      };
      return entry;
    },
    async reserve(input) {
      const outcome = await callOutcome(db, "novatrade_membership_journal_reserve", input);
      if (outcome === "reserved") return "reserved";
      if (outcome === "completed") return "completed";
      if (outcome === "in_progress") return "in_progress";
      if (outcome === "conflict") return "conflict";
      if (outcome === "policy_blocked") throw new MembershipAdministrationError("POLICY_BLOCKED");
      throw transactionFailed();
    },
    async complete(input) {
      const applied = await callApplied(db, "novatrade_membership_journal_complete", input);
      if (!applied) throw stateConflict();
    },
  };
}

/**
 * The policy surface mirrors the local backend: membership administration is
 * permitted under a live member context for the domain action names; the
 * member-select policies and the definer functions' GUC bindings provide the
 * tenant/actor authority boundary.
 */
const postgresPolicyEvaluator: TenantPolicyEvaluator = (context) => ({
  allowed: MEMBERSHIP_POLICY_ACTIONS.has(context.action),
  context,
});

function composePolicyEvaluator(injected?: TenantPolicyEvaluator): TenantPolicyEvaluator {
  return async (context) => {
    const local = await postgresPolicyEvaluator(context);
    if (!local.allowed || !injected) return local;
    const external = await injected(context);
    return { allowed: external.allowed === true, context };
  };
}

export function createPostgresTenantMembershipAdministrationService(
  options: PostgresMembershipAdministrationOptions = {},
): TenantMembershipAdministrationService {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new MembershipAdministrationError("TRANSACTION_REQUIRED");
  }
  const policyEvaluator = composePolicyEvaluator(options.policyEvaluator);
  // Captured per transaction so the service clock is exactly the instant the
  // memberships guard trigger stamps into updated_at (transaction_timestamp).
  // AsyncLocalStorage keeps concurrent transactions' instants isolated.
  const transactionClock = new AsyncLocalStorage<Date>();
  return createTenantMembershipAdministrationService({
    clock: () => transactionClock.getStore() ?? options.clock?.() ?? new Date(),
    idFactory: { next: () => randomUUID() },
    policyEvaluator,
    transactionCoordinator: {
      run: async <T>(callback: (scope: MembershipAdministrationTransactionScope) => Promise<T>): Promise<T> =>
        withTenantDbContext(async (db) => {
          const row = await db
            .prepare("SELECT pg_catalog.transaction_timestamp() AS now")
            .get<{ now: unknown }>();
          if (!(row?.now instanceof Date) || Number.isNaN(row.now.getTime())) {
            throw transactionFailed();
          }
          return transactionClock.run(row.now, () =>
            callback({
              repository: createRepository(db),
              idempotency: createIdempotencyPort(db),
              audit: {
                append: async (event) => {
                  const applied = await callApplied(db, "novatrade_membership_audit_append", event);
                  if (!applied) throw transactionFailed();
                },
              },
            }),
          );
        }),
    },
  });
}
