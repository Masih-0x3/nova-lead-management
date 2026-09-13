import { createHash } from "node:crypto";

import type { DbClient } from "@/lib/db";
import { getTenantPermissionDecision } from "@/lib/permissions";
import { SUPPORT_ACCESS_LOCAL_DDL } from "@/lib/tenancy/support-access-schema";
import type {
  ResolvedSupportPrincipal,
  SupportAccessPolicyEvaluator,
  SupportAccessRepository,
  SupportAccessTransaction,
  SupportPrincipalResolver,
} from "@/lib/tenancy/support-access";
import {
  PLATFORM_SUPPORT_ROLE,
  type SupportAccessGrant,
  type SupportAccessGrantDataClass,
  type SupportAccessGrantPermission,
} from "@/lib/tenancy/types";

type Row = Record<string, unknown>;

/** Applies the support-access journal/event/principal tables to a local SQLite database. */
export async function ensureLocalSupportAccessSchema(db: DbClient): Promise<void> {
  await db.exec(SUPPORT_ACCESS_LOCAL_DDL);
}

/**
 * Local principal resolver. `resolve` maps an opaque member-supplied reference
 * to an active platform-support principal; `resolveCurrent` maps the locally
 * "authenticated" support reference provided by the host. Production binds a
 * resolver backed by the platform session instead.
 */
export function createLocalSupportPrincipalResolver(
  db: DbClient,
  options: { readonly currentReference?: () => string | null } = {},
): SupportPrincipalResolver {
  const resolve = async (reference: unknown): Promise<ResolvedSupportPrincipal | null> => {
    if (typeof reference !== "string" || reference.length === 0) return null;
    const row = await db
      .prepare(
        "SELECT auth_identity_id FROM platform_support_principals WHERE reference = ? AND status = 'active'",
      )
      .get<Row>(reference);
    if (!row || typeof row.auth_identity_id !== "string") return null;
    return { authIdentityId: row.auth_identity_id, platformRole: PLATFORM_SUPPORT_ROLE };
  };
  return {
    resolve,
    resolveCurrent: async () => {
      const reference = options.currentReference ? options.currentReference() : null;
      return reference === null ? null : resolve(reference);
    },
  };
}

/**
 * Local policy evaluator: member-initiated support operations are permitted
 * while the tenant is live or read-accessible (active, suspended, archived).
 * Provisioning tenants have no settled membership and deletion-bound tenants
 * must not acquire new support elevation.
 */
