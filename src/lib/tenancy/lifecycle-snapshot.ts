import type { DbClient } from "@/lib/db";
import type { TenantDeletionJobView } from "@/components/admin/data-lifecycle-panel";
import type {
  TenantLifecycleAuditSummary,
  TenantLifecycleSnapshot,
} from "@/components/admin/tenant-lifecycle-panel";
import type { TenantLifecycleOperationsService } from "@/lib/tenancy/lifecycle-operations";
import { createTenantQueryRepository, type Tenant } from "@/lib/tenancy/queries";
import type { TenantExportJob } from "@/lib/tenancy/types";
import {
  TENANT_DELETION_FREEZE_HANDOFF_STATUSES,
  TENANT_STATUSES,
  type TenantDeletionFreezeHandoffStatus,
  type TenantStatus,
} from "@/lib/tenancy/types";

/**
 * Read-side projection for the tenant lifecycle panel. The panel is
 * mutation-agnostic and fail-closed: it only renders controls when the
 * snapshot carries a recorded audit receipt bound to the current status.
 * This loader derives that receipt from the canonical `audit_logs` ledger —
 * every status-producing lifecycle op records `tenantFromStatus`/
 * `tenantToStatus` in its event metadata, and owner acceptance records
 * `tenant.provisioned`.
 */

type Row = Record<string, unknown>;

/**
 * Audit actions that can move the tenant status. `tenant.deletion.canceled`
 * only counts when the event actually rolled the tenant back (its metadata
 * carries the to-status only then). Job progress events
 * (verified/scheduled/running/failed) never move the tenant status.
 */
const TRANSITION_AUDIT_ACTIONS = [
  "tenant.provisioned",
  "tenant.suspended",
  "tenant.resumed",
  "tenant.archived",
  "tenant.deletion.requested",
  "tenant.deletion.primary_deleted",
  "tenant.deletion.completed",
  "tenant.deletion.canceled",
] as const;

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TENANT_STATUS_SET = new Set<string>(TENANT_STATUSES);
const HANDOFF_STATUS_SET = new Set<string>(TENANT_DELETION_FREEZE_HANDOFF_STATUSES);

interface LifecycleReceipt {
  readonly eventId: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly actorId: string;
  readonly fromStatus: TenantStatus;
  readonly toStatus: TenantStatus;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
  readonly sortEpochMs: number;
}

/** Loads the tenant-scoped lifecycle snapshot, or null when the tenant is not visible in this scope. */
export async function loadTenantLifecycleSnapshot(
  db: DbClient,
  tenantId: Tenant["id"],
): Promise<TenantLifecycleSnapshot | null> {
  if (process.env.DATABASE_URL?.trim()) {
    return loadPostgresLifecycleSnapshot(db, tenantId);
  }
  const repository = createTenantQueryRepository(db);
  const tenant = await repository.getTenant(tenantId);
  if (!tenant) return null;

  const rows = await db
    .prepare(
      `SELECT id, action, metadata, created_at, workspace_id, actor_auth_identity_id
       FROM audit_logs
       WHERE action IN (${TRANSITION_AUDIT_ACTIONS.map(() => "?").join(", ")})
         AND (tenant_id = ? OR entity_id = ?)
       ORDER BY created_at DESC
       LIMIT 500`,
    )
    .all<Row>(...TRANSITION_AUDIT_ACTIONS, tenantId, tenantId);

  return buildSnapshot(tenant, rows, await latestDeletionHandoffs(db, tenantId));
}

