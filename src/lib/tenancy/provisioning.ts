import { createHash } from "node:crypto";

import {
  tenantProvisioningOperatorCommandSchema,
  type TenantProvisioningOperatorCommand,
} from "@/lib/tenancy/schemas";
import type { TenantQueryRepository } from "@/lib/tenancy/queries";
import { getTenantContext } from "@/lib/tenancy/context";
import type { TenantLimitService } from "@/lib/tenancy/limits";
import {
  authIdentityIdSchema,
  provisioningRequestIdSchema,
  tenantIdSchema,
  tenantInvitationAcceptanceCommandSchema,
  tenantInvitationIdSchema,
  tenantInvitationIssueCommandSchema,
  tenantInvitationReissueCommandSchema,
  tenantInvitationRevokeCommandSchema,
  tenantInvitationStatusQuerySchema,
  workspaceIdSchema,
  type TenantInvitationAcceptanceCommand,
  type TenantInvitationIssueCommand,
  type TenantInvitationReissueCommand,
  type TenantInvitationRevokeCommand,
  type TenantInvitationStatusQuery,
} from "@/lib/tenancy/schemas";
import {
  LAUNCH_ROLES,
  TENANT_INVITATION_DELIVERY_STATES,
  TENANT_INVITATION_KINDS,
  TENANT_INVITATION_STATUSES,
  TENANT_STATUSES,
  type ActorLayer,
  type AuthIdentityId,
  type CorrelationId,
  type LaunchRole,
  type MembershipId,
  type ProvisioningRequestId,
  type TenantId,
  type TenantInvitation,
  type TenantInvitationDeliveryState,
  type TenantInvitationId,
  type TenantInvitationKind,
  type TenantInvitationStatus,
  type TenantInvitationResultCode,
  type TenantStatus,
  type WorkflowPolicyVersion,
  type WorkspaceId,
  type WorkspaceStatus,
} from "@/lib/tenancy/types";

export const TENANT_PROVISIONING_RESULT_CODE = "PROVISIONING_FOUNDATION_CREATED" as const;
export const TENANT_PROVISIONING_AUDIT_EVENT = "tenant.provisioning_started" as const;

/**
 * Invitation issuance, delivery, and acceptance are implemented below; the
 * only remaining activation gate is the owner actually accepting.
 */
export const TENANT_PROVISIONING_ACTIVATION_BLOCKERS = [
  "OWNER_ACCEPTANCE_REQUIRED",
] as const;

/** Finite owner/member invitation lifetime. Reissue mints a fresh interval. */
export const TENANT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const INVITATION_ISSUED_AUDIT_EVENT = "tenant.invitation_issued" as const;
const INVITATION_DELIVERY_AUDIT_EVENT = "tenant.invitation_delivery_recorded" as const;
const INVITATION_ACCEPTED_AUDIT_EVENT = "tenant.invitation_accepted" as const;
const INVITATION_REISSUED_AUDIT_EVENT = "tenant.invitation_reissued" as const;
const INVITATION_REVOKED_AUDIT_EVENT = "tenant.invitation_revoked" as const;
const TENANT_PROVISIONED_AUDIT_EVENT = "tenant.provisioned" as const;

export type TenantProvisioningActivationBlocker = (typeof TENANT_PROVISIONING_ACTIVATION_BLOCKERS)[number];

export type ProvisioningIdKind =
  | "request"
  | "tenant"
  | "workspace"
  | "policy"
  | "membership"
  | "role_binding"
  | "invitation"
  | "audit";

/** IDs are server-owned. Production adapters must use a durable, collision-safe generator. */
export interface ProvisioningIdFactory {
  next(kind: ProvisioningIdKind): string;
}

export interface ProvisioningJournalRecord {
  readonly idempotencyKeyHashRef: string;
  readonly inputHashRef: string;
  readonly requestId: ProvisioningRequestId;
  readonly state: "in_progress" | "completed";
  readonly result?: TenantProvisioningResult;
}

export interface ProvisioningJournalReservation {
  readonly idempotencyKeyHashRef: string;
  readonly inputHashRef: string;
  readonly requestId: ProvisioningRequestId;
}

/**
 * Required durable idempotency port. Implementations MUST be transaction-scoped
 * by the coordinator; this is not a process memory cache and there is
 * intentionally no default implementation.
 */
export interface TransactionalProvisioningJournal {
  findByIdempotencyKeyHash(idempotencyKeyHashRef: string): Promise<ProvisioningJournalRecord | null>;
  reserve(input: ProvisioningJournalReservation): Promise<ProvisioningJournalReservationOutcome>;
  complete(input: {
    idempotencyKeyHashRef: string;
    inputHashRef: string;
    requestId: ProvisioningRequestId;
    result: TenantProvisioningResult;
  }): Promise<void>;
}

export type ProvisioningJournalReservationOutcome =
  | { readonly state: "reserved" }
  | { readonly state: "completed"; readonly record: ProvisioningJournalRecord }
  | { readonly state: "in_progress" }
  | { readonly state: "conflict" };

export interface TenantProvisioningAuditEvent {
  readonly eventId: string;
  readonly eventType: typeof TENANT_PROVISIONING_AUDIT_EVENT;
  readonly requestId: ProvisioningRequestId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKeyHashRef: string;
  readonly inputHashRef: string;
  readonly actorLayer: "system";
  readonly actorIdentityId: AuthIdentityId;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId | null;
  readonly createdIds: {
    readonly tenantId: TenantId;
    readonly workspaceId: WorkspaceId | null;
    readonly policyId: string;
    readonly membershipId: MembershipId;
    readonly roleBindingId: string;
    readonly invitationId: TenantInvitationId;
  };
  readonly policyVersion: WorkflowPolicyVersion;
  readonly priorWorkflowState: "operator_approved";
  readonly nextWorkflowState: "provisioning";
  readonly resultCode: typeof TENANT_PROVISIONING_RESULT_CODE;
}

export type TenantInvitationAuditEventType =
  | typeof INVITATION_ISSUED_AUDIT_EVENT
  | typeof INVITATION_DELIVERY_AUDIT_EVENT
  | typeof INVITATION_ACCEPTED_AUDIT_EVENT
  | typeof INVITATION_REISSUED_AUDIT_EVENT
  | typeof INVITATION_REVOKED_AUDIT_EVENT
  | typeof TENANT_PROVISIONED_AUDIT_EVENT;

/**
 * Invitation lifecycle audit event. Member-scope events carry a full member
 * actor context; operator/system events leave the member fields null and are
 * recorded at platform scope with the tenant reference inside metadata.
 */
export interface TenantInvitationAuditEvent {
  readonly eventId: string;
  readonly eventType: TenantInvitationAuditEventType;
  readonly requestId: ProvisioningRequestId | null;
  readonly invitationId: TenantInvitationId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKeyHashRef: string | null;
  readonly inputHashRef: string | null;
  readonly actorLayer: ActorLayer;
  readonly actorIdentityId: AuthIdentityId;
  readonly actorMembershipId: MembershipId | null;
  readonly actorRole: LaunchRole | null;
  readonly actorRoleBindingId: string | null;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId | null;
  readonly resultCode: TenantInvitationResultCode;
  readonly priorStatus: TenantInvitationStatus | null;
  readonly nextStatus: TenantInvitationStatus | null;
  readonly generation: number | null;
}

export type TenantProvisioningDomainAuditEvent =
  | TenantProvisioningAuditEvent
  | TenantInvitationAuditEvent;

/**
 * Required durable audit port. The coordinator supplies this transaction-scoped
 * port alongside the repository and journal; a separate telemetry sink is not
 * sufficient for provisioning acceptance.
 */
export interface TransactionalProvisioningAuditPort {
  append(event: TenantProvisioningDomainAuditEvent): Promise<void>;
}

export interface TenantProvisioningTransactionScope {
  readonly repository: TenantQueryRepository;
  readonly journal: TransactionalProvisioningJournal;
  readonly audit: TransactionalProvisioningAuditPort;
}

/**
 * The only transaction boundary accepted by the service. A real coordinator
 * MUST obtain all three callback ports from the same database transaction and
 * MUST discard their writes when the callback fails.
 */
export interface TenantProvisioningTransactionCoordinator {
  run<T>(callback: (scope: TenantProvisioningTransactionScope) => Promise<T>): Promise<T>;
}

/**
 * Invitation delivery port. The provisioning domain owns the durable record;
 * adapters own transport. The request carries no raw recipient material —
 * adapters receive the invitation reference the invitee will present at
 * acceptance. A local/log adapter satisfies this now; an email adapter can
 * bind later without domain changes.
 */
export interface TenantInvitationDeliveryRequest {
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly kind: TenantInvitation["kind"];
  readonly expiresAt: string;
  readonly correlationId: CorrelationId;
}

export interface TenantInvitationDeliveryOutcome {
  /** Stable adapter identifier recorded on the durable row. */
  readonly adapterId: string;
  readonly state: "delivered" | "delivery_failed";
  /** Non-reversible provider reference; never raw link material. */
  readonly deliveryRefHash: string | null;
  /** Bounded, non-secret diagnostic (e.g. provider error class). */
  readonly deliveryDetail: string | null;
}

export interface TenantInvitationDeliveryPort {
  readonly adapterId: string;
  deliver(request: TenantInvitationDeliveryRequest): Promise<TenantInvitationDeliveryOutcome>;
}

/**
 * Server-side provider hook run inside the acceptance transaction. Production
 * binds the Supabase service-role client; the local adapter asserts identity
 * existence in-process. The returned identity must equal the request.
 */
export interface TenantAuthUserProvisionRequest {
  readonly authIdentityId: AuthIdentityId;
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly correlationId: CorrelationId;
}

export interface TenantAuthUserProvisionOutcome {
  readonly authIdentityId: AuthIdentityId;
  readonly provisioned: "existing" | "created";
}

