import { randomUUID } from "node:crypto";

import type { DbClient, DbRunResult, DbStatement } from "@/lib/db";
import { withTenantDbContext } from "@/lib/db";
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
import { createTenantQueryRepository, type TenantQueryRepository } from "@/lib/tenancy/queries";
import type { TenantLimitService } from "@/lib/tenancy/limits";
import type { Membership, RoleBinding, Tenant } from "@/lib/tenancy/queries";
import type { MembershipId, TenantId, TenantPolicy } from "@/lib/tenancy/types";

/**
 * L-02 T-039: Postgres twin of the canonical deletion surface
 * (requestDeletion/verifyDeletion/approveDeletion/runDeletion/
 * requeueDeletion/cancelDeletion/getDeletionJob/listDeletionCheckpoints).
 *
 * The deletion lane cannot ride member RLS: the ledger tables are
 * zero-policy deny-all, and every member-select policy evaluates
 * novatrade_rls_member_context(), which requires tenants.status = 'active'
 * — unreachable for a ledger whose entry state is 'archived'. Every read
 * (job/checkpoint/tenant/policy/membership/binding) therefore goes through
 * novatrade_deletion_read, and every write through the definer functions in
 * migration 202609120012, all gated on novatrade_deletion_actor_ctx() — a
 * structural member-context proof (live membership + live binding, no
 * tenant-status gate).
 *
 * The canonical service mutates through scope.db.prepare(...).run(...) with
 * fixed SQL literals; the DbClient shim below translates each literal into
 * the matching definer call so the service, its state machine, and its
 * error semantics stay unchanged.
 */

const DELETION_READ_FN = "novatrade_deletion_read";
const DELETION_REQUEST_FN = "novatrade_deletion_request";
const DELETION_TRANSITION_FN = "novatrade_deletion_transition";
const DELETION_TENANT_CAS_FN = "novatrade_deletion_tenant_cas";
const DELETION_CHECKPOINT_INSERT_FN = "novatrade_deletion_checkpoint_insert";
const DELETION_CHECKPOINT_TRANSITION_FN = "novatrade_deletion_checkpoint_transition";
const DELETION_CHECKPOINT_EVENT_FN = "novatrade_deletion_checkpoint_event";
const DELETION_TOMBSTONE_FN = "novatrade_deletion_tombstone_insert";
const DELETION_AUDIT_FN = "novatrade_deletion_audit_append";

const TENANT_STATUS_CAS_SQL =
  "UPDATE tenants SET status = ? WHERE id = ? AND status = ?";

const GET_DELETION_JOB_SQL =
  "SELECT * FROM tenant_deletion_jobs WHERE tenant_id = ? AND id = ?";
const GET_DELETION_JOB_BY_IDEM_SQL =
  "SELECT * FROM tenant_deletion_jobs WHERE tenant_id = ? AND operation = ? AND scope_selector_hash = ? AND idempotency_key_hash = ?";
const GET_CHECKPOINT_SQL =
  "SELECT * FROM tenant_deletion_checkpoints WHERE tenant_id = ? AND job_id = ? AND store_class = ?";
const LIST_CHECKPOINTS_SQL =
  "SELECT * FROM tenant_deletion_checkpoints WHERE tenant_id = ? AND job_id = ? ORDER BY store_class";

const INSERT_DELETION_JOB_SQL = `INSERT INTO tenant_deletion_jobs
  (id, tenant_id, workspace_id, operation, scope_kind, scope_selector_hash,
   requested_by_auth_identity_id, requested_by_membership_id, status,
   policy_version, policy_snapshot_hash, input_hash, idempotency_key_hash,
   correlation_id, audit_event_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`;

const INSERT_CHECKPOINT_SQL = `INSERT INTO tenant_deletion_checkpoints
  (id, job_id, tenant_id, workspace_id, store_class, opaque_target_hash)
 VALUES (?, ?, ?, ?, ?, ?)`;