function buildSnapshot(
  tenant: Tenant,
  rows: readonly Row[],
  handoffs: Readonly<{ freeze: TenantDeletionFreezeHandoffStatus; accessRevocation: TenantDeletionFreezeHandoffStatus }>,
): TenantLifecycleSnapshot {
  const receipts = rows
    .map(parseReceipt)
    .filter((receipt): receipt is LifecycleReceipt => receipt !== null && receipt.tenantId === tenant.id);

  // Clock granularity cannot order same-timestamp commits — reconstruct the
  // canonical chain by causality instead: the receipt that produced the
  // current status, then the receipt that produced its from-status, and so on.
  const chain = orderReceiptChain(receipts, tenant.status);
  const lifecycleVersion = Math.max(1, chain.length);
  const latest = chain[0] ?? null;
  const audit = latest !== null
    ? recordedAudit(latest, lifecycleVersion)
    : missingAudit(receipts.length === 0);

  return {
    tenant,
    workspace: null,
    lifecycleVersion,
    reasonCode: audit.state === "recorded" ? (latest?.reasonCode ?? "unrecorded") : "none_recorded",
    reason: audit.state === "recorded"
      ? (latest?.reason ?? "No human-supplied reason was recorded for this version.")
      : "No lifecycle receipt is bound to the current version.",
    freezeHandoffStatus: handoffs.freeze,
    accessRevocationHandoffStatus: handoffs.accessRevocation,
    changedAt: tenant.updatedAt,
    audit,
  };
}

/**
 * Postgres read path: audit_logs and tenant_deletion_jobs are zero-policy for
 * the runtime role, so the snapshot arrives as one actor-context-gated definer
 * bundle. The gate is structural (live membership + binding), not member RLS —
 * suspended and archived tenants keep their recorded snapshot truthful.
 */
async function loadPostgresLifecycleSnapshot(
  db: DbClient,
  tenantId: Tenant["id"],
): Promise<TenantLifecycleSnapshot | null> {
  const row = await db
    .prepare("SELECT public.novatrade_tenant_lifecycle_snapshot_read(?::uuid) AS bundle")
    .get<{ bundle: unknown }>(tenantId);
  const bundle = parseSnapshotBundle(row?.bundle);
  if (bundle === null) return null;
  return buildSnapshot(bundle.tenant, bundle.auditRows, bundle.deletionHandoffs);
}

function parseSnapshotBundle(
  value: unknown,
): { tenant: Tenant; auditRows: Row[]; deletionHandoffs: { freeze: TenantDeletionFreezeHandoffStatus; accessRevocation: TenantDeletionFreezeHandoffStatus } } | null {
  const record = typeof value === "string" ? safeJsonObject(value) : value;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const bundle = record as Record<string, unknown>;

  const tenant = parseBundleTenant(bundle.tenant);
  if (tenant === null) return null;

  const auditRows = Array.isArray(bundle.audit)
    ? bundle.audit.filter((row): row is Row => row !== null && typeof row === "object" && !Array.isArray(row))
    : [];

  const deletion = bundle.deletion !== null && typeof bundle.deletion === "object" && !Array.isArray(bundle.deletion)
    ? bundle.deletion as Record<string, unknown>
    : null;

  return {
    tenant,
    auditRows,
    deletionHandoffs: {
      freeze: handoffStatus(deletion?.freeze_handoff_status),
      accessRevocation: handoffStatus(deletion?.access_revocation_handoff_status),
    },
  };
}

function parseBundleTenant(value: unknown): Tenant | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.slug !== "string" || typeof row.name !== "string"
    || typeof row.status !== "string" || !TENANT_STATUS_SET.has(row.status)
    || typeof row.locale !== "string" || typeof row.timezone !== "string") {
    return null;
  }
  const createdAt = canonicalTimestamp(row.created_at);
  const updatedAt = canonicalTimestamp(row.updated_at);
  if (createdAt === null || updatedAt === null) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as TenantStatus,
    locale: row.locale,
    timezone: row.timezone,
    createdAt,
    updatedAt,
  };
}

function safeJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Newest-first causal chain of tenant-wide receipts anchored at the current
 * tenant status. Each step takes the latest receipt (by recordedAt, eventId)
 * strictly before the previously found one whose toStatus produces the needed
 * status — so a drifted or unlinked receipt can never pose as the current
 * version's anchor.
 */
