"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  requireTenantSession,
  TenantSessionUnauthenticatedError,
  TenantSessionUnavailableError,
  type TenantSession,
} from "@/lib/auth";
import { withTenantDbContext, type DbClient } from "@/lib/db";
import type { TenantPermission } from "@/lib/permissions";
import {
  assertTenantPermission,
  TenantAuthorizationError,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext, TenantContextError } from "@/lib/tenancy/context";
import {
  TenantLifecycleOpsError,
  type TenantDeletionStorePort,
  type TenantLifecycleOperationsService,
  type TenantLifecycleOpsCode,
} from "@/lib/tenancy/lifecycle-operations";
import { createLocalTenantLifecycleOperationsService } from "@/lib/tenancy/local-lifecycle-operations";
import { isLocalMembershipAdministrationAvailable } from "@/lib/tenancy/local-membership-administration";
import { createLocalTenantLimitService } from "@/lib/tenancy/local-tenant-limits";
import { createPostgresTenantLimitService } from "@/lib/tenancy/postgres-tenant-limits";
import { createPostgresTenantLifecycleService } from "@/lib/tenancy/postgres-lifecycle";
import {
  createPostgresExportOperationsService,
  createPostgresExportRunner,
} from "@/lib/tenancy/postgres-export-operations";
import { createPostgresDeletionOperationsService } from "@/lib/tenancy/postgres-deletion-operations";
import {
  createPostgresSupportAccessPolicyEvaluator,
  createPostgresSupportAccessRepository,
  createPostgresSupportPrincipalResolver,
} from "@/lib/tenancy/postgres-support-access";
import {
  createLocalSupportAccessPolicyEvaluator,
  createLocalSupportAccessRepository,
  createLocalSupportPrincipalResolver,
} from "@/lib/tenancy/local-support-access";
import { createSupportAccessService, type SupportAccessCode } from "@/lib/tenancy/support-access";
import {
  SUPPORT_ACCESS_GRANT_DATA_CLASSES,
  SUPPORT_ACCESS_GRANT_PERMISSIONS,
  type TenantStatus,
} from "@/lib/tenancy/types";

const TENANT_OPERATIONS_PATH = "/tenancy";
const REASON_CODE = /^[a-z][a-z0-9._-]{2,79}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const requestIdSchema = z.string().uuid();
const reasonCodeSchema = z.string().regex(REASON_CODE);
const reasonSchema = z.string().trim().min(1).max(500);
const canonicalTimestampSchema = z.string().regex(CANONICAL_TIMESTAMP)
  .refine((value) => new Date(value).toISOString() === value);

const lifecycleTransitionInputSchema = z.object({
  toStatus: z.enum(["suspended", "active", "archived"]),
  expectedCurrentState: z.enum(["active", "suspended"]),
  reasonCode: reasonCodeSchema,
  reason: reasonSchema,
  requestId: requestIdSchema,
}).strict();

const exportRequestInputSchema = z.object({
  requestId: requestIdSchema,
}).strict();

const jobScopedInputSchema = z.object({
  jobId: z.string().uuid(),
  requestId: requestIdSchema,
}).strict();

const deletionRequestInputSchema = z.object({
  requestId: requestIdSchema,
}).strict();

const supportRequestInputSchema = z.object({
  supportPrincipalRef: z.string().trim().min(1).max(256),
  reasonCode: reasonCodeSchema,
  reason: reasonSchema,
  startsAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  permissions: z.array(z.enum(SUPPORT_ACCESS_GRANT_PERMISSIONS)).min(1)
    .max(SUPPORT_ACCESS_GRANT_PERMISSIONS.length),
  dataClasses: z.array(z.enum(SUPPORT_ACCESS_GRANT_DATA_CLASSES)).min(1)
    .max(SUPPORT_ACCESS_GRANT_DATA_CLASSES.length),
  requestId: requestIdSchema,
}).strict();

const supportDecisionInputSchema = z.object({
  grantId: z.string().uuid(),
  decision: z.enum(["approve", "revoke"]),
  requestId: requestIdSchema,
}).strict();

export type TenantOperationErrorCode =
  | "INVALID_INPUT"
  | "NOT_AUTHORIZED"
  | "LOCAL_MUTATIONS_UNAVAILABLE"
  | "OPERATION_UNAVAILABLE"
  | "CONFLICT"
  | "UNAVAILABLE";

export type TenantOperationResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; code: TenantOperationErrorCode; message: string }>;

/**
 * runDeletion is driven by the platform worker lane, never by these member
 * actions — the port stays fail-closed so an accidental dispatch surfaces
 * FAILED_INTERNAL instead of touching tenant data.
 */
const ACTION_UNREACHABLE_DELETION_STORE: TenantDeletionStorePort = {
  execute: () => Promise.reject(new TenantLifecycleOpsError("FAILED_INTERNAL")),
};