const INSERT_CHECKPOINT_EVENT_SQL = `INSERT INTO tenant_deletion_checkpoint_events
  (checkpoint_id, tenant_id, job_id, status, attempt, lease_generation, receipt_hash, reason_code)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TOMBSTONE_SQL = `INSERT INTO tenant_deletion_tombstones
  (id, job_id, tenant_id, workspace_id, scope_selector_hash, tenant_identity_hash, policy_version, retention_until)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const JOB_EDGES = new Map<string, string>([
  ["UPDATE tenant_deletion_jobs SET status = 'verified', verified_by_auth_identity_id = ?, verified_by_membership_id = ?, verified_at = ? WHERE tenant_id = ? AND id = ? AND status = 'requested'", "verify"],
  ["UPDATE tenant_deletion_jobs SET status = 'scheduled', approved_by_auth_identity_id = ?, approved_by_membership_id = ?, approved_at = ?, scheduled_at = ? WHERE tenant_id = ? AND id = ? AND status = 'verified'", "approve"],
  ["UPDATE tenant_deletion_jobs SET status = 'running', started_at = ? WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", "start"],
  ["UPDATE tenant_deletion_jobs SET status = 'running', next_retry_at = NULL, error_code = NULL, error_fingerprint = NULL WHERE tenant_id = ? AND id = ? AND status = 'retry_wait'", "restart"],
  ["UPDATE tenant_deletion_jobs SET status = 'primary_deleted', primary_deleted_at = ?, backup_expiry_target_at = ? WHERE tenant_id = ? AND id = ? AND status = 'running'", "primary"],
  ["UPDATE tenant_deletion_jobs SET status = 'backup_aging', backup_aging_at = ? WHERE tenant_id = ? AND id = ? AND status = 'primary_deleted'", "aging"],
  ["UPDATE tenant_deletion_jobs SET status = 'completed', completed_at = ? WHERE tenant_id = ? AND id = ? AND status = 'backup_aging'", "complete"],
  ["UPDATE tenant_deletion_jobs SET status = 'failed', error_code = 'DELETE_INTERNAL', error_fingerprint = ? WHERE tenant_id = ? AND id = ? AND status = 'running'", "failed"],
  ["UPDATE tenant_deletion_jobs SET status = 'retry_wait', retry_count = retry_count + 1, next_retry_at = ?, error_code = 'DELETE_CHECKPOINT_RETRYABLE', error_fingerprint = ? WHERE tenant_id = ? AND id = ? AND status = 'failed'", "requeue"],
  ["UPDATE tenant_deletion_jobs SET status = 'canceled', canceled_at = ? WHERE tenant_id = ? AND id = ? AND status = ?", "cancel"],
]);

const CHECKPOINT_EDGES = new Map<string, string>([
  ["UPDATE tenant_deletion_checkpoints SET status = 'retryable', attempt = ?, error_code = 'DELETE_CHECKPOINT_RETRYABLE', error_fingerprint = ? WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = 'failed'", "retryable"],
  ["UPDATE tenant_deletion_checkpoints SET status = 'running', started_at = ?, error_code = NULL, error_fingerprint = NULL WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = ?", "running"],
  ["UPDATE tenant_deletion_checkpoints SET status = 'complete', completed_at = ?, receipt_hash = ?, observed_count = ?, expected_count = ? WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = 'running'", "complete"],
  ["UPDATE tenant_deletion_checkpoints SET status = 'failed', error_code = 'DELETE_CHECKPOINT_FAILED', error_fingerprint = ? WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = 'running'", "failed"],
]);

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