function orderReceiptChain(
  receipts: readonly LifecycleReceipt[],
  currentStatus: TenantStatus,
): LifecycleReceipt[] {
  const ordered = receipts
    .filter((receipt) => receipt.workspaceId === null)
    .sort((a, b) => a.sortEpochMs - b.sortEpochMs || a.eventId.localeCompare(b.eventId));
  const chain: LifecycleReceipt[] = [];
  let needed = currentStatus;
  let cursor = ordered.length;
  while (cursor > 0) {
    let found = -1;
    for (let i = cursor - 1; i >= 0; i -= 1) {
      if (ordered[i]!.toStatus === needed) { found = i; break; }
    }
    if (found === -1) return chain;
    chain.push(ordered[found]!);
    needed = ordered[found]!.fromStatus;
    cursor = found;
  }
  return chain;
}

function recordedAudit(receipt: LifecycleReceipt, lifecycleVersion: number): TenantLifecycleAuditSummary {
  return {
    state: "recorded",
    tenantId: receipt.tenantId,
    workspaceId: receipt.workspaceId,
    lifecycleVersion,
    eventId: receipt.eventId,
    actorId: receipt.actorId,
    fromStatus: receipt.fromStatus,
    toStatus: receipt.toStatus,
    recordedAt: receipt.recordedAt,
  };
}

function missingAudit(empty: boolean): TenantLifecycleAuditSummary {
  return { state: empty ? "missing" : "pending" };
}

/**
 * Maps one audit row to a transition receipt. Returns null when the row is not
 * a status-producing event or its metadata cannot be verified — a malformed
 * receipt is never a basis for controls.
 */
function parseReceipt(row: Row): LifecycleReceipt | null {
  const action = typeof row.action === "string" ? row.action : null;
  const metadata = parseMetadata(row.metadata);
  if (action === null || metadata === null) return null;
  const metaTenantId = metadata.tenantId;
  if (typeof metaTenantId !== "string" || metaTenantId === "") return null;

  const rowWorkspaceId = typeof row.workspace_id === "string" ? row.workspace_id : null;
  const metaWorkspaceId = typeof metadata.workspaceId === "string" ? metadata.workspaceId : null;
  const eventId = typeof metadata.eventId === "string" && metadata.eventId !== ""
    ? metadata.eventId
    : (typeof row.id === "string" ? row.id : null);
  const actorId = typeof metadata.actorIdentityId === "string" && metadata.actorIdentityId !== ""
    ? metadata.actorIdentityId
    : (typeof row.actor_auth_identity_id === "string" ? row.actor_auth_identity_id : null);
  if (eventId === null || actorId === null) return null;

  const recordedAt = canonicalTimestamp(metadata.occurredAt) ?? canonicalTimestamp(row.created_at);
  if (recordedAt === null) return null;
  const sortEpochMs = Date.parse(recordedAt);

  if (action === "tenant.provisioned") {
    // Owner-acceptance event: the tenant moved provisioning → active.
    return {
      eventId,
      tenantId: metaTenantId,
      workspaceId: metaWorkspaceId ?? rowWorkspaceId,
      actorId,
      fromStatus: "provisioning",
      toStatus: "active",
      reasonCode: "owner_acceptance",
      reason: "Tenant activated when the owner accepted the provisioning invitation.",
      recordedAt,
      sortEpochMs,
    };
  }

  const toStatus = isTenantStatus(metadata.tenantToStatus) ? metadata.tenantToStatus : null;
  const fromStatus = isTenantStatus(metadata.tenantFromStatus) ? metadata.tenantFromStatus : null;
  if (toStatus === null || fromStatus === null) return null;

  return {
    eventId,
    tenantId: metaTenantId,
    workspaceId: metaWorkspaceId ?? rowWorkspaceId,
    actorId,
    fromStatus,
    toStatus,
    reasonCode: typeof metadata.reasonCode === "string" && metadata.reasonCode !== "" ? metadata.reasonCode : null,
    reason: typeof metadata.reason === "string" && metadata.reason !== "" ? metadata.reason : null,
    recordedAt,
    sortEpochMs,
  };
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  if (CANONICAL_TIMESTAMP.test(value) && new Date(value).toISOString() === value) return value;
  // audit_logs.created_at arrives as SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    const iso = `${value.replace(" ", "T")}.000Z`;
    return new Date(iso).toISOString() === iso ? iso : null;
  }
  return null;
}

function isTenantStatus(value: unknown): value is TenantStatus {
  return typeof value === "string" && TENANT_STATUS_SET.has(value);
}

