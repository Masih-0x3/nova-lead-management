import { authIdentityIdSchema, tenantIdSchema, tenantPolicySchema } from "@/lib/tenancy/schemas";
import type {
  AuthIdentityId,
  CorrelationId,
  TenantId,
  TenantPolicy,
} from "@/lib/tenancy/types";

/**
 * Mutable retention knobs on tenant_policies. tombstoneRetentionYears and
 * activeMaterialsMode are literal-fixed contract values, and locale/timezone/
 * review-gate/enablement fields belong to other surfaces — none are retention
 * knobs and none are mutable here.
 */
export const TENANT_RETENTION_KNOBS = [
  "export_retention_days",
  "operational_log_retention_days",
  "raw_source_retention_days",
  "contact_freshness_days",
  "primary_delete_within_days",
  "backup_expire_within_days",
] as const;

export type TenantRetentionKnob = (typeof TENANT_RETENTION_KNOBS)[number];

export const TENANT_RETENTION_POLICY_FIELDS = {
  export_retention_days: "exportRetentionDays",
  operational_log_retention_days: "operationalLogRetentionDays",
  raw_source_retention_days: "rawSourceRetentionDays",
  contact_freshness_days: "contactFreshnessDays",
  primary_delete_within_days: "primaryDeleteWithinDays",
  backup_expire_within_days: "backupExpireWithinDays",
} as const satisfies Record<TenantRetentionKnob, keyof TenantPolicy>;

export type TenantRetentionPolicyField = (typeof TENANT_RETENTION_POLICY_FIELDS)[TenantRetentionKnob];

export const TENANT_RETENTION_REASON_CODES = [
  "INVALID_REQUEST",
  "INVALID_TENANT_ID",
  "INVALID_KNOB",
  "INVALID_DAYS_VALUE",
  "INVALID_EXPECTED_POLICY_VERSION",
  "INVALID_REASON",
  "INVALID_CORRELATION",
  "RETENTION_MANAGER_UNAUTHORIZED",
  "ACTOR_SCOPE_MISMATCH",
  "POLICY_MISSING",
  "POLICY_MALFORMED",
  "POLICY_SCOPE_MISMATCH",
  "POLICY_UNAVAILABLE",
  "POLICY_CHANGE_UNAVAILABLE",
  "POLICY_VERSION_CONFLICT",
  "POLICY_VERSION_OVERFLOW",
  "POLICY_CHANGE_EXECUTOR_UNAVAILABLE",
  "POLICY_CHANGE_EXECUTION_FAILED",
] as const;
export type TenantRetentionReasonCode = (typeof TENANT_RETENTION_REASON_CODES)[number];

export interface TenantRetentionPolicyRepository {
  // The tenant scope is explicit at the repository boundary. No unscoped or
  // global policy lookup is accepted by this service.
  getCurrentTenantPolicy(tenantId: TenantId): Promise<unknown | null>;
}

export const RETENTION_MANAGE_PERMISSION = "tenant:manage" as const;

// This value can only enter the service through the trusted resolver. The
// public change request intentionally has no actor field.
export interface TrustedTenantRetentionManager {
  readonly tenantId: TenantId;
  readonly authIdentityId: AuthIdentityId;
  readonly permission: typeof RETENTION_MANAGE_PERMISSION;
}

export interface TenantRetentionActorResolver {
  // The resolver/authorizer, not this service, proves the server-derived
  // actor's tenant:manage permission for the exact tenant.
  resolveRetentionManager(tenantId: TenantId): Promise<TrustedTenantRetentionManager | null>;
}

export interface TenantRetentionChangeRequest {
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly days: number;
  readonly expectedPolicyVersion: number;
  readonly reason: string;
  readonly correlationId: CorrelationId;
}

export interface TenantRetentionPolicyMutation {
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly policyField: TenantRetentionPolicyField;
  readonly previousDays: number;
  readonly days: number;
  readonly previousPolicyVersion: number;
  readonly resultingPolicyVersion: number;
  readonly expectedPolicyVersion: number;
}