export interface TenantAuthUserProvisioner {
  ensureAuthUser(request: TenantAuthUserProvisionRequest): Promise<TenantAuthUserProvisionOutcome>;
}

export interface TenantProvisioningServiceDependencies {
  readonly idFactory: ProvisioningIdFactory;
  readonly transactionCoordinator: TenantProvisioningTransactionCoordinator;
  /** The service boundary is operator-only; this identity is not caller-selected per command. */
  readonly operatorIdentityId: AuthIdentityId;
  /** Optional delivery adapter; when absent, invitations stay queued for a later bind. */
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  /** Server-owned clock; injectable for deterministic tests. */
  readonly clock?: () => Date;
}

export interface TenantProvisioningResult {
  readonly resultCode: typeof TENANT_PROVISIONING_RESULT_CODE;
  readonly requestId: ProvisioningRequestId;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId | null;
  readonly policyId: string;
  readonly membershipId: MembershipId;
  readonly roleBindingId: string;
  readonly invitationId: TenantInvitationId;
  readonly workflowState: "provisioning";
  readonly tenantStatus: "provisioning";
  readonly workspaceStatus: "provisioning" | null;
  readonly membershipStatus: "pending";
  readonly role: "owner";
  /** Role effectiveness remains pending while membership is pending. */
  readonly roleBindingStatus: "pending";
  readonly activationState: "blocked";
  readonly activationBlockers: readonly TenantProvisioningActivationBlocker[];
}

export type TenantProvisioningErrorCode =
  | "INVALID_INPUT"
  | "PROVISIONING_NOT_AUTHORIZED"
  | "PROVISIONING_IDEMPOTENCY_CONFLICT"
  | "PROVISIONING_IN_PROGRESS"
  | "PROVISIONING_RETRYABLE";

/** Stable, privacy-safe errors do not enumerate command material or provider details. */
export class TenantProvisioningError extends Error {
  readonly code!: TenantProvisioningErrorCode;
  readonly retryable!: boolean;

  constructor(code: TenantProvisioningErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message);
    this.name = "TenantProvisioningError";
    Object.defineProperties(this, {
      code: { value: code, enumerable: true, writable: false },
      retryable: { value: retryable, enumerable: true, writable: false },
      cause: { value: cause, enumerable: false, writable: false },
    });
  }
}

export class TenantProvisioningInputError extends TenantProvisioningError {
  constructor() {
    super("INVALID_INPUT", "The provisioning command is invalid.");
    this.name = "TenantProvisioningInputError";
  }
}

export class TenantProvisioningAuthorizationError extends TenantProvisioningError {
  constructor() {
    super("PROVISIONING_NOT_AUTHORIZED", "The provisioning operation is not authorized.");
    this.name = "TenantProvisioningAuthorizationError";
  }
}

export class TenantProvisioningIdempotencyConflictError extends TenantProvisioningError {
  constructor() {
    super("PROVISIONING_IDEMPOTENCY_CONFLICT", "The provisioning request conflicts with a prior request.");
    this.name = "TenantProvisioningIdempotencyConflictError";
  }
}

export class TenantProvisioningInProgressError extends TenantProvisioningError {
  constructor() {
    super("PROVISIONING_IN_PROGRESS", "The provisioning request is already in progress.", true);
    this.name = "TenantProvisioningInProgressError";
  }
}

export class TenantProvisioningRetryableError extends TenantProvisioningError {
  constructor(cause?: unknown) {
    super("PROVISIONING_RETRYABLE", "The provisioning operation could not be completed.", true, cause);
    this.name = "TenantProvisioningRetryableError";
  }
}

export interface TenantProvisioningService {
  provisionTenant(command: unknown): Promise<TenantProvisioningResult>;
}

export function createTenantProvisioningService(
  dependencies: TenantProvisioningServiceDependencies,
): TenantProvisioningService {
  assertDependencies(dependencies);
  const operatorIdentityId = parseOperatorIdentity(dependencies.operatorIdentityId);

  return {
    async provisionTenant(rawCommand: unknown): Promise<TenantProvisioningResult> {
      const command = parseCommand(rawCommand);
      const inputHashRef = hashNormalizedMaterial(command);
      const idempotencyKeyHashRef = hashRef(command.idempotencyKey);

      try {
        const committed: TenantProvisioningResult | FoundationCreation =
          await dependencies.transactionCoordinator.run(async (scope) => {
            const prior = await scope.journal.findByIdempotencyKeyHash(idempotencyKeyHashRef);
            if (prior) return resolvePrior(prior, idempotencyKeyHashRef, inputHashRef);

            const requestId = generatedId(dependencies.idFactory, "request", "request");
            const reservation = await scope.journal.reserve({ idempotencyKeyHashRef, inputHashRef, requestId });
            if (reservation.state === "completed") {
              return resolvePrior(reservation.record, idempotencyKeyHashRef, inputHashRef);
            }
            if (reservation.state === "in_progress") throw new TenantProvisioningInProgressError();
            if (reservation.state === "conflict") throw new TenantProvisioningIdempotencyConflictError();

            const created = await createFoundation({
              command,
              requestId,
              operatorIdentityId,
              inputHashRef,
              idempotencyKeyHashRef,
              repository: scope.repository,
              idFactory: dependencies.idFactory,
              audit: scope.audit,
              clock: trustedClock(dependencies),
            });
            await scope.journal.complete({
              idempotencyKeyHashRef,
              inputHashRef,
              requestId,
              result: created.result,
            });
            return created;
          });

        if (!("invitation" in committed)) return committed;

        // Delivery is post-commit and best-effort: the durable invitation row
        // is the source of truth, and the tenant-scoped status/reissue paths
        // recover a queued or failed delivery without exposing the invitee.
        if (dependencies.invitationDelivery) {
          await deliverInvitationBestEffort(
            dependencies,
            committed.invitation,
            committed.result.tenantId,
            operatorIdentityId,
          );
        }
        return committed.result;
      } catch (error) {
        if (error instanceof TenantProvisioningError) throw error;
        throw new TenantProvisioningRetryableError(error);
      }
    },
  };
}

interface InvitationDeliveryScope {
  readonly repository: TenantQueryRepository;
  readonly audit: { append(event: TenantInvitationAuditEvent): Promise<void> };
}

interface InvitationDeliveryDependencies {
  readonly idFactory: ProvisioningIdFactory;
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  readonly clock?: () => Date;
  readonly transactionCoordinator: {
    run<T>(callback: (scope: InvitationDeliveryScope) => Promise<T>): Promise<T>;
  };
}

async function deliverInvitationBestEffort(
  dependencies: InvitationDeliveryDependencies,
  invitation: TenantInvitation,
  tenantId: TenantId,
  actorIdentityId: AuthIdentityId,
): Promise<void> {
  const delivery = dependencies.invitationDelivery;
  if (!delivery) return;
  let outcome: TenantInvitationDeliveryOutcome;
  try {
    outcome = await delivery.deliver({
      invitationId: invitation.id,
      tenantId,
      membershipId: invitation.membershipId,
      kind: invitation.kind,
      expiresAt: invitation.expiresAt,
      correlationId: invitation.correlationId,
    });
  } catch {
    outcome = {
      adapterId: delivery.adapterId,
      state: "delivery_failed",
      deliveryRefHash: null,
      deliveryDetail: "adapter_error",
    };
  }
  if (typeof outcome?.adapterId !== "string" || outcome.adapterId !== delivery.adapterId
    || (outcome.state !== "delivered" && outcome.state !== "delivery_failed")) {
    return;
  }
  try {
    await dependencies.transactionCoordinator.run(async (scope) => {
      const marked = await scope.repository.recordInvitationDelivery(tenantId, invitation.id, {
        deliveryState: outcome.state,
        deliveryAdapter: outcome.adapterId,
        deliveryRefHash: outcome.deliveryRefHash,
        deliveryDetail: outcome.deliveryDetail,
        at: trustedClock(dependencies)().toISOString(),
      });
      if (marked) {
        await scope.audit.append({
          eventId: generatedId(dependencies.idFactory, "audit", "delivery audit event"),
          eventType: INVITATION_DELIVERY_AUDIT_EVENT,
          requestId: invitation.provisioningRequestId,
          invitationId: invitation.id,
          correlationId: invitation.correlationId,
          idempotencyKeyHashRef: null,
          inputHashRef: null,
          actorLayer: "system",
          actorIdentityId,
          actorMembershipId: null,
          actorRole: null,
          actorRoleBindingId: null,
          tenantId,
          workspaceId: invitation.workspaceId,
          resultCode: outcome.state === "delivered" ? "INVITATION_DELIVERY_RECORDED" : "INVITE_DELIVERY_UNAVAILABLE",
          priorStatus: "issued",
          nextStatus: "issued",
          generation: invitation.generation,
        });
      }
    });
  } catch {
    // The invitation remains queued; operators observe delivery state via the
    // tenant-scoped status path and may reissue. Nothing enumerates the row.
  }
}

function trustedClock(dependencies: { readonly clock?: () => Date }): () => Date {
  return () => {
    const now = dependencies.clock?.() ?? new Date();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TenantProvisioningRetryableError(new Error("The trusted clock returned an invalid time."));
    }
    return now;
  };
}

interface FoundationContext {
  readonly command: TenantProvisioningOperatorCommand;
  readonly requestId: ProvisioningRequestId;
  readonly operatorIdentityId: AuthIdentityId;
  readonly inputHashRef: string;
  readonly idempotencyKeyHashRef: string;
  readonly repository: TenantQueryRepository;
  readonly idFactory: ProvisioningIdFactory;
  readonly audit: TransactionalProvisioningAuditPort;
  readonly clock: () => Date;
}

