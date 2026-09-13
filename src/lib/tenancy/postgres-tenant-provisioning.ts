/**
 * L-02 Postgres tenant provisioning adapter.
 *
 * The twin of `createLocalTenantProvisioningService` for the DATABASE_URL
 * runtime. Provisioning is a system-lane operation: the tenant being
 * provisioned does not exist, so no member context can be installed and no
 * member GUCs are set. Every write goes through the SECURITY DEFINER family
 * in migration 202609120009, which refuses to run while a member/worker/
 * support context is installed and binds child-row inserts to a tenant
 * created inside the same transaction (xmin = current xact) — the functions
 * can never touch a pre-existing tenant.
 *
 * The canonical service stays the orchestrator: this adapter supplies only
 * the transaction-scope ports — repository (foundation creators + delivery
 * marking), the durable provisioning journal, and the platform-scope system
 * audit append.
 */
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import {
  createTenantQueryRepository,
  type CreateTenantInput,
  type CreateWorkspaceInput,
  type CreateMembershipInput,
  type CreateRoleBindingInput,
  type CreateTenantPolicyInput,
  type CreateTenantInvitationInput,
  type RecordTenantInvitationDeliveryInput,
  type Tenant,
  type Workspace,
  type Membership,
  type RoleBinding,
  type TenantQueryRepository,
} from "@/lib/tenancy/queries";
import {
  createTenantProvisioningService,
  TenantProvisioningError,
  type ProvisioningIdFactory,
  type ProvisioningJournalRecord,
  type TenantInvitationAuditEvent,
  type TenantInvitationDeliveryPort,
  type TenantProvisioningDomainAuditEvent,
  type TenantProvisioningService,
  type TenantProvisioningTransactionScope,
  type TransactionalProvisioningJournal,
} from "@/lib/tenancy/provisioning";
import { TENANT_POLICY_DEFAULTS } from "@/lib/tenancy/schemas";
import type { AuthIdentityId, TenantInvitation, TenantPolicy } from "@/lib/tenancy/types";

type Row = Record<string, unknown>;

export interface PostgresTenantProvisioningOptions {
  readonly operatorIdentityId: AuthIdentityId;
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  readonly idFactory?: ProvisioningIdFactory;
  readonly clock?: () => Date;
}

export function createPostgresTenantProvisioningService(
  options: PostgresTenantProvisioningOptions,
): TenantProvisioningService {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new TenantProvisioningError(
      "PROVISIONING_RETRYABLE",
      "The Postgres provisioning service requires DATABASE_URL.",
      true,
    );
  }
  return createTenantProvisioningService({
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    operatorIdentityId: options.operatorIdentityId,
    invitationDelivery: options.invitationDelivery,
    clock: options.clock,
    transactionCoordinator: {
      run: async <T>(callback: (scope: TenantProvisioningTransactionScope) => Promise<T>): Promise<T> => {
        const db = await getDb();
        if (typeof db.withTransaction !== "function") {
          throw new TenantProvisioningError(
            "PROVISIONING_RETRYABLE",
            "The provisioning store is unavailable.",
            true,
          );
        }
        return db.withTransaction(() =>
          callback({
            repository: postgresProvisioningRepository(),
            journal: postgresProvisioningJournal(),
            audit: { append: appendProvisioningAudit },
          }),
        );
      },
    },
  });
}

async function callFunction<T>(name: string, payload: Row): Promise<T | null> {
  const db = await getDb();
  const row = await db
    .prepare(`SELECT public.${name}(?) AS record`)
    .get<{ record: T | null }>(JSON.stringify(payload));
  return row?.record ?? null;
}

async function callOutcome<T>(name: string, payload: Row): Promise<T | null> {
  const db = await getDb();
  const row = await db
    .prepare(`SELECT * FROM public.${name}(?)`)
    .get<T>(JSON.stringify(payload));
  return row ?? null;
}