export function createLocalSupportAccessPolicyEvaluator(db: DbClient): SupportAccessPolicyEvaluator {
  return {
    evaluate: async (input) => {
      const row = await db
        .prepare("SELECT status FROM tenants WHERE id = ?")
        .get<Row>(input.tenantId);
      const status = typeof row?.status === "string" ? row.status : null;
      const allowed =
        status !== null && (status === "active" || status === "suspended" || status === "archived");
      return { ...input, allowed };
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function journalKeyHash(input: {
  tenantId: string | null;
  actorNamespace: string;
  operation: string;
  idempotencyKey: string;
}): string {
  return createHash("sha256")
    .update(
      `support-access${input.tenantId ?? ""}${input.actorNamespace}${input.operation}${input.idempotencyKey}`,
      "utf8",
    )
    .digest("hex");
}

async function readGrant(db: DbClient, tenantId: string, grantId: string): Promise<SupportAccessGrant | null> {
  const row = await db
    .prepare("SELECT * FROM support_access_grants WHERE tenant_id = ? AND id = ?")
    .get<Row>(tenantId, grantId);
  if (!row) return null;
  return mapGrant(db, row);
}

async function mapGrant(db: DbClient, row: Row): Promise<SupportAccessGrant> {
  const grantId = String(row.id);
  const permissionRows = await db
    .prepare("SELECT permission FROM support_access_grant_permissions WHERE grant_id = ? ORDER BY permission")
    .all<Row>(grantId);
  const dataClassRows = await db
    .prepare("SELECT data_class FROM support_access_grant_data_classes WHERE grant_id = ? ORDER BY data_class")
    .all<Row>(grantId);
  return {
    id: grantId,
    tenantId: String(row.tenant_id),
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
    supportActorAuthIdentityId: String(row.support_actor_auth_identity_id),
    platformRole: PLATFORM_SUPPORT_ROLE,
    requestedByAuthIdentityId: String(row.requested_by_auth_identity_id),
    approvedByAuthIdentityId:
      typeof row.approved_by_auth_identity_id === "string" ? row.approved_by_auth_identity_id : null,
    approvedAt: typeof row.approved_at === "string" ? row.approved_at : null,
    revokedByAuthIdentityId:
      typeof row.revoked_by_auth_identity_id === "string" ? row.revoked_by_auth_identity_id : null,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
    state: row.state as SupportAccessGrant["state"],
    reasonCode: String(row.reason_code),
    reason: String(row.reason),
    startsAt: String(row.starts_at),
    expiresAt: String(row.expires_at),
    correlationId: String(row.correlation_id),
    auditEventId: String(row.audit_event_id),
    permissions: permissionRows.map((entry) => String(entry.permission)) as SupportAccessGrantPermission[],
    dataClasses: dataClassRows.map((entry) => String(entry.data_class)) as SupportAccessGrantDataClass[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function createSqliteSupportAccessTransaction(db: DbClient): SupportAccessTransaction {
  return {
    reserveIdempotency: async (input) => {
      const keyHash = journalKeyHash(input);
      const existing = await db
        .prepare(
          "SELECT input_hash, status, result_json FROM support_access_journal WHERE idempotency_key_hash = ?",
        )
        .get<Row>(keyHash);
      if (!existing) {
        await db
          .prepare(
            `INSERT INTO support_access_journal (idempotency_key_hash, input_hash, operation, tenant_id, actor_namespace)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(keyHash, input.inputHash, input.operation, input.tenantId, input.actorNamespace);
        return { kind: "new", reservationId: keyHash };
      }
      if (existing.input_hash !== input.inputHash) return { kind: "conflict" };
      if (existing.status === "completed" && typeof existing.result_json === "string") {
        return {
          kind: "replay",
          inputHash: String(existing.input_hash),
          result: JSON.parse(existing.result_json),
        };
      }
      return { kind: "conflict" };
    },

    commitIdempotency: async (input) => {
      const result = await db
        .prepare(
          `UPDATE support_access_journal
           SET status = 'completed', result_json = ?, completed_at = ?
           WHERE idempotency_key_hash = ? AND status = 'reserved'`,
        )
        .run(JSON.stringify(input.result), nowIso(), input.reservationId);
      return { committed: result.changes === 1 };
    },

    appendEvent: async (event) => {
      const result = await db
        .prepare(
          `INSERT INTO support_access_events
            (event_id, operation, tenant_id, workspace_id, actor_layer, actor_id, support_grant_id,
             permission, data_classes_json, decision_code, reason_code, correlation_id, attempt_id, input_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.operation,
          event.tenantId,
          event.workspaceId,
          event.actorLayer,
          event.actorId,
          event.supportGrantId,
          event.permission,
          JSON.stringify(event.dataClasses),
          event.decisionCode,
          event.reasonCode,
          event.correlationId,
          event.attemptId,
          event.inputHash,
        );
      if (result.changes !== 1) throw new Error("support access event was not recorded");
      return { recorded: true };
    },

    createGrant: async (creation) => {
      // The grant row is inserted first so the child-scope guard triggers see a
      // pending parent; the deferred anchor foreign keys validate at commit.
      await db
        .prepare(
          `INSERT INTO support_access_grants
            (id, tenant_id, workspace_id, support_actor_auth_identity_id, platform_role,
             requested_by_auth_identity_id, state, reason_code, reason, starts_at, expires_at,
             correlation_id, audit_event_id, permission_anchor, data_class_anchor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          creation.id,
          creation.tenantId,
          creation.workspaceId,
          creation.supportActorAuthIdentityId,
          creation.platformRole,
          creation.requestedByAuthIdentityId,
          creation.reasonCode,
          creation.reason,
          creation.startsAt,
          creation.expiresAt,
          creation.correlationId,
          creation.auditEventId,
          creation.permissions[0],
          creation.dataClasses[0],
          creation.createdAt,
          creation.updatedAt,
        );
      for (const permission of creation.permissions) {
        await db
          .prepare("INSERT INTO support_access_grant_permissions (grant_id, permission) VALUES (?, ?)")
          .run(creation.id, permission);
      }
      for (const dataClass of creation.dataClasses) {
        await db
          .prepare("INSERT INTO support_access_grant_data_classes (grant_id, data_class) VALUES (?, ?)")
          .run(creation.id, dataClass);
      }
      const stored = await readGrant(db, creation.tenantId, creation.id);
      if (!stored) throw new Error("support access grant was not persisted");
      return stored;
    },

    approveGrant: async (input) => {
      const result = await db
        .prepare(
          `UPDATE support_access_grants
           SET state = 'approved', approved_by_auth_identity_id = ?, approved_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(input.approverAuthIdentityId, input.approvedAt, input.approvedAt, input.grantId);
      if (result.changes !== 1) return null;
      const row = await db
        .prepare("SELECT * FROM support_access_grants WHERE id = ?")
        .get<Row>(input.grantId);
      return row ? mapGrant(db, row) : null;
    },

    revokeGrant: async (input) => {
      const result = await db
        .prepare(
          `UPDATE support_access_grants
           SET state = 'revoked', revoked_by_auth_identity_id = ?, revoked_at = ?, updated_at = ?
           WHERE id = ? AND state = 'approved'`,
        )
        .run(input.revokerAuthIdentityId, input.revokedAt, input.revokedAt, input.grantId);
      if (result.changes !== 1) return null;
      const row = await db
        .prepare("SELECT * FROM support_access_grants WHERE id = ?")
        .get<Row>(input.grantId);
      return row ? mapGrant(db, row) : null;
    },

    getGrant: async (input) => readGrant(db, input.tenantId, input.grantId),

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
      const grants: SupportAccessGrant[] = [];
      for (const row of rows) grants.push(await mapGrant(db, row));
      return grants;
    },

    verifyWorkspace: async (input) => {
      const row = await db
        .prepare("SELECT 1 AS present FROM workspaces WHERE tenant_id = ? AND id = ?")
        .get<Row>(input.tenantId, input.workspaceId);
      return { tenantId: input.tenantId, workspaceId: input.workspaceId, exists: !!row };
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
        !!row &&
        row.status === "active" &&
        row.workspace_id === input.workspaceId &&
        row.role === input.role &&
        row.revoked_at === null &&
        typeof row.valid_from === "string" &&
        row.valid_from <= nowIso() &&
        getTenantPermissionDecision(input.role, input.permission).decision === "C";
      return { ...input, allowed };
    },
  };
}

/**
 * Durable SQLite repository for the support-access service. Every operation
 * runs inside a single transaction so the idempotency reservation, grant
 * mutation, and decision event commit or roll back together.
 */
export function createLocalSupportAccessRepository(db: DbClient): SupportAccessRepository {
  if (!db || typeof db.withTransaction !== "function") {
    throw new Error("The support access store is unavailable.");
  }
  const transaction = createSqliteSupportAccessTransaction(db);
  return {
    withTransaction: async <T>(callback: (tx: SupportAccessTransaction) => Promise<T>): Promise<T> =>
      db.withTransaction!(async () => callback(transaction)),
  };
}
