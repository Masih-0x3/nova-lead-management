import { createHash, randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import {
  createTenantLifecycleOperationsService,
  TenantLifecycleOpsError,
  type TenantDeletionStorePort,
  type TenantExportRunnerPort,
  type TenantLifecycleOpsAuditEvent,
  type TenantLifecycleOpsIdFactory,
  type TenantLifecycleOperationsService,
  type TenantLifecycleOpsTransactionScope,
} from "@/lib/tenancy/lifecycle-operations";
import { TENANT_LIMIT_ACTIONS, type TenantLimitService } from "@/lib/tenancy/limits";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";

export interface LocalTenantLifecycleOperationsOptions {
  readonly exportRunner?: TenantExportRunnerPort;
  readonly deletionStore?: TenantDeletionStorePort;
  /** Optional tenant-limit service enforcing export_request/deletion_request quotas. */
  readonly limits?: Pick<TenantLimitService, "consume">;
  readonly idFactory?: TenantLifecycleOpsIdFactory;
  readonly clock?: () => Date;
}

/**
 * Local export runner: serializes the tenant-owned operational rows into a
 * canonical JSON artifact, redacts capability hashes, and returns the
 * committed artifact facts. The artifact bytes are not persisted locally —
 * the job row's ref + checksum commit to them and a real storage adapter
 * binds the same port in production.
 */
export function createLocalExportRunner(db: DbClient): TenantExportRunnerPort {
  return {
    async execute({ job, tenantId, format, artifactExpiresAt }) {
      if (format !== "json") throw new TenantLifecycleOpsError("BLOCKED_MALFORMED");
      const snapshotAt = new Date().toISOString();
      const payload = await snapshotTenantData(db, tenantId);
      const redacted = redactSnapshot(payload);
      const bytes = JSON.stringify(redacted.rows);
      return {
        snapshotAt,
        artifactStorageRef: `tenants/${tenantId}/exports/${job.id}/export.json`,
        checksumSha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
        includedCount: redacted.includedCount,
        excludedCount: redacted.excludedCount,
        redactedCount: redacted.redactedCount,
        artifactCreatedAt: new Date().toISOString(),
        expiresAt: artifactExpiresAt,
      };
    },
    // Artifact bytes were never persisted locally — the committed ref +
    // checksum on the job row are the accountability record, so the sweep's
    // delete transition has no bytes to remove.
    async purge() {},
  };
}

async function snapshotTenantData(db: DbClient, tenantId: string) {
  const read = async (sql: string, ...params: unknown[]) =>
    db.prepare(sql).all<Record<string, unknown>>(...params);
  return [
    { table: "tenants", rows: await read("SELECT id, slug, name, status, locale, timezone, created_at, updated_at FROM tenants WHERE id = ?", tenantId) },
    { table: "workspaces", rows: await read("SELECT id, tenant_id, slug, name, status, created_at, updated_at FROM workspaces WHERE tenant_id = ?", tenantId) },
    { table: "tenant_policies", rows: await read("SELECT * FROM tenant_policies WHERE tenant_id = ?", tenantId) },
    { table: "tenant_memberships", rows: await read("SELECT * FROM tenant_memberships WHERE tenant_id = ?", tenantId) },
    { table: "tenant_role_bindings", rows: await read("SELECT * FROM tenant_role_bindings WHERE tenant_id = ?", tenantId) },
  ];
}

const REDACTED_COLUMNS = new Set(["pending_identity_ref_hash", "auth_identity_id"]);

function redactSnapshot(payload: { table: string; rows: Record<string, unknown>[] }[]) {
  let includedCount = 0;
  let redactedCount = 0;
  const rows = payload.map(({ table, rows: tableRows }) => ({
    table,
    rows: tableRows.map((row) => {
      includedCount += 1;
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (REDACTED_COLUMNS.has(key)) {
          next[key] = null;
          redactedCount += 1;
        } else {
          next[key] = value;
        }
      }
      return next;
    }),
  }));
  return { rows, includedCount, excludedCount: 0, redactedCount };
}

/**
 * Mutable tenant-owned operational residue purged by
 * `primary_database_negative_verification`: per-tenant quota configuration.
 * The schema's append-only ledgers (invitations, the
 * invitation/provisioning/membership journals, limit idempotency and events,
 * export/deletion ledgers, and audit logs) plus the tenant row, memberships,
 * role bindings, policies, workspaces, and the support-access grant ledger
 * are the accountability record and survive deletion.
 *
 * Support grants in particular cannot be row-deleted: their permission and
 * data-class anchor rows are append-only and RESTRICT-reference the grant.
 * Access is ended the designed way instead — the executor force-revokes any
 * surviving `approved` grant (the one legal terminal transition), attributed
 * to the deletion approver, so no in-window grant authorizes after deletion.
 * `pending` grants cannot be revoked (the state machine forbids it) and
 * cannot authorize anything; on a deleted tenant they can never reach
 * `approved` because member decisions fail the lifecycle policy gate.
 */
const TENANT_OWNED_PURGE_ORDER = [
  { table: "tenant_limit_configuration", key: "action" },
] as const;