interface FoundationCreation {
  readonly result: TenantProvisioningResult;
  readonly invitation: TenantInvitation;
}

async function createFoundation(context: FoundationContext): Promise<FoundationCreation> {
  const tenantId = generatedId(context.idFactory, "tenant", "tenant");
  const workspaceId = context.command.workspace
    ? generatedId(context.idFactory, "workspace", "workspace")
    : null;
  const policyId = generatedId(context.idFactory, "policy", "policy");
  const membershipId = generatedId(context.idFactory, "membership", "membership");
  const roleBindingId = generatedId(context.idFactory, "role_binding", "role binding");
  const invitationId = generatedId(context.idFactory, "invitation", "invitation");
  const auditEventId = generatedId(context.idFactory, "audit", "audit event");

  const tenant = await context.repository.createTenant({
    id: tenantId,
    slug: context.command.organizationSlug,
    name: context.command.organizationName,
    status: "provisioning",
    locale: context.command.locale,
    timezone: context.command.timezone,
  });
  const workspace = context.command.workspace
    ? await context.repository.createWorkspace(tenantId, {
      id: workspaceId!,
      slug: context.command.workspace.workspaceSlug,
      name: context.command.workspace.workspaceName,
      status: "provisioning",
    })
    : null;
  const policy = await context.repository.createTenantPolicy(tenantId, {
    id: policyId,
    locale: context.command.locale,
    timezone: context.command.timezone,
  });
  const membership = await context.repository.createMembership(tenantId, {
    id: membershipId,
    authIdentityId: context.command.ownerIdentityId,
    workspaceId,
    status: "pending",
  });
  const roleBinding = await context.repository.createRoleBinding(tenantId, {
    id: roleBindingId,
    membershipId: membership.id,
    role: "owner",
    reasonCode: "initial_provisioning",
  });

  const issuedAt = context.clock().toISOString();
  const expiresAt = new Date(context.clock().getTime() + TENANT_INVITATION_TTL_MS).toISOString();
  const expectedIdentityRefHash = hashInvitationIdentityRef(context.command.ownerIdentityId);
  const policyVersionRef = tenantPolicyVersionRef(policy.version);
  const contentHash = hashInvitationContent({
    id: invitationId,
    tenantId,
    membershipId: membership.id,
    provisioningRequestId: context.requestId,
    kind: "owner",
    role: "owner",
    workspaceId,
    expectedIdentityRefHash,
    policyVersion: policyVersionRef,
    generation: 1,
    expiresAt,
  });
  const invitation = await context.repository.createInvitation(tenantId, {
    id: invitationId,
    membershipId: membership.id,
    provisioningRequestId: context.requestId,
    kind: "owner",
    role: "owner",
    workspaceId,
    expectedIdentityRefHash,
    policyVersion: policyVersionRef,
    generation: 1,
    contentHash,
    expiresAt,
    correlationId: context.command.correlationId,
    auditEventId,
    issuedAt,
  });
  assertFoundationRecords({
    tenant,
    workspace,
    policy,
    membership,
    roleBinding,
    invitation,
    requestId: context.requestId,
    tenantId,
    workspaceId,
    policyId,
    membershipId,
    roleBindingId,
    invitationId,
  });

  const result: TenantProvisioningResult = {
    resultCode: TENANT_PROVISIONING_RESULT_CODE,
    requestId: context.requestId,
    tenantId: tenant.id,
    workspaceId: workspace?.id ?? null,
    policyId: policy.id,
    membershipId: membership.id,
    roleBindingId: roleBinding.id,
    invitationId: invitation.id,
    workflowState: "provisioning",
    tenantStatus: "provisioning",
    workspaceStatus: workspace ? "provisioning" : null,
    membershipStatus: "pending",
    role: "owner",
    roleBindingStatus: "pending",
    activationState: "blocked",
    activationBlockers: TENANT_PROVISIONING_ACTIVATION_BLOCKERS,
  };

  await context.audit.append({
    eventId: auditEventId,
    eventType: TENANT_PROVISIONING_AUDIT_EVENT,
    requestId: context.requestId,
    correlationId: context.command.correlationId,
    idempotencyKeyHashRef: context.idempotencyKeyHashRef,
    inputHashRef: context.inputHashRef,
    actorLayer: "system",
    actorIdentityId: context.operatorIdentityId,
    tenantId: tenant.id,
    workspaceId: workspace?.id ?? null,
    createdIds: {
      tenantId: tenant.id,
      workspaceId: workspace?.id ?? null,
      policyId: policy.id,
      membershipId: membership.id,
      roleBindingId: roleBinding.id,
      invitationId: invitation.id,
    },
    policyVersion: context.command.requestedPolicyVersion,
    priorWorkflowState: "operator_approved",
    nextWorkflowState: "provisioning",
    resultCode: TENANT_PROVISIONING_RESULT_CODE,
  });

  return { result, invitation };
}

function assertDependencies(dependencies: TenantProvisioningServiceDependencies): void {
  if (!dependencies || typeof dependencies !== "object") throw new TenantProvisioningInputError();
  if (!dependencies.transactionCoordinator || typeof dependencies.transactionCoordinator.run !== "function") {
    throw new TenantProvisioningRetryableError();
  }
  if (!dependencies.idFactory || typeof dependencies.idFactory.next !== "function") {
    throw new TenantProvisioningRetryableError();
  }
}

function parseOperatorIdentity(value: unknown): AuthIdentityId {
  const parsed = authIdentityIdSchema.safeParse(value);
  if (!parsed.success) throw new TenantProvisioningAuthorizationError();
  return parsed.data;
}

function parseCommand(rawCommand: unknown): TenantProvisioningOperatorCommand {
  const parsed = tenantProvisioningOperatorCommandSchema.safeParse(rawCommand);
  if (!parsed.success) throw new TenantProvisioningInputError();
  return parsed.data;
}

function resolvePrior(
  prior: ProvisioningJournalRecord,
  expectedIdempotencyKeyHashRef: string,
  expectedInputHashRef: string,
): TenantProvisioningResult {
  if (!isSha256Reference(prior.idempotencyKeyHashRef) || prior.idempotencyKeyHashRef !== expectedIdempotencyKeyHashRef) {
    throw new TenantProvisioningRetryableError();
  }
  if (!isSha256Reference(prior.inputHashRef)) throw new TenantProvisioningRetryableError();
  if (prior.inputHashRef !== expectedInputHashRef) throw new TenantProvisioningIdempotencyConflictError();
  if (!provisioningRequestIdSchema.safeParse(prior.requestId).success) throw new TenantProvisioningRetryableError();
  if (prior.state !== "in_progress" && prior.state !== "completed") throw new TenantProvisioningRetryableError();
  if (prior.state === "in_progress") {
    if (!hasExactKeys(prior, ["idempotencyKeyHashRef", "inputHashRef", "requestId", "state"])) {
      throw new TenantProvisioningRetryableError();
    }
    throw new TenantProvisioningInProgressError();
  }
  if (!hasExactKeys(prior, ["idempotencyKeyHashRef", "inputHashRef", "requestId", "state", "result"])) {
    throw new TenantProvisioningRetryableError();
  }
  if (!isValidProvisioningResult(prior.result) || prior.result.requestId !== prior.requestId) {
    throw new TenantProvisioningRetryableError();
  }
  return prior.result;
}

function assertFoundationRecords(input: {
  tenant: Awaited<ReturnType<TenantQueryRepository["createTenant"]>>;
  workspace: Awaited<ReturnType<TenantQueryRepository["createWorkspace"]>> | null;
  policy: Awaited<ReturnType<TenantQueryRepository["createTenantPolicy"]>>;
  membership: Awaited<ReturnType<TenantQueryRepository["createMembership"]>>;
  roleBinding: Awaited<ReturnType<TenantQueryRepository["createRoleBinding"]>>;
  invitation: Awaited<ReturnType<TenantQueryRepository["createInvitation"]>>;
  requestId: ProvisioningRequestId;
  tenantId: TenantId;
  workspaceId: WorkspaceId | null;
  policyId: string;
  membershipId: MembershipId;
  roleBindingId: string;
  invitationId: TenantInvitationId;
}): void {
  if (
    input.tenant.id !== input.tenantId
    || input.tenant.status !== "provisioning"
    || (input.workspace === null && input.workspaceId !== null)
    || (input.workspace !== null && (
      input.workspace.id !== input.workspaceId
      || input.workspace.tenantId !== input.tenantId
      || input.workspace.status !== "provisioning"
    ))
    || input.policy.id !== input.policyId
    || input.policy.tenantId !== input.tenantId
    || input.membership.id !== input.membershipId
    || input.membership.tenantId !== input.tenantId
    || input.membership.status !== "pending"
    || input.membership.workspaceId !== input.workspaceId
    || input.roleBinding.id !== input.roleBindingId
    || input.roleBinding.tenantId !== input.tenantId
    || input.roleBinding.membershipId !== input.membershipId
    || input.roleBinding.role !== "owner"
    || input.roleBinding.revokedAt !== null
    || !tenantIdSchema.safeParse(input.roleBinding.id).success
    || input.invitation.id !== input.invitationId
    || input.invitation.tenantId !== input.tenantId
    || input.invitation.membershipId !== input.membershipId
    || input.invitation.provisioningRequestId !== input.requestId
    || input.invitation.kind !== "owner"
    || input.invitation.role !== "owner"
    || input.invitation.workspaceId !== input.workspaceId
    || input.invitation.status !== "issued"
    || input.invitation.deliveryState !== "queued"
    || input.invitation.generation !== 1
  ) {
    throw new TenantProvisioningRetryableError();
  }
}