async function latestDeletionHandoffs(
  db: DbClient,
  tenantId: string,
): Promise<Readonly<{ freeze: TenantDeletionFreezeHandoffStatus; accessRevocation: TenantDeletionFreezeHandoffStatus }>> {
  const row = await db
    .prepare(
      `SELECT freeze_handoff_status, access_revocation_handoff_status
       FROM tenant_deletion_jobs
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get<Row>(tenantId);
  return {
    freeze: handoffStatus(row?.freeze_handoff_status),
    accessRevocation: handoffStatus(row?.access_revocation_handoff_status),
  };
}

function handoffStatus(value: unknown): TenantDeletionFreezeHandoffStatus {
  return typeof value === "string" && HANDOFF_STATUS_SET.has(value)
    ? value as TenantDeletionFreezeHandoffStatus
    : "not_started";
}

/**
 * Latest tenant-scope export/deletion jobs, mapped through the lifecycle
 * service's canonical getters so the panel receives validated domain rows.
 * Workspace-scoped jobs are out of scope for the tenant-wide surface.
 */
export async function loadLatestDataLifecycleJobs(
  db: DbClient,
  tenantId: string,
  service: Pick<TenantLifecycleOperationsService, "getExportJob" | "getDeletionJob" | "listDeletionCheckpoints">,
): Promise<Readonly<{ exportJob: TenantExportJob | null; deletionJob: TenantDeletionJobView | null }>> {
  // Under Postgres both job tables are closed to member reads once the tenant
  // leaves 'active' (member RLS is status-gated; deletion jobs are zero-policy
  // outright), so the latest-id lookups go through actor-context-gated
  // definers — the same gate the snapshot bundle uses.
  const postgres = Boolean(process.env.DATABASE_URL?.trim());
  const exportRow = postgres
    ? await db
      .prepare("SELECT public.novatrade_tenant_export_job_latest(?::uuid)::text AS id")
      .get<Row>(tenantId)
    : await db
      .prepare("SELECT id FROM tenant_export_jobs WHERE tenant_id = ? AND workspace_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
      .get<Row>(tenantId);
  const deletionRow = postgres
    ? await db
      .prepare("SELECT public.novatrade_tenant_deletion_job_latest(?::uuid)::text AS id")
      .get<Row>(tenantId)
    : await db
      .prepare("SELECT id FROM tenant_deletion_jobs WHERE tenant_id = ? AND workspace_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
      .get<Row>(tenantId);

  const exportJob = typeof exportRow?.id === "string"
    ? await service.getExportJob(tenantId, exportRow.id)
    : null;
  const job = typeof deletionRow?.id === "string"
    ? await service.getDeletionJob(tenantId, deletionRow.id)
    : null;
  if (job === null) return { exportJob, deletionJob: null };

  const checkpoints = (await service.listDeletionCheckpoints(tenantId, job.id))
    .map((checkpoint) => ({
      store: checkpoint.storeClass,
      status: checkpoint.status,
      required: true,
      exemptionReason: null,
      exemptionApproved: false,
    }));
  return {
    exportJob,
    deletionJob: {
      id: job.id,
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      operation: job.operation,
      status: job.status,
      scopeKind: job.scopeKind,
      scopeSelectorHash: job.scopeSelectorHash,
      policyVersion: job.policyVersion,
      legalHoldStatus: job.legalHoldStatus as TenantDeletionJobView["legalHoldStatus"],
      freezeHandoffStatus: job.freezeHandoffStatus as TenantDeletionJobView["freezeHandoffStatus"],
      accessRevocationHandoffStatus: job.accessRevocationHandoffStatus as TenantDeletionJobView["accessRevocationHandoffStatus"],
      checkpoints,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      backupExpiryTargetAt: job.backupExpiryTargetAt,
      errorCode: job.errorCode,
      auditEventId: job.auditEventId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      requestedByAuthIdentityId: job.requestedByAuthIdentityId,
      verifiedByAuthIdentityId: job.verifiedByAuthIdentityId,
      approvedByAuthIdentityId: job.approvedByAuthIdentityId,
    },
  };
}
