/**
 * L-02 T-040: Postgres twin of the tenant invitation service — member issue,
 * recipient acceptance, and operator reissue/revoke/status over the
 * zero-policy tenant_invitations and tenant_invitation_journal tables.
 *
 * Three lanes share one coordinator, dispatched on ambient context:
 *   * member lane   — issue runs under the ambient member context installed
 *                     by withTenantDbContext; authority is the GUC set.
 *   * identity lane — accept runs context-free; the invitation capability
 *                     plus the CAS-bound recipient hash is the authority.
 *   * system lane   — operator reissue/revoke/status run context-free like
 *                     the provisioning lane.
 *
 * Lane-gated SECURITY DEFINER functions (migration 202609120013) refuse any
 * call whose installed context is missing, mixed, or tenant-mismatched, so a
 * denied call is indistinguishable from an absent row.
 */
import { createHash, randomUUID } from "node:crypto";

import { getDb, withTenantDbContext } from "@/lib/db";
import { getTenantContext } from "@/lib/tenancy/context";
import {
  createTenantQueryRepository,
  type CloseTenantInvitationInput,
  type CreateMembershipInput,
  type CreateRoleBindingInput,
  type CreateTenantInvitationInput,
  type FinalizeTenantInvitationAcceptanceInput,
  type Membership,
  type RecordTenantInvitationDeliveryInput,
  type RoleBinding,
  type RoleBindingReason,
  type Tenant,
  type TenantQueryRepository,
  type Workspace,
} from "@/lib/tenancy/queries";
import {
  createTenantInvitationService,
  TenantInvitationError,
  type ProvisioningIdFactory,
  type TenantAuthUserProvisioner,
  type TenantInvitationAuditEvent,
  type TenantInvitationDeliveryPort,
  type TenantInvitationJournalRecord,
  type TenantInvitationService,
  type TenantInvitationTransactionScope,
  type TransactionalTenantInvitationJournal,
} from "@/lib/tenancy/provisioning";
import type { TenantLimitService } from "@/lib/tenancy/limits";
import type {
  AuthIdentityId,
  MembershipId,
  TenantId,
  TenantInvitation,
  TenantInvitationId,
  TenantPolicy,
  WorkspaceId,
} from "@/lib/tenancy/types";

type Row = Record<string, unknown>;

export interface PostgresTenantInvitationOptions {
  /** Required for operator-scoped reissue/revoke/status. */
  readonly operatorIdentityId?: AuthIdentityId;
  /** Required for acceptance: verifies the provider identity server-side. */
  readonly authUserProvisioner?: TenantAuthUserProvisioner;
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  readonly limits?: Pick<TenantLimitService, "consume">;
  readonly idFactory?: ProvisioningIdFactory;
  readonly clock?: () => Date;
}

export function createPostgresTenantInvitationService(
  options: PostgresTenantInvitationOptions = {},
): TenantInvitationService {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new TenantInvitationError(
      "PROVISIONING_RETRYABLE",
      "The Postgres invitation service requires DATABASE_URL.",
      true,
    );
  }
  return createTenantInvitationService({
    idFactory: options.idFactory ?? { next: () => randomUUID() },
    operatorIdentityId: options.operatorIdentityId,
    authUserProvisioner: options.authUserProvisioner,
    invitationDelivery: options.invitationDelivery,
    limits: options.limits,
    clock: options.clock,
    transactionCoordinator: {
      run: async <T>(callback: (scope: TenantInvitationTransactionScope) => Promise<T>): Promise<T> => {
        const scope = {
          repository: createInvitationRepository(),
          journal: createInvitationJournal(),
          audit: { append: appendInvitationAudit },
        };
        // Lane dispatch: an ambient member context installs the member lane;
        // anything else runs context-free where the lane-gated functions
        // apply the identity/system-lane bindings.
        if (getTenantContext()) {
          return withTenantDbContext(() => callback(scope));
        }
        const db = await getDb();
        if (typeof db.withTransaction !== "function") {
          throw new TenantInvitationError(
            "PROVISIONING_RETRYABLE",
            "The invitation store is unavailable.",
            true,
          );
        }
        return db.withTransaction(() => callback(scope));
      },
    },
  });
}