const PROVISIONING_RESULT_KEYS = [
  "resultCode",
  "requestId",
  "tenantId",
  "workspaceId",
  "policyId",
  "membershipId",
  "roleBindingId",
  "invitationId",
  "workflowState",
  "tenantStatus",
  "workspaceStatus",
  "membershipStatus",
  "role",
  "roleBindingStatus",
  "activationState",
  "activationBlockers",
] as const;

function isValidProvisioningResult(value: unknown): value is TenantProvisioningResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<TenantProvisioningResult>;
  if (!hasExactKeys(result, PROVISIONING_RESULT_KEYS)) return false;
  if (!provisioningRequestIdSchema.safeParse(result.requestId).success) return false;
  if (!tenantIdSchema.safeParse(result.tenantId).success) return false;
  if (result.workspaceId !== null && !workspaceIdSchema.safeParse(result.workspaceId).success) return false;
  if (!tenantIdSchema.safeParse(result.policyId).success) return false;
  if (!tenantIdSchema.safeParse(result.membershipId).success) return false;
  if (!tenantIdSchema.safeParse(result.roleBindingId).success) return false;
  if (!tenantInvitationIdSchema.safeParse(result.invitationId).success) return false;
  if (
    result.resultCode !== TENANT_PROVISIONING_RESULT_CODE
    || result.workflowState !== "provisioning"
    || result.tenantStatus !== "provisioning"
    || result.membershipStatus !== "pending"
    || result.role !== "owner"
    || result.roleBindingStatus !== "pending"
    || result.activationState !== "blocked"
  ) return false;
  if (result.workspaceId === null ? result.workspaceStatus !== null : result.workspaceStatus !== "provisioning") {
    return false;
  }
  return Array.isArray(result.activationBlockers)
    && result.activationBlockers.length === TENANT_PROVISIONING_ACTIVATION_BLOCKERS.length
    && result.activationBlockers.every((blocker, index) => blocker === TENANT_PROVISIONING_ACTIVATION_BLOCKERS[index]);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actualKeys.length === expected.length && actualKeys.every((key, index) => key === expected[index]);
}