function createLifecycleService(db: DbClient): TenantLifecycleOperationsService {
  if (isLocalMembershipAdministrationAvailable()) {
    return createLocalTenantLifecycleOperationsService(db, {
      limits: createLocalTenantLimitService(db),
    });
  }
  const limits = createPostgresTenantLimitService();
  return {
    ...createPostgresTenantLifecycleService(),
    ...createPostgresExportOperationsService({
      exportRunner: createPostgresExportRunner(),
      limits,
    }),
    ...createPostgresDeletionOperationsService({
      deletionStore: ACTION_UNREACHABLE_DELETION_STORE,
      limits,
    }),
  };
}

export async function requestTenantLifecycleTransitionAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, lifecycleTransitionInputSchema, "tenant:lifecycle",
    "tenant-lifecycle.transition", async (session, parsed, db) => {
      const service = createLifecycleService(db);
      const command = {
        tenantId: session.tenantId,
        actor: {
          authIdentityId: session.userId,
          layer: "member" as const,
          membershipId: session.membershipId,
        },
        expectedCurrentState: parsed.expectedCurrentState as TenantStatus,
        reasonCode: parsed.reasonCode,
        reason: parsed.reason,
        correlationId: `tenant-lifecycle:${parsed.toStatus}:${parsed.requestId}`,
      };
      const result = parsed.toStatus === "suspended"
        ? await service.suspend(command)
        : parsed.toStatus === "archived"
          ? await service.archive(command)
          : await service.resume(command);
      const verb = parsed.toStatus === "suspended"
        ? "suspension"
        : parsed.toStatus === "archived" ? "archive" : "resume";
      return { ok: true, message: `Tenant ${verb} recorded (${result.code}).` };
    });
}

/**
 * Member-facing export request. The local compat runtime has no separate
 * export worker, so a successful request is driven to completion inline by the
 * runtime executor; the audit ledger records the member request and the
 * system-layer execution separately.
 */
export async function requestTenantExportAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, exportRequestInputSchema, "data:export",
    "tenant-export.request", async (session, parsed, db) => {
      const service = createLifecycleService(db);
      const requested = await service.requestExport({
        tenantId: session.tenantId,
        workspaceId: null,
        requester: { authIdentityId: session.userId, membershipId: session.membershipId },
        idempotencyKey: `tenant-export-request.${parsed.requestId}`,
        correlationId: `tenant-export:request:${parsed.requestId}`,
      });
      try {
        const ran = await service.runExport({
          tenantId: session.tenantId,
          jobId: requested.job.id,
          executor: { authIdentityId: session.userId, layer: "system" },
          correlationId: `tenant-export:run:${parsed.requestId}`,
        });
        return { ok: true, message: `Tenant export ${ran.job.status} (${ran.code}).` };
      } catch (error) {
        if (error instanceof TenantLifecycleOpsError && error.code !== "FAILED_INTERNAL") {
          // The journaled request is intact; the job row carries the failure for retry.
          return { ok: true, message: `Tenant export requested; execution requires a retry (${requested.code}).` };
        }
        throw error;
      }
    });
}

export async function cancelTenantExportAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, jobScopedInputSchema, "data:export",
    "tenant-export.cancel", async (session, parsed, db) => {
      const result = await createLifecycleService(db).cancelExport({
        tenantId: session.tenantId,
        jobId: parsed.jobId,
        actor: memberActor(session),
        correlationId: `tenant-export:cancel:${parsed.requestId}`,
      });
      return { ok: true, message: `Tenant export canceled (${result.code}).` };
    });
}

export async function retryTenantExportAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, jobScopedInputSchema, "data:export",
    "tenant-export.retry", async (session, parsed, db) => {
      const service = createLifecycleService(db);
      const requeued = await service.requeueExport({
        tenantId: session.tenantId,
        jobId: parsed.jobId,
        actor: memberActor(session),
        correlationId: `tenant-export:requeue:${parsed.requestId}`,
      });
      try {
        const ran = await service.runExport({
          tenantId: session.tenantId,
          jobId: parsed.jobId,
          executor: { authIdentityId: session.userId, layer: "system" },
          correlationId: `tenant-export:run:${parsed.requestId}`,
        });
        return { ok: true, message: `Tenant export ${ran.job.status} (${ran.code}).` };
      } catch (error) {
        if (error instanceof TenantLifecycleOpsError && error.code !== "FAILED_INTERNAL") {
          return { ok: true, message: `Tenant export requeued (${requeued.code}); execution requires another retry.` };
        }
        throw error;
      }
    });
}

/**
 * Deletion is three-person: an owner requests, a different owner/admin verifies,
 * and an owner distinct from both approves the schedule. runDeletion itself is
 * executed by the platform worker lane once the freeze handoff completes.
 */