export interface TenantRetentionPolicyAuditEvent {
  readonly eventType: "tenant_retention_policy_changed";
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly policyField: TenantRetentionPolicyField;
  readonly previousDays: number;
  readonly days: number;
  readonly previousPolicyVersion: number;
  readonly resultingPolicyVersion: number;
  readonly actorAuthIdentityId: AuthIdentityId;
  readonly reason: string;
  readonly correlationId: CorrelationId;
}

export interface TenantRetentionPolicyChangeCommand {
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly actor: TrustedTenantRetentionManager;
  readonly expectedPolicyVersion: number;
  readonly previousPolicyVersion: number;
  readonly resultingPolicyVersion: number;
  readonly mutation: TenantRetentionPolicyMutation;
  readonly auditEvent: TenantRetentionPolicyAuditEvent;
}

export interface TenantRetentionPolicyChangeExecutor {
  // The implementation must CAS the policy and append the immutable audit
  // event atomically. The canonical service intentionally does not implement
  // this port — the runtime supplies it.
  execute(command: TenantRetentionPolicyChangeCommand): Promise<TenantRetentionPolicyCommittedResult>;
}

export interface TenantRetentionPolicyCommittedResult {
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly previousPolicyVersion: number;
  readonly resultingPolicyVersion: number;
}

export interface TenantRetentionServiceDependencies {
  readonly policyRepository: TenantRetentionPolicyRepository;
  readonly actorResolver: TenantRetentionActorResolver;
  readonly changeExecutor: TenantRetentionPolicyChangeExecutor;
}

export interface TenantRetentionChangeAccepted {
  readonly status: "unchanged" | "changed";
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly previousPolicyVersion: number;
  readonly resultingPolicyVersion: number;
}

export class TenantRetentionInputError extends Error {
  readonly code: TenantRetentionReasonCode;

  constructor(code: TenantRetentionReasonCode) {
    super(`Tenant retention request is denied: ${code}.`);
    this.name = "TenantRetentionInputError";
    this.code = code;
  }
}

export class TenantRetentionPolicyChangeError extends Error {
  readonly code: TenantRetentionReasonCode;
  readonly tenantId: TenantId;
  readonly knob: TenantRetentionKnob;
  readonly policyVersion: number | null;

  constructor(
    code: TenantRetentionReasonCode,
    input: Pick<TenantRetentionChangeRequest, "tenantId" | "knob">,
    policyVersion: number | null,
  ) {
    super(`Tenant retention knob ${input.knob} policy change is denied: ${code}.`);
    this.name = "TenantRetentionPolicyChangeError";
    this.code = code;
    this.tenantId = input.tenantId;
    this.knob = input.knob;
    this.policyVersion = policyVersion;
  }
}

export interface TenantRetentionService {
  requestRetentionChange(input: TenantRetentionChangeRequest): Promise<TenantRetentionChangeAccepted>;
}

