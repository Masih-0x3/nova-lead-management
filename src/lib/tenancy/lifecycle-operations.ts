import { createHash, randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import type { TenantQueryRepository } from "@/lib/tenancy/queries";
import { getTenantContext } from "@/lib/tenancy/context";
import { canTenantOperation, canTransitionTenant } from "@/lib/tenancy/lifecycle";
import type { TenantLimitAction, TenantLimitService } from "@/lib/tenancy/limits";
import {
  TENANT_DELETION_CHECKPOINT_STATUSES,
  TENANT_DELETION_CHECKPOINT_STORES,
  TENANT_DELETION_JOB_OPERATION,
  TENANT_DELETION_JOB_STATUSES,
  canEnterTenantDeletionPrimaryDeleted,
  isTenantDeletionCheckpointTransitionAllowed,
  isTenantDeletionTransitionAllowed,
  type ActorLayer,
  type AuthIdentityId,
  type CorrelationId,
  type MembershipId,
  type TenantDeletionCheckpointInput,
  type TenantDeletionCheckpointStatus,
  type TenantDeletionCheckpointStore,
  type TenantDeletionErrorCode,
  type TenantDeletionJobStatus,
  type TenantExportErrorCode,
  type TenantExportFormat,
  type TenantExportJob,
  type TenantExportJobStatus,
  type TenantId,
  type TenantStatus,
  type TenantPolicy,
  type WorkspaceId,
  TENANT_EXPORT_JOB_OPERATION,
  TENANT_EXPORT_JOB_STATUSES,
  TENANT_EXPORT_MANIFEST_VERSION,
  TENANT_EXPORT_SCHEMA_VERSION,
} from "@/lib/tenancy/types";

// ─── Result codes ────────────────────────────────────────────────────────────

export const TENANT_LIFECYCLE_OPS_CODES = [
  "OK_SUSPENDED",
  "OK_RESUMED",
  "OK_ARCHIVED",
  "OK_EXPORT_REQUESTED",
  "OK_EXPORT_COMPLETED",
  "OK_EXPORT_CANCELED",
  "OK_EXPORT_RUNNING",
  "OK_EXPORT_SWEPT",
  "OK_DELETION_REQUESTED",
  "OK_DELETION_VERIFIED",
  "OK_DELETION_SCHEDULED",
  "OK_DELETION_RUNNING",
  "OK_DELETION_COMPLETED",
  "OK_DELETION_CANCELED",
  "NOT_FOUND_NON_ENUMERATING",
  "BLOCKED_MALFORMED",
  "BLOCKED_STATE_CONFLICT",
  "BLOCKED_ACTOR_SCOPE",
  "BLOCKED_APPROVAL_INDEPENDENCE",
  "BLOCKED_REPLAY_CONFLICT",
  "BLOCKED_LIMIT",
  "FAILED_INTERNAL",
] as const;
export type TenantLifecycleOpsCode = (typeof TENANT_LIFECYCLE_OPS_CODES)[number];

export class TenantLifecycleOpsError extends Error {
  readonly code!: TenantLifecycleOpsCode;
  readonly retryable!: boolean;

  constructor(code: TenantLifecycleOpsCode, retryable = false) {
    super(code);
    this.name = "TenantLifecycleOpsError";
    Object.defineProperties(this, {
      code: { value: code, enumerable: true },
      retryable: { value: retryable, enumerable: true },
    });
  }
}

function fail(code: TenantLifecycleOpsCode, retryable = false): never {
  throw new TenantLifecycleOpsError(code, retryable);
}

// ─── Domain row types ────────────────────────────────────────────────────────

export interface TenantDeletionJob {
  id: string;
  tenantId: TenantId;
  workspaceId: WorkspaceId | null;
  operation: typeof TENANT_DELETION_JOB_OPERATION;
  scopeKind: "tenant" | "workspace" | "resource_set";
  scopeSelectorHash: string;
  requestedByAuthIdentityId: AuthIdentityId;
  requestedByMembershipId: MembershipId;
  verifiedByAuthIdentityId: AuthIdentityId | null;
  verifiedByMembershipId: MembershipId | null;
  verifiedAt: string | null;
  approvedByAuthIdentityId: AuthIdentityId | null;
  approvedByMembershipId: MembershipId | null;
  approvedAt: string | null;
  status: TenantDeletionJobStatus;
  policyVersion: string;
  policySnapshotHash: string;
  inputHash: string;
  idempotencyKeyHash: string;
  legalHoldStatus: string;
  freezeHandoffStatus: string;
  accessRevocationHandoffStatus: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  correlationId: CorrelationId;
  auditEventId: string;
  errorCode: TenantDeletionErrorCode | null;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  primaryDeletedAt: string | null;
  backupAgingAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  backupExpiryTargetAt: string | null;
}

export interface TenantDeletionCheckpoint {
  id: string;
  jobId: string;
  tenantId: TenantId;
  workspaceId: WorkspaceId | null;
  storeClass: TenantDeletionCheckpointStore;
  status: TenantDeletionCheckpointStatus;
  attempt: number;
  receiptHash: string | null;
  observedCount: number | null;
  expectedCount: number | null;
}

// ─── Ports ───────────────────────────────────────────────────────────────────

/** Published artifact facts; the port owns byte production and storage. */
export interface TenantExportArtifactFacts {
  snapshotAt: string;
  artifactStorageRef: string;
  checksumSha256: string;
  includedCount: number;
  excludedCount: number;
  redactedCount: number;
  artifactCreatedAt: string;
  expiresAt: string;
}

export interface TenantExportRunnerPort {
  /**
   * Snapshot, redact, and publish the artifact for a job. Runs inside the job's
   * transaction boundary; must return facts whose storage ref stays inside
   * `tenants/<tenant>/exports/<job>/…`.
   */
  execute(input: {
    job: TenantExportJob;
    tenantId: TenantId;
    workspaceId: WorkspaceId | null;
    format: TenantExportFormat;
    artifactExpiresAt: string;
  }): Promise<TenantExportArtifactFacts>;
  /**
   * Purge the published artifact bytes for a job whose status is `expired`.
   * Runs inside the sweep transaction; the job row and its artifact facts stay
   * as the accountability record — only the bytes go away.
   */
  purge(input: { job: TenantExportJob; tenantId: TenantId }): Promise<void>;
}

export interface TenantDeletionCheckpointReceipt {
  receiptHash: string;
  observedCount: number;
  expectedCount: number;
}

export interface TenantDeletionStorePort {
  /**
   * Execute one store-class purge inside the job transaction. Local adapters
   * purge the tables they own; provider classes may complete with an empty
   * receipt when there is nothing to delete.
   */
  execute(input: {
    job: TenantDeletionJob;
    checkpoint: TenantDeletionCheckpoint;
    db: DbClient;
  }): Promise<TenantDeletionCheckpointReceipt>;
}

export interface TenantLifecycleOpsAuditEvent {
  eventId: string;
  eventType:
    | "tenant.suspended"
    | "tenant.resumed"
    | "tenant.archived"
    | "tenant.export.requested"
    | "tenant.export.released"
    | "tenant.export.failed"
    | "tenant.export.canceled"
    | "tenant.export.requeued"
    | "tenant.export.expired"
    | "tenant.export.deleted"
    | "tenant.deletion.requested"
    | "tenant.deletion.verified"
    | "tenant.deletion.scheduled"
    | "tenant.deletion.running"
    | "tenant.deletion.primary_deleted"
    | "tenant.deletion.completed"
    | "tenant.deletion.canceled"
    | "tenant.deletion.failed"
    | "tenant.deletion.requeued";
  tenantId: TenantId;
  workspaceId: WorkspaceId | null;
  jobId: string | null;
  actorIdentityId: AuthIdentityId;
  actorLayer: ActorLayer;
  actorMembershipId: MembershipId | null;
  actorRole: string | null;
  actorRoleBindingId: string | null;
  correlationId: CorrelationId;
  occurredAt: string;
  /** Present when the event moved the tenant status; binds the receipt to the produced version. */
  tenantFromStatus?: TenantStatus;
  tenantToStatus?: TenantStatus;
  reasonCode?: string | null;
  reason?: string | null;
}

export interface TenantLifecycleOpsAuditWriter {
  append(event: TenantLifecycleOpsAuditEvent): Promise<void>;
}

export interface TenantLifecycleOpsTransactionScope {
  db: DbClient;
  repository: TenantQueryRepository;
  auditWriter: TenantLifecycleOpsAuditWriter;
}

export interface TenantLifecycleOpsTransactionRunner {
  run<T>(callback: (scope: TenantLifecycleOpsTransactionScope) => Promise<T>): Promise<T>;
}

export interface TenantLifecycleOpsIdFactory {
  next(kind: "export_job" | "deletion_job" | "checkpoint" | "tombstone" | "audit"): string;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface TenantLifecycleActor {
  authIdentityId: AuthIdentityId;
  layer: ActorLayer;
  membershipId?: MembershipId | null;
}

export interface SuspendResumeArchiveInput {
  tenantId: TenantId;
  actor: TenantLifecycleActor;
  /** Optimistic-concurrency guard: the transition aborts unless the tenant is in this state. */
  expectedCurrentState: TenantStatus;
  reasonCode: string;
  reason: string;
  correlationId: CorrelationId;
}

/** Member-initiated export request. The requester must be an active owner/admin. */
export interface RequestTenantExportInput {
  tenantId: TenantId;
  workspaceId?: WorkspaceId | null;
  requester: {
    authIdentityId: AuthIdentityId;
    membershipId?: MembershipId | null;
    supportAccessGrantId?: string | null;
  };
  format?: TenantExportFormat;
  idempotencyKey: string;
  correlationId: CorrelationId;
}

export interface RunTenantExportInput {
  tenantId: TenantId;
  jobId: string;
  /** System/worker identity executing the pipeline. */
  executor: { authIdentityId: AuthIdentityId; layer: ActorLayer };
  correlationId: CorrelationId;
}

export interface CancelTenantExportInput {
  tenantId: TenantId;
  jobId: string;
  actor: TenantLifecycleActor;
  correlationId: CorrelationId;
}

/**
 * Retention sweep: a system/worker executor advances each eligible job by
 * exactly one legal transition per pass — `released` past `expires_at` becomes
 * `expired` (the artifact stops being usable) and `expired` becomes `deleted`
 * after the runner port purges its bytes. Repeating the sweep is the designed
 * path from a released artifact back to a requestable state.
 */
export interface SweepTenantExportRetentionInput {
  tenantId: TenantId;
  executor: { authIdentityId: AuthIdentityId; layer: ActorLayer };
  correlationId: CorrelationId;
}

/** Member-initiated deletion request; only archived tenants may enter deletion. */
export interface RequestTenantDeletionInput {
  tenantId: TenantId;
  workspaceId?: WorkspaceId | null;
  requester: { authIdentityId: AuthIdentityId; membershipId: MembershipId };
  idempotencyKey: string;
  correlationId: CorrelationId;
}

export interface VerifyTenantDeletionInput {
  tenantId: TenantId;
  jobId: string;
  verifier: { authIdentityId: AuthIdentityId; membershipId: MembershipId };
  correlationId: CorrelationId;
}

export interface ApproveTenantDeletionInput {
  tenantId: TenantId;
  jobId: string;
  approver: { authIdentityId: AuthIdentityId; membershipId: MembershipId };
  correlationId: CorrelationId;
}

export interface RunTenantDeletionInput {
  tenantId: TenantId;
  jobId: string;
  executor: TenantLifecycleActor;
  correlationId: CorrelationId;
}

export interface CancelTenantDeletionInput {
  tenantId: TenantId;
  jobId: string;
  actor: TenantLifecycleActor;
  correlationId: CorrelationId;
}

export interface TenantLifecycleOpsDependencies {
  transactionRunner: TenantLifecycleOpsTransactionRunner;
  exportRunner: TenantExportRunnerPort;
  deletionStore: TenantDeletionStorePort;
  /**
   * Optional tenant-limit service. When present, member-context calls to
   * requestExport/requestDeletion consume the export_request/deletion_request
   * quota before the operation transaction opens. Support-grant callers are
   * authorized by the grant itself and are not quota-gated here.
   */
  limits?: Pick<TenantLimitService, "consume">;
  idFactory?: TenantLifecycleOpsIdFactory;
  clock?: () => Date;
}

// ─── Hashing helpers ─────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Reserves one unit of the tenant-limit action under the installed member
 * context. The idempotency key is a derived digest, so the raw operation key
 * never reaches the limit store and replays count once. Fail-closed: any
 * denial, malformed result, or backend error denies the operation.
 */
async function consumeLimit(
  limits: Pick<TenantLimitService, "consume"> | undefined,
  action: TenantLimitAction,
  keyMaterial: string,
): Promise<"allowed" | "denied"> {
  if (!limits || typeof limits.consume !== "function") return "allowed";
  try {
    const result = await limits.consume({
      action,
      amount: 1,
      idempotencyKey: sha256(`novatrade:tenant-limit:${action}:v1:${keyMaterial}`),
    });
    return result && result.outcome === "allowed" ? "allowed" : "denied";
  } catch {
    return "denied";
  }
}

function exportScopeHash(tenantId: string, workspaceId: string | null, format: string): string {
  return sha256(`novatrade:tenant-export-scope:v1:${tenantId}:${workspaceId ?? "-"}:${format}`);
}

function exportInputHash(tenantId: string, workspaceId: string | null, format: string): string {
  return sha256(`novatrade:tenant-export-input:v1:${JSON.stringify({ tenantId, workspaceId, format })}`);
}

function exportIdempotencyHash(key: string): string {
  return sha256(`novatrade:tenant-export-idem:v1:${key}`);
}

function deletionScopeHash(tenantId: string, workspaceId: string | null, scopeKind: string): string {
  return sha256(`novatrade:tenant-deletion-scope:v1:${tenantId}:${workspaceId ?? "-"}:${scopeKind}`);
}

function deletionInputHash(tenantId: string, workspaceId: string | null, requesterMembershipId: string): string {
  return sha256(`novatrade:tenant-deletion-input:v1:${JSON.stringify({ tenantId, workspaceId, requesterMembershipId })}`);
}

function deletionIdempotencyHash(key: string): string {
  return sha256(`novatrade:tenant-deletion-idem:v1:${key}`);
}

function policySnapshotHash(policy: TenantPolicy): string {
  return sha256(`novatrade:tenant-policy-snapshot:v1:${JSON.stringify({
    id: policy.id,
    version: policy.version,
    exportRetentionDays: policy.exportRetentionDays,
    primaryDeleteWithinDays: policy.primaryDeleteWithinDays,
    backupExpireWithinDays: policy.backupExpireWithinDays,
    tombstoneRetentionYears: policy.tombstoneRetentionYears,
  })}`);
}

function tenantIdentityHash(tenantId: string): string {
  return sha256(`novatrade:tenant-identity:v1:${tenantId}`);
}

function deletionTargetHash(jobId: string, store: string): string {
  return sha256(`novatrade:tenant-deletion-target:v1:${jobId}:${store}`);
}

function tenantPolicyVersionRef(version: number): string {
  return `tenant-policy-v${version}`;
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function mapExportJob(row: Record<string, unknown>): TenantExportJob {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as TenantId,
    workspaceId: (row.workspace_id as WorkspaceId | null) ?? null,
    operation: TENANT_EXPORT_JOB_OPERATION,
    requesterAuthIdentityId: row.requester_auth_identity_id as AuthIdentityId,
    requesterMembershipId: (row.requester_membership_id as MembershipId | null) ?? null,
    supportAccessGrantId: (row.support_access_grant_id as string | null) ?? null,
    status: row.status as TenantExportJobStatus,
    scopeHash: row.scope_hash as string,
    inputHash: row.input_hash as string,
    idempotencyKeyHash: row.idempotency_key_hash as string,
    policyVersion: row.policy_version as string,
    manifestVersion: row.manifest_version as string,
    schemaVersion: row.schema_version as string,
    requestedFormat: row.requested_format as TenantExportFormat,
    snapshotAt: (row.snapshot_at as string | null) ?? null,
    artifactStorageRef: (row.artifact_storage_ref as string | null) ?? null,
    artifactChecksumSha256: (row.artifact_checksum_sha256 as string | null) ?? null,
    includedCount: (row.included_count as number | null) ?? null,
    excludedCount: (row.excluded_count as number | null) ?? null,
    redactedCount: (row.redacted_count as number | null) ?? null,
    artifactCreatedAt: (row.artifact_created_at as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    errorCode: (row.error_code as TenantExportErrorCode | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    nextRetryAt: (row.next_retry_at as string | null) ?? null,
    leaseOwnerHash: (row.lease_owner_hash as string | null) ?? null,
    leaseGeneration: row.lease_generation as number,
    leaseAcquiredAt: (row.lease_acquired_at as string | null) ?? null,
    leaseHeartbeatAt: (row.lease_heartbeat_at as string | null) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    correlationId: row.correlation_id as CorrelationId,
    auditEventId: row.audit_event_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDeletionJob(row: Record<string, unknown>): TenantDeletionJob {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as TenantId,
    workspaceId: (row.workspace_id as WorkspaceId | null) ?? null,
    operation: TENANT_DELETION_JOB_OPERATION,
    scopeKind: row.scope_kind as TenantDeletionJob["scopeKind"],
    scopeSelectorHash: row.scope_selector_hash as string,
    requestedByAuthIdentityId: row.requested_by_auth_identity_id as AuthIdentityId,
    requestedByMembershipId: row.requested_by_membership_id as MembershipId,
    verifiedByAuthIdentityId: (row.verified_by_auth_identity_id as AuthIdentityId | null) ?? null,
    verifiedByMembershipId: (row.verified_by_membership_id as MembershipId | null) ?? null,
    verifiedAt: (row.verified_at as string | null) ?? null,
    approvedByAuthIdentityId: (row.approved_by_auth_identity_id as AuthIdentityId | null) ?? null,
    approvedByMembershipId: (row.approved_by_membership_id as MembershipId | null) ?? null,
    approvedAt: (row.approved_at as string | null) ?? null,
    status: row.status as TenantDeletionJobStatus,
    policyVersion: row.policy_version as string,
    policySnapshotHash: row.policy_snapshot_hash as string,
    inputHash: row.input_hash as string,
    idempotencyKeyHash: row.idempotency_key_hash as string,
    legalHoldStatus: row.legal_hold_status as string,
    freezeHandoffStatus: row.freeze_handoff_status as string,
    accessRevocationHandoffStatus: row.access_revocation_handoff_status as string,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    nextRetryAt: (row.next_retry_at as string | null) ?? null,
    correlationId: row.correlation_id as CorrelationId,
    auditEventId: row.audit_event_id as string,
    errorCode: (row.error_code as TenantDeletionErrorCode | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    primaryDeletedAt: (row.primary_deleted_at as string | null) ?? null,
    backupAgingAt: (row.backup_aging_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    canceledAt: (row.canceled_at as string | null) ?? null,
    backupExpiryTargetAt: (row.backup_expiry_target_at as string | null) ?? null,
  };
}

function mapCheckpoint(row: Record<string, unknown>): TenantDeletionCheckpoint {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    tenantId: row.tenant_id as TenantId,
    workspaceId: (row.workspace_id as WorkspaceId | null) ?? null,
    storeClass: row.store_class as TenantDeletionCheckpointStore,
    status: row.status as TenantDeletionCheckpointStatus,
    attempt: row.attempt as number,
    receiptHash: (row.receipt_hash as string | null) ?? null,
    observedCount: (row.observed_count as number | null) ?? null,
    expectedCount: (row.expected_count as number | null) ?? null,
  };
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

const TENANT_STATUS_CAS_SQL = "UPDATE tenants SET status = ? WHERE id = ? AND status = ?";

const GET_EXPORT_JOB_SQL = "SELECT * FROM tenant_export_jobs WHERE tenant_id = ? AND id = ?";
const GET_EXPORT_JOB_BY_IDEM_SQL =
  "SELECT * FROM tenant_export_jobs WHERE tenant_id = ? AND operation = ? AND idempotency_key_hash = ?";

const INSERT_EXPORT_JOB_SQL = `INSERT INTO tenant_export_jobs
  (id, tenant_id, workspace_id, operation, requester_auth_identity_id, requester_membership_id,
   support_access_grant_id, status, scope_hash, input_hash, idempotency_key_hash,
   policy_version, manifest_version, schema_version, requested_format, correlation_id, audit_event_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const GET_DELETION_JOB_SQL = "SELECT * FROM tenant_deletion_jobs WHERE tenant_id = ? AND id = ?";
const GET_DELETION_JOB_BY_IDEM_SQL =
  "SELECT * FROM tenant_deletion_jobs WHERE tenant_id = ? AND operation = ? AND scope_selector_hash = ? AND idempotency_key_hash = ?";

const INSERT_DELETION_JOB_SQL = `INSERT INTO tenant_deletion_jobs
  (id, tenant_id, workspace_id, operation, scope_kind, scope_selector_hash,
   requested_by_auth_identity_id, requested_by_membership_id, status,
   policy_version, policy_snapshot_hash, input_hash, idempotency_key_hash,
   correlation_id, audit_event_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`;

const LIST_CHECKPOINTS_SQL =
  "SELECT * FROM tenant_deletion_checkpoints WHERE tenant_id = ? AND job_id = ? ORDER BY store_class";

const INSERT_CHECKPOINT_SQL = `INSERT INTO tenant_deletion_checkpoints
  (id, job_id, tenant_id, workspace_id, store_class, opaque_target_hash)
 VALUES (?, ?, ?, ?, ?, ?)`;

const INSERT_CHECKPOINT_EVENT_SQL = `INSERT INTO tenant_deletion_checkpoint_events
  (checkpoint_id, tenant_id, job_id, status, attempt, lease_generation, receipt_hash, reason_code)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TOMBSTONE_SQL = `INSERT INTO tenant_deletion_tombstones
  (id, job_id, tenant_id, workspace_id, scope_selector_hash, tenant_identity_hash, policy_version, retention_until)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const EXPORT_STATUS = new Set<string>(TENANT_EXPORT_JOB_STATUSES);
const DELETION_STATUS = new Set<string>(TENANT_DELETION_JOB_STATUSES);
const CHECKPOINT_STATUS = new Set<string>(TENANT_DELETION_CHECKPOINT_STATUSES);

// ─── Service ─────────────────────────────────────────────────────────────────

export function createTenantLifecycleOperationsService(dependencies: TenantLifecycleOpsDependencies) {
  if (!dependencies?.transactionRunner || typeof dependencies.transactionRunner.run !== "function") {
    fail("FAILED_INTERNAL");
  }
  const idFactory: TenantLifecycleOpsIdFactory = dependencies.idFactory ?? { next: () => randomUUID() };
  const now = (): string => (dependencies.clock?.() ?? new Date()).toISOString();

  async function appendEvent(
    scope: TenantLifecycleOpsTransactionScope,
    event: Omit<TenantLifecycleOpsAuditEvent, "occurredAt">,
  ): Promise<void> {
    await scope.auditWriter.append({ ...event, occurredAt: now() });
  }

  /** CAS the tenant status; a miss is deliberately indistinguishable from absence. */
  async function casTenantStatus(
    scope: TenantLifecycleOpsTransactionScope,
    tenantId: TenantId,
    from: string,
    to: string,
  ): Promise<void> {
    const result = await scope.db.prepare(TENANT_STATUS_CAS_SQL).run(to, tenantId, from);
    if (result.changes !== 1) fail("NOT_FOUND_NON_ENUMERATING");
  }

  async function getExportJob(scope: TenantLifecycleOpsTransactionScope, tenantId: TenantId, jobId: string) {
    const row = await scope.db.prepare(GET_EXPORT_JOB_SQL).get<Record<string, unknown>>(tenantId, jobId);
    if (!row || !EXPORT_STATUS.has(String(row.status))) fail("NOT_FOUND_NON_ENUMERATING");
    return mapExportJob(row);
  }

  async function getDeletionJob(scope: TenantLifecycleOpsTransactionScope, tenantId: TenantId, jobId: string) {
    const row = await scope.db.prepare(GET_DELETION_JOB_SQL).get<Record<string, unknown>>(tenantId, jobId);
    if (!row || !DELETION_STATUS.has(String(row.status))) fail("NOT_FOUND_NON_ENUMERATING");
    return mapDeletionJob(row);
  }

  async function requireMemberActor(
    scope: TenantLifecycleOpsTransactionScope,
    tenantId: TenantId,
    actor: { authIdentityId: AuthIdentityId; membershipId: MembershipId },
    roles: readonly string[],
  ) {
    const membership = await scope.repository.getMembership(tenantId, actor.membershipId);
    if (!membership || membership.authIdentityId !== actor.authIdentityId || membership.status !== "active") {
      fail("NOT_FOUND_NON_ENUMERATING");
    }
    const binding = await scope.repository.getCurrentRoleBinding(tenantId, membership.id);
    if (!binding || binding.revokedAt !== null || !roles.includes(binding.role)) {
      fail("BLOCKED_ACTOR_SCOPE");
    }
    return { membership, binding };
  }

  /**
   * Resolves audit-actor fields for operator decisions (cancel/retry). A member
   * actor must carry a verified role binding — tenant-scope audit rows require
   * membership, role, and binding. Non-member layers must not carry a
   * membership — platform-scope rows require member fields to be absent.
   */
  async function resolveAuditActor(
    scope: TenantLifecycleOpsTransactionScope,
    tenantId: TenantId,
    actor: TenantLifecycleActor,
    roles: readonly string[],
  ): Promise<{ membershipId: MembershipId | null; role: string | null; roleBindingId: string | null }> {
    if (actor.layer === "member") {
      if (!actor.membershipId) fail("BLOCKED_MALFORMED");
      const { membership, binding } = await requireMemberActor(
        scope, tenantId,
        { authIdentityId: actor.authIdentityId, membershipId: actor.membershipId },
        roles,
      );
      return { membershipId: membership.id, role: binding.role, roleBindingId: binding.id };
    }
    if (actor.membershipId) fail("BLOCKED_MALFORMED");
    return { membershipId: null, role: null, roleBindingId: null };
  }

  // ── Suspend / resume / archive ────────────────────────────────────────────

  async function suspend(input: SuspendResumeArchiveInput) {
    return transition(input, "suspended", "tenant.suspended", "OK_SUSPENDED");
  }

  async function resume(input: SuspendResumeArchiveInput) {
    return transition(input, "active", "tenant.resumed", "OK_RESUMED");
  }

  async function archive(input: SuspendResumeArchiveInput) {
    return transition(input, "archived", "tenant.archived", "OK_ARCHIVED");
  }

  async function transition(
    input: SuspendResumeArchiveInput,
    toStatus: "active" | "suspended" | "archived",
    eventType: TenantLifecycleOpsAuditEvent["eventType"],
    code: TenantLifecycleOpsCode,
  ) {
    return dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      if (!tenant || tenant.status !== input.expectedCurrentState) fail("NOT_FOUND_NON_ENUMERATING");
      if (!canTransitionTenant(input.expectedCurrentState, toStatus).allowed) fail("BLOCKED_STATE_CONFLICT");
      // Member actors carry their verified role binding into the audit record;
      // member-scope audit rows require all three actor fields non-null.
      let actorRole: string | null = null;
      let actorRoleBindingId: string | null = null;
      if (input.actor.layer === "member") {
        if (!input.actor.membershipId) fail("BLOCKED_MALFORMED");
        const { binding } = await requireMemberActor(
          scope, input.tenantId,
          { authIdentityId: input.actor.authIdentityId, membershipId: input.actor.membershipId },
          ["owner", "admin"],
        );
        actorRole = binding.role;
        actorRoleBindingId = binding.id;
      }
      await casTenantStatus(scope, input.tenantId, input.expectedCurrentState, toStatus);
      await appendEvent(scope, {
        eventId: idFactory.next("audit"),
        eventType,
        tenantId: input.tenantId,
        workspaceId: null,
        jobId: null,
        actorIdentityId: input.actor.authIdentityId,
        actorLayer: input.actor.layer,
        actorMembershipId: input.actor.membershipId ?? null,
        actorRole,
        actorRoleBindingId,
        correlationId: input.correlationId,
        tenantFromStatus: input.expectedCurrentState,
        tenantToStatus: toStatus,
        reasonCode: input.reasonCode,
        reason: input.reason,
      });
      const updated = await scope.repository.getTenant(input.tenantId);
      if (!updated || updated.status !== toStatus) fail("FAILED_INTERNAL");
      return { code, tenant: updated };
    });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  async function requestExport(input: RequestTenantExportInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantExportJob; replayed: boolean }> {
    const format = input.format ?? "json";
    if (input.requester?.membershipId && getTenantContext()
      && (await consumeLimit(dependencies.limits, "export_request", String(input.idempotencyKey))) !== "allowed") {
      fail("BLOCKED_LIMIT");
    }
    return dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      if (!tenant || !canTenantOperation(tenant.status, "export").allowed) fail("NOT_FOUND_NON_ENUMERATING");
      const policy = await scope.repository.getCurrentTenantPolicy(input.tenantId);
      if (!policy) fail("NOT_FOUND_NON_ENUMERATING");

      const workspaceId = input.workspaceId ?? null;
      const idemHash = exportIdempotencyHash(input.idempotencyKey);
      const inputHash = exportInputHash(input.tenantId, workspaceId, format);
      const prior = await scope.db.prepare(GET_EXPORT_JOB_BY_IDEM_SQL)
        .get<Record<string, unknown>>(input.tenantId, TENANT_EXPORT_JOB_OPERATION, idemHash);
      if (prior) {
        if (prior.input_hash !== inputHash) fail("BLOCKED_REPLAY_CONFLICT");
        return { code: "OK_EXPORT_REQUESTED", job: mapExportJob(prior), replayed: true };
      }

      let actorMembershipId: MembershipId | null = null;
      let actorRole: string | null = null;
      let actorRoleBindingId: string | null = null;
      if (input.requester.membershipId) {
        const { membership, binding } = await requireMemberActor(
          scope, input.tenantId,
          { authIdentityId: input.requester.authIdentityId, membershipId: input.requester.membershipId },
          ["owner", "admin"],
        );
        actorMembershipId = membership.id;
        actorRole = binding.role;
        actorRoleBindingId = binding.id;
      } else if (input.requester.supportAccessGrantId) {
        const grant = await scope.db.prepare(
          `SELECT tenant_id, workspace_id, state, revoked_at, starts_at, expires_at, support_actor_auth_identity_id
           FROM support_access_grants WHERE id = ?`,
        ).get<Record<string, unknown>>(input.requester.supportAccessGrantId);
        const at = now();
        const grantValid = grant
          && grant.tenant_id === input.tenantId
          && grant.support_actor_auth_identity_id === input.requester.authIdentityId
          && grant.state === "approved"
          && grant.revoked_at === null
          && (grant.workspace_id === null || grant.workspace_id === workspaceId)
          && (grant.starts_at as string) <= at
          && (grant.expires_at as string) > at;
        if (!grantValid) fail("NOT_FOUND_NON_ENUMERATING");
        const permission = await scope.db.prepare(
          "SELECT 1 FROM support_access_grant_permissions WHERE grant_id = ? AND permission = 'data:export'",
        ).get(input.requester.supportAccessGrantId);
        if (!permission) fail("NOT_FOUND_NON_ENUMERATING");
      } else {
        fail("BLOCKED_MALFORMED");
      }

      const jobId = idFactory.next("export_job");
      const auditId = idFactory.next("audit");
      const inserted = await scope.db.prepare(INSERT_EXPORT_JOB_SQL).run(
        jobId, input.tenantId, workspaceId, TENANT_EXPORT_JOB_OPERATION,
        input.requester.authIdentityId, input.requester.membershipId ?? null,
        input.requester.supportAccessGrantId ?? null,
        exportScopeHash(input.tenantId, workspaceId, format), inputHash, idemHash,
        tenantPolicyVersionRef(policy.version), TENANT_EXPORT_MANIFEST_VERSION,
        TENANT_EXPORT_SCHEMA_VERSION, format, input.correlationId, auditId,
      );
      if (inserted.changes !== 1) fail("FAILED_INTERNAL");

      await appendEvent(scope, {
        eventId: auditId, eventType: "tenant.export.requested",
        tenantId: input.tenantId, workspaceId, jobId,
        actorIdentityId: input.requester.authIdentityId,
        actorLayer: input.requester.membershipId ? "member" : "support",
        actorMembershipId, actorRole, actorRoleBindingId,
        correlationId: input.correlationId,
      });
      const job = await getExportJob(scope, input.tenantId, jobId);
      return { code: "OK_EXPORT_REQUESTED", job, replayed: false };
    });
  }

  async function runExport(input: RunTenantExportInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantExportJob }> {
    const outcome = await dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      const job = await getExportJob(scope, input.tenantId, input.jobId);
      if (!tenant || !canTenantOperation(tenant.status, "export").allowed) fail("NOT_FOUND_NON_ENUMERATING");
      if (job.status !== "requested" && job.status !== "retry_wait") fail("BLOCKED_STATE_CONFLICT");

      const enter = await scope.db.prepare(
        "UPDATE tenant_export_jobs SET status = 'snapshotting', next_retry_at = NULL WHERE tenant_id = ? AND id = ? AND status = ?",
      ).run(input.tenantId, job.id, job.status);
      if (enter.changes !== 1) fail("FAILED_INTERNAL");

      const policy = await scope.repository.getCurrentTenantPolicy(input.tenantId);
      const retentionDays = Math.min(Math.max(policy?.exportRetentionDays ?? 1, 1), 7);
      const artifactCreatedAt = now();
      const artifactExpiresAt = new Date(
        new Date(artifactCreatedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      let facts: TenantExportArtifactFacts;
      try {
        facts = await dependencies.exportRunner.execute({
          job, tenantId: input.tenantId, workspaceId: job.workspaceId,
          format: job.requestedFormat, artifactExpiresAt,
        });
      } catch (error) {
        // The failure ledger must commit; the caller throws after this tx returns.
        const code: TenantExportErrorCode =
          error instanceof TenantLifecycleOpsError && error.code === "BLOCKED_STATE_CONFLICT"
            ? "EXPORT_POLICY_BLOCKED" : "EXPORT_UNKNOWN_FAILURE";
        // retry_count is immutable outside retry_wait entry; requeueExport owns the bump.
        await scope.db.prepare(
          `UPDATE tenant_export_jobs SET status = 'failed', error_code = ?, error_message = ?
           WHERE tenant_id = ? AND id = ? AND status = 'snapshotting'`,
        ).run(code, "export pipeline execution failed", input.tenantId, job.id);
        await appendEvent(scope, {
          eventId: idFactory.next("audit"), eventType: "tenant.export.failed",
          tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
          actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
          actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
          correlationId: input.correlationId,
        });
        return { failed: true as const, job: await getExportJob(scope, input.tenantId, job.id) };
      }

      const redacting = await scope.db.prepare(
        `UPDATE tenant_export_jobs SET status = 'redacting', snapshot_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'snapshotting'`,
      ).run(facts.snapshotAt, input.tenantId, job.id);
      if (redacting.changes !== 1) fail("FAILED_INTERNAL");

      const artifact = await scope.db.prepare(
        `UPDATE tenant_export_jobs SET status = 'artifact_created',
           artifact_storage_ref = ?, artifact_checksum_sha256 = ?, included_count = ?,
           excluded_count = ?, redacted_count = ?, artifact_created_at = ?, expires_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'redacting'`,
      ).run(
        facts.artifactStorageRef, facts.checksumSha256, facts.includedCount,
        facts.excludedCount, facts.redactedCount, facts.artifactCreatedAt, facts.expiresAt,
        input.tenantId, job.id,
      );
      if (artifact.changes !== 1) fail("FAILED_INTERNAL");

      const released = await scope.db.prepare(
        "UPDATE tenant_export_jobs SET status = 'released' WHERE tenant_id = ? AND id = ? AND status = 'artifact_created'",
      ).run(input.tenantId, job.id);
      if (released.changes !== 1) fail("FAILED_INTERNAL");

      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.export.released",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
        actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
        correlationId: input.correlationId,
      });
      return { failed: false as const, job: await getExportJob(scope, input.tenantId, job.id) };
    });
    if (outcome.failed) fail("FAILED_INTERNAL");
    return { code: "OK_EXPORT_COMPLETED", job: outcome.job };
  }

  async function cancelExport(input: CancelTenantExportInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantExportJob }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const job = await getExportJob(scope, input.tenantId, input.jobId);
      const cancelable = ["requested", "snapshotting", "redacting", "artifact_created", "retry_wait", "failed"];
      if (!cancelable.includes(job.status)) fail("BLOCKED_STATE_CONFLICT");
      const actor = await resolveAuditActor(scope, input.tenantId, input.actor, ["owner", "admin"]);
      const result = await scope.db.prepare(
        `UPDATE tenant_export_jobs SET status = 'canceled', error_code = 'EXPORT_CANCELED', error_message = ?
         WHERE tenant_id = ? AND id = ? AND status = ?`,
      ).run("export canceled by operator", input.tenantId, job.id, job.status);
      if (result.changes !== 1) fail("FAILED_INTERNAL");
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.export.canceled",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.actor.authIdentityId, actorLayer: input.actor.layer,
        actorMembershipId: actor.membershipId, actorRole: actor.role, actorRoleBindingId: actor.roleBindingId,
        correlationId: input.correlationId,
      });
      return { code: "OK_EXPORT_CANCELED", job: await getExportJob(scope, input.tenantId, job.id) };
    });
  }

  /**
   * Member/operator retry: moves a failed export back to retry_wait. The
   * retry_wait entry consumes one retry slot — the jobs trigger requires the
   * +1 bump exactly here and forbids retry_count changes anywhere else.
   */
  async function requeueExport(input: CancelTenantExportInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantExportJob }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const job = await getExportJob(scope, input.tenantId, input.jobId);
      // retry_wait requires retry_count < max_retries after the +1 entry bump.
      if (job.status !== "failed" || job.retryCount + 1 >= job.maxRetries) fail("BLOCKED_STATE_CONFLICT");
      const actor = await resolveAuditActor(scope, input.tenantId, input.actor, ["owner", "admin"]);
      const nextRetryAt = new Date(new Date(now()).getTime() + 5 * 60 * 1000).toISOString();
      const result = await scope.db.prepare(
        `UPDATE tenant_export_jobs SET status = 'retry_wait', retry_count = retry_count + 1,
           next_retry_at = ?, error_code = 'EXPORT_RETRYABLE', error_message = ?
         WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
      ).run(nextRetryAt, "export requeued for retry", input.tenantId, job.id);
      if (result.changes !== 1) fail("FAILED_INTERNAL");
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.export.requeued",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.actor.authIdentityId, actorLayer: input.actor.layer,
        actorMembershipId: actor.membershipId, actorRole: actor.role, actorRoleBindingId: actor.roleBindingId,
        correlationId: input.correlationId,
      });
      return { code: "OK_EXPORT_RUNNING", job: await getExportJob(scope, input.tenantId, job.id) };
    });
  }

  async function sweepExportRetention(input: SweepTenantExportRetentionInput): Promise<{ code: TenantLifecycleOpsCode; expiredJobIds: string[]; deletedJobIds: string[] }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      if (!tenant) fail("NOT_FOUND_NON_ENUMERATING");
      const at = now();
      const deletedJobIds: string[] = [];
      const expiredJobIds: string[] = [];

      // Delete first: jobs that expired in an earlier pass purge their bytes
      // now, so each job advances exactly one legal transition per sweep.
      const expired = await scope.db.prepare(
        "SELECT id FROM tenant_export_jobs WHERE tenant_id = ? AND status = 'expired' ORDER BY created_at",
      ).all<{ id: string }>(input.tenantId);
      for (const { id: jobId } of expired) {
        const job = await getExportJob(scope, input.tenantId, jobId);
        await dependencies.exportRunner.purge({ job, tenantId: input.tenantId });
        const deleted = await scope.db.prepare(
          "UPDATE tenant_export_jobs SET status = 'deleted' WHERE tenant_id = ? AND id = ? AND status = 'expired'",
        ).run(input.tenantId, job.id);
        if (deleted.changes !== 1) fail("FAILED_INTERNAL");
        await appendEvent(scope, {
          eventId: idFactory.next("audit"), eventType: "tenant.export.deleted",
          tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
          actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
          actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
          correlationId: input.correlationId,
        });
        deletedJobIds.push(job.id);
      }

      const releasable = await scope.db.prepare(
        "SELECT id FROM tenant_export_jobs WHERE tenant_id = ? AND status = 'released' AND expires_at <= ? ORDER BY created_at",
      ).all<{ id: string }>(input.tenantId, at);
      for (const { id: jobId } of releasable) {
        const job = await getExportJob(scope, input.tenantId, jobId);
        const expiredNow = await scope.db.prepare(
          "UPDATE tenant_export_jobs SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'released'",
        ).run(input.tenantId, job.id);
        if (expiredNow.changes !== 1) fail("FAILED_INTERNAL");
        await appendEvent(scope, {
          eventId: idFactory.next("audit"), eventType: "tenant.export.expired",
          tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
          actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
          actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
          correlationId: input.correlationId,
        });
        expiredJobIds.push(job.id);
      }

      return { code: "OK_EXPORT_SWEPT", expiredJobIds, deletedJobIds };
    });
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  async function requestDeletion(input: RequestTenantDeletionInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantDeletionJob; replayed: boolean }> {
    if (input.requester?.membershipId && getTenantContext()
      && (await consumeLimit(dependencies.limits, "deletion_request", String(input.idempotencyKey))) !== "allowed") {
      fail("BLOCKED_LIMIT");
    }
    return dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      if (!tenant || !canTenantOperation(tenant.status, "deletion_request").allowed) {
        fail("NOT_FOUND_NON_ENUMERATING");
      }
      const policy = await scope.repository.getCurrentTenantPolicy(input.tenantId);
      if (!policy) fail("NOT_FOUND_NON_ENUMERATING");

      const workspaceId = input.workspaceId ?? null;
      const scopeKind = workspaceId ? "workspace" : "tenant";
      const scopeHash = deletionScopeHash(input.tenantId, workspaceId, scopeKind);
      const idemHash = deletionIdempotencyHash(input.idempotencyKey);
      const inputHash = deletionInputHash(input.tenantId, workspaceId, input.requester.membershipId);

      const prior = await scope.db.prepare(GET_DELETION_JOB_BY_IDEM_SQL)
        .get<Record<string, unknown>>(input.tenantId, TENANT_DELETION_JOB_OPERATION, scopeHash, idemHash);
      if (prior) {
        if (prior.input_hash !== inputHash) fail("BLOCKED_REPLAY_CONFLICT");
        return { code: "OK_DELETION_REQUESTED", job: mapDeletionJob(prior), replayed: true };
      }

      const { membership, binding } = await requireMemberActor(
        scope, input.tenantId, input.requester, ["owner"],
      );

      const jobId = idFactory.next("deletion_job");
      const auditId = idFactory.next("audit");
      const inserted = await scope.db.prepare(INSERT_DELETION_JOB_SQL).run(
        jobId, input.tenantId, workspaceId, TENANT_DELETION_JOB_OPERATION, scopeKind, scopeHash,
        input.requester.authIdentityId, membership.id, tenantPolicyVersionRef(policy.version),
        policySnapshotHash(policy), inputHash, idemHash, input.correlationId, auditId,
      );
      if (inserted.changes !== 1) fail("FAILED_INTERNAL");

      await casTenantStatus(scope, input.tenantId, "archived", "deletion_pending");
      await appendEvent(scope, {
        eventId: auditId, eventType: "tenant.deletion.requested",
        tenantId: input.tenantId, workspaceId, jobId,
        actorIdentityId: input.requester.authIdentityId, actorLayer: "member",
        actorMembershipId: membership.id, actorRole: binding.role, actorRoleBindingId: binding.id,
        correlationId: input.correlationId,
        tenantFromStatus: "archived",
        tenantToStatus: "deletion_pending",
      });
      return { code: "OK_DELETION_REQUESTED", job: await getDeletionJob(scope, input.tenantId, jobId), replayed: false };
    });
  }

  async function verifyDeletion(input: VerifyTenantDeletionInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantDeletionJob }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const job = await getDeletionJob(scope, input.tenantId, input.jobId);
      if (job.status !== "requested") fail("BLOCKED_STATE_CONFLICT");
      const { membership, binding } = await requireMemberActor(scope, input.tenantId, input.verifier, ["owner", "admin"]);
      if (membership.id === job.requestedByMembershipId || input.verifier.authIdentityId === job.requestedByAuthIdentityId) {
        fail("BLOCKED_APPROVAL_INDEPENDENCE");
      }
      const at = now();
      const result = await scope.db.prepare(
        `UPDATE tenant_deletion_jobs SET status = 'verified',
           verified_by_auth_identity_id = ?, verified_by_membership_id = ?, verified_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'requested'`,
      ).run(input.verifier.authIdentityId, membership.id, at, input.tenantId, job.id);
      if (result.changes !== 1) fail("FAILED_INTERNAL");
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.deletion.verified",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.verifier.authIdentityId, actorLayer: "member",
        actorMembershipId: membership.id, actorRole: binding.role, actorRoleBindingId: binding.id,
        correlationId: input.correlationId,
      });
      return { code: "OK_DELETION_VERIFIED", job: await getDeletionJob(scope, input.tenantId, job.id) };
    });
  }

  async function approveDeletion(input: ApproveTenantDeletionInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantDeletionJob }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const job = await getDeletionJob(scope, input.tenantId, input.jobId);
      if (job.status !== "verified" || !job.verifiedAt) fail("BLOCKED_STATE_CONFLICT");
      const { membership, binding } = await requireMemberActor(scope, input.tenantId, input.approver, ["owner"]);
      if (membership.id === job.requestedByMembershipId || membership.id === job.verifiedByMembershipId
        || input.approver.authIdentityId === job.requestedByAuthIdentityId
        || input.approver.authIdentityId === job.verifiedByAuthIdentityId) {
        fail("BLOCKED_APPROVAL_INDEPENDENCE");
      }
      const policy = await scope.repository.getCurrentTenantPolicy(input.tenantId);
      const scheduledAt = new Date(
        new Date(now()).getTime() + Math.max(policy?.primaryDeleteWithinDays ?? 0, 0) * 24 * 60 * 60 * 1000,
      ).toISOString();
      const at = now();
      const result = await scope.db.prepare(
        `UPDATE tenant_deletion_jobs SET status = 'scheduled',
           approved_by_auth_identity_id = ?, approved_by_membership_id = ?, approved_at = ?, scheduled_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'verified'`,
      ).run(input.approver.authIdentityId, membership.id, at, scheduledAt, input.tenantId, job.id);
      if (result.changes !== 1) fail("FAILED_INTERNAL");
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.deletion.scheduled",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.approver.authIdentityId, actorLayer: "member",
        actorMembershipId: membership.id, actorRole: binding.role, actorRoleBindingId: binding.id,
        correlationId: input.correlationId,
      });
      return { code: "OK_DELETION_SCHEDULED", job: await getDeletionJob(scope, input.tenantId, job.id) };
    });
  }

  async function listCheckpoints(scope: TenantLifecycleOpsTransactionScope, tenantId: TenantId, jobId: string) {
    const rows = await scope.db.prepare(LIST_CHECKPOINTS_SQL).all<Record<string, unknown>>(tenantId, jobId);
    return rows.map(mapCheckpoint);
  }

  async function runDeletion(input: RunTenantDeletionInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantDeletionJob }> {
    const outcome = await dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      if (!tenant || tenant.status !== "deletion_pending") fail("NOT_FOUND_NON_ENUMERATING");
      let job = await getDeletionJob(scope, input.tenantId, input.jobId);
      if (job.status !== "scheduled" && job.status !== "retry_wait") fail("BLOCKED_STATE_CONFLICT");
      // The approval schedules the run; executing early violates the ledger's clock ordering.
      if (job.status === "scheduled" && job.scheduledAt && job.scheduledAt > now()) {
        fail("BLOCKED_STATE_CONFLICT");
      }

      // The job guard requires the canonical checkpoint set before execution.
      await ensureCheckpoints(scope, job);

      // started_at is immutable once set; only the scheduled→running edge stamps it.
      const start = job.status === "scheduled"
        ? await scope.db.prepare(
            "UPDATE tenant_deletion_jobs SET status = 'running', started_at = ? WHERE tenant_id = ? AND id = ? AND status = 'scheduled'",
          ).run(now(), input.tenantId, job.id)
        : await scope.db.prepare(
            `UPDATE tenant_deletion_jobs SET status = 'running',
               next_retry_at = NULL, error_code = NULL, error_fingerprint = NULL
             WHERE tenant_id = ? AND id = ? AND status = 'retry_wait'`,
          ).run(input.tenantId, job.id);
      if (start.changes !== 1) fail("FAILED_INTERNAL");
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.deletion.running",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
        actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
        correlationId: input.correlationId,
      });
      job = await getDeletionJob(scope, input.tenantId, job.id);

      try {
        const primaryStores = TENANT_DELETION_CHECKPOINT_STORES.filter((store) => store !== "backup_aging");
        for (const store of primaryStores) await executeCheckpoint(scope, job, store);

        const checkpoints = await listCheckpoints(scope, input.tenantId, job.id);
        if (!canEnterTenantDeletionPrimaryDeleted({ checkpoints: checkpoints.map(toCheckpointInput) })) {
          fail("FAILED_INTERNAL");
        }

        const policy = await scope.repository.getCurrentTenantPolicy(input.tenantId);
        const backupTarget = new Date(
          new Date(now()).getTime() + Math.max(policy?.backupExpireWithinDays ?? 30, 0) * 24 * 60 * 60 * 1000,
        ).toISOString();
        const primary = await scope.db.prepare(
          `UPDATE tenant_deletion_jobs SET status = 'primary_deleted', primary_deleted_at = ?, backup_expiry_target_at = ?
           WHERE tenant_id = ? AND id = ? AND status = 'running'`,
        ).run(now(), backupTarget, input.tenantId, job.id);
        if (primary.changes !== 1) fail("FAILED_INTERNAL");
        await casTenantStatus(scope, input.tenantId, "deletion_pending", "deleted");
        await appendEvent(scope, {
          eventId: idFactory.next("audit"), eventType: "tenant.deletion.primary_deleted",
          tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
          actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
          actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
          correlationId: input.correlationId,
          tenantFromStatus: "deletion_pending",
          tenantToStatus: "deleted",
        });
        job = await getDeletionJob(scope, input.tenantId, job.id);

        await executeCheckpoint(scope, job, "backup_aging");

        const aging = await scope.db.prepare(
          "UPDATE tenant_deletion_jobs SET status = 'backup_aging', backup_aging_at = ? WHERE tenant_id = ? AND id = ? AND status = 'primary_deleted'",
        ).run(now(), input.tenantId, job.id);
        if (aging.changes !== 1) fail("FAILED_INTERNAL");

        await writeTombstone(scope, job);

        const done = await scope.db.prepare(
          "UPDATE tenant_deletion_jobs SET status = 'completed', completed_at = ? WHERE tenant_id = ? AND id = ? AND status = 'backup_aging'",
        ).run(now(), input.tenantId, job.id);
        if (done.changes !== 1) fail("FAILED_INTERNAL");
        await appendEvent(scope, {
          eventId: idFactory.next("audit"), eventType: "tenant.deletion.completed",
          tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
          actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
          actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
          correlationId: input.correlationId,
        });
        return { failed: false as const, job: await getDeletionJob(scope, input.tenantId, job.id) };
      } catch (error) {
        if (error instanceof TenantLifecycleOpsError) throw error;
        // The failure ledger must commit; the caller throws after this tx returns.
        const fingerprint = sha256(`novatrade:tenant-deletion-error:v1:${job.id}:${now()}`);
        const stranded = await listCheckpoints(scope, input.tenantId, job.id);
        for (const checkpoint of stranded.filter((entry) => entry.status === "running")) {
          await scope.db.prepare(
            `UPDATE tenant_deletion_checkpoints SET status = 'failed',
               error_code = 'DELETE_CHECKPOINT_FAILED', error_fingerprint = ?
             WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = 'running'`,
          ).run(fingerprint, job.tenantId, job.id, checkpoint.storeClass);
          await scope.db.prepare(INSERT_CHECKPOINT_EVENT_SQL).run(
            checkpoint.id, job.tenantId, job.id, "failed", checkpoint.attempt, 0, null, null,
          );
        }
        await scope.db.prepare(
          `UPDATE tenant_deletion_jobs SET status = 'failed', error_code = 'DELETE_INTERNAL', error_fingerprint = ?
           WHERE tenant_id = ? AND id = ? AND status = 'running'`,
        ).run(fingerprint, input.tenantId, job.id);
        await appendEvent(scope, {
          eventId: idFactory.next("audit"), eventType: "tenant.deletion.failed",
          tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
          actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
          actorMembershipId: null, actorRole: null, actorRoleBindingId: null,
          correlationId: input.correlationId,
        });
        return { failed: true as const, job: await getDeletionJob(scope, input.tenantId, job.id) };
      }
    });
    if (outcome.failed) fail("FAILED_INTERNAL");
    return { code: "OK_DELETION_COMPLETED", job: outcome.job };
  }

  /** Insert the canonical 10-store checkpoint set if absent. */
  async function ensureCheckpoints(scope: TenantLifecycleOpsTransactionScope, job: TenantDeletionJob): Promise<void> {
    const existing = await listCheckpoints(scope, job.tenantId, job.id);
    const present = new Set(existing.map((checkpoint) => checkpoint.storeClass));
    for (const store of TENANT_DELETION_CHECKPOINT_STORES) {
      if (present.has(store)) continue;
      const inserted = await scope.db.prepare(INSERT_CHECKPOINT_SQL).run(
        idFactory.next("checkpoint"), job.id, job.tenantId, job.workspaceId,
        store, deletionTargetHash(job.id, store),
      );
      if (inserted.changes !== 1) fail("FAILED_INTERNAL");
      const row = await scope.db.prepare(
        "SELECT * FROM tenant_deletion_checkpoints WHERE tenant_id = ? AND job_id = ? AND store_class = ?",
      ).get<Record<string, unknown>>(job.tenantId, job.id, store);
      if (!row) fail("FAILED_INTERNAL");
      await scope.db.prepare(INSERT_CHECKPOINT_EVENT_SQL).run(
        (row.id as string), job.tenantId, job.id, "pending", 0, 0, null, null,
      );
    }
  }

  async function executeCheckpoint(
    scope: TenantLifecycleOpsTransactionScope,
    job: TenantDeletionJob,
    store: TenantDeletionCheckpointStore,
  ): Promise<void> {
    const row = await scope.db.prepare(
      "SELECT * FROM tenant_deletion_checkpoints WHERE tenant_id = ? AND job_id = ? AND store_class = ?",
    ).get<Record<string, unknown>>(job.tenantId, job.id, store);
    if (!row || !CHECKPOINT_STATUS.has(String(row.status))) fail("FAILED_INTERNAL");
    const checkpoint = mapCheckpoint(row);
    if (checkpoint.status === "complete" || checkpoint.status === "exempted") return;
    let attempt = checkpoint.attempt;

    // A failed checkpoint re-enters through retryable with a bounded attempt bump.
    if (checkpoint.status === "failed") {
      attempt += 1;
      const fingerprint = sha256(`novatrade:tenant-deletion-retry:v1:${job.id}:${store}:${attempt}`);
      const retryable = await scope.db.prepare(
        `UPDATE tenant_deletion_checkpoints SET status = 'retryable', attempt = ?,
           error_code = 'DELETE_CHECKPOINT_RETRYABLE', error_fingerprint = ?
         WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = 'failed'`,
      ).run(attempt, fingerprint, job.tenantId, job.id, store);
      if (retryable.changes !== 1) fail("FAILED_INTERNAL");
      await scope.db.prepare(INSERT_CHECKPOINT_EVENT_SQL).run(
        checkpoint.id, job.tenantId, job.id, "retryable", attempt, 0, null, null,
      );
    }

    const fromStatus = checkpoint.status === "failed" ? "retryable" : checkpoint.status;
    if (!isTenantDeletionCheckpointTransitionAllowed(fromStatus, "running")) fail("FAILED_INTERNAL");

    // running requires the retryable error facts cleared.
    const running = await scope.db.prepare(
      `UPDATE tenant_deletion_checkpoints SET status = 'running', started_at = ?,
         error_code = NULL, error_fingerprint = NULL
       WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = ?`,
    ).run(now(), job.tenantId, job.id, store, fromStatus);
    if (running.changes !== 1) fail("FAILED_INTERNAL");
    // The event ledger dedupes on (checkpoint, attempt, generation, status);
    // a re-run of an already-running checkpoint must not re-emit it.
    if (fromStatus !== "running") {
      await scope.db.prepare(INSERT_CHECKPOINT_EVENT_SQL).run(
        checkpoint.id, job.tenantId, job.id, "running", attempt, 0, null, null,
      );
    }

    const receipt = await dependencies.deletionStore.execute({ job, checkpoint, db: scope.db });
    const done = await scope.db.prepare(
      `UPDATE tenant_deletion_checkpoints SET status = 'complete', completed_at = ?,
         receipt_hash = ?, observed_count = ?, expected_count = ?
       WHERE tenant_id = ? AND job_id = ? AND store_class = ? AND status = 'running'`,
    ).run(now(), receipt.receiptHash, receipt.observedCount, receipt.expectedCount, job.tenantId, job.id, store);
    if (done.changes !== 1) fail("FAILED_INTERNAL");
    await scope.db.prepare(INSERT_CHECKPOINT_EVENT_SQL).run(
      checkpoint.id, job.tenantId, job.id, "complete", attempt, 0, receipt.receiptHash, null,
    );
  }

  async function writeTombstone(scope: TenantLifecycleOpsTransactionScope, job: TenantDeletionJob): Promise<void> {
    const policy = await scope.repository.getCurrentTenantPolicy(job.tenantId);
    const retentionUntil = new Date(
      new Date(now()).getTime() + (policy?.tombstoneRetentionYears ?? 7) * 365.25 * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000,
    ).toISOString();
    const inserted = await scope.db.prepare(INSERT_TOMBSTONE_SQL).run(
      idFactory.next("tombstone"), job.id, job.tenantId, job.workspaceId,
      job.scopeSelectorHash, tenantIdentityHash(job.tenantId), job.policyVersion, retentionUntil,
    );
    if (inserted.changes !== 1) fail("FAILED_INTERNAL");
  }

  /** Moves a failed job back into the retry window so runDeletion can resume it. */
  async function requeueDeletion(input: RunTenantDeletionInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantDeletionJob }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const job = await getDeletionJob(scope, input.tenantId, input.jobId);
      if (job.status !== "failed") fail("BLOCKED_STATE_CONFLICT");
      if (job.retryCount + 1 > job.maxRetries) fail("BLOCKED_STATE_CONFLICT");
      const actor = await resolveAuditActor(scope, input.tenantId, input.executor, ["owner", "admin"]);
      const fingerprint = sha256(`novatrade:tenant-deletion-requeue:v1:${job.id}:${job.retryCount + 1}`);
      const nextRetryAt = new Date(new Date(now()).getTime() + 5 * 60 * 1000).toISOString();
      const result = await scope.db.prepare(
        `UPDATE tenant_deletion_jobs SET status = 'retry_wait', retry_count = retry_count + 1,
           next_retry_at = ?, error_code = 'DELETE_CHECKPOINT_RETRYABLE', error_fingerprint = ?
         WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
      ).run(nextRetryAt, fingerprint, input.tenantId, job.id);
      if (result.changes !== 1) fail("FAILED_INTERNAL");
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.deletion.requeued",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.executor.authIdentityId, actorLayer: input.executor.layer,
        actorMembershipId: actor.membershipId, actorRole: actor.role, actorRoleBindingId: actor.roleBindingId,
        correlationId: input.correlationId,
      });
      return { code: "OK_DELETION_RUNNING", job: await getDeletionJob(scope, input.tenantId, job.id) };
    });
  }

  /** Cancel-before-run is the durable rollback path: tenant returns to archived. */
  async function cancelDeletion(input: CancelTenantDeletionInput): Promise<{ code: TenantLifecycleOpsCode; job: TenantDeletionJob }> {
    return dependencies.transactionRunner.run(async (scope) => {
      const tenant = await scope.repository.getTenant(input.tenantId);
      const job = await getDeletionJob(scope, input.tenantId, input.jobId);
      if (!tenant) fail("NOT_FOUND_NON_ENUMERATING");
      if (!isTenantDeletionTransitionAllowed(job.status, "canceled")) fail("BLOCKED_STATE_CONFLICT");
      const actor = await resolveAuditActor(scope, input.tenantId, input.actor, ["owner", "admin"]);
      const result = await scope.db.prepare(
        `UPDATE tenant_deletion_jobs SET status = 'canceled', canceled_at = ?
         WHERE tenant_id = ? AND id = ? AND status = ?`,
      ).run(now(), input.tenantId, job.id, job.status);
      if (result.changes !== 1) fail("FAILED_INTERNAL");
      const rolledBack = tenant.status === "deletion_pending";
      if (rolledBack) {
        await casTenantStatus(scope, input.tenantId, "deletion_pending", "archived");
      }
      await appendEvent(scope, {
        eventId: idFactory.next("audit"), eventType: "tenant.deletion.canceled",
        tenantId: input.tenantId, workspaceId: job.workspaceId, jobId: job.id,
        actorIdentityId: input.actor.authIdentityId, actorLayer: input.actor.layer,
        actorMembershipId: actor.membershipId, actorRole: actor.role, actorRoleBindingId: actor.roleBindingId,
        correlationId: input.correlationId,
        ...(rolledBack ? { tenantFromStatus: "deletion_pending" as const, tenantToStatus: "archived" as const } : {}),
      });
      return { code: "OK_DELETION_CANCELED", job: await getDeletionJob(scope, input.tenantId, job.id) };
    });
  }

  return {
    suspend,
    resume,
    archive,
    requestExport,
    runExport,
    cancelExport,
    requeueExport,
    sweepExportRetention,
    getExportJob: (tenantId: TenantId, jobId: string) =>
      dependencies.transactionRunner.run((scope) => getExportJob(scope, tenantId, jobId)),
    requestDeletion,
    verifyDeletion,
    approveDeletion,
    runDeletion,
    requeueDeletion,
    cancelDeletion,
    getDeletionJob: (tenantId: TenantId, jobId: string) =>
      dependencies.transactionRunner.run((scope) => getDeletionJob(scope, tenantId, jobId)),
    listDeletionCheckpoints: (tenantId: TenantId, jobId: string) =>
      dependencies.transactionRunner.run((scope) => listCheckpoints(scope, tenantId, jobId)),
  };
}

export type TenantLifecycleOperationsService = ReturnType<typeof createTenantLifecycleOperationsService>;

function toCheckpointInput(checkpoint: TenantDeletionCheckpoint): TenantDeletionCheckpointInput {
  return {
    store: checkpoint.storeClass,
    status: checkpoint.status,
    required: true,
    exemptionReason: null,
    exemptionApproved: false,
  };
}
