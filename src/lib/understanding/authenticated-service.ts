import "server-only";

import { isProxy } from "node:util/types";

import type { TenantSession } from "@/lib/auth";
import { withTenantDbContext } from "@/lib/db";
import {
  requireTenantPermission,
  TenantAuthorizationError,
  type TenantPolicyContext,
  type TenantPolicyEvaluator,
  type TenantSessionBoundary,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";

import {
  createPostgresQuestionRepository,
  createPostgresUnderstandingRepository,
} from "./repository";
import {
  createUnderstandingVersion,
  getCurrentApprovedUnderstanding,
  getUnderstandingVersion,
  listUnderstandingVersions,
  transitionUnderstandingVersionReview,
  type CreateUnderstandingVersionRequest,
  type TransitionUnderstandingReviewRequest,
  type UnderstandingScope,
  type UnderstandingServiceResult,
  type UnderstandingVersionView,
} from "./service";
import {
  getQuestionSession,
  listQuestionSessionAnswers,
  planQuestionSession,
  recordAdaptiveQuestionAnswer,
  type PlanQuestionSessionRequest,
  type QuestionServiceResult,
  type RecordedQuestionAnswer,
  type RecordQuestionAnswerRequest,
  type StoredQuestionSession,
} from "./question-service";
import type { AdaptiveQuestionSession, QuestionAnswerRecord } from "./question-planner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AuthenticatedUnderstandingDependencies {
  readonly correlationId: string;
  readonly sessionBoundary?: TenantSessionBoundary;
  /**
   * Conditional-permission evaluator. The conservative default admits only
   * owner/admin for C-rated permissions (coordinator decision for the D-002
   * conditional rows); a durable policy record evaluator can replace it later
   * without changing call sites.
   */
  readonly policyEvaluator?: TenantPolicyEvaluator;
}

/**
 * Conservative default for conditional (C) D-002 rows: admit owner/admin only.
 * Every other conditional role is denied until a durable policy record exists
 * for the evaluator to consult.
 */
const conservativeConditionalEvaluator: TenantPolicyEvaluator = (
  context: TenantPolicyContext,
) => Object.freeze({
  allowed: context.role === "owner" || context.role === "admin",
  context,
});

function evaluator(dependencies: AuthenticatedUnderstandingDependencies): TenantPolicyEvaluator {
  return dependencies.policyEvaluator ?? conservativeConditionalEvaluator;
}

function assertScope(session: TenantSession, scope: UnderstandingScope): void {
  if (session.tenantId !== scope.tenantId || session.workspaceId !== scope.workspaceId) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
}

function parseScope(raw: unknown): UnderstandingScope {
  if (!raw || typeof raw !== "object" || isProxy(raw) || Array.isArray(raw)) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
  const candidate = raw as { tenantId?: unknown; workspaceId?: unknown };
  const tenantId = typeof candidate.tenantId === "string" ? candidate.tenantId : null;
  const workspaceId = candidate.workspaceId === undefined || candidate.workspaceId === null
    ? null
    : typeof candidate.workspaceId === "string" ? candidate.workspaceId : undefined;
  if (!tenantId || !UUID.test(tenantId) || workspaceId === undefined
    || (workspaceId !== null && !UUID.test(workspaceId))) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
  return Object.freeze({ tenantId, workspaceId });
}

export async function createAuthenticatedUnderstandingVersion(
  rawScope: unknown,
  request: CreateUnderstandingVersionRequest,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<UnderstandingServiceResult<UnderstandingVersionView>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "understanding:edit",
    {
      action: "understanding:create",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => createUnderstandingVersion(scope, request, {
      repository: createPostgresUnderstandingRepository(db),
    })));
}

export async function getAuthenticatedUnderstandingVersion(
  rawScope: unknown,
  versionId: string,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<UnderstandingServiceResult<UnderstandingVersionView>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "understanding:read",
    {
      action: "understanding:read",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getUnderstandingVersion(
      scope,
      versionId,
      createPostgresUnderstandingRepository(db),
    )));
}

export async function listAuthenticatedUnderstandingVersions(
  rawScope: unknown,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<UnderstandingServiceResult<readonly UnderstandingVersionView[]>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "understanding:read",
    {
      action: "understanding:list",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => listUnderstandingVersions(
      scope,
      createPostgresUnderstandingRepository(db),
    )));
}

export async function getAuthenticatedApprovedUnderstanding(
  rawScope: unknown,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<UnderstandingServiceResult<UnderstandingVersionView | null>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "understanding:read",
    {
      action: "understanding:read-approved",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getCurrentApprovedUnderstanding(
      scope,
      createPostgresUnderstandingRepository(db),
    )));
}

export async function transitionAuthenticatedUnderstandingReview(
  rawScope: unknown,
  request: TransitionUnderstandingReviewRequest,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<UnderstandingServiceResult<UnderstandingVersionView>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    request.to === "in_review" ? "understanding:edit" : "understanding:approve",
    {
      action: `understanding:review:${request.to}`,
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => transitionUnderstandingVersionReview(scope, request, {
      repository: createPostgresUnderstandingRepository(db),
    })));
}

export async function planAuthenticatedQuestionSession(
  rawScope: unknown,
  request: PlanQuestionSessionRequest,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<QuestionServiceResult<AdaptiveQuestionSession>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "question:manage",
    {
      action: "question:plan",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => planQuestionSession(scope, request, {
      repository: createPostgresQuestionRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function recordAuthenticatedQuestionAnswer(
  rawScope: unknown,
  request: RecordQuestionAnswerRequest,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<QuestionServiceResult<RecordedQuestionAnswer>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "question:answer",
    {
      action: "question:answer",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => recordAdaptiveQuestionAnswer(scope, request, {
      repository: createPostgresQuestionRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function getAuthenticatedQuestionSession(
  rawScope: unknown,
  sessionRef: string,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<QuestionServiceResult<StoredQuestionSession>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "question:manage",
    {
      action: "question:session-read",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getQuestionSession(
      scope,
      sessionRef,
      createPostgresQuestionRepository(db),
    )));
}

export async function listAuthenticatedQuestionAnswers(
  rawScope: unknown,
  sessionRef: string,
  dependencies: AuthenticatedUnderstandingDependencies,
): Promise<QuestionServiceResult<readonly QuestionAnswerRecord[]>> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(
    scope,
    "question:manage",
    {
      action: "question:answers-read",
      policyEvaluator: evaluator(dependencies),
      sessionBoundary: dependencies.sessionBoundary,
    },
  );
  assertScope(session, scope);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => listQuestionSessionAnswers(
      scope,
      sessionRef,
      createPostgresQuestionRepository(db),
    )));
}