export function createTenantRetentionService(
  dependencies: TenantRetentionServiceDependencies,
): TenantRetentionService {
  const requestRetentionChange = async (
    input: TenantRetentionChangeRequest,
  ): Promise<TenantRetentionChangeAccepted> => {
    const request = normalizeChangeRequest(input);
    const actor = await resolveTrustedActor(request.tenantId, request.knob);

    const current = await loadPolicy(request.tenantId, request.knob);
    if (current.version !== request.expectedPolicyVersion) {
      throw new TenantRetentionPolicyChangeError("POLICY_VERSION_CONFLICT", request, current.version);
    }

    const previousDays = current.days;
    if (previousDays === request.days) {
      return {
        status: "unchanged",
        tenantId: request.tenantId,
        knob: request.knob,
        previousPolicyVersion: request.expectedPolicyVersion,
        resultingPolicyVersion: request.expectedPolicyVersion,
      };
    }
    const resultingPolicyVersion = nextPolicyVersion(request.expectedPolicyVersion);
    if (resultingPolicyVersion === null) {
      throw new TenantRetentionPolicyChangeError("POLICY_VERSION_OVERFLOW", request, current.version);
    }
    if (typeof dependencies.changeExecutor?.execute !== "function") {
      throw new TenantRetentionPolicyChangeError("POLICY_CHANGE_EXECUTOR_UNAVAILABLE", request, current.version);
    }

    const command: TenantRetentionPolicyChangeCommand = {
      tenantId: request.tenantId,
      knob: request.knob,
      actor,
      expectedPolicyVersion: request.expectedPolicyVersion,
      previousPolicyVersion: request.expectedPolicyVersion,
      resultingPolicyVersion,
      mutation: {
        tenantId: request.tenantId,
        knob: request.knob,
        policyField: TENANT_RETENTION_POLICY_FIELDS[request.knob],
        previousDays,
        days: request.days,
        previousPolicyVersion: request.expectedPolicyVersion,
        resultingPolicyVersion,
        expectedPolicyVersion: request.expectedPolicyVersion,
      },
      auditEvent: {
        eventType: "tenant_retention_policy_changed",
        tenantId: request.tenantId,
        knob: request.knob,
        policyField: TENANT_RETENTION_POLICY_FIELDS[request.knob],
        previousDays,
        days: request.days,
        previousPolicyVersion: request.expectedPolicyVersion,
        resultingPolicyVersion,
        actorAuthIdentityId: actor.authIdentityId,
        reason: request.reason,
        correlationId: request.correlationId,
      },
    };

    try {
      const committed = await dependencies.changeExecutor.execute(command);
      if (!isMatchingCommittedResult(committed, command)) {
        throw new Error("Malformed or mismatched committed result.");
      }
    } catch {
      throw new TenantRetentionPolicyChangeError("POLICY_CHANGE_EXECUTION_FAILED", request, current.version);
    }

    return {
      status: "changed",
      tenantId: request.tenantId,
      knob: request.knob,
      previousPolicyVersion: request.expectedPolicyVersion,
      resultingPolicyVersion,
    };
  };

  const loadPolicy = async (
    tenantId: TenantId,
    knob: TenantRetentionKnob,
  ): Promise<{ version: number; days: number }> => {
    let rawPolicy: unknown | null;
    try {
      rawPolicy = await dependencies.policyRepository.getCurrentTenantPolicy(tenantId);
    } catch {
      throw new TenantRetentionPolicyChangeError("POLICY_UNAVAILABLE", { tenantId, knob }, null);
    }
    if (rawPolicy === null || rawPolicy === undefined) {
      throw new TenantRetentionPolicyChangeError("POLICY_MISSING", { tenantId, knob }, null);
    }
    const version = policyVersionFrom(rawPolicy);
    if (isRecord(rawPolicy) && typeof rawPolicy.tenantId === "string" && rawPolicy.tenantId !== tenantId) {
      throw new TenantRetentionPolicyChangeError("POLICY_SCOPE_MISMATCH", { tenantId, knob }, version);
    }
    const parsed = tenantPolicySchema.safeParse(rawPolicy);
    if (!parsed.success) {
      throw new TenantRetentionPolicyChangeError("POLICY_MALFORMED", { tenantId, knob }, version);
    }
    return { version: parsed.data.version, days: parsed.data[TENANT_RETENTION_POLICY_FIELDS[knob]] };
  };

  const resolveTrustedActor = async (
    tenantId: TenantId,
    knob: TenantRetentionKnob,
  ): Promise<TrustedTenantRetentionManager> => {
    const request = { tenantId, knob };
    if (typeof dependencies.actorResolver?.resolveRetentionManager !== "function") {
      throw new TenantRetentionPolicyChangeError("RETENTION_MANAGER_UNAUTHORIZED", request, null);
    }
    let actor: TrustedTenantRetentionManager | null;
    try {
      actor = await dependencies.actorResolver.resolveRetentionManager(tenantId);
    } catch {
      throw new TenantRetentionPolicyChangeError("RETENTION_MANAGER_UNAUTHORIZED", request, null);
    }
    if (actor === null || !isRecord(actor)) {
      throw new TenantRetentionPolicyChangeError("RETENTION_MANAGER_UNAUTHORIZED", request, null);
    }
    if (actor.tenantId !== tenantId) {
      throw new TenantRetentionPolicyChangeError("ACTOR_SCOPE_MISMATCH", request, null);
    }
    if (
      !tenantIdSchema.safeParse(actor.tenantId).success ||
      !authIdentityIdSchema.safeParse(actor.authIdentityId).success ||
      actor.permission !== RETENTION_MANAGE_PERMISSION
    ) {
      throw new TenantRetentionPolicyChangeError("RETENTION_MANAGER_UNAUTHORIZED", request, null);
    }
    return actor;
  };

  return { requestRetentionChange };
}