function postgresProvisioningJournal(): TransactionalProvisioningJournal {
  return {
    async findByIdempotencyKeyHash(idempotencyKeyHashRef) {
      const record = await callFunction<ProvisioningJournalRecord>(
        "novatrade_provisioning_journal_find",
        { idempotencyKeyHash: idempotencyKeyHashRef },
      );
      if (!record) return null;
      return normalizeJournalRecord(record);
    },
    async reserve(input) {
      const row = await callOutcome<{ outcome: string; record: ProvisioningJournalRecord | null }>(
        "novatrade_provisioning_journal_reserve",
        {
          idempotencyKeyHash: input.idempotencyKeyHashRef,
          inputHash: input.inputHashRef,
          requestId: input.requestId,
        },
      );
      if (!row) throw journalMalformed();
      switch (row.outcome) {
        case "reserved": return { state: "reserved" };
        case "in_progress": return { state: "in_progress" };
        case "completed": return { state: "completed", record: normalizeJournalRecord(row.record) };
        case "conflict": return { state: "conflict" };
        default: throw journalMalformed();
      }
    },
    async complete(input) {
      const row = await callOutcome<{ committed: boolean }>(
        "novatrade_provisioning_journal_complete",
        {
          idempotencyKeyHash: input.idempotencyKeyHashRef,
          inputHash: input.inputHashRef,
          requestId: input.requestId,
          result: input.result,
        },
      );
      if (row?.committed !== true) throw journalMalformed();
    },
  };
}

function normalizeJournalRecord(record: ProvisioningJournalRecord | null): ProvisioningJournalRecord {
  if (!record
    || (record.state !== "in_progress" && record.state !== "completed")
    || typeof record.idempotencyKeyHashRef !== "string"
    || typeof record.inputHashRef !== "string"
    || typeof record.requestId !== "string"
    || (record.state === "completed" && (record.result === undefined || record.result === null))) {
    throw journalMalformed();
  }
  if (record.state === "completed") return record;
  // In-progress records must carry exactly the four reservation keys — the
  // canonical resolver rejects extra properties.
  return {
    idempotencyKeyHashRef: record.idempotencyKeyHashRef,
    inputHashRef: record.inputHashRef,
    requestId: record.requestId,
    state: record.state,
  };
}

