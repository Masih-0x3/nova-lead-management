/**
 * L-02 Postgres member-side support-access adapter — the fifth
 * DATABASE_URL-backed service-port binding after T-031..T-034.
 *
 * The support-operation tables are intentionally unreachable through member
 * RLS: support_access_journal and support_access_events are zero-policy
 * append-only ledgers, platform_support_principals is a zero-policy operator
 * registry, and support_access_grants carries member-select but
 * deny-all-else write policies. Every member-facing write therefore calls a
 * SECURITY DEFINER function from migration 202609120008 inside
 * withTenantDbContext; the functions re-validate the transaction-local
 * member GUCs database-side and bind tenant, actor, workspace, and
 * correlation facts to the accepted context.
 *
 * Reads stay on member RLS: getGrant / listGrants / verifyWorkspace /
 * verifyMemberAuthority query through the member-select policies on grants,
 * workspaces, memberships, and role bindings, which already expose exactly
 * the accepted-context slice to owner/admin sessions.
 *
 * Support-side authorization (check / authorizeAndRun) rides the
 * edge-asserted support-session envelope: the same transaction ports serve
 * it once migration 202609120015 widens the journal/event definers to the
 * structural support lane, and the grant/workspace reads switch to the
 * lane-bound definers while a support envelope is ambient.
 */
import { withTenantDbContext, type DbClient } from "@/lib/db";
import { getTenantPermissionDecision } from "@/lib/permissions";
import { getSupportAccessContext } from "@/lib/tenancy/support-access";
import { getSupportSession } from "@/lib/tenancy/support-session";
import type {
  ResolvedSupportPrincipal,
  SupportAccessEvent,
  SupportAccessPolicyEvaluator,
  SupportAccessRepository,
  SupportAccessReservation,
  SupportAccessResult,
  SupportAccessTransaction,
  SupportPrincipalResolver,
} from "@/lib/tenancy/support-access";
import {
  PLATFORM_SUPPORT_ROLE,
  type SupportAccessGrantDataClass,
  type SupportAccessGrantPermission,
} from "@/lib/tenancy/types";

type Row = Record<string, unknown>;

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requiredTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid timestamp returned by support access store.");
    return value.toISOString();
  }
  if (typeof value === "string" && CANONICAL_TIMESTAMP.test(value) && new Date(value).toISOString() === value) {
    return value;
  }
  throw new Error("Invalid timestamp returned by support access store.");
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredTimestamp(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid string returned by support access store.");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredString(value);
}

function mapGrantRow(row: Row, permissions: string[], dataClasses: string[]) {
  return {
    id: requiredString(row.id),
    tenantId: requiredString(row.tenant_id),
    workspaceId: nullableString(row.workspace_id),
    supportActorAuthIdentityId: requiredString(row.support_actor_auth_identity_id),
    platformRole: PLATFORM_SUPPORT_ROLE,
    requestedByAuthIdentityId: requiredString(row.requested_by_auth_identity_id),
    approvedByAuthIdentityId: nullableString(row.approved_by_auth_identity_id),
    approvedAt: nullableTimestamp(row.approved_at),
    revokedByAuthIdentityId: nullableString(row.revoked_by_auth_identity_id),
    revokedAt: nullableTimestamp(row.revoked_at),
    state: requiredString(row.state),
    reasonCode: requiredString(row.reason_code),
    reason: requiredString(row.reason),
    startsAt: requiredTimestamp(row.starts_at),
    expiresAt: requiredTimestamp(row.expires_at),
    correlationId: requiredString(row.correlation_id),
    auditEventId: requiredString(row.audit_event_id),
    permissions: permissions as SupportAccessGrantPermission[],
    dataClasses: dataClasses as SupportAccessGrantDataClass[],
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  };
}

async function mapGrant(db: DbClient, row: Row) {
  const grantId = requiredString(row.id);
  const permissionRows = await db
    .prepare("SELECT permission FROM support_access_grant_permissions WHERE grant_id = ? ORDER BY permission")
    .all<Row>(grantId);
  const dataClassRows = await db
    .prepare("SELECT data_class FROM support_access_grant_data_classes WHERE grant_id = ? ORDER BY data_class")
    .all<Row>(grantId);
  return mapGrantRow(
    row,
    permissionRows.map((entry) => requiredString(entry.permission)),
    dataClassRows.map((entry) => requiredString(entry.data_class)),
  );
}

interface ReserveOutcomeRow {
  readonly outcome: string;
  readonly reservation_id: string | null;
  readonly prior_input_hash: string | null;
  readonly prior_result: unknown;
}

/**
 * Support-lane reads cannot ride member RLS: under a support envelope the
 * member-select policies are dark. The check/authorizeAndRun path reads the
 * asserted grant and workspace existence through lane-bound definers; member
 * operations keep the member-RLS path. A lane is ambient when either the
 * edge-asserted session or the service-minted run context is installed.
 */
function isSupportLaneAmbient(): boolean {
  return getSupportSession() !== null || getSupportAccessContext() !== null;
}