export async function requestTenantDeletionAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, deletionRequestInputSchema, "data:delete",
    "tenant-deletion.request", async (session, parsed, db) => {
      const result = await createLifecycleService(db).requestDeletion({
        tenantId: session.tenantId,
        workspaceId: null,
        requester: { authIdentityId: session.userId, membershipId: session.membershipId },
        idempotencyKey: `tenant-deletion-request.${parsed.requestId}`,
        correlationId: `tenant-deletion:request:${parsed.requestId}`,
      });
      return { ok: true, message: `Tenant deletion request recorded (${result.code}). Verification by a different owner or admin is required.` };
    });
}

export async function verifyTenantDeletionAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, jobScopedInputSchema, "data:delete",
    "tenant-deletion.verify", async (session, parsed, db) => {
      const result = await createLifecycleService(db).verifyDeletion({
        tenantId: session.tenantId,
        jobId: parsed.jobId,
        verifier: { authIdentityId: session.userId, membershipId: session.membershipId },
        correlationId: `tenant-deletion:verify:${parsed.requestId}`,
      });
      return { ok: true, message: `Tenant deletion verified (${result.code}). A distinct owner approval is still required.` };
    });
}

export async function approveTenantDeletionAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, jobScopedInputSchema, "data:delete",
    "tenant-deletion.approve", async (session, parsed, db) => {
      const result = await createLifecycleService(db).approveDeletion({
        tenantId: session.tenantId,
        jobId: parsed.jobId,
        approver: { authIdentityId: session.userId, membershipId: session.membershipId },
        correlationId: `tenant-deletion:approve:${parsed.requestId}`,
      });
      return { ok: true, message: `Tenant deletion scheduled (${result.code}).` };
    });
}

export async function cancelTenantDeletionAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, jobScopedInputSchema, "data:delete",
    "tenant-deletion.cancel", async (session, parsed, db) => {
      const result = await createLifecycleService(db).cancelDeletion({
        tenantId: session.tenantId,
        jobId: parsed.jobId,
        actor: memberActor(session),
        correlationId: `tenant-deletion:cancel:${parsed.requestId}`,
      });
      return { ok: true, message: `Tenant deletion canceled (${result.code}).` };
    });
}

export async function retryTenantDeletionAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, jobScopedInputSchema, "data:delete",
    "tenant-deletion.retry", async (session, parsed, db) => {
      const result = await createLifecycleService(db).requeueDeletion({
        tenantId: session.tenantId,
        jobId: parsed.jobId,
        executor: memberActor(session),
        correlationId: `tenant-deletion:requeue:${parsed.requestId}`,
      });
      return { ok: true, message: `Tenant deletion requeued (${result.code}).` };
    });
}

function memberActor(session: TenantSession) {
  return {
    authIdentityId: session.userId,
    layer: "member" as const,
    membershipId: session.membershipId,
  };
}

export async function requestTenantSupportAccessAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, supportRequestInputSchema, "support:grant",
    "support.grant.request", async (session, parsed, db) => {
      const result = await createSupportService(db).request({
        tenantId: session.tenantId,
        supportPrincipalRef: parsed.supportPrincipalRef,
        reasonCode: parsed.reasonCode,
        reason: parsed.reason,
        startsAt: parsed.startsAt,
        expiresAt: parsed.expiresAt,
        permissions: parsed.permissions,
        dataClasses: parsed.dataClasses,
        idempotencyKey: `support-grant-request.${parsed.requestId}`,
      });
      return supportResult(result.code);
    });
}

export async function decideTenantSupportAccessAction(
  input: unknown,
): Promise<TenantOperationResult> {
  return executeTenantOperation(input, supportDecisionInputSchema, "support:grant",
    "support.grant.decision", async (session, parsed, db) => {
      const service = createSupportService(db);
      const command = {
        tenantId: session.tenantId,
        grantId: parsed.grantId,
        idempotencyKey: `support-grant-${parsed.decision}.${parsed.requestId}`,
      };
      const result = parsed.decision === "approve"
        ? await service.approve(command)
        : await service.revoke(command);
      return supportResult(result.code);
    });
}

function createSupportService(db: DbClient) {
  if (isLocalMembershipAdministrationAvailable()) {
    return createSupportAccessService({
      repository: createLocalSupportAccessRepository(db),
      principalResolver: createLocalSupportPrincipalResolver(db),
      policyEvaluator: createLocalSupportAccessPolicyEvaluator(db),
      limits: createLocalTenantLimitService(db),
    });
  }
  return createSupportAccessService({
    repository: createPostgresSupportAccessRepository(),
    principalResolver: createPostgresSupportPrincipalResolver(),
    policyEvaluator: createPostgresSupportAccessPolicyEvaluator(),
    limits: createPostgresTenantLimitService(),
  });
}