function postgresProvisioningRepository(): TenantQueryRepository {
  const base = createTenantQueryRepository();
  return {
    ...base,
    createTenant: async (input: CreateTenantInput): Promise<Tenant> => {
      const timestamp = nowIso();
      const record = await callFunction<Row>("novatrade_provisioning_create_tenant", {
        id: input.id,
        slug: input.slug,
        name: input.name,
        status: input.status ?? "provisioning",
        locale: input.locale ?? "en-US",
        timezone: input.timezone ?? "UTC",
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
      });
      if (!record) throw notCommitted("tenant creation");
      return record as unknown as Tenant;
    },
    createWorkspace: async (tenantId, input: CreateWorkspaceInput): Promise<Workspace> => {
      const timestamp = nowIso();
      const record = await callFunction<Row>("novatrade_provisioning_create_workspace", {
        id: input.id,
        tenantId,
        slug: input.slug,
        name: input.name,
        status: input.status ?? "provisioning",
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
      });
      if (!record) throw notCommitted("workspace creation");
      return record as unknown as Workspace;
    },
    createTenantPolicy: async (tenantId, input: CreateTenantPolicyInput): Promise<TenantPolicy> => {
      const defaults = { ...TENANT_POLICY_DEFAULTS, ...input };
      const timestamp = nowIso();
      const record = await callFunction<Row>("novatrade_provisioning_create_policy", {
        id: input.id,
        tenantId,
        locale: defaults.locale,
        timezone: defaults.timezone,
        exportRetentionDays: defaults.exportRetentionDays,
        operationalLogRetentionDays: defaults.operationalLogRetentionDays,
        rawSourceRetentionDays: defaults.rawSourceRetentionDays,
        contactFreshnessDays: defaults.contactFreshnessDays,
        primaryDeleteWithinDays: defaults.primaryDeleteWithinDays,
        backupExpireWithinDays: defaults.backupExpireWithinDays,
        tombstoneRetentionYears: defaults.tombstoneRetentionYears,
        activeMaterialsMode: defaults.activeMaterialsMode,
        aiProcessingEnabled: defaults.aiProcessingEnabled,
        sourceResearchEnabled: defaults.sourceResearchEnabled,
        contactResearchEnabled: defaults.contactResearchEnabled,
        outreachDraftingEnabled: defaults.outreachDraftingEnabled,
        copyExportEnabled: defaults.copyExportEnabled,
        autonomousSendEnabled: defaults.autonomousSendEnabled,
        requireSourcePlanApproval: defaults.requireSourcePlanApproval,
        requireKnowledgeReview: defaults.requireKnowledgeReview,
        requireIcpReview: defaults.requireIcpReview,
        requireLeadPlayReview: defaults.requireLeadPlayReview,
        requireContactReview: defaults.requireContactReview,
        requireOutreachReview: defaults.requireOutreachReview,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
      });
      if (!record) throw notCommitted("tenant policy creation");
      return record as unknown as TenantPolicy;
    },
    createMembership: async (tenantId, input: CreateMembershipInput): Promise<Membership> => {
      const timestamp = nowIso();
      const record = await callFunction<Row>("novatrade_provisioning_create_membership", {
        id: input.id,
        tenantId,
        authIdentityId: input.authIdentityId ?? null,
        pendingIdentityRefHash: input.pendingIdentityRefHash ?? null,
        workspaceId: input.workspaceId ?? null,
        status: input.status ?? "pending",
        invitedByMembershipId: input.invitedByMembershipId ?? null,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
      });
      if (!record) throw notCommitted("membership creation");
      return record as unknown as Membership;
    },
    createRoleBinding: async (tenantId, input: CreateRoleBindingInput): Promise<RoleBinding> => {
      const timestamp = nowIso();
      const record = await callFunction<Row>("novatrade_provisioning_create_binding", {
        id: input.id,
        tenantId,
        membershipId: input.membershipId,
        role: input.role,
        reasonCode: input.reasonCode ?? "initial_provisioning",
        validFrom: input.validFrom ?? input.createdAt ?? timestamp,
        assignedByMembershipId: input.assignedByMembershipId ?? null,
        createdAt: input.createdAt ?? timestamp,
      });
      if (!record) throw notCommitted("role binding creation");
      return record as unknown as RoleBinding;
    },
    createInvitation: async (tenantId, input: CreateTenantInvitationInput): Promise<TenantInvitation> => {
      const timestamp = nowIso();
      const record = await callFunction<Row>("novatrade_provisioning_create_invitation", {
        id: input.id,
        tenantId,
        membershipId: input.membershipId,
        provisioningRequestId: input.provisioningRequestId ?? null,
        kind: input.kind,
        role: input.role,
        workspaceId: input.workspaceId ?? null,
        expectedIdentityRefHash: input.expectedIdentityRefHash,
        policyVersion: input.policyVersion,
        generation: input.generation,
        contentHash: input.contentHash,
        issuedAt: input.issuedAt ?? timestamp,
        expiresAt: input.expiresAt,
        correlationId: input.correlationId,
        auditEventId: input.auditEventId,
      });
      if (!record) throw notCommitted("invitation creation");
      return record as unknown as TenantInvitation;
    },
    recordInvitationDelivery: async (
      tenantId,
      invitationId,
      input: RecordTenantInvitationDeliveryInput,
    ): Promise<TenantInvitation | null> => {
      const row = await callOutcome<{ marked: boolean; record: TenantInvitation | null }>(
        "novatrade_invitation_delivery_mark",
        {
          tenantId,
          invitationId,
          deliveryState: input.deliveryState,
          deliveryAdapter: input.deliveryAdapter,
          deliveryRefHash: input.deliveryRefHash,
          deliveryDetail: input.deliveryDetail,
        },
      );
      if (!row || row.marked !== true) return null;
      return row.record;
    },
  };
}

async function appendProvisioningAudit(event: TenantProvisioningDomainAuditEvent): Promise<void> {
  const isFoundation = event.eventType === "tenant.provisioning_started";
  const row = await callOutcome<{ recorded: boolean }>(
    "novatrade_provisioning_audit_append",
    {
      entityType: isFoundation ? "tenant" : "tenant_invitation",
      entityId: isFoundation
        ? event.tenantId
        : (event as TenantInvitationAuditEvent).invitationId,
      event,
    },
  );
  if (row?.recorded !== true) throw journalMalformed();
}

function notCommitted(operation: string): Error {
  return new Error(`Provisioning ${operation} was not committed.`);
}

function journalMalformed(): Error {
  return new Error("The tenant journal returned a malformed record.");
}

function nowIso(): string {
  return new Date().toISOString();
}