function createPostgresSupportAccessTransaction(db: DbClient): SupportAccessTransaction {
  return {
    reserveIdempotency: async (input) => {
      const row = await db
        .prepare(
          `SELECT outcome, reservation_id, prior_input_hash, prior_result
           FROM public.novatrade_support_access_reserve(?)`,
        )
        .get<ReserveOutcomeRow>(JSON.stringify({
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          inputHash: input.inputHash,
        }));
      if (!row || typeof row.outcome !== "string") {
        throw new Error("support access reservation failed");
      }
      if (row.outcome === "new" && typeof row.reservation_id === "string" && SHA256.test(row.reservation_id)) {
        const reservation: SupportAccessReservation = { kind: "new", reservationId: row.reservation_id };
        return reservation;
      }
      if (
        row.outcome === "replay"
        && typeof row.prior_input_hash === "string"
        && SHA256.test(row.prior_input_hash)
        && row.prior_result !== null
        && row.prior_result !== undefined
      ) {
        const reservation: SupportAccessReservation = {
          kind: "replay",
          inputHash: row.prior_input_hash,
          result: row.prior_result,
        };
        return reservation;
      }
      if (row.outcome === "conflict") {
        const reservation: SupportAccessReservation = { kind: "conflict" };
        return reservation;
      }
      throw new Error("support access reservation refused");
    },

    commitIdempotency: async (input: { reservationId: string; result: SupportAccessResult }) => {
      const row = await db
        .prepare("SELECT committed FROM public.novatrade_support_access_commit(?)")
        .get<{ committed: boolean }>(JSON.stringify({
          reservationId: input.reservationId,
          result: input.result,
        }));
      return { committed: row?.committed === true };
    },

    appendEvent: async (event: SupportAccessEvent) => {
      const row = await db
        .prepare("SELECT recorded FROM public.novatrade_support_access_append_event(?)")
        .get<{ recorded: boolean }>(JSON.stringify({
          eventId: event.eventId,
          operation: event.operation,
          tenantId: event.tenantId,
          workspaceId: event.workspaceId,
          actorLayer: event.actorLayer,
          actorId: event.actorId,
          supportGrantId: event.supportGrantId,
          permission: event.permission,
          dataClasses: event.dataClasses,
          decisionCode: event.decisionCode,
          reasonCode: event.reasonCode,
          correlationId: event.correlationId,
          attemptId: event.attemptId,
          inputHash: event.inputHash,
        }));
      if (row?.recorded !== true) throw new Error("support access event was not recorded");
      return { recorded: true };
    },

    createGrant: async (creation) => {
      const row = await db
        .prepare("SELECT grant_json AS grant FROM public.novatrade_support_access_create_grant(?)")
        .get<{ grant: unknown }>(JSON.stringify({
          id: creation.id,
          tenantId: creation.tenantId,
          workspaceId: creation.workspaceId,
          supportActorAuthIdentityId: creation.supportActorAuthIdentityId,
          platformRole: creation.platformRole,
          requestedByAuthIdentityId: creation.requestedByAuthIdentityId,
          reasonCode: creation.reasonCode,
          reason: creation.reason,
          startsAt: creation.startsAt,
          expiresAt: creation.expiresAt,
          correlationId: creation.correlationId,
          auditEventId: creation.auditEventId,
          permissions: creation.permissions,
          dataClasses: creation.dataClasses,
          createdAt: creation.createdAt,
          updatedAt: creation.updatedAt,
        }));
      return row?.grant ?? null;
    },

    approveGrant: async (input) => {
      const row = await db
        .prepare("SELECT grant_json AS grant FROM public.novatrade_support_access_approve_grant(?)")
        .get<{ grant: unknown }>(JSON.stringify({ grantId: input.grantId, at: input.approvedAt }));
      return row?.grant ?? null;
    },

    revokeGrant: async (input) => {
      const row = await db
        .prepare("SELECT grant_json AS grant FROM public.novatrade_support_access_revoke_grant(?)")
        .get<{ grant: unknown }>(JSON.stringify({ grantId: input.grantId, at: input.revokedAt }));
      return row?.grant ?? null;
    },

    getGrant: async (input) => {
      if (isSupportLaneAmbient()) {
        // The lane-bound read returns the envelope's own asserted grant as the
        // canonical bundle; a foreign or absent grant reads back NULL.
        const row = await db
          .prepare("SELECT public.novatrade_support_access_grant_read() AS grant")
          .get<{ grant: unknown }>();
        return row?.grant ?? null;
      }
      const row = await db
        .prepare("SELECT * FROM support_access_grants WHERE tenant_id = ? AND id = ?")
        .get<Row>(input.tenantId, input.grantId);
      return row ? mapGrant(db, row) : null;
    },

    listGrants: async (input) => {
      const rows = input.workspaceId === null
        ? await db
            .prepare("SELECT * FROM support_access_grants WHERE tenant_id = ? ORDER BY created_at, id")
            .all<Row>(input.tenantId)
        : await db
            .prepare(
              "SELECT * FROM support_access_grants WHERE tenant_id = ? AND workspace_id = ? ORDER BY created_at, id",
            )
            .all<Row>(input.tenantId, input.workspaceId);
      const grants = [];
      for (const row of rows) grants.push(await mapGrant(db, row));
      return grants;
    },

    verifyWorkspace: async (input) => {
      if (isSupportLaneAmbient()) {
        const row = await db
          .prepare("SELECT public.novatrade_support_access_workspace_exists(?::uuid) AS present")
          .get<{ present: boolean }>(input.workspaceId);
        return { tenantId: input.tenantId, workspaceId: input.workspaceId, exists: row?.present === true };
      }
      const row = await db
        .prepare("SELECT 1 AS present FROM workspaces WHERE tenant_id = ? AND id = ?")
        .get<Row>(input.tenantId, input.workspaceId);
      return { tenantId: input.tenantId, workspaceId: input.workspaceId, exists: Boolean(row) };
    },

    verifyMemberAuthority: async (input) => {
      const row = await db
        .prepare(
          `SELECT membership.status AS status, membership.workspace_id AS workspace_id,
                  binding.role AS role, binding.revoked_at AS revoked_at, binding.valid_from AS valid_from
           FROM tenant_memberships AS membership
           JOIN tenant_role_bindings AS binding
             ON binding.tenant_id = membership.tenant_id
             AND binding.membership_id = membership.id
           WHERE membership.tenant_id = ? AND membership.id = ?
             AND membership.auth_identity_id = ? AND binding.id = ?`,
        )
        .get<Row>(input.tenantId, input.membershipId, input.actorAuthIdentityId, input.roleBindingId);
      const allowed =
        Boolean(row)
        && row!.status === "active"
        && (row!.workspace_id ?? null) === input.workspaceId
        && row!.role === input.role
        && row!.revoked_at === null
        && requiredTimestamp(row!.valid_from) <= new Date().toISOString()
        && getTenantPermissionDecision(input.role, input.permission).decision === "C";
      return { ...input, allowed };
    },
  };
}