function malformed(): Error {
  return new Error("The invitation store returned a malformed record.");
}

async function callRecord<T>(name: string, payload: Row): Promise<T | null> {
  const db = await getDb();
  const row = await db
    .prepare(`SELECT public.${name}(?) AS record`)
    .get<{ record: T | null }>(JSON.stringify(payload));
  return row?.record ?? null;
}

async function callRows<T>(name: string, payload: Row): Promise<T[]> {
  const db = await getDb();
  return db.prepare(`SELECT * FROM public.${name}(?)`).all<T>(JSON.stringify(payload));
}

async function callOne<T extends Row>(name: string, payload: Row): Promise<T | null> {
  const rows = await callRows<T>(name, payload);
  if (rows.length > 1) throw malformed();
  return rows[0] ?? null;
}

function hashRef(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Same domain as the service's recipient binding — acceptance re-checks it
 * inside the finalize CAS. */
function invitationIdentityRefHash(authIdentityId: AuthIdentityId): string {
  return hashRef(`novatrade:tenant-membership-invite:v1:auth-identity:${authIdentityId.toLowerCase()}`);
}

function mapTenant(row: Row): Tenant {
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
}

function mapWorkspace(row: Row): Workspace {
  return {
    id: row.id as Workspace["id"],
    tenantId: row.tenant_id as TenantId,
    slug: row.slug as string,
    name: row.name as string,
    status: row.status as Workspace["status"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapMembership(row: Row): Membership {
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
}

function mapBinding(row: Row): RoleBinding {
  return {
    id: row.id as RoleBinding["id"],
    tenantId: row.tenant_id as TenantId,
    membershipId: row.membership_id as MembershipId,
    role: row.role as RoleBinding["role"],
    createdAt: row.created_at as string,
    validFrom: row.valid_from as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
    assignedByMembershipId: (row.assigned_by_membership_id as MembershipId | null) ?? null,
    reasonCode: row.reason_code as RoleBindingReason,
  };
}

function mapPolicy(row: Row): TenantPolicy {
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
}

function requireRow(row: Row | null): Row {
  if (!row) throw malformed();
  return row;
}

/**
 * Repository twin: the methods the invitation service calls are routed
 * through the lane-gated definer surface; every other method delegates to
 * the member-RLS repository where deny-all posture keeps them honest.
 */
function createInvitationRepository(): TenantQueryRepository {
  const inner = createTenantQueryRepository();

  return {
    ...inner,

    getTenant: async (tenantId: TenantId): Promise<Tenant | null> => {
      const row = await callRecord<Row>("novatrade_invitation_tenant_read", { tenantId });
      return row ? mapTenant(row) : null;
    },
    getWorkspace: async (tenantId: TenantId, workspaceId: WorkspaceId): Promise<Workspace | null> => {
      const row = await callRecord<Row>("novatrade_invitation_workspace_read", { tenantId, workspaceId });
      return row ? mapWorkspace(row) : null;
    },
    getMembership: async (tenantId: TenantId, membershipId: MembershipId): Promise<Membership | null> => {
      const row = await callRecord<Row>("novatrade_invitation_membership_read", { tenantId, membershipId });
      return row ? mapMembership(row) : null;
    },
    getCurrentRoleBinding: async (tenantId: TenantId, membershipId: MembershipId): Promise<RoleBinding | null> => {
      const row = await callRecord<Row>("novatrade_invitation_binding_read", { tenantId, membershipId });
      return row ? mapBinding(row) : null;
    },
    getCurrentTenantPolicy: async (tenantId: TenantId): Promise<TenantPolicy | null> => {
      const row = await callRecord<Row>("novatrade_invitation_policy_read", { tenantId });
      return row ? mapPolicy(row) : null;
    },

    getInvitationById: async (invitationId: TenantInvitationId): Promise<TenantInvitation | null> =>
      callRecord<TenantInvitation>("novatrade_invitation_read", { invitationId }),
    getLiveInvitationForMembership: async (
      tenantId: TenantId,
      membershipId: MembershipId,
    ): Promise<TenantInvitation | null> =>
      callRecord<TenantInvitation>("novatrade_invitation_live_read", { tenantId, membershipId }),

    createInvitation: async (
      tenantId: TenantId,
      input: CreateTenantInvitationInput,
    ): Promise<TenantInvitation> => {
      const row = await callOne<{ record: TenantInvitation }>("novatrade_invitation_create", {
        id: input.id,
        tenantId,
        membershipId: input.membershipId,
        provisioningRequestId: input.provisioningRequestId,
        kind: input.kind,
        role: input.role,
        workspaceId: input.workspaceId,
        expectedIdentityRefHash: input.expectedIdentityRefHash,
        policyVersion: input.policyVersion,
        generation: String(input.generation),
        contentHash: input.contentHash,
        expiresAt: input.expiresAt,
        correlationId: input.correlationId,
        auditEventId: input.auditEventId,
        issuedAt: input.issuedAt ?? new Date().toISOString(),
      });
      if (!row?.record) throw malformed();
      return row.record;
    },
    finalizeInvitationAcceptance: async (
      tenantId: TenantId,
      invitationId: TenantInvitationId,
      input: FinalizeTenantInvitationAcceptanceInput,
    ): Promise<TenantInvitation | null> => {
      const row = await callOne<{ record: TenantInvitation }>("novatrade_invitation_finalize", {
        tenantId,
        invitationId,
        expectedContentHash: input.expectedContentHash,
        expectedIdentityRefHash: invitationIdentityRefHash(input.acceptedAuthIdentityId),
        acceptedAt: input.acceptedAt,
        acceptedAuthIdentityId: input.acceptedAuthIdentityId,
      });
      return row?.record ?? null;
    },
    supersedeInvitation: async (
      tenantId: TenantId,
      invitationId: TenantInvitationId,
      input: CloseTenantInvitationInput,
    ): Promise<TenantInvitation | null> => {
      const row = await callOne<{ record: TenantInvitation }>("novatrade_invitation_supersede", {
        tenantId,
        invitationId,
        at: input.at,
        reasonCode: input.reasonCode,
        supersededByInvitationId: input.supersededByInvitationId,
      });
      return row?.record ?? null;
    },
    revokeInvitation: async (
      tenantId: TenantId,
      invitationId: TenantInvitationId,
      input: CloseTenantInvitationInput,
    ): Promise<TenantInvitation | null> => {
      const row = await callOne<{ record: TenantInvitation }>("novatrade_invitation_revoke", {
        tenantId,
        invitationId,
        at: input.at,
        reasonCode: input.reasonCode,
      });
      return row?.record ?? null;
    },
    recordInvitationDelivery: async (
      tenantId: TenantId,
      invitationId: TenantInvitationId,
      input: RecordTenantInvitationDeliveryInput,
    ): Promise<TenantInvitation | null> => {
      const row = await callOne<{ marked: boolean; record: TenantInvitation | null }>(
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
      return row?.marked ? row.record : null;
    },

    updateMembershipStatus: async (
      tenantId: TenantId,
      membershipId: MembershipId,
      status: Membership["status"],
    ): Promise<Membership> =>
      mapMembership(requireRow(await callOne<{ record: Row }>("novatrade_invitation_membership_status", {
        tenantId,
        membershipId,
        status,
      }).then((row) => row?.record ?? null))),
    revokeCurrentRoleBinding: async (
      tenantId: TenantId,
      membershipId: MembershipId,
      revokedAt?: string,
    ): Promise<RoleBinding> =>
      mapBinding(requireRow(await callOne<{ record: Row }>("novatrade_invitation_binding_revoke", {
        tenantId,
        membershipId,
        revokedAt: revokedAt ?? new Date().toISOString(),
      }).then((row) => row?.record ?? null))),
    createMembership: async (tenantId: TenantId, input: CreateMembershipInput): Promise<Membership> =>
      mapMembership(requireRow(await callOne<{ record: Row }>("novatrade_invitation_membership_create", {
        tenantId,
        id: input.id,
        authIdentityId: input.authIdentityId,
        workspaceId: input.workspaceId,
        invitedByMembershipId: input.invitedByMembershipId,
        createdAt: input.createdAt ?? new Date().toISOString(),
      }).then((row) => row?.record ?? null))),
    createRoleBinding: async (tenantId: TenantId, input: CreateRoleBindingInput): Promise<RoleBinding> =>
      mapBinding(requireRow(await callOne<{ record: Row }>("novatrade_invitation_binding_create", {
        tenantId,
        id: input.id,
        membershipId: input.membershipId,
        validFrom: input.validFrom ?? input.createdAt ?? new Date().toISOString(),
      }).then((row) => row?.record ?? null))),
    updateTenantStatus: async (tenantId: TenantId, status: Tenant["status"]): Promise<Tenant> => {
      if (status !== "active") throw malformed();
      return mapTenant(requireRow(await callOne<{ record: Row }>("novatrade_invitation_tenant_activate", {
        tenantId,
      }).then((row) => row?.record ?? null)));
    },
    updateWorkspaceStatus: async (
      tenantId: TenantId,
      workspaceId: WorkspaceId,
      status: Workspace["status"],
    ): Promise<Workspace> => {
      if (status !== "active") throw malformed();
      return mapWorkspace(requireRow(await callOne<{ record: Row }>("novatrade_invitation_workspace_activate", {
        tenantId,
        workspaceId,
      }).then((row) => row?.record ?? null)));
    },
  };
}

function normalizeJournalRecord(record: TenantInvitationJournalRecord): TenantInvitationJournalRecord {
  // Reserved rows carry no result key — the canonical resolver asserts the
  // exact shape before reading it.
  if (record.state === "reserved" || record.result === null) {
    const rest = { ...record } as TenantInvitationJournalRecord & { result?: unknown };
    delete rest.result;
    return rest;
  }
  return record;
}

function createInvitationJournal(): TransactionalTenantInvitationJournal {
  return {
    async findByIdempotencyKeyHash(idempotencyKeyHashRef) {
      const record = await callRecord<TenantInvitationJournalRecord>(
        "novatrade_invitation_journal_find",
        { idempotencyKeyHash: idempotencyKeyHashRef },
      );
      if (!record) return null;
      return normalizeJournalRecord(record);
    },
    async reserve(input) {
      const row = await callOne<{ outcome: string; record: TenantInvitationJournalRecord | null }>(
        "novatrade_invitation_journal_reserve",
        {
          idempotencyKeyHash: input.idempotencyKeyHashRef,
          inputHash: input.inputHashRef,
          operation: input.operation,
          tenantId: input.tenantId,
          invitationId: input.invitationId,
        },
      );
      if (!row) throw malformed();
      switch (row.outcome) {
        case "reserved": return { state: "reserved" };
        case "in_progress": return { state: "in_progress" };
        case "completed": return { state: "completed", record: normalizeJournalRecord(row.record!) };
        case "conflict": return { state: "conflict" };
        default: throw malformed();
      }
    },
    async complete(input) {
      const row = await callOne<{ committed: boolean }>(
        "novatrade_invitation_journal_complete",
        {
          idempotencyKeyHash: input.idempotencyKeyHashRef,
          result: input.result,
        },
      );
      if (!row?.committed) throw malformed();
    },
  };
}

async function appendInvitationAudit(event: TenantInvitationAuditEvent): Promise<void> {
  const row = await callOne<{ applied: boolean }>("novatrade_invitation_audit_append", {
    eventId: event.eventId,
    eventType: event.eventType,
    requestId: event.requestId,
    invitationId: event.invitationId,
    correlationId: event.correlationId,
    idempotencyKeyHashRef: event.idempotencyKeyHashRef,
    inputHashRef: event.inputHashRef,
    actorLayer: event.actorLayer,
    actorIdentityId: event.actorIdentityId,
    actorMembershipId: event.actorMembershipId,
    actorRole: event.actorRole,
    actorRoleBindingId: event.actorRoleBindingId,
    tenantId: event.tenantId,
    workspaceId: event.workspaceId,
    resultCode: event.resultCode,
  });
  if (!row?.applied) throw malformed();
}