function isSha256Reference(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function generatedId(factory: ProvisioningIdFactory, kind: ProvisioningIdKind, label: string): string {
  const value = factory.next(kind);
  if (typeof value !== "string" || !tenantIdSchema.safeParse(value).success) {
    throw new TenantProvisioningRetryableError(new Error(`Invalid generated ${label} identifier.`));
  }
  if (kind === "workspace" && !workspaceIdSchema.safeParse(value).success) {
    throw new TenantProvisioningRetryableError(new Error("Invalid generated workspace identifier."));
  }
  return value;
}

function hashRef(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashNormalizedMaterial(command: TenantProvisioningOperatorCommand): string {
  const canonical = JSON.stringify({
    organizationName: command.organizationName,
    organizationSlug: command.organizationSlug,
    requestedPolicyVersion: command.requestedPolicyVersion,
    locale: command.locale,
    timezone: command.timezone,
    ownerIdentityId: command.ownerIdentityId,
    workspace: command.workspace
      ? {
        workspaceName: command.workspace.workspaceName,
        workspaceSlug: command.workspace.workspaceSlug,
      }
      : null,
  });
  return hashRef(canonical);
}

// ---------------------------------------------------------------------------
// Tenant invitation service — durable issuance, delivery, acceptance, reissue,
// revoke, and operator status. All operations are transaction-scoped,
// idempotent, audited, and non-enumerating.
// ---------------------------------------------------------------------------

export type TenantInvitationOperation = "issue" | "accept" | "reissue" | "revoke";

export interface TenantInvitationAcceptanceResult {
  readonly resultCode: "INVITATION_ACCEPTED";
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  /** Effective membership — the replacement row when a pending selector resolved. */
  readonly membershipId: MembershipId;
  readonly role: LaunchRole;
  readonly tenantStatus: TenantStatus;
  readonly workspaceStatus: WorkspaceStatus | null;
  readonly membershipStatus: "active";
  readonly acceptedAt: string;
  readonly activationState: "active";
  readonly activationBlockers: readonly TenantProvisioningActivationBlocker[];
}

export interface TenantInvitationIssueResult {
  readonly resultCode: "INVITATION_ISSUED";
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly generation: number;
  readonly expiresAt: string;
  readonly deliveryState: TenantInvitationDeliveryState;
}

export interface TenantInvitationReissueResult {
  readonly resultCode: "INVITATION_REISSUED";
  readonly priorInvitationId: TenantInvitationId;
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly generation: number;
  readonly expiresAt: string;
  readonly deliveryState: TenantInvitationDeliveryState;
}

export interface TenantInvitationRevokeResult {
  readonly resultCode: "INVITATION_REVOKED";
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly status: "revoked";
  readonly revokedAt: string;
}

/** Privacy-safe operator view — no recipient material, only lifecycle facts. */
export interface TenantInvitationStatusView {
  readonly invitationId: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly kind: TenantInvitationKind;
  readonly role: LaunchRole;
  readonly status: TenantInvitationStatus;
  readonly effectiveStatus: TenantInvitationStatus;
  readonly deliveryState: TenantInvitationDeliveryState;
  readonly deliveryAdapter: string | null;
  readonly generation: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}

export type TenantInvitationOperationResult =
  | TenantInvitationAcceptanceResult
  | TenantInvitationIssueResult
  | TenantInvitationReissueResult
  | TenantInvitationRevokeResult;

export interface TenantInvitationJournalRecord {
  readonly idempotencyKeyHashRef: string;
  readonly inputHashRef: string;
  readonly operation: TenantInvitationOperation;
  readonly tenantId: TenantId;
  readonly invitationId: TenantInvitationId;
  readonly state: "reserved" | "completed";
  readonly result?: TenantInvitationOperationResult;
}

export type TenantInvitationJournalReservationOutcome =
  | { readonly state: "reserved" }
  | { readonly state: "completed"; readonly record: TenantInvitationJournalRecord }
  | { readonly state: "in_progress" }
  | { readonly state: "conflict" };

/**
 * Required durable idempotency port for invitation mutations. Transaction-scoped
 * by the coordinator; there is intentionally no process-memory default.
 */
export interface TransactionalTenantInvitationJournal {
  findByIdempotencyKeyHash(idempotencyKeyHashRef: string): Promise<TenantInvitationJournalRecord | null>;
  reserve(input: {
    idempotencyKeyHashRef: string;
    inputHashRef: string;
    operation: TenantInvitationOperation;
    tenantId: TenantId;
    invitationId: TenantInvitationId;
  }): Promise<TenantInvitationJournalReservationOutcome>;
  complete(input: {
    idempotencyKeyHashRef: string;
    result: TenantInvitationOperationResult;
  }): Promise<void>;
}

/** Transaction-scoped audit port for invitation lifecycle events. */
export interface TransactionalTenantInvitationAuditPort {
  append(event: TenantInvitationAuditEvent): Promise<void>;
}

export interface TenantInvitationTransactionScope {
  readonly repository: TenantQueryRepository;
  readonly journal: TransactionalTenantInvitationJournal;
  readonly audit: TransactionalTenantInvitationAuditPort;
}

export interface TenantInvitationTransactionCoordinator {
  run<T>(callback: (scope: TenantInvitationTransactionScope) => Promise<T>): Promise<T>;
}

export interface TenantInvitationServiceDependencies {
  readonly idFactory: ProvisioningIdFactory;
  readonly transactionCoordinator: TenantInvitationTransactionCoordinator;
  /** Required for operator-scoped issue/reissue/revoke/status. */
  readonly operatorIdentityId?: AuthIdentityId;
  /** Required for acceptance: verifies the provider identity server-side. */
  readonly authUserProvisioner?: TenantAuthUserProvisioner;
  /** Optional delivery adapter; absent delivery leaves rows queued. */
  readonly invitationDelivery?: TenantInvitationDeliveryPort;
  /**
   * Optional tenant-limit service. When present, member-context invitation
   * issue consumes the membership_invite quota before the transaction opens.
   */
  readonly limits?: Pick<TenantLimitService, "consume">;
  readonly clock?: () => Date;
}

export interface TenantInvitationService {
  /**
   * Member-facing acceptance. The accepting identity is the caller's verified
   * session subject — never taken from the command body.
   */
  acceptInvitation(authenticatedIdentityId: unknown, command: unknown): Promise<TenantInvitationAcceptanceResult>;
  /** Issues the durable invite for an existing pending membership (member path). */
  issueMembershipInvitation(command: unknown): Promise<TenantInvitationIssueResult>;
  reissueInvitation(command: unknown): Promise<TenantInvitationReissueResult>;
  revokeInvitation(command: unknown): Promise<TenantInvitationRevokeResult>;
  getInvitationStatus(query: unknown): Promise<TenantInvitationStatusView>;
}

/** Stable, privacy-safe errors — none enumerate tenant existence or recipient material. */
export class TenantInvitationError extends Error {
  readonly code!: TenantInvitationResultCode;
  readonly retryable!: boolean;

  constructor(code: TenantInvitationResultCode, message: string, retryable = false, cause?: unknown) {
    super(message);
    this.name = "TenantInvitationError";
    Object.defineProperties(this, {
      code: { value: code, enumerable: true, writable: false },
      retryable: { value: retryable, enumerable: true, writable: false },
      cause: { value: cause, enumerable: false, writable: false },
    });
  }
}

export class TenantInvitationInputError extends TenantInvitationError {
  constructor() {
    super("INVALID_INPUT", "The invitation command is invalid.");
    this.name = "TenantInvitationInputError";
  }
}

export class TenantInvitationAuthorizationError extends TenantInvitationError {
  constructor() {
    super("INVITATION_NOT_AUTHORIZED", "The invitation operation is not authorized.");
    this.name = "TenantInvitationAuthorizationError";
  }
}

export class TenantInvitationNotFoundError extends TenantInvitationError {
  constructor() {
    super("INVITE_NOT_FOUND", "The invitation is not available.");
    this.name = "TenantInvitationNotFoundError";
  }
}

export class TenantInvitationIdempotencyConflictError extends TenantInvitationError {
  constructor() {
    super("PROVISIONING_IDEMPOTENCY_CONFLICT", "The invitation request conflicts with a prior request.");
    this.name = "TenantInvitationIdempotencyConflictError";
  }
}

export class TenantInvitationInProgressError extends TenantInvitationError {
  constructor() {
    super("PROVISIONING_IN_PROGRESS", "The invitation request is already in progress.", true);
    this.name = "TenantInvitationInProgressError";
  }
}

export class TenantInvitationConflictError extends TenantInvitationError {
  constructor() {
    super("PROVISIONING_CONFLICT", "The invitation changed while the operation was in flight.");
    this.name = "TenantInvitationConflictError";
  }
}

export class TenantInvitationMisconfiguredError extends TenantInvitationError {
  constructor(cause?: unknown) {
    super("SERVICE_MISCONFIGURED", "The invitation service is not configured for this operation.", true, cause);
    this.name = "TenantInvitationMisconfiguredError";
  }
}

export class TenantInvitationRetryableError extends TenantInvitationError {
  constructor(cause?: unknown) {
    super("PROVISIONING_RETRYABLE", "The invitation operation could not be completed.", true, cause);
    this.name = "TenantInvitationRetryableError";
  }
}

export function createTenantInvitationService(
  dependencies: TenantInvitationServiceDependencies,
): TenantInvitationService {
  if (!dependencies || typeof dependencies !== "object") throw new TenantInvitationInputError();
  if (!dependencies.transactionCoordinator || typeof dependencies.transactionCoordinator.run !== "function") {
    throw new TenantInvitationMisconfiguredError();
  }
  if (!dependencies.idFactory || typeof dependencies.idFactory.next !== "function") {
    throw new TenantInvitationMisconfiguredError();
  }
  const operatorIdentityId = dependencies.operatorIdentityId === undefined
    ? null
    : parseInvitationOperatorIdentity(dependencies.operatorIdentityId);
  const clock = () => {
    const now = dependencies.clock?.() ?? new Date();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TenantInvitationRetryableError(new Error("The trusted clock returned an invalid time."));
    }
    return now;
  };

  return {
    async issueMembershipInvitation(rawCommand: unknown): Promise<TenantInvitationIssueResult> {
      // Member-initiated: the command's actor membership/identity is verified
      // against durable state inside the transaction, so no operator gate.
      const command = parseInvitationCommand<TenantInvitationIssueCommand>(
        rawCommand,
        tenantInvitationIssueCommandSchema,
      );
      // Member-initiated issues consume the tenant invite quota. The derived
      // digest key replays with the operation and never exposes the raw key.
      if (getTenantContext()
        && !(await consumeInvitationLimit(dependencies.limits, `issue:${command.idempotencyKey}`))) {
        throw new TenantInvitationError("TENANT_STATE_BLOCKED", "The tenant is not available for invitations.");
      }
      const inputHashRef = hashInvitationInput("issue", {
        tenantId: command.tenantId,
        membershipId: command.membershipId,
        role: command.role,
        workspaceId: command.workspaceId,
        expectedIdentityRefHash: command.expectedIdentityRefHash,
      });
      const keyHashRef = hashInvitationKey("issue", command.idempotencyKey);
      const newInvitationId = generatedInvitationId(dependencies.idFactory, "invitation");

      try {
        const committed = await dependencies.transactionCoordinator.run(async (scope) => {
          const prior = await scope.journal.findByIdempotencyKeyHash(keyHashRef);
          if (prior) {
            return { result: resolveInvitationPrior<TenantInvitationIssueResult>(prior, keyHashRef, inputHashRef, "issue", command.membershipId) };
          }

          const tenant = await scope.repository.getTenant(command.tenantId);
          if (!tenant || tenant.status !== "active") {
            throw new TenantInvitationError("TENANT_STATE_BLOCKED", "The tenant is not available for invitations.");
          }
          const membership = await scope.repository.getMembership(command.tenantId, command.membershipId);
          if (!membership || membership.status !== "pending"
            || membership.pendingIdentityRefHash !== command.expectedIdentityRefHash
            || membership.authIdentityId !== null
            || membership.workspaceId !== command.workspaceId) {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The invitation target is not available.");
          }
          const actorBinding = await scope.repository.getCurrentRoleBinding(command.tenantId, command.actorMembershipId);
          const actorMembership = await scope.repository.getMembership(command.tenantId, command.actorMembershipId);
          if (!actorMembership || actorMembership.status !== "active"
            || actorMembership.authIdentityId !== command.actorIdentityId
            || !actorBinding || actorBinding.revokedAt !== null
            || (actorBinding.role !== "owner" && actorBinding.role !== "admin")) {
            throw new TenantInvitationAuthorizationError();
          }
          if (command.role === "owner") {
            throw new TenantInvitationInputError();
          }

          const reservation = await scope.journal.reserve({
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            operation: "issue",
            tenantId: command.tenantId,
            invitationId: newInvitationId,
          });
          if (reservation.state === "completed") {
            return { result: resolveInvitationPrior<TenantInvitationIssueResult>(reservation.record, keyHashRef, inputHashRef, "issue", command.membershipId) };
          }
          if (reservation.state === "in_progress") throw new TenantInvitationInProgressError();
          if (reservation.state === "conflict") throw new TenantInvitationIdempotencyConflictError();

          const live = await scope.repository.getLiveInvitationForMembership(command.tenantId, command.membershipId);
          if (live) throw new TenantInvitationConflictError();

          const policy = await scope.repository.getCurrentTenantPolicy(command.tenantId);
          if (!policy) {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The tenant policy is unavailable.");
          }
          const policyVersionRef = tenantPolicyVersionRef(policy.version);

          const issuedAt = clock().toISOString();
          const expiresAt = new Date(clock().getTime() + TENANT_INVITATION_TTL_MS).toISOString();
          const contentHash = hashInvitationContent({
            id: newInvitationId,
            tenantId: command.tenantId,
            membershipId: command.membershipId,
            provisioningRequestId: null,
            kind: "member",
            role: command.role,
            workspaceId: command.workspaceId,
            expectedIdentityRefHash: command.expectedIdentityRefHash,
            policyVersion: policyVersionRef,
            generation: 1,
            expiresAt,
          });
          const auditEventId = generatedInvitationId(dependencies.idFactory, "audit");
          const invitation = await scope.repository.createInvitation(command.tenantId, {
            id: newInvitationId,
            membershipId: command.membershipId,
            provisioningRequestId: null,
            kind: "member",
            role: command.role,
            workspaceId: command.workspaceId,
            expectedIdentityRefHash: command.expectedIdentityRefHash,
            policyVersion: policyVersionRef,
            generation: 1,
            contentHash,
            expiresAt,
            correlationId: command.correlationId,
            auditEventId,
            issuedAt,
          });
          assertIssuedInvitation(invitation, {
            id: newInvitationId,
            tenantId: command.tenantId,
            membershipId: command.membershipId,
            kind: "member",
            role: command.role,
            workspaceId: command.workspaceId,
            expectedIdentityRefHash: command.expectedIdentityRefHash,
            generation: 1,
          });

          await scope.audit.append({
            eventId: auditEventId,
            eventType: INVITATION_ISSUED_AUDIT_EVENT,
            requestId: invitation.provisioningRequestId,
            invitationId: invitation.id,
            correlationId: command.correlationId,
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            actorLayer: "member",
            actorIdentityId: command.actorIdentityId,
            actorMembershipId: command.actorMembershipId,
            actorRole: actorBinding.role,
            actorRoleBindingId: actorBinding.id,
            tenantId: command.tenantId,
            workspaceId: command.workspaceId,
            resultCode: "INVITATION_ISSUED",
            priorStatus: null,
            nextStatus: "issued",
            generation: invitation.generation,
          });

          const result: TenantInvitationIssueResult = {
            resultCode: "INVITATION_ISSUED",
            invitationId: invitation.id,
            tenantId: command.tenantId,
            membershipId: command.membershipId,
            generation: invitation.generation,
            expiresAt: invitation.expiresAt,
            deliveryState: invitation.deliveryState,
          };
          await scope.journal.complete({ idempotencyKeyHashRef: keyHashRef, result });
          return { result, invitation };
        });

        if ("invitation" in committed && committed.invitation) {
          await deliverInvitationBestEffort(dependencies, committed.invitation, committed.result.tenantId, command.actorIdentityId);
        }
        return committed.result;
      } catch (error) {
        throw mapInvitationError(error);
      }
    },

    async acceptInvitation(authenticatedIdentityId: unknown, rawCommand: unknown): Promise<TenantInvitationAcceptanceResult> {
      const identity = parseAcceptingIdentity(authenticatedIdentityId);
      const command = parseInvitationCommand<TenantInvitationAcceptanceCommand>(
        rawCommand,
        tenantInvitationAcceptanceCommandSchema,
      );
      const identityRefHash = hashInvitationIdentityRef(identity);
      const inputHashRef = hashInvitationInput("accept", {
        invitationId: command.invitationId,
        acceptingIdentityRefHash: identityRefHash,
      });
      const keyHashRef = hashInvitationKey("accept", command.idempotencyKey);

      try {
        return await dependencies.transactionCoordinator.run(async (scope) => {
          const prior = await scope.journal.findByIdempotencyKeyHash(keyHashRef);
          if (prior) {
            return resolveInvitationPrior<TenantInvitationAcceptanceResult>(prior, keyHashRef, inputHashRef, "accept", command.invitationId);
          }

          const invitation = await scope.repository.getInvitationById(command.invitationId);
          if (!invitation) throw new TenantInvitationNotFoundError();

          // Recipient binding is verified before any status disclosure so a
          // wrong recipient learns nothing about the invitation's lifecycle.
          if (invitation.expectedIdentityRefHash !== identityRefHash) {
            throw new TenantInvitationError("INVITE_RECIPIENT_MISMATCH", "The invitation is not available.");
          }

          const now = clock();
          const nowIso = now.toISOString();
          if (invitation.status === "accepted") {
            throw new TenantInvitationError("INVITE_ALREADY_ACCEPTED", "The invitation was already accepted.");
          }
          if (invitation.status === "revoked" || invitation.status === "superseded") {
            throw new TenantInvitationError("INVITE_REVOKED", "The invitation is not available.");
          }
          if (invitation.status === "expired" || nowIso >= invitation.expiresAt) {
            throw new TenantInvitationError("INVITE_EXPIRED", "The invitation has expired.");
          }

          const tenant = await scope.repository.getTenant(invitation.tenantId);
          const requiredTenantStatus: TenantStatus = invitation.kind === "owner" ? "provisioning" : "active";
          if (!tenant || tenant.status !== requiredTenantStatus) {
            throw new TenantInvitationError("TENANT_STATE_BLOCKED", "The tenant is not available for acceptance.");
          }

          const membership = await scope.repository.getMembership(invitation.tenantId, invitation.membershipId);
          if (!membership || membership.status !== "pending"
            || membership.workspaceId !== invitation.workspaceId) {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The invitation target is not available.");
          }
          if (membership.authIdentityId !== null) {
            if (membership.authIdentityId !== identity) {
              throw new TenantInvitationError("INVITE_RECIPIENT_MISMATCH", "The invitation is not available.");
            }
          } else if (membership.pendingIdentityRefHash !== invitation.expectedIdentityRefHash) {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The invitation target is not available.");
          }

          const roleBinding = await scope.repository.getCurrentRoleBinding(invitation.tenantId, membership.id);
          if (!roleBinding || roleBinding.role !== invitation.role || roleBinding.revokedAt !== null) {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The invitation target is not available.");
          }

          const policy = await scope.repository.getCurrentTenantPolicy(invitation.tenantId);
          if (!policy || invitation.policyVersion !== tenantPolicyVersionRef(policy.version)) {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The tenant policy is unavailable.");
          }

          const workspace = invitation.workspaceId === null
            ? null
            : await scope.repository.getWorkspace(invitation.tenantId, invitation.workspaceId);
          if (invitation.workspaceId !== null) {
            const requiredWorkspaceStatus = invitation.kind === "owner" ? "provisioning" : "active";
            if (!workspace || workspace.status !== requiredWorkspaceStatus) {
              throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The invitation target is not available.");
            }
          }

          const reservation = await scope.journal.reserve({
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            operation: "accept",
            tenantId: invitation.tenantId,
            invitationId: invitation.id,
          });
          if (reservation.state === "completed") {
            return resolveInvitationPrior<TenantInvitationAcceptanceResult>(reservation.record, keyHashRef, inputHashRef, "accept", command.invitationId);
          }
          if (reservation.state === "in_progress") throw new TenantInvitationInProgressError();
          if (reservation.state === "conflict") throw new TenantInvitationIdempotencyConflictError();

          const provisioner = dependencies.authUserProvisioner;
          if (!provisioner) throw new TenantInvitationMisconfiguredError();
          const provisioned = await provisioner.ensureAuthUser({
            authIdentityId: identity,
            invitationId: invitation.id,
            tenantId: invitation.tenantId,
            correlationId: command.correlationId,
          });
          if (!provisioned || provisioned.authIdentityId !== identity) {
            throw new TenantInvitationMisconfiguredError();
          }

          const accepted = await scope.repository.finalizeInvitationAcceptance(invitation.tenantId, invitation.id, {
            expectedContentHash: invitation.contentHash,
            acceptedAt: nowIso,
            acceptedAuthIdentityId: identity,
          });
          if (!accepted) throw new TenantInvitationConflictError();

          let effectiveMembershipId = membership.id;
          let effectiveRoleBindingId = roleBinding.id;
          if (membership.authIdentityId !== null) {
            const activated = await scope.repository.updateMembershipStatus(invitation.tenantId, membership.id, "active");
            if (activated.status !== "active" || activated.authIdentityId !== identity) {
              throw new TenantInvitationRetryableError();
            }
          } else {
            const expired = await scope.repository.updateMembershipStatus(invitation.tenantId, membership.id, "expired");
            if (expired.status !== "expired") throw new TenantInvitationRetryableError();
            await scope.repository.revokeCurrentRoleBinding(invitation.tenantId, membership.id, nowIso);
            const replacement = await scope.repository.createMembership(invitation.tenantId, {
              id: generatedInvitationId(dependencies.idFactory, "membership"),
              authIdentityId: identity,
              workspaceId: invitation.workspaceId,
              status: "active",
              invitedByMembershipId: membership.invitedByMembershipId,
              createdAt: nowIso,
              updatedAt: nowIso,
            });
            const binding = await scope.repository.createRoleBinding(invitation.tenantId, {
              id: generatedInvitationId(dependencies.idFactory, "role_binding"),
              membershipId: replacement.id,
              role: invitation.role,
              reasonCode: "invitation",
              validFrom: nowIso,
              createdAt: nowIso,
              assignedByMembershipId: membership.invitedByMembershipId,
            });
            effectiveMembershipId = replacement.id;
            effectiveRoleBindingId = binding.id;
          }

          let workspaceStatus: WorkspaceStatus | null = null;
          if (invitation.kind === "owner") {
            const activatedTenant = await scope.repository.updateTenantStatus(invitation.tenantId, "active");
            if (activatedTenant.status !== "active") throw new TenantInvitationRetryableError();
            if (invitation.workspaceId !== null) {
              const activatedWorkspace = await scope.repository.updateWorkspaceStatus(
                invitation.tenantId,
                invitation.workspaceId,
                "active",
              );
              workspaceStatus = activatedWorkspace.status;
            }
          } else {
            workspaceStatus = workspace?.status ?? null;
          }

          const result: TenantInvitationAcceptanceResult = {
            resultCode: "INVITATION_ACCEPTED",
            invitationId: invitation.id,
            tenantId: invitation.tenantId,
            membershipId: effectiveMembershipId,
            role: invitation.role,
            tenantStatus: invitation.kind === "owner" ? "active" : tenant.status,
            workspaceStatus,
            membershipStatus: "active",
            acceptedAt: nowIso,
            activationState: "active",
            activationBlockers: [],
          };

          await scope.audit.append({
            eventId: generatedInvitationId(dependencies.idFactory, "audit"),
            eventType: invitation.kind === "owner" ? TENANT_PROVISIONED_AUDIT_EVENT : INVITATION_ACCEPTED_AUDIT_EVENT,
            requestId: invitation.provisioningRequestId,
            invitationId: invitation.id,
            correlationId: command.correlationId,
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            actorLayer: "member",
            actorIdentityId: identity,
            actorMembershipId: effectiveMembershipId,
            actorRole: invitation.role,
            actorRoleBindingId: effectiveRoleBindingId,
            tenantId: invitation.tenantId,
            workspaceId: invitation.workspaceId,
            resultCode: "INVITATION_ACCEPTED",
            priorStatus: "issued",
            nextStatus: "accepted",
            generation: invitation.generation,
          });
          await scope.journal.complete({ idempotencyKeyHashRef: keyHashRef, result });
          return result;
        });
      } catch (error) {
        throw mapInvitationError(error);
      }
    },

    async reissueInvitation(rawCommand: unknown): Promise<TenantInvitationReissueResult> {
      const operator = requireInvitationOperator(operatorIdentityId);
      const command = parseInvitationCommand<TenantInvitationReissueCommand>(
        rawCommand,
        tenantInvitationReissueCommandSchema,
      );
      const inputHashRef = hashInvitationInput("reissue", {
        invitationId: command.invitationId,
        reasonCode: command.reasonCode,
        reason: command.reason,
        expiresAt: command.expiresAt ?? null,
      });
      const keyHashRef = hashInvitationKey("reissue", command.idempotencyKey);
      const newInvitationId = generatedInvitationId(dependencies.idFactory, "invitation");

      try {
        const committed = await dependencies.transactionCoordinator.run(async (scope) => {
          const prior = await scope.journal.findByIdempotencyKeyHash(keyHashRef);
          if (prior) {
            return { result: resolveInvitationPrior<TenantInvitationReissueResult>(prior, keyHashRef, inputHashRef, "reissue", command.invitationId) };
          }

          const invitation = await scope.repository.getInvitationById(command.invitationId);
          if (!invitation) throw new TenantInvitationNotFoundError();
          if (invitation.status === "accepted") {
            throw new TenantInvitationError("INVITE_ALREADY_ACCEPTED", "The invitation was already accepted.");
          }
          if (invitation.status === "revoked" || invitation.status === "superseded") {
            throw new TenantInvitationError("INVITE_REVOKED", "The invitation is not available.");
          }

          const tenant = await scope.repository.getTenant(invitation.tenantId);
          const requiredTenantStatus: TenantStatus = invitation.kind === "owner" ? "provisioning" : "active";
          if (!tenant || tenant.status !== requiredTenantStatus) {
            throw new TenantInvitationError("TENANT_STATE_BLOCKED", "The tenant is not available for invitations.");
          }
          const membership = await scope.repository.getMembership(invitation.tenantId, invitation.membershipId);
          if (!membership || membership.status !== "pending") {
            throw new TenantInvitationError("PROVISIONING_STATE_BLOCKED", "The invitation target is not available.");
          }

          const now = clock();
          const nowIso = now.toISOString();
          const expiresAt = command.expiresAt
            ?? new Date(now.getTime() + TENANT_INVITATION_TTL_MS).toISOString();
          if (expiresAt <= nowIso) throw new TenantInvitationInputError();

          const reservation = await scope.journal.reserve({
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            operation: "reissue",
            tenantId: invitation.tenantId,
            invitationId: newInvitationId,
          });
          if (reservation.state === "completed") {
            return { result: resolveInvitationPrior<TenantInvitationReissueResult>(reservation.record, keyHashRef, inputHashRef, "reissue", command.invitationId) };
          }
          if (reservation.state === "in_progress") throw new TenantInvitationInProgressError();
          if (reservation.state === "conflict") throw new TenantInvitationIdempotencyConflictError();

          const priorStatus = invitation.status;
          if (invitation.status === "issued") {
            const superseded = await scope.repository.supersedeInvitation(invitation.tenantId, invitation.id, {
              at: nowIso,
              reasonCode: command.reasonCode,
              supersededByInvitationId: newInvitationId,
            });
            if (!superseded) throw new TenantInvitationConflictError();
          }

          const generation = invitation.generation + 1;
          const contentHash = hashInvitationContent({
            id: newInvitationId,
            tenantId: invitation.tenantId,
            membershipId: invitation.membershipId,
            provisioningRequestId: invitation.provisioningRequestId,
            kind: invitation.kind,
            role: invitation.role,
            workspaceId: invitation.workspaceId,
            expectedIdentityRefHash: invitation.expectedIdentityRefHash,
            policyVersion: invitation.policyVersion,
            generation,
            expiresAt,
          });
          const auditEventId = generatedInvitationId(dependencies.idFactory, "audit");
          const issued = await scope.repository.createInvitation(invitation.tenantId, {
            id: newInvitationId,
            membershipId: invitation.membershipId,
            provisioningRequestId: invitation.provisioningRequestId,
            kind: invitation.kind,
            role: invitation.role,
            workspaceId: invitation.workspaceId,
            expectedIdentityRefHash: invitation.expectedIdentityRefHash,
            policyVersion: invitation.policyVersion,
            generation,
            contentHash,
            expiresAt,
            correlationId: command.correlationId,
            auditEventId,
            issuedAt: nowIso,
          });
          assertIssuedInvitation(issued, {
            id: newInvitationId,
            tenantId: invitation.tenantId,
            membershipId: invitation.membershipId,
            kind: invitation.kind,
            role: invitation.role,
            workspaceId: invitation.workspaceId,
            expectedIdentityRefHash: invitation.expectedIdentityRefHash,
            generation,
          });

          await scope.audit.append({
            eventId: auditEventId,
            eventType: INVITATION_REISSUED_AUDIT_EVENT,
            requestId: invitation.provisioningRequestId,
            invitationId: issued.id,
            correlationId: command.correlationId,
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            actorLayer: "system",
            actorIdentityId: operator,
            actorMembershipId: null,
            actorRole: null,
            actorRoleBindingId: null,
            tenantId: invitation.tenantId,
            workspaceId: invitation.workspaceId,
            resultCode: "INVITATION_REISSUED",
            priorStatus,
            nextStatus: "issued",
            generation,
          });

          const result: TenantInvitationReissueResult = {
            resultCode: "INVITATION_REISSUED",
            priorInvitationId: invitation.id,
            invitationId: issued.id,
            tenantId: invitation.tenantId,
            membershipId: invitation.membershipId,
            generation,
            expiresAt: issued.expiresAt,
            deliveryState: issued.deliveryState,
          };
          await scope.journal.complete({ idempotencyKeyHashRef: keyHashRef, result });
          return { result, invitation: issued };
        });

        if ("invitation" in committed && committed.invitation) {
          await deliverInvitationBestEffort(dependencies, committed.invitation, committed.result.tenantId, operator);
        }
        return committed.result;
      } catch (error) {
        throw mapInvitationError(error);
      }
    },

    async revokeInvitation(rawCommand: unknown): Promise<TenantInvitationRevokeResult> {
      const operator = requireInvitationOperator(operatorIdentityId);
      const command = parseInvitationCommand<TenantInvitationRevokeCommand>(
        rawCommand,
        tenantInvitationRevokeCommandSchema,
      );
      const inputHashRef = hashInvitationInput("revoke", {
        invitationId: command.invitationId,
        reasonCode: command.reasonCode,
        reason: command.reason,
      });
      const keyHashRef = hashInvitationKey("revoke", command.idempotencyKey);

      try {
        return await dependencies.transactionCoordinator.run(async (scope) => {
          const prior = await scope.journal.findByIdempotencyKeyHash(keyHashRef);
          if (prior) {
            return resolveInvitationPrior<TenantInvitationRevokeResult>(prior, keyHashRef, inputHashRef, "revoke", command.invitationId);
          }

          const invitation = await scope.repository.getInvitationById(command.invitationId);
          if (!invitation) throw new TenantInvitationNotFoundError();
          if (invitation.status === "accepted") {
            throw new TenantInvitationError("INVITE_ALREADY_ACCEPTED", "The invitation was already accepted.");
          }
          if (invitation.status === "revoked" || invitation.status === "superseded") {
            throw new TenantInvitationError("INVITE_REVOKED", "The invitation is not available.");
          }
          if (invitation.status === "expired") {
            throw new TenantInvitationError("INVITE_EXPIRED", "The invitation has expired.");
          }

          const reservation = await scope.journal.reserve({
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            operation: "revoke",
            tenantId: invitation.tenantId,
            invitationId: invitation.id,
          });
          if (reservation.state === "completed") {
            return resolveInvitationPrior<TenantInvitationRevokeResult>(reservation.record, keyHashRef, inputHashRef, "revoke", command.invitationId);
          }
          if (reservation.state === "in_progress") throw new TenantInvitationInProgressError();
          if (reservation.state === "conflict") throw new TenantInvitationIdempotencyConflictError();

          const nowIso = clock().toISOString();
          const revoked = await scope.repository.revokeInvitation(invitation.tenantId, invitation.id, {
            at: nowIso,
            reasonCode: command.reasonCode,
          });
          if (!revoked) throw new TenantInvitationConflictError();

          await scope.audit.append({
            eventId: generatedInvitationId(dependencies.idFactory, "audit"),
            eventType: INVITATION_REVOKED_AUDIT_EVENT,
            requestId: invitation.provisioningRequestId,
            invitationId: invitation.id,
            correlationId: command.correlationId,
            idempotencyKeyHashRef: keyHashRef,
            inputHashRef,
            actorLayer: "system",
            actorIdentityId: operator,
            actorMembershipId: null,
            actorRole: null,
            actorRoleBindingId: null,
            tenantId: invitation.tenantId,
            workspaceId: invitation.workspaceId,
            resultCode: "INVITATION_REVOKED",
            priorStatus: "issued",
            nextStatus: "revoked",
            generation: invitation.generation,
          });

          const result: TenantInvitationRevokeResult = {
            resultCode: "INVITATION_REVOKED",
            invitationId: invitation.id,
            tenantId: invitation.tenantId,
            membershipId: invitation.membershipId,
            status: "revoked",
            revokedAt: nowIso,
          };
          await scope.journal.complete({ idempotencyKeyHashRef: keyHashRef, result });
          return result;
        });
      } catch (error) {
        throw mapInvitationError(error);
      }
    },

    async getInvitationStatus(rawQuery: unknown): Promise<TenantInvitationStatusView> {
      requireInvitationOperator(operatorIdentityId);
      const query = parseInvitationCommand<TenantInvitationStatusQuery>(
        rawQuery,
        tenantInvitationStatusQuerySchema,
      );
      try {
        return await dependencies.transactionCoordinator.run(async (scope) => {
          const invitation = await scope.repository.getInvitationById(query.invitationId);
          if (!invitation) throw new TenantInvitationNotFoundError();
          const effectiveStatus: TenantInvitationStatus =
            invitation.status === "issued" && clock().toISOString() >= invitation.expiresAt
              ? "expired"
              : invitation.status;
          return {
            invitationId: invitation.id,
            tenantId: invitation.tenantId,
            membershipId: invitation.membershipId,
            kind: invitation.kind,
            role: invitation.role,
            status: invitation.status,
            effectiveStatus,
            deliveryState: invitation.deliveryState,
            deliveryAdapter: invitation.deliveryAdapter,
            generation: invitation.generation,
            issuedAt: invitation.issuedAt,
            expiresAt: invitation.expiresAt,
            acceptedAt: invitation.acceptedAt,
            revokedAt: invitation.revokedAt,
          };
        });
      } catch (error) {
        throw mapInvitationError(error);
      }
    },
  };
}

function parseAcceptingIdentity(value: unknown): AuthIdentityId {
  const parsed = authIdentityIdSchema.safeParse(value);
  if (!parsed.success) throw new TenantInvitationInputError();
  return parsed.data;
}

function parseInvitationOperatorIdentity(value: unknown): AuthIdentityId {
  const parsed = authIdentityIdSchema.safeParse(value);
  if (!parsed.success) throw new TenantInvitationAuthorizationError();
  return parsed.data;
}

function requireInvitationOperator(operatorIdentityId: AuthIdentityId | null): AuthIdentityId {
  if (operatorIdentityId === null) throw new TenantInvitationAuthorizationError();
  return operatorIdentityId;
}

function parseInvitationCommand<T>(rawCommand: unknown, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }): T {
  const parsed = schema.safeParse(rawCommand);
  if (!parsed.success) throw new TenantInvitationInputError();
  return parsed.data;
}