/** `tenant_limit_buckets` key derivation, mirrored from `limits.ts`. */
function limitBucketKey(scope: "tenant" | "actor", action: string, tenantId: string, actorId?: string): string {
  const material = actorId === undefined
    ? `${action}\u0000${tenantId}`
    : `${action}\u0000${tenantId}\u0000${actorId}`;
  return `${scope}:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

async function localTableExists(db: DbClient, table: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get<{ name: string }>(table);
  return row?.name === table;
}

/**
 * Local deletion executor: purges tenant-owned operational residue for the
 * primary-database and cache checkpoints, then verifies the purged tables are
 * empty. A store that was never initialized locally (e.g. the lazy limit DDL)
 * is definitionally empty and verifies absent. Provider-side classes complete
 * with empty receipts — there are no external copies, embeddings, queues, or
 * quarantines locally.
 */
export function createLocalDeletionStore(): TenantDeletionStorePort {
  return {
    async execute({ job, checkpoint, db }) {
      let expected = 0;
      if (checkpoint.storeClass === "cache_idempotency"
        && await localTableExists(db, "tenant_limit_buckets")
        && await localTableExists(db, "tenant_memberships")) {
        // Local quota buckets are the tenant's cache/idempotency store. Their
        // hashed keys are recomputed per action (and per member actor for the
        // actor-scope buckets) because no tenant_id column exists; the
        // append-only idempotency ledger survives as accountability.
        const members = await db.prepare(
          "SELECT auth_identity_id AS actor_id FROM tenant_memberships WHERE tenant_id = ? AND auth_identity_id IS NOT NULL",
        ).all<{ actor_id: string }>(job.tenantId);
        const keys = TENANT_LIMIT_ACTIONS.flatMap((action) => [
          limitBucketKey("tenant", action, job.tenantId),
          ...members.map(({ actor_id }) => limitBucketKey("actor", action, job.tenantId, actor_id)),
        ]);
        for (const key of keys) {
          const removed = await db.prepare("DELETE FROM tenant_limit_buckets WHERE bucket_key = ?").run(key);
          expected += removed.changes;
        }
      }
      if (checkpoint.storeClass === "primary_database_negative_verification") {
        // Revocation is the designed kill switch for support access — grant
        // rows stay as accountability, but an approved in-window grant would
        // otherwise still pass check/authorizeAndRun on a deleted tenant.
        if (await localTableExists(db, "support_access_grants")) {
          const revokedAt = job.startedAt ?? job.approvedAt ?? new Date().toISOString();
          const revoker = job.approvedByAuthIdentityId ?? job.requestedByAuthIdentityId;
          await db.prepare(
            `UPDATE support_access_grants
             SET state = 'revoked', revoked_by_auth_identity_id = ?, revoked_at = ?
             WHERE tenant_id = ? AND state = 'approved'`,
          ).run(revoker, revokedAt, job.tenantId);
          const live = await db.prepare(
            "SELECT COUNT(*) AS count FROM support_access_grants WHERE tenant_id = ? AND state = 'approved' AND revoked_at IS NULL",
          ).get<{ count: number }>(job.tenantId);
          if (!live || live.count !== 0) throw new TenantLifecycleOpsError("FAILED_INTERNAL");
        }
        for (const { table, key } of TENANT_OWNED_PURGE_ORDER) {
          if (!await localTableExists(db, table)) continue;
          const rows = await db.prepare(`SELECT ${key} AS row_key FROM ${table} WHERE tenant_id = ?`)
            .all<{ row_key: string }>(job.tenantId);
          expected += rows.length;
          for (const { row_key: rowKey } of rows) {
            await db.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND ${key} = ?`).run(job.tenantId, rowKey);
          }
          const remaining = await db.prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`,
          ).get<{ count: number }>(job.tenantId);
          if (!remaining || remaining.count !== 0) throw new TenantLifecycleOpsError("FAILED_INTERNAL");
        }
      }
      return {
        receiptHash: createHash("sha256").update(
          `novatrade:tenant-deletion-receipt:v1:${JSON.stringify({
            jobId: job.id, store: checkpoint.storeClass, expected, observed: 0,
          })}`,
        ).digest("hex"),
        observedCount: 0,
        expectedCount: expected,
      };
    },
  };
}

export function createLocalTenantLifecycleOperationsService(
  db: DbClient,
  options: LocalTenantLifecycleOperationsOptions = {},
): TenantLifecycleOperationsService {
  if (!db || typeof db.withTransaction !== "function") {
    throw new TenantLifecycleOpsError("FAILED_INTERNAL");
  }
  return createTenantLifecycleOperationsService({
    exportRunner: options.exportRunner ?? createLocalExportRunner(db),
    deletionStore: options.deletionStore ?? createLocalDeletionStore(),
    limits: options.limits,
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    clock: options.clock,
    transactionRunner: {
      run: async <T>(callback: (scope: TenantLifecycleOpsTransactionScope) => Promise<T>): Promise<T> =>
        db.withTransaction!(async () =>
          callback({
            db,
            repository: createTenantQueryRepository(db),
            auditWriter: { append: (event) => appendLifecycleAudit(db, event) },
          })),
    },
  });
}

async function appendLifecycleAudit(db: DbClient, event: TenantLifecycleOpsAuditEvent): Promise<void> {
  const isMemberScope = event.actorLayer === "member";
  const result = await db.prepare(
    `INSERT INTO audit_logs
      (id, action, entity_type, entity_id, metadata, scope_kind, tenant_id, workspace_id,
       correlation_id, actor_auth_identity_id, actor_membership_id, actor_launch_role,
       actor_role_binding_id, actor_layer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId,
    event.eventType,
    event.jobId ? "tenant_lifecycle_job" : "tenant",
    event.jobId ?? event.tenantId,
    JSON.stringify(event),
    isMemberScope ? "tenant" : "platform",
    isMemberScope ? event.tenantId : null,
    isMemberScope ? event.workspaceId : null,
    event.correlationId,
    event.actorIdentityId,
    isMemberScope ? event.actorMembershipId : null,
    isMemberScope ? event.actorRole : null,
    isMemberScope ? event.actorRoleBindingId : null,
    event.actorLayer,
  );
  if (result.changes !== 1) throw new TenantLifecycleOpsError("FAILED_INTERNAL");
}
