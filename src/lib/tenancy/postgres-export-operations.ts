import { createHash, randomUUID } from "node:crypto";

import type { DbClient, DbRunResult, DbStatement } from "@/lib/db";
import { getDb, withTenantDbContext } from "@/lib/db";
import {
  createTenantLifecycleOperationsService,
  TenantLifecycleOpsError,
  type TenantDeletionStorePort,
  type TenantExportRunnerPort,
  type TenantLifecycleOperationsService,
  type TenantLifecycleOpsAuditEvent,
  type TenantLifecycleOpsIdFactory,
  type TenantLifecycleOpsTransactionScope,
} from "@/lib/tenancy/lifecycle-operations";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import type { TenantLimitService } from "@/lib/tenancy/limits";

/**
 * L-02 T-038: Postgres twin of createLocalTenantLifecycleOperationsService
 * for the export surface (request/run/cancel/requeue/sweep). The canonical
 * service mutates tenant_export_jobs through scope.db.prepare(...).run(...)
 * with fixed SQL literals, so the transaction scope exposes a DbClient shim:
 * the nine known write statements are routed to the SECURITY DEFINER
 * functions in migration 202609120011 (which bind every fact to the member
 * GUCs and drive the guard trigger's legal edges), while every read —
-- including the idempotency replay lookup, the sweep candidate list, and
 * the support-grant checks — passes through to the transaction-bound client
 * and rides member RLS. Unmatched writes delegate verbatim, where deny-all
 * RLS keeps them honest.
 *
 * Context lane: every shipped caller runs under a member ambient context —
-- the action layer drives runExport inline with a system-layer executor
 * inside the member's transaction context — so the functions require the
 * member lane plus a tenant-wide owner/admin role. Support-grant requesters
 * fail closed through the member-RLS grant read until the support-context
 * ops lane lands.
 */

const EXPORT_REQUEST_FN = "novatrade_export_request";
const EXPORT_TRANSITION_FN = "novatrade_export_transition";
const EXPORT_AUDIT_FN = "novatrade_export_audit_append";

/** Canonical service literal — tenant-scoped job read routed to the
 * actor-context-gated definer so recorded jobs stay visible on suspended and
 * archived tenants where member RLS cannot see them. */
const GET_EXPORT_JOB_SQL = "SELECT * FROM tenant_export_jobs WHERE tenant_id = ? AND id = ?";