function mapInvitationError(error: unknown): TenantInvitationError {
  if (error instanceof TenantInvitationError) return error;
  return new TenantInvitationRetryableError(error);
}

/** Same domain as membership invite selectors — pending-hash binding must match. */
function hashInvitationIdentityRef(authIdentityId: AuthIdentityId): string {
  return hashRef(`novatrade:tenant-membership-invite:v1:auth-identity:${authIdentityId.toLowerCase()}`);
}

function hashInvitationKey(operation: TenantInvitationOperation, idempotencyKey: string): string {
  return hashRef(`novatrade:tenant-invitation-journal:v1:${operation}:${idempotencyKey}`);
}

/**
 * Reserves one membership_invite unit under the installed member context.
 * Fail-closed: denial, malformed result, or backend error all deny the issue.
 */
async function consumeInvitationLimit(
  limits: Pick<TenantLimitService, "consume"> | undefined,
  keyMaterial: string,
): Promise<boolean> {
  if (!limits || typeof limits.consume !== "function") return true;
  try {
    const result = await limits.consume({
      action: "membership_invite",
      amount: 1,
      idempotencyKey: hashRef(`novatrade:tenant-limit:membership_invite:v1:${keyMaterial}`),
    });
    return result?.outcome === "allowed";
  } catch {
    return false;
  }
}