async function executeTenantOperation<T extends { requestId: string }>(
  input: unknown,
  schema: z.ZodType<T>,
  permission: TenantPermission,
  action: string,
  execute: (session: TenantSession, parsed: T, db: DbClient) => Promise<TenantOperationResult>,
): Promise<TenantOperationResult> {
  try {
    const session = await requireTenantSession({});
    if (session.workspaceId !== null || (session.role !== "owner" && session.role !== "admin")) {
      return failure("NOT_AUTHORIZED");
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");

    const result = await runWithTenantContext(
      session,
      `tenant-operations:${action}:${parsed.data.requestId}`,
      () => withTenantDbContext(async (db) => {
        await assertTenantPermission(session, permission, {
          action,
          policyEvaluator: async (context) => ({
            allowed: context.tenantId === session.tenantId
              && context.workspaceId === session.workspaceId
              && context.membershipId === session.membershipId
              && await tenantPolicyPresent(db, session.tenantId),
            context,
          }),
        });
        return execute(session, parsed.data, db);
      }),
    );
    if (result.ok) {
      try {
        revalidatePath(TENANT_OPERATIONS_PATH);
      } catch {
        // The mutation already committed; cache invalidation must not rewrite a truthful success.
      }
    }
    return result;
  } catch (error) {
    return mapFailure(error);
  }
}

async function tenantPolicyPresent(db: DbClient, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM tenant_policies WHERE tenant_id = ?")
    .get<Record<string, unknown>>(tenantId);
  return Boolean(row);
}

function supportResult(code: SupportAccessCode): TenantOperationResult {
  if (code === "OK_SUPPORT_GRANT_REQUESTED") {
    return { ok: true, message: "The support access request was recorded and awaits approval." };
  }
  if (code === "OK_SUPPORT_GRANT_APPROVED") {
    return { ok: true, message: "The support access grant was approved." };
  }
  if (code === "OK_SUPPORT_GRANT_REVOKED") {
    return { ok: true, message: "The support access grant was revoked." };
  }
  if (code === "OK_SUPPORT_REPLAY") {
    return { ok: true, message: "The recorded decision was replayed for this request." };
  }
  if (code === "SUPPORT_MALFORMED" || code === "SUPPORT_SCOPE_MISMATCH"
    || code === "SUPPORT_WORKSPACE_SCOPE_INVALID") {
    return failure("INVALID_INPUT");
  }
  if (code === "SUPPORT_POLICY_BLOCKED" || code === "SUPPORT_SELF_ACTION"
    || code === "SUPPORT_GRANT_REQUIRED") {
    return failure("NOT_AUTHORIZED");
  }
  if (code === "SUPPORT_STATE_CONFLICT") return failure("CONFLICT");
  // SUPPORT_NOT_FOUND_OR_FORBIDDEN and everything else collapse to one result.
  return failure("OPERATION_UNAVAILABLE");
}

function mapFailure(error: unknown): TenantOperationResult {
  if (error instanceof TenantSessionUnauthenticatedError
    || error instanceof TenantSessionUnavailableError
    || error instanceof TenantContextError
    || error instanceof TenantAuthorizationError) {
    return failure("NOT_AUTHORIZED");
  }
  if (error instanceof TenantLifecycleOpsError) {
    const code: TenantLifecycleOpsCode = error.code;
    if (code === "BLOCKED_MALFORMED") return failure("INVALID_INPUT");
    if (code === "BLOCKED_ACTOR_SCOPE") return failure("NOT_AUTHORIZED");
    if (code === "BLOCKED_STATE_CONFLICT" || code === "BLOCKED_REPLAY_CONFLICT"
      || code === "BLOCKED_LIMIT" || code === "BLOCKED_APPROVAL_INDEPENDENCE") {
      return failure("CONFLICT");
    }
    // NOT_FOUND_NON_ENUMERATING, FAILED_*, and every other code collapse here.
    return failure("OPERATION_UNAVAILABLE");
  }
  return failure("UNAVAILABLE");
}

function failure(code: TenantOperationErrorCode): TenantOperationResult {
  const messages: Record<TenantOperationErrorCode, string> = {
    INVALID_INPUT: "The request was not valid.",
    NOT_AUTHORIZED: "You are not authorized to perform this tenant operation.",
    LOCAL_MUTATIONS_UNAVAILABLE: "Tenant operations are unavailable in this runtime.",
    OPERATION_UNAVAILABLE: "The requested operation could not be completed.",
    CONFLICT: "The operation conflicts with the recorded state.",
    UNAVAILABLE: "Tenant operations are temporarily unavailable.",
  };
  return { ok: false, code, message: messages[code] };
}