const INSERT_EXPORT_JOB_SQL = `INSERT INTO tenant_export_jobs
  (id, tenant_id, workspace_id, operation, requester_auth_identity_id, requester_membership_id,
   support_access_grant_id, status, scope_hash, input_hash, idempotency_key_hash,
   policy_version, manifest_version, schema_version, requested_format, correlation_id, audit_event_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const TRANSITION_EDGES = new Map<string, string>([
  ["UPDATE tenant_export_jobs SET status = 'snapshotting', next_retry_at = NULL WHERE tenant_id = ? AND id = ? AND status = ?", "enter"],
  ["UPDATE tenant_export_jobs SET status = 'failed', error_code = ?, error_message = ? WHERE tenant_id = ? AND id = ? AND status = 'snapshotting'", "fail"],
  ["UPDATE tenant_export_jobs SET status = 'redacting', snapshot_at = ? WHERE tenant_id = ? AND id = ? AND status = 'snapshotting'", "redact"],
  ["UPDATE tenant_export_jobs SET status = 'artifact_created', artifact_storage_ref = ?, artifact_checksum_sha256 = ?, included_count = ?, excluded_count = ?, redacted_count = ?, artifact_created_at = ?, expires_at = ? WHERE tenant_id = ? AND id = ? AND status = 'redacting'", "artifact"],
  ["UPDATE tenant_export_jobs SET status = 'released' WHERE tenant_id = ? AND id = ? AND status = 'artifact_created'", "release"],
  ["UPDATE tenant_export_jobs SET status = 'canceled', error_code = 'EXPORT_CANCELED', error_message = ? WHERE tenant_id = ? AND id = ? AND status = ?", "cancel"],
  ["UPDATE tenant_export_jobs SET status = 'retry_wait', retry_count = retry_count + 1, next_retry_at = ?, error_code = 'EXPORT_RETRYABLE', error_message = ? WHERE tenant_id = ? AND id = ? AND status = 'failed'", "requeue"],
  ["UPDATE tenant_export_jobs SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'released'", "expire"],
  ["UPDATE tenant_export_jobs SET status = 'deleted' WHERE tenant_id = ? AND id = ? AND status = 'expired'", "delete"],
]);

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

const NORMALIZED_INSERT = normalizeSql(INSERT_EXPORT_JOB_SQL);
const NORMALIZED_GET_JOB = normalizeSql(GET_EXPORT_JOB_SQL);
const NORMALIZED_TRANSITIONS = new Map<string, string>(
  [...TRANSITION_EDGES.entries()].map(([sql, edge]) => [normalizeSql(sql), edge]),
);

/** postgres.js returns timestamptz as Date; the service contract is the
 * canonical millisecond ISO string the SQLite backend produces. */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeRow<T>(row: T): T {
  if (row === null || typeof row !== "object" || row instanceof Date) return row;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized as T;
}

function failInternal(): TenantLifecycleOpsError {
  return new TenantLifecycleOpsError("FAILED_INTERNAL");
}

function transitionPayload(edge: string, params: unknown[]): Record<string, unknown> {
  const text = (index: number): string | null => {
    const value = params[index];
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : String(value);
  };
  const count = (index: number): number | null => {
    const value = params[index];
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  };
  switch (edge) {
    case "enter":
      return { tenantId: text(0), jobId: text(1), edge, expectedStatus: text(2) };
    case "fail":
      return { tenantId: text(2), jobId: text(3), edge, errorCode: text(0), errorMessage: text(1) };
    case "redact":
      return { tenantId: text(1), jobId: text(2), edge, snapshotAt: text(0) };
    case "artifact":
      return {
        tenantId: text(7), jobId: text(8), edge,
        artifactStorageRef: text(0), artifactChecksumSha256: text(1),
        includedCount: count(2), excludedCount: count(3), redactedCount: count(4),
        artifactCreatedAt: text(5), expiresAt: text(6),
      };
    case "release":
      return { tenantId: text(0), jobId: text(1), edge };
    case "cancel":
      return { tenantId: text(1), jobId: text(2), edge, errorMessage: text(0), expectedStatus: text(3) };
    case "requeue":
      return { tenantId: text(2), jobId: text(3), edge, nextRetryAt: text(0), errorMessage: text(1) };
    case "expire":
    case "delete":
      return { tenantId: text(0), jobId: text(1), edge };
    default:
      return { edge };
  }
}

function requestPayload(params: unknown[]): Record<string, unknown> {
  const text = (index: number): string | null => {
    const value = params[index];
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : String(value);
  };
  return {
    jobId: text(0), tenantId: text(1), workspaceId: text(2),
    requesterAuthIdentityId: text(4), requesterMembershipId: text(5),
    supportAccessGrantId: text(6), scopeHash: text(7), inputHash: text(8),
    idempotencyKeyHash: text(9), policyVersion: text(10),
    manifestVersion: text(11), schemaVersion: text(12),
    requestedFormat: text(13), correlationId: text(14), auditEventId: text(15),
  };
}

/** Translates the canonical service's fixed export SQL into definer calls. */
function createExportDbShim(db: DbClient): DbClient {
  async function callOutcome(fn: string, payload: Record<string, unknown>): Promise<DbRunResult> {
    const rows = await db
      .prepare(`SELECT outcome FROM public.${fn}(?)`)
      .all<{ outcome: string }>(JSON.stringify(payload));
    if (rows.length !== 1) throw failInternal();
    return { changes: rows[0].outcome === "applied" ? 1 : 0 };
  }

  async function callApplied(fn: string, payload: Record<string, unknown>): Promise<DbRunResult> {
    const rows = await db
      .prepare(`SELECT applied FROM public.${fn}(?)`)
      .all<{ applied: boolean }>(JSON.stringify(payload));
    if (rows.length !== 1) throw failInternal();
    return { changes: rows[0].applied === true ? 1 : 0 };
  }

  return {
    exec: (query) => db.exec(query),
    ...(db.withStatementTimeout ? { withStatementTimeout: db.withStatementTimeout.bind(db) } : {}),
    ...(db.withTransaction ? { withTransaction: db.withTransaction.bind(db) } : {}),
    prepare(query: string): DbStatement {
      const normalized = normalizeSql(query);
      if (normalized === NORMALIZED_INSERT) {
        return {
          run: (...params: unknown[]) => callApplied(EXPORT_REQUEST_FN, requestPayload(params)),
          get: <T,>() => Promise.reject<T | undefined>(failInternal()),
          all: <T,>() => Promise.reject<T[]>(failInternal()),
        };
      }
      const edge = NORMALIZED_TRANSITIONS.get(normalized);
      if (edge) {
        return {
          run: (...params: unknown[]) => callOutcome(EXPORT_TRANSITION_FN, transitionPayload(edge, params)),
          get: <T,>() => Promise.reject<T | undefined>(failInternal()),
          all: <T,>() => Promise.reject<T[]>(failInternal()),
        };
      }
      if (normalized === NORMALIZED_GET_JOB) {
        const read = db.prepare(
          "SELECT * FROM public.novatrade_tenant_export_job_read(?::uuid, ?::uuid)",
        );
        return {
          run: () => Promise.reject<DbRunResult>(failInternal()),
          get: async <T,>(...params: unknown[]) => {
            const row = await read.get<T>(...params);
            return row === undefined ? undefined : normalizeRow(row);
          },
          all: <T,>() => Promise.reject<T[]>(failInternal()),
        };
      }
      const inner = db.prepare(query);
      return {
        run: (...params: unknown[]) => inner.run(...params),
        get: async <T,>(...params: unknown[]) => {
          const row = await inner.get<T>(...params);
          return row === undefined ? undefined : normalizeRow(row);
        },
        all: async <T,>(...params: unknown[]) => (await inner.all<T>(...params)).map(normalizeRow),
      };
    },
  };
}

export interface PostgresExportOperationsOptions {
  exportRunner: TenantExportRunnerPort;
  /** Unused by the export surface; the ops dependencies require the port. */
  deletionStore?: TenantDeletionStorePort;
  limits?: Pick<TenantLimitService, "consume">;
  idFactory?: TenantLifecycleOpsIdFactory;
  clock?: () => Date;
}

export type PostgresExportOperationsService = Pick<
  TenantLifecycleOperationsService,
  "requestExport" | "runExport" | "cancelExport" | "requeueExport" | "sweepExportRetention" | "getExportJob"
>;

export function createPostgresExportOperationsService(
  options: PostgresExportOperationsOptions,
): PostgresExportOperationsService {
  const service = createTenantLifecycleOperationsService({
    exportRunner: options.exportRunner,
    deletionStore: options.deletionStore ?? {
      execute: () => Promise.reject(new TenantLifecycleOpsError("FAILED_INTERNAL")),
    },
    limits: options.limits,
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    clock: options.clock,
    transactionRunner: {
      run: async <T>(callback: (scope: TenantLifecycleOpsTransactionScope) => Promise<T>): Promise<T> =>
        withTenantDbContext(async (db) =>
          callback({
            db: createExportDbShim(db),
            repository: createTenantQueryRepository(db),
            auditWriter: {
              append: async (event: TenantLifecycleOpsAuditEvent) => {
                const rows = await db
                  .prepare(`SELECT applied FROM public.${EXPORT_AUDIT_FN}(?)`)
                  .all<{ applied: boolean }>(JSON.stringify(event));
                if (rows.length !== 1 || rows[0].applied !== true) throw failInternal();
              },
            },
          })),
    },
  });
  return {
    requestExport: (input) => service.requestExport(input),
    runExport: (input) => service.runExport(input),
    cancelExport: (input) => service.cancelExport(input),
    requeueExport: (input) => service.requeueExport(input),
    sweepExportRetention: (input) => service.sweepExportRetention(input),
    getExportJob: (tenantId, jobId) => service.getExportJob(tenantId, jobId),
  };
}

/**
 * L-02 T-041 (0X3-234): Postgres twin of createLocalExportRunner. The
 * transaction runner installs the member context before execute() fires, so
 * getDb() here resolves the transaction-bound client and every snapshot read
 * rides member RLS — the same five-table projection, redaction set, and
 * checksum contract as the local runner. Artifact bytes stay committed only
 * as the job row's ref + checksum; purge() is a no-op for the same reason.
 */
export function createPostgresExportRunner(): TenantExportRunnerPort {
  return {
    async execute({ job, tenantId, format, artifactExpiresAt }) {
      if (format !== "json") throw new TenantLifecycleOpsError("BLOCKED_MALFORMED");
      const db = await getDb();
      const snapshotAt = new Date().toISOString();
      const read = async (sql: string, ...params: unknown[]) =>
        db.prepare(sql).all<Record<string, unknown>>(...params);
      const payload = [
        { table: "tenants", rows: await read("SELECT id, slug, name, status, locale, timezone, created_at, updated_at FROM tenants WHERE id = ?", tenantId) },
        { table: "workspaces", rows: await read("SELECT id, tenant_id, slug, name, status, created_at, updated_at FROM workspaces WHERE tenant_id = ?", tenantId) },
        { table: "tenant_policies", rows: await read("SELECT * FROM tenant_policies WHERE tenant_id = ?", tenantId) },
        { table: "tenant_memberships", rows: await read("SELECT * FROM tenant_memberships WHERE tenant_id = ?", tenantId) },
        { table: "tenant_role_bindings", rows: await read("SELECT * FROM tenant_role_bindings WHERE tenant_id = ?", tenantId) },
      ];
      let includedCount = 0;
      let redactedCount = 0;
      const rows = payload.map(({ table, rows: tableRows }) => ({
        table,
        rows: tableRows.map((row) => {
          includedCount += 1;
          const next: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            if (EXPORT_REDACTED_COLUMNS.has(key)) {
              next[key] = null;
              redactedCount += 1;
            } else {
              next[key] = value;
            }
          }
          return next;
        }),
      }));
      const bytes = JSON.stringify(rows);
      return {
        snapshotAt,
        artifactStorageRef: `tenants/${tenantId}/exports/${job.id}/export.json`,
        checksumSha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
        includedCount,
        excludedCount: 0,
        redactedCount,
        artifactCreatedAt: new Date().toISOString(),
        expiresAt: artifactExpiresAt,
      };
    },
    async purge() {},
  };
}

const EXPORT_REDACTED_COLUMNS = new Set(["pending_identity_ref_hash", "auth_identity_id"]);