function hashInvitationInput(operation: TenantInvitationOperation, material: Record<string, unknown>): string {
  return hashRef(`novatrade:tenant-invitation-input:v1:${operation}:${JSON.stringify(material)}`);
}

/** Stored policy reference — binds acceptance to the tenant policy generation. */
function tenantPolicyVersionRef(policyVersion: number): string {
  return `tenant-policy-v${policyVersion}`;
}

/**
 * Content hash over the invitation's binding facts. Acceptance re-checks this
 * hash in the CAS so a stale read can never finalize a mutated row.
 */
function hashInvitationContent(invitation: {
  readonly id: TenantInvitationId;
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly provisioningRequestId: ProvisioningRequestId | null;
  readonly kind: TenantInvitationKind;
  readonly role: LaunchRole;
  readonly workspaceId: WorkspaceId | null;
  readonly expectedIdentityRefHash: string;
  readonly policyVersion: WorkflowPolicyVersion;
  readonly generation: number;
  readonly expiresAt: string;
}): string {
  return hashRef(`novatrade:tenant-invitation-content:v1:${JSON.stringify({
    id: invitation.id,
    tenantId: invitation.tenantId,
    membershipId: invitation.membershipId,
    provisioningRequestId: invitation.provisioningRequestId,
    kind: invitation.kind,
    role: invitation.role,
    workspaceId: invitation.workspaceId,
    expectedIdentityRefHash: invitation.expectedIdentityRefHash,
    policyVersion: invitation.policyVersion,
    generation: invitation.generation,
    expiresAt: invitation.expiresAt,
  })}`);
}