function normalizeChangeRequest(input: unknown): TenantRetentionChangeRequest {
  if (!isRecord(input)) throw new TenantRetentionInputError("INVALID_REQUEST");
  const tenantId = input.tenantId;
  const knob = input.knob;
  validateTenantId(tenantId);
  validateKnob(knob);
  // The field's own schema carries the int/min/max contract — bounds are never
  // duplicated here.
  if (!tenantPolicySchema.shape[TENANT_RETENTION_POLICY_FIELDS[knob]].safeParse(input.days).success) {
    throw new TenantRetentionInputError("INVALID_DAYS_VALUE");
  }
  if (
    typeof input.expectedPolicyVersion !== "number" ||
    !Number.isSafeInteger(input.expectedPolicyVersion) ||
    input.expectedPolicyVersion < 1
  ) {
    throw new TenantRetentionInputError("INVALID_EXPECTED_POLICY_VERSION");
  }
  const reason = boundedReason(input.reason);
  if (reason === null) throw new TenantRetentionInputError("INVALID_REASON");
  const correlationId = boundedCorrelation(input.correlationId);
  if (correlationId === null) throw new TenantRetentionInputError("INVALID_CORRELATION");

  // Build a new object so request-controlled extras, including actor-shaped
  // fields, cannot reach the trusted executor command.
  return {
    tenantId: tenantId as TenantId,
    knob,
    days: input.days as number,
    expectedPolicyVersion: input.expectedPolicyVersion,
    reason,
    correlationId: correlationId as CorrelationId,
  };
}

function validateTenantId(value: unknown): asserts value is TenantId {
  if (!tenantIdSchema.safeParse(value).success) throw new TenantRetentionInputError("INVALID_TENANT_ID");
}

function validateKnob(value: unknown): asserts value is TenantRetentionKnob {
  if (!isTenantRetentionKnob(value)) throw new TenantRetentionInputError("INVALID_KNOB");
}

function isTenantRetentionKnob(value: unknown): value is TenantRetentionKnob {
  return typeof value === "string" && (TENANT_RETENTION_KNOBS as readonly string[]).includes(value);
}

function boundedReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 500 || CONTROL_CHARACTER_PATTERN.test(trimmed)) return null;
  return SAFE_AUDIT_REASON_PATTERN.test(trimmed) ? trimmed : null;
}

function boundedCorrelation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(trimmed) ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function policyVersionFrom(value: unknown): number | null {
  if (!isRecord(value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version)) return null;
  return value.version;
}

function nextPolicyVersion(version: number): number | null {
  return version < Number.MAX_SAFE_INTEGER ? version + 1 : null;
}

function isMatchingCommittedResult(
  value: unknown,
  command: TenantRetentionPolicyChangeCommand,
): value is TenantRetentionPolicyCommittedResult {
  if (!isRecord(value)) return false;
  return (
    value.tenantId === command.tenantId &&
    value.knob === command.knob &&
    value.previousPolicyVersion === command.previousPolicyVersion &&
    value.resultingPolicyVersion === command.resultingPolicyVersion &&
    typeof value.previousPolicyVersion === "number" &&
    Number.isSafeInteger(value.previousPolicyVersion) &&
    typeof value.resultingPolicyVersion === "number" &&
    Number.isSafeInteger(value.resultingPolicyVersion)
  );
}

const SAFE_AUDIT_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,_:;()'"+&@#?!%=\/-]{0,499}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