/**
 * Postgres repository twin: every transaction method runs inside the same
 * withTenantDbContext transaction, so the journal reservation, grant
 * mutation, decision event, and idempotency commit share one commit
 * boundary exactly like the local SQLite backend.
 */
export function createPostgresSupportAccessRepository(): SupportAccessRepository {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("The Postgres support access store requires DATABASE_URL.");
  }
  return {
    withTransaction: async <T>(callback: (tx: SupportAccessTransaction) => Promise<T>): Promise<T> =>
      withTenantDbContext((db) => callback(createPostgresSupportAccessTransaction(db))),
  };
}

/**
 * Postgres principal resolver. `resolve` maps an opaque member-supplied
 * reference through the zero-policy registry under member context;
 * `resolveCurrent` resolves the installed support context's actor for the
 * support-authorization lane and returns null without one.
 */
export function createPostgresSupportPrincipalResolver(): SupportPrincipalResolver {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("The Postgres support principal resolver requires DATABASE_URL.");
  }
  return {
    resolve: async (reference: unknown): Promise<ResolvedSupportPrincipal | null> => {
      if (typeof reference !== "string" || reference.length === 0) return null;
      try {
        const row = await withTenantDbContext((db) =>
          db
            .prepare(
              "SELECT auth_identity_id, platform_role FROM public.novatrade_support_principal_resolve(?)",
            )
            .get<{ auth_identity_id: string; platform_role: string }>(reference));
        if (!row || typeof row.auth_identity_id !== "string" || row.platform_role !== PLATFORM_SUPPORT_ROLE) {
          return null;
        }
        return { authIdentityId: row.auth_identity_id, platformRole: PLATFORM_SUPPORT_ROLE };
      } catch {
        return null;
      }
    },
    resolveCurrent: async (): Promise<ResolvedSupportPrincipal | null> => {
      try {
        const row = await withTenantDbContext((db) =>
          db
            .prepare(
              "SELECT auth_identity_id, platform_role FROM public.novatrade_support_principal_current()",
            )
            .get<{ auth_identity_id: string; platform_role: string }>());
        if (!row || typeof row.auth_identity_id !== "string" || row.platform_role !== PLATFORM_SUPPORT_ROLE) {
          return null;
        }
        return { authIdentityId: row.auth_identity_id, platformRole: PLATFORM_SUPPORT_ROLE };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Postgres policy evaluator: member-initiated support operations are
 * permitted while the tenant is live or read-accessible (active, suspended,
 * archived). Under a valid member context the tenant is always active —
-- the read rides member RLS and stays fail-closed for anything else.
 */
export function createPostgresSupportAccessPolicyEvaluator(): SupportAccessPolicyEvaluator {
  return {
    evaluate: async (input) => {
      const allowed = await withTenantDbContext(async (db) => {
        const row = await db
          .prepare("SELECT status FROM tenants WHERE id = ?")
          .get<Row>(input.tenantId);
        const status = typeof row?.status === "string" ? row.status : null;
        return status === "active" || status === "suspended" || status === "archived";
      });
      return { ...input, allowed };
    },
  };
}