function generatedInvitationId(factory: ProvisioningIdFactory, kind: ProvisioningIdKind): string {
  const value = factory.next(kind);
  if (typeof value !== "string" || !tenantIdSchema.safeParse(value).success) {
    throw new TenantInvitationRetryableError(new Error(`Invalid generated ${kind} identifier.`));
  }
  return value;
}

function assertIssuedInvitation(
  invitation: TenantInvitation,
  expected: {
    readonly id: TenantInvitationId;
    readonly tenantId: TenantId;
    readonly membershipId: MembershipId;
    readonly kind: TenantInvitationKind;
    readonly role: LaunchRole;
    readonly workspaceId: WorkspaceId | null;
    readonly expectedIdentityRefHash: string;
    readonly generation: number;
  },
): void {
  if (
    invitation.id !== expected.id
    || invitation.tenantId !== expected.tenantId
    || invitation.membershipId !== expected.membershipId
    || invitation.kind !== expected.kind
    || invitation.role !== expected.role
    || invitation.workspaceId !== expected.workspaceId
    || invitation.expectedIdentityRefHash !== expected.expectedIdentityRefHash
    || invitation.generation !== expected.generation
    || invitation.status !== "issued"
    || invitation.deliveryState !== "queued"
    || !TENANT_INVITATION_KINDS.includes(invitation.kind)
    || !LAUNCH_ROLES.includes(invitation.role)
    || !TENANT_INVITATION_STATUSES.includes(invitation.status)
  ) {
    throw new TenantInvitationRetryableError();
  }
}

function resolveInvitationPrior<R extends TenantInvitationOperationResult>(
  prior: TenantInvitationJournalRecord,
  expectedIdempotencyKeyHashRef: string,
  expectedInputHashRef: string,
  operation: TenantInvitationOperation,
  requestSubjectId: string | null,
): R {
  if (!isSha256Reference(prior.idempotencyKeyHashRef) || prior.idempotencyKeyHashRef !== expectedIdempotencyKeyHashRef) {
    throw new TenantInvitationRetryableError();
  }
  if (!isSha256Reference(prior.inputHashRef)) throw new TenantInvitationRetryableError();
  if (prior.operation !== operation) throw new TenantInvitationRetryableError();
  if (prior.inputHashRef !== expectedInputHashRef) throw new TenantInvitationIdempotencyConflictError();
  if (prior.state === "reserved") throw new TenantInvitationInProgressError();
  if (prior.state !== "completed" || prior.result === undefined) throw new TenantInvitationRetryableError();
  if (!isValidInvitationOperationResult(operation, prior.result)) throw new TenantInvitationRetryableError();
  // The journal records the operation's subject invitation: the targeted
  // record for accept/revoke, the generated record for issue/reissue. The
  // journaled subject must always equal the result's invitation id.
  const result = prior.result;
  if (prior.invitationId !== result.invitationId) throw new TenantInvitationIdempotencyConflictError();
  // The request-side subject must also bind: the targeted invitation for
  // accept/revoke, the source invitation for reissue, the membership for
  // issue (whose generated invitation id cannot be known upfront).
  if (operation === "reissue") {
    if (result.resultCode !== "INVITATION_REISSUED" || result.priorInvitationId !== requestSubjectId) {
      throw new TenantInvitationIdempotencyConflictError();
    }
  } else if (operation === "issue") {
    if (result.membershipId !== requestSubjectId) throw new TenantInvitationIdempotencyConflictError();
  } else if (prior.invitationId !== requestSubjectId) {
    throw new TenantInvitationIdempotencyConflictError();
  }
  return result as R;
}

const ACCEPTANCE_RESULT_KEYS = [
  "resultCode", "invitationId", "tenantId", "membershipId", "role", "tenantStatus",
  "workspaceStatus", "membershipStatus", "acceptedAt", "activationState", "activationBlockers",
] as const;
const ISSUE_RESULT_KEYS = [
  "resultCode", "invitationId", "tenantId", "membershipId", "generation", "expiresAt", "deliveryState",
] as const;
const REISSUE_RESULT_KEYS = [
  "resultCode", "priorInvitationId", "invitationId", "tenantId", "membershipId",
  "generation", "expiresAt", "deliveryState",
] as const;
const REVOKE_RESULT_KEYS = [
  "resultCode", "invitationId", "tenantId", "membershipId", "status", "revokedAt",
] as const;

const tenantStatusValueSet = new Set<string>(TENANT_STATUSES);
const launchRoleValueSet = new Set<string>(LAUNCH_ROLES);
const deliveryStateValueSet = new Set<string>(TENANT_INVITATION_DELIVERY_STATES);

function isUuid(value: unknown): boolean {
  return tenantIdSchema.safeParse(value).success;
}

function isCanonicalTimestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function isValidInvitationOperationResult(
  operation: TenantInvitationOperation,
  value: unknown,
): value is TenantInvitationOperationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (operation === "accept") {
    if (!hasExactKeys(result, ACCEPTANCE_RESULT_KEYS)) return false;
    return result.resultCode === "INVITATION_ACCEPTED"
      && isUuid(result.invitationId) && isUuid(result.tenantId) && isUuid(result.membershipId)
      && typeof result.role === "string" && launchRoleValueSet.has(result.role)
      && typeof result.tenantStatus === "string" && tenantStatusValueSet.has(result.tenantStatus)
      && (result.workspaceStatus === null || (typeof result.workspaceStatus === "string" && workspaceStatusValue(result)))
      && result.membershipStatus === "active"
      && isCanonicalTimestamp(result.acceptedAt)
      && result.activationState === "active"
      && Array.isArray(result.activationBlockers) && result.activationBlockers.length === 0;
  }
  if (operation === "issue") {
    if (!hasExactKeys(result, ISSUE_RESULT_KEYS)) return false;
    return result.resultCode === "INVITATION_ISSUED"
      && isUuid(result.invitationId) && isUuid(result.tenantId) && isUuid(result.membershipId)
      && result.generation === 1
      && isCanonicalTimestamp(result.expiresAt)
      && typeof result.deliveryState === "string" && deliveryStateValueSet.has(result.deliveryState);
  }
  if (operation === "reissue") {
    if (!hasExactKeys(result, REISSUE_RESULT_KEYS)) return false;
    return result.resultCode === "INVITATION_REISSUED"
      && isUuid(result.priorInvitationId)
      && isUuid(result.invitationId) && isUuid(result.tenantId) && isUuid(result.membershipId)
      && Number.isInteger(result.generation) && (result.generation as number) >= 2
      && isCanonicalTimestamp(result.expiresAt)
      && typeof result.deliveryState === "string" && deliveryStateValueSet.has(result.deliveryState);
  }
  if (!hasExactKeys(result, REVOKE_RESULT_KEYS)) return false;
  return result.resultCode === "INVITATION_REVOKED"
    && isUuid(result.invitationId) && isUuid(result.tenantId) && isUuid(result.membershipId)
    && result.status === "revoked"
    && isCanonicalTimestamp(result.revokedAt);
}

function workspaceStatusValue(result: Record<string, unknown>): boolean {
  return typeof result.workspaceStatus === "string"
    && ["provisioning", "active", "paused", "archived", "deletion_pending", "deleted"].includes(result.workspaceStatus);
}
