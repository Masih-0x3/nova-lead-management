import { randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import type { TenantLimitService } from "@/lib/tenancy/limits";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import {
  createTenantInvitationService,
  createTenantProvisioningService,
  TenantInvitationError,
  TenantProvisioningError,
  type TenantAuthUserProvisioner,
  type TenantInvitationAuditEvent,
  type TenantInvitationDeliveryPort,
  type TenantInvitationJournalRecord,
  type TenantInvitationOperation,
  type TenantInvitationOperationResult,
  type TenantInvitationService,
  type TenantInvitationTransactionScope,
  type ProvisioningIdFactory,
  type TenantProvisioningDomainAuditEvent,
  type TenantProvisioningResult,
  type TenantProvisioningService,
  type TenantProvisioningTransactionScope,
  type TransactionalProvisioningJournal,
  type TransactionalTenantInvitationJournal,
} from "@/lib/tenancy/provisioning";
import { authIdentityIdSchema } from "@/lib/tenancy/schemas";
import { TENANT_INVITATION_LOCAL_DDL } from "@/lib/tenancy/tenant-invitation-schema";
import type { AuthIdentityId } from "@/lib/tenancy/types";

type JournalRow = Record<string, unknown>;

export interface LocalTenantProvisioningOptions {
  readonly operatorIdentityId: AuthIdentityId;
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  readonly idFactory?: ProvisioningIdFactory;
  readonly clock?: () => Date;
}

export interface LocalTenantInvitationOptions {
  readonly operatorIdentityId?: AuthIdentityId;
  readonly authUserProvisioner?: TenantAuthUserProvisioner;
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  /** Optional tenant-limit service enforcing the membership_invite quota. */
  readonly limits?: Pick<TenantLimitService, "consume">;
  readonly idFactory?: ProvisioningIdFactory;
  readonly clock?: () => Date;
}

/**
 * Local invitation delivery adapter: no transport, durable outcome only. The
 * delivery reference is a non-reversible digest of the invitation id — the id
 * itself (the acceptance capability) is never logged or persisted here.
 */
export function createLocalInvitationDeliveryAdapter(): TenantInvitationDeliveryPort {
  return {
    adapterId: "local-noop",
    deliver: async (request) => {
      if (typeof request.invitationId !== "string" || request.invitationId.length === 0) {
        throw new TenantInvitationError("INVALID_INPUT", "The invitation delivery request is invalid.");
      }
      return {
        adapterId: "local-noop",
        state: "delivered",
        deliveryRefHash: null,
        deliveryDetail: "local_delivery_noop",
      };
    },
  };
}

/**
 * Local auth provisioner: there is no external provider locally, so the
 * verified session identity is asserted in-process. Production binds the
 * Supabase service-role adapter instead.
 */
export function createLocalAuthUserProvisioner(): TenantAuthUserProvisioner {
  return {
    ensureAuthUser: async (request) => {
      const parsed = authIdentityIdSchema.safeParse(request.authIdentityId);
      if (!parsed.success) {
        throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The auth identity is invalid.", true);
      }
      return { authIdentityId: parsed.data, provisioned: "existing" };
    },
  };
}

/** Applies the invitation + journal tables to a local SQLite database. */
export async function ensureLocalTenantInvitationSchema(db: DbClient): Promise<void> {
  await db.exec(TENANT_INVITATION_LOCAL_DDL);
}

export function createLocalTenantProvisioningService(
  db: DbClient,
  options: LocalTenantProvisioningOptions,
): TenantProvisioningService {
  if (!db || typeof db.withTransaction !== "function") {
    throw new TenantProvisioningError("PROVISIONING_RETRYABLE", "The provisioning store is unavailable.", true);
  }
  return createTenantProvisioningService({
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    operatorIdentityId: options.operatorIdentityId,
    invitationDelivery: options.invitationDelivery,
    clock: options.clock,
    transactionCoordinator: {
      run: async <T>(callback: (scope: TenantProvisioningTransactionScope) => Promise<T>): Promise<T> =>
        db.withTransaction!(async () =>
          callback({
            repository: createTenantQueryRepository(db),
            journal: createSqliteProvisioningJournal(db),
            audit: { append: (event) => appendTenantAudit(db, event) },
          })),
    },
  });
}

export function createLocalTenantInvitationService(
  db: DbClient,
  options: LocalTenantInvitationOptions = {},
): TenantInvitationService {
  if (!db || typeof db.withTransaction !== "function") {
    throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The invitation store is unavailable.", true);
  }
  return createTenantInvitationService({
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    operatorIdentityId: options.operatorIdentityId,
    authUserProvisioner: options.authUserProvisioner ?? createLocalAuthUserProvisioner(),
    invitationDelivery: options.invitationDelivery,
    limits: options.limits,
    clock: options.clock,
    transactionCoordinator: {
      run: async <T>(callback: (scope: TenantInvitationTransactionScope) => Promise<T>): Promise<T> =>
        db.withTransaction!(async () =>
          callback({
            repository: createTenantQueryRepository(db),
            journal: createSqliteInvitationJournal(db),
            audit: { append: (event) => appendTenantAudit(db, event) },
          })),
    },
  });
}

function createSqliteProvisioningJournal(db: DbClient): TransactionalProvisioningJournal {
  const read = async (hash: string): Promise<JournalRow | null> =>
    (await db.prepare(
      `SELECT idempotency_key_hash, input_hash, request_id, status, result_json
       FROM tenant_provisioning_journal WHERE idempotency_key_hash = ?`,
    ).get<JournalRow>(hash)) ?? null;

  return {
    async findByIdempotencyKeyHash(idempotencyKeyHashRef) {
      const row = await read(idempotencyKeyHashRef);
      if (!row) return null;
      return provisioningJournalRecord(row);
    },
    async reserve(input) {
      const existing = await read(input.idempotencyKeyHashRef);
      if (existing) {
        if (existing.request_id !== input.requestId || existing.input_hash !== input.inputHashRef) return { state: "conflict" };
        if (existing.status === "completed") return { state: "completed", record: provisioningJournalRecord(existing) };
        if (existing.status === "in_progress") return { state: "in_progress" };
        throw journalMalformed();
      }
      const inserted = await db.prepare(
        `INSERT OR IGNORE INTO tenant_provisioning_journal
          (idempotency_key_hash, input_hash, request_id)
         VALUES (?, ?, ?)`,
      ).run(input.idempotencyKeyHashRef, input.inputHashRef, input.requestId);
      if (inserted.changes === 1) return { state: "reserved" };
      const row = await read(input.idempotencyKeyHashRef);
      if (!row || row.request_id !== input.requestId || row.input_hash !== input.inputHashRef) return { state: "conflict" };
      if (row.status === "completed") return { state: "completed", record: provisioningJournalRecord(row) };
      if (row.status === "in_progress") return { state: "in_progress" };
      throw journalMalformed();
    },
    async complete(input) {
      const result = await db.prepare(
        `UPDATE tenant_provisioning_journal
         SET status = 'completed', result_json = ?, completed_at = ?
         WHERE idempotency_key_hash = ? AND input_hash = ? AND request_id = ? AND status = 'in_progress'`,
      ).run(JSON.stringify(input.result), nowIso(), input.idempotencyKeyHashRef, input.inputHashRef, input.requestId);
      if (result.changes !== 1) throw journalMalformed();
    },
  };
}

function createSqliteInvitationJournal(db: DbClient): TransactionalTenantInvitationJournal {
  const read = async (hash: string): Promise<JournalRow | null> =>
    (await db.prepare(
      `SELECT idempotency_key_hash, input_hash, operation, tenant_id, invitation_id, status, result_json
       FROM tenant_invitation_journal WHERE idempotency_key_hash = ?`,
    ).get<JournalRow>(hash)) ?? null;

  return {
    async findByIdempotencyKeyHash(idempotencyKeyHashRef) {
      const row = await read(idempotencyKeyHashRef);
      if (!row) return null;
      return invitationJournalRecord(row);
    },
    async reserve(input) {
      const existing = await read(input.idempotencyKeyHashRef);
      if (existing) {
        if (existing.input_hash !== input.inputHashRef
          || existing.operation !== input.operation
          || existing.tenant_id !== input.tenantId
          || existing.invitation_id !== input.invitationId) return { state: "conflict" };
        if (existing.status === "completed") return { state: "completed", record: invitationJournalRecord(existing) };
        if (existing.status === "reserved") return { state: "in_progress" };
        throw journalMalformed();
      }
      const inserted = await db.prepare(
        `INSERT OR IGNORE INTO tenant_invitation_journal
          (idempotency_key_hash, input_hash, operation, tenant_id, invitation_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(input.idempotencyKeyHashRef, input.inputHashRef, input.operation, input.tenantId, input.invitationId);
      if (inserted.changes === 1) return { state: "reserved" };
      const row = await read(input.idempotencyKeyHashRef);
      if (!row || row.input_hash !== input.inputHashRef || row.operation !== input.operation) {
        return { state: "conflict" };
      }
      if (row.status === "completed") return { state: "completed", record: invitationJournalRecord(row) };
      if (row.status === "reserved") return { state: "in_progress" };
      throw journalMalformed();
    },
    async complete(input) {
      const result = await db.prepare(
        `UPDATE tenant_invitation_journal
         SET status = 'completed', result_json = ?, completed_at = ?
         WHERE idempotency_key_hash = ? AND status = 'reserved'`,
      ).run(JSON.stringify(input.result), nowIso(), input.idempotencyKeyHashRef);
      if (result.changes !== 1) throw journalMalformed();
    },
  };
}

function provisioningJournalRecord(row: JournalRow): {
  idempotencyKeyHashRef: string;
  inputHashRef: string;
  requestId: string;
  state: "in_progress" | "completed";
  result?: TenantProvisioningResult;
} {
  const state = requiredString(row.status);
  if (state !== "in_progress" && state !== "completed") throw journalMalformed();
  return {
    idempotencyKeyHashRef: requiredString(row.idempotency_key_hash),
    inputHashRef: requiredString(row.input_hash),
    requestId: requiredString(row.request_id),
    state,
    ...(state === "completed" ? { result: parseResultJson(row.result_json) as TenantProvisioningResult } : {}),
  };
}

function invitationJournalRecord(row: JournalRow): TenantInvitationJournalRecord {
  const state = requiredString(row.status);
  if (state !== "reserved" && state !== "completed") throw journalMalformed();
  return {
    idempotencyKeyHashRef: requiredString(row.idempotency_key_hash),
    inputHashRef: requiredString(row.input_hash),
    operation: requiredString(row.operation) as TenantInvitationOperation,
    tenantId: requiredString(row.tenant_id),
    invitationId: requiredString(row.invitation_id),
    state,
    ...(state === "completed" ? { result: parseResultJson(row.result_json) as TenantInvitationOperationResult } : {}),
  };
}

function parseResultJson(value: unknown): unknown {
  if (typeof value !== "string") throw journalMalformed();
  try {
    return JSON.parse(value);
  } catch {
    throw journalMalformed();
  }
}

async function appendTenantAudit(db: DbClient, event: TenantProvisioningDomainAuditEvent): Promise<void> {
  const isMemberScope = event.actorLayer === "member";
  const isFoundation = event.eventType === "tenant.provisioning_started";
  const memberFields = isMemberScope && !isFoundation ? event as TenantInvitationAuditEvent : null;
  const result = await db.prepare(
    `INSERT INTO audit_logs
      (id, action, entity_type, entity_id, metadata, scope_kind, tenant_id, workspace_id,
       correlation_id, actor_auth_identity_id, actor_membership_id, actor_launch_role,
       actor_role_binding_id, actor_layer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId,
    event.eventType,
    isFoundation ? "tenant" : "tenant_invitation",
    isFoundation ? event.tenantId : (event as TenantInvitationAuditEvent).invitationId,
    JSON.stringify(event),
    isMemberScope ? "tenant" : "platform",
    isMemberScope ? event.tenantId : null,
    isMemberScope ? event.workspaceId : null,
    event.correlationId,
    event.actorIdentityId,
    memberFields?.actorMembershipId ?? null,
    memberFields?.actorRole ?? null,
    memberFields?.actorRoleBindingId ?? null,
    event.actorLayer,
  );
  if (result.changes !== 1) throw journalMalformed();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw journalMalformed();
  return value;
}

function journalMalformed(): Error {
  return new Error("The tenant journal returned a malformed record.");
}

function nowIso(): string {
  return new Date().toISOString();
}