const NORMALIZED = {
  tenantCas: normalizeSql(TENANT_STATUS_CAS_SQL),
  getJob: normalizeSql(GET_DELETION_JOB_SQL),
  getJobByIdem: normalizeSql(GET_DELETION_JOB_BY_IDEM_SQL),
  getCheckpoint: normalizeSql(GET_CHECKPOINT_SQL),
  listCheckpoints: normalizeSql(LIST_CHECKPOINTS_SQL),
  insertJob: normalizeSql(INSERT_DELETION_JOB_SQL),
  insertCheckpoint: normalizeSql(INSERT_CHECKPOINT_SQL),
  insertEvent: normalizeSql(INSERT_CHECKPOINT_EVENT_SQL),
  insertTombstone: normalizeSql(INSERT_TOMBSTONE_SQL),
  jobEdges: new Map([...JOB_EDGES.entries()].map(([sql, edge]) => [normalizeSql(sql), edge])),
  checkpointEdges: new Map([...CHECKPOINT_EDGES.entries()].map(([sql, edge]) => [normalizeSql(sql), edge])),
};

function failInternal(): TenantLifecycleOpsError {
  return new TenantLifecycleOpsError("FAILED_INTERNAL");
}

function text(params: unknown[], index: number): string | null {
  const value = params[index];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function count(params: unknown[], index: number): number | null {
  const value = params[index];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function jobPayload(edge: string, params: unknown[]): Record<string, unknown> {
  switch (edge) {
    case "verify":
      return {
        edge, tenantId: text(params, 3), jobId: text(params, 4),
        verifierAuthIdentityId: text(params, 0), verifierMembershipId: text(params, 1),
        at: text(params, 2),
      };
    case "approve":
      return {
        edge, tenantId: text(params, 4), jobId: text(params, 5),
        approverAuthIdentityId: text(params, 0), approverMembershipId: text(params, 1),
        at: text(params, 2), scheduledAt: text(params, 3),
      };
    case "start":
      return { edge, tenantId: text(params, 1), jobId: text(params, 2), at: text(params, 0) };
    case "restart":
      return { edge, tenantId: text(params, 0), jobId: text(params, 1) };
    case "primary":
      return {
        edge, tenantId: text(params, 2), jobId: text(params, 3),
        at: text(params, 0), backupExpiryTargetAt: text(params, 1),
      };
    case "aging":
    case "complete":
      return { edge, tenantId: text(params, 1), jobId: text(params, 2), at: text(params, 0) };
    case "failed":
      return { edge, tenantId: text(params, 1), jobId: text(params, 2), errorFingerprint: text(params, 0) };
    case "requeue":
      return {
        edge, tenantId: text(params, 2), jobId: text(params, 3),
        nextRetryAt: text(params, 0), errorFingerprint: text(params, 1),
      };
    case "cancel":
      return {
        edge, tenantId: text(params, 1), jobId: text(params, 2),
        at: text(params, 0), expectedStatus: text(params, 3),
      };
    default:
      return { edge };
  }
}

function checkpointPayload(edge: string, params: unknown[]): Record<string, unknown> {
  switch (edge) {
    case "retryable":
      return {
        edge, tenantId: text(params, 2), jobId: text(params, 3), storeClass: text(params, 4),
        attempt: count(params, 0), errorFingerprint: text(params, 1),
      };
    case "running":
      return {
        edge, tenantId: text(params, 1), jobId: text(params, 2), storeClass: text(params, 3),
        at: text(params, 0), fromStatus: text(params, 4),
      };
    case "complete":
      return {
        edge, tenantId: text(params, 4), jobId: text(params, 5), storeClass: text(params, 6),
        at: text(params, 0), receiptHash: text(params, 1),
        observedCount: count(params, 2), expectedCount: count(params, 3),
      };
    case "failed":
      return {
        edge, tenantId: text(params, 1), jobId: text(params, 2), storeClass: text(params, 3),
        errorFingerprint: text(params, 0),
      };
    default:
      return { edge };
  }
}

/** Translates the canonical service's fixed deletion SQL into definer calls. */
function createDeletionDbShim(db: DbClient): DbClient {
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

  async function readRow(payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const rows = await db
      .prepare(`SELECT record FROM public.${DELETION_READ_FN}(?) AS record`)
      .all<{ record: Record<string, unknown> | null }>(JSON.stringify(payload));
    if (rows.length !== 1) throw failInternal();
    return rows[0].record === null ? undefined : rows[0].record;
  }

  function rejected<T>(): Promise<T> {
    return Promise.reject<T>(failInternal());
  }

  return {
    exec: (query) => db.exec(query),
    ...(db.withStatementTimeout ? { withStatementTimeout: db.withStatementTimeout.bind(db) } : {}),
    ...(db.withTransaction ? { withTransaction: db.withTransaction.bind(db) } : {}),
    prepare(query: string): DbStatement {
      const normalized = normalizeSql(query);

      if (normalized === NORMALIZED.getJob) {
        return {
          run: () => rejected<DbRunResult>(),
          get: <T,>(...params: unknown[]) =>
            readRow({ kind: "job", tenantId: text(params, 0), jobId: text(params, 1) }) as Promise<T | undefined>,
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.getJobByIdem) {
        return {
          run: () => rejected<DbRunResult>(),
          get: <T,>(...params: unknown[]) =>
            readRow({
              kind: "job_by_idem", tenantId: text(params, 0),
              scopeSelectorHash: text(params, 2), idempotencyKeyHash: text(params, 3),
            }) as Promise<T | undefined>,
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.getCheckpoint) {
        return {
          run: () => rejected<DbRunResult>(),
          get: <T,>(...params: unknown[]) =>
            readRow({
              kind: "checkpoint", tenantId: text(params, 0),
              jobId: text(params, 1), storeClass: text(params, 2),
            }) as Promise<T | undefined>,
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.listCheckpoints) {
        return {
          run: () => rejected<DbRunResult>(),
          get: <T,>() => rejected<T | undefined>(),
          all: async <T,>(...params: unknown[]) => {
            const rows = await db
              .prepare(`SELECT record FROM public.${DELETION_READ_FN}(?) AS record`)
              .all<{ record: unknown }>(JSON.stringify({
                kind: "checkpoint_list", tenantId: text(params, 0), jobId: text(params, 1),
              }));
            if (rows.length !== 1 || !Array.isArray(rows[0].record)) throw failInternal();
            return rows[0].record as T[];
          },
        };
      }
      if (normalized === NORMALIZED.insertJob) {
        return {
          run: (...params: unknown[]) => callApplied(DELETION_REQUEST_FN, {
            jobId: text(params, 0), tenantId: text(params, 1), workspaceId: text(params, 2),
            scopeKind: text(params, 4), scopeSelectorHash: text(params, 5),
            requesterAuthIdentityId: text(params, 6), requesterMembershipId: text(params, 7),
            policyVersion: text(params, 8), policySnapshotHash: text(params, 9),
            inputHash: text(params, 10), idempotencyKeyHash: text(params, 11),
            correlationId: text(params, 12), auditEventId: text(params, 13),
          }),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.insertCheckpoint) {
        return {
          run: (...params: unknown[]) => callApplied(DELETION_CHECKPOINT_INSERT_FN, {
            checkpointId: text(params, 0), jobId: text(params, 1), tenantId: text(params, 2),
            workspaceId: text(params, 3), storeClass: text(params, 4),
            opaqueTargetHash: text(params, 5),
          }),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.insertEvent) {
        return {
          run: (...params: unknown[]) => callApplied(DELETION_CHECKPOINT_EVENT_FN, {
            checkpointId: text(params, 0), tenantId: text(params, 1), jobId: text(params, 2),
            status: text(params, 3), attempt: count(params, 4),
            leaseGeneration: count(params, 5), receiptHash: text(params, 6),
            reasonCode: text(params, 7),
          }),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.insertTombstone) {
        return {
          run: (...params: unknown[]) => callApplied(DELETION_TOMBSTONE_FN, {
            tombstoneId: text(params, 0), jobId: text(params, 1), tenantId: text(params, 2),
            workspaceId: text(params, 3), scopeSelectorHash: text(params, 4),
            tenantIdentityHash: text(params, 5), policyVersion: text(params, 6),
            retentionUntil: text(params, 7),
          }),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
        };
      }
      if (normalized === NORMALIZED.tenantCas) {
        return {
          run: (...params: unknown[]) => callApplied(DELETION_TENANT_CAS_FN, {
            tenantId: text(params, 1), toStatus: text(params, 0), fromStatus: text(params, 2),
          }),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
        };
      }
      const jobEdge = NORMALIZED.jobEdges.get(normalized);
      if (jobEdge) {
        return {
          run: (...params: unknown[]) => callOutcome(DELETION_TRANSITION_FN, jobPayload(jobEdge, params)),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
        };
      }
      const checkpointEdge = NORMALIZED.checkpointEdges.get(normalized);
      if (checkpointEdge) {
        return {
          run: (...params: unknown[]) =>
            callOutcome(DELETION_CHECKPOINT_TRANSITION_FN, checkpointPayload(checkpointEdge, params)),
          get: <T,>() => rejected<T | undefined>(),
          all: <T,>() => rejected<T[]>(),
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

/** Repository twin: the four reads the canonical deletion surface uses,
 * routed through novatrade_deletion_read; every other method delegates to
 * the member-RLS repository where deny-all posture keeps them honest. */
function createDeletionRepository(db: DbClient): TenantQueryRepository {
  const inner = createTenantQueryRepository(db);

  async function read(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const rows = await db
      .prepare(`SELECT record FROM public.${DELETION_READ_FN}(?) AS record`)
      .all<{ record: Record<string, unknown> | null }>(JSON.stringify(payload));
    if (rows.length !== 1) throw failInternal();
    return rows[0].record;
  }

  return {
    ...inner,
    getTenant: async (tenantId: TenantId): Promise<Tenant | null> => {
      const row = await read({ kind: "tenant", tenantId });
      if (row === null) return null;
      return {
        id: row.id as Tenant["id"],
        slug: row.slug as string,
        name: row.name as string,
        status: row.status as Tenant["status"],
        locale: row.locale as string,
        timezone: row.timezone as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };
    },
    getCurrentTenantPolicy: async (tenantId: TenantId): Promise<TenantPolicy | null> => {
      const row = await read({ kind: "policy", tenantId });
      if (row === null) return null;
      return {
        id: row.id as string,
        tenantId: row.tenant_id as TenantId,
        version: row.version as number,
        locale: row.locale as string,
        timezone: row.timezone as string,
        exportRetentionDays: row.export_retention_days as number,
        operationalLogRetentionDays: row.operational_log_retention_days as number,
        rawSourceRetentionDays: row.raw_source_retention_days as number,
        contactFreshnessDays: row.contact_freshness_days as number,
        primaryDeleteWithinDays: row.primary_delete_within_days as number,
        backupExpireWithinDays: row.backup_expire_within_days as number,
        tombstoneRetentionYears: row.tombstone_retention_years as TenantPolicy["tombstoneRetentionYears"],
        activeMaterialsMode: row.active_materials_mode as TenantPolicy["activeMaterialsMode"],
        aiProcessingEnabled: row.ai_processing_enabled as boolean,
        sourceResearchEnabled: row.source_research_enabled as boolean,
        contactResearchEnabled: row.contact_research_enabled as boolean,
        outreachDraftingEnabled: row.outreach_drafting_enabled as boolean,
        copyExportEnabled: row.copy_export_enabled as boolean,
        autonomousSendEnabled: row.autonomous_send_enabled as TenantPolicy["autonomousSendEnabled"],
        requireSourcePlanApproval: row.require_source_plan_approval as boolean,
        requireKnowledgeReview: row.require_knowledge_review as boolean,
        requireIcpReview: row.require_icp_review as boolean,
        requireLeadPlayReview: row.require_lead_play_review as boolean,
        requireContactReview: row.require_contact_review as boolean,
        requireOutreachReview: row.require_outreach_review as boolean,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };
    },
    getMembership: async (tenantId: TenantId, membershipId: MembershipId): Promise<Membership | null> => {
      const row = await read({ kind: "membership", tenantId, membershipId });
      if (row === null) return null;
      return {
        id: row.id as Membership["id"],
        tenantId: row.tenant_id as TenantId,
        authIdentityId: (row.auth_identity_id as Membership["authIdentityId"]) ?? null,
        pendingIdentityRefHash: (row.pending_identity_ref_hash as string | null) ?? null,
        workspaceId: (row.workspace_id as Membership["workspaceId"]) ?? null,
        status: row.status as Membership["status"],
        invitedByMembershipId: (row.invited_by_membership_id as Membership["invitedByMembershipId"]) ?? null,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };
    },
    getCurrentRoleBinding: async (
      tenantId: TenantId,
      membershipId: MembershipId,
    ): Promise<RoleBinding | null> => {
      const row = await read({ kind: "binding", tenantId, membershipId });
      if (row === null) return null;
      return {
        id: row.id as RoleBinding["id"],
        tenantId: row.tenant_id as TenantId,
        membershipId: row.membership_id as MembershipId,
        role: row.role as RoleBinding["role"],
        createdAt: row.created_at as string,
        validFrom: row.valid_from as string,
        revokedAt: (row.revoked_at as string | null) ?? null,
        assignedByMembershipId: (row.assigned_by_membership_id as RoleBinding["assignedByMembershipId"]) ?? null,
        reasonCode: (row.reason_code as RoleBinding["reasonCode"]) ?? null,
      };
    },
  };
}

export interface PostgresDeletionOperationsOptions {
  deletionStore: TenantDeletionStorePort;
  /** Unused by the deletion surface; the ops dependencies require the port. */
  exportRunner?: TenantExportRunnerPort;
  limits?: Pick<TenantLimitService, "consume">;
  idFactory?: TenantLifecycleOpsIdFactory;
  clock?: () => Date;
}

export type PostgresDeletionOperationsService = Pick<
  TenantLifecycleOperationsService,
  | "requestDeletion" | "verifyDeletion" | "approveDeletion" | "runDeletion"
  | "requeueDeletion" | "cancelDeletion" | "getDeletionJob" | "listDeletionCheckpoints"
>;

export function createPostgresDeletionOperationsService(
  options: PostgresDeletionOperationsOptions,
): PostgresDeletionOperationsService {
  const service = createTenantLifecycleOperationsService({
    exportRunner: options.exportRunner ?? {
      execute: () => Promise.reject(new TenantLifecycleOpsError("FAILED_INTERNAL")),
      purge: () => Promise.reject(new TenantLifecycleOpsError("FAILED_INTERNAL")),
    },
    deletionStore: options.deletionStore,
    limits: options.limits,
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    clock: options.clock,
    transactionRunner: {
      run: async <T>(callback: (scope: TenantLifecycleOpsTransactionScope) => Promise<T>): Promise<T> =>
        withTenantDbContext(async (db) =>
          callback({
            db: createDeletionDbShim(db),
            repository: createDeletionRepository(db),
            auditWriter: {
              append: async (event: TenantLifecycleOpsAuditEvent) => {
                const rows = await db
                  .prepare(`SELECT applied FROM public.${DELETION_AUDIT_FN}(?)`)
                  .all<{ applied: boolean }>(JSON.stringify(event));
                if (rows.length !== 1 || rows[0].applied !== true) throw failInternal();
              },
            },
          })),
    },
  });
  return {
    requestDeletion: (input) => service.requestDeletion(input),
    verifyDeletion: (input) => service.verifyDeletion(input),
    approveDeletion: (input) => service.approveDeletion(input),
    runDeletion: (input) => service.runDeletion(input),
    requeueDeletion: (input) => service.requeueDeletion(input),
    cancelDeletion: (input) => service.cancelDeletion(input),
    getDeletionJob: (tenantId, jobId) => service.getDeletionJob(tenantId, jobId),
    listDeletionCheckpoints: (tenantId, jobId) => service.listDeletionCheckpoints(tenantId, jobId),
  };
}
