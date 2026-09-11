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
import { createPostgresUnderstandingRepository } from "@/lib/understanding/repository";

import { createPostgresStrategyRepository } from "./repository";
import {
  createIcpVersion,
  createLeadPlayVersion,
  getApprovedIcp,
  getIcpVersion,
  getLeadPlayActivationState,
  getLeadPlayVersion,
  listIcpVersions,
  listLeadPlayVersions,
  reviewLeadPlaySimulationEligibilityDecision,
  simulateLeadPlayVersion,
  transitionIcpVersionReview,
  transitionLeadPlayActivationState,
  transitionLeadPlayVersionReview,
  type CreateIcpVersionRequest,
  type CreateLeadPlayVersionRequest,
  type IcpVersionView,
  type LeadPlayActivationTransitionRequest,
  type LeadPlayVersionView,
  type ReviewSimulationEligibilityRequest,
  type SimulateLeadPlayRequest,
  type StoredLeadPlayActivation,
  type StoredLeadPlaySimulation,
  type StoredLeadPlaySimulationReview,
  type StrategyScope,
  type StrategyServiceResult,
  type TransitionReviewRequest,
} from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AuthenticatedStrategyDependencies {
  readonly correlationId: string;
  readonly sessionBoundary?: TenantSessionBoundary;
  /**
   * Conditional-permission evaluator. The conservative default admits only
   * owner/admin for C-rated permissions (approve/activate per coordinator
   * decision); a durable policy evaluator can replace it later.
   */
  readonly policyEvaluator?: TenantPolicyEvaluator;
}

/** Conservative default for conditional (C) D-002 rows: owner/admin only. */
const conservativeConditionalEvaluator: TenantPolicyEvaluator = (
  context: TenantPolicyContext,
) => Object.freeze({
  allowed: context.role === "owner" || context.role === "admin",
  context,
});

function evaluator(dependencies: AuthenticatedStrategyDependencies): TenantPolicyEvaluator {
  return dependencies.policyEvaluator ?? conservativeConditionalEvaluator;
}

function assertScope(session: TenantSession, scope: StrategyScope): void {
  if (session.tenantId !== scope.tenantId || session.workspaceId !== scope.workspaceId) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
}

function parseScope(raw: unknown): StrategyScope {
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

async function authorize(
  rawScope: unknown,
  permission: "icp:read" | "icp:edit" | "icp:approve"
    | "play:read" | "play:edit" | "play:approve" | "play:activate",
  action: string,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<{ session: TenantSession; scope: StrategyScope }> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(scope, permission, {
    action,
    policyEvaluator: evaluator(dependencies),
    sessionBoundary: dependencies.sessionBoundary,
  });
  assertScope(session, scope);
  return { session, scope };
}

export async function createAuthenticatedIcpVersion(
  rawScope: unknown,
  request: CreateIcpVersionRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<IcpVersionView>> {
  const { session, scope } = await authorize(
    rawScope, "icp:edit", "icp:create", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => createIcpVersion(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function getAuthenticatedIcpVersion(
  rawScope: unknown,
  versionId: string,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<IcpVersionView>> {
  const { session, scope } = await authorize(
    rawScope, "icp:read", "icp:read", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getIcpVersion(
      scope, versionId, createPostgresStrategyRepository(db))));
}

export async function listAuthenticatedIcpVersions(
  rawScope: unknown,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<readonly IcpVersionView[]>> {
  const { session, scope } = await authorize(
    rawScope, "icp:read", "icp:list", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => listIcpVersions(
      scope, createPostgresStrategyRepository(db))));
}

export async function getAuthenticatedApprovedIcp(
  rawScope: unknown,
  stableKey: string,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<IcpVersionView | null>> {
  const { session, scope } = await authorize(
    rawScope, "icp:read", "icp:read-approved", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getApprovedIcp(
      scope, stableKey, createPostgresStrategyRepository(db))));
}

export async function transitionAuthenticatedIcpReview(
  rawScope: unknown,
  request: TransitionReviewRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<IcpVersionView>> {
  const { session, scope } = await authorize(
    rawScope,
    request.to === "in_review" ? "icp:edit" : "icp:approve",
    `icp:review:${request.to}`,
    dependencies,
  );
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => transitionIcpVersionReview(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function createAuthenticatedLeadPlayVersion(
  rawScope: unknown,
  request: CreateLeadPlayVersionRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<LeadPlayVersionView>> {
  const { session, scope } = await authorize(
    rawScope, "play:edit", "play:create", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => createLeadPlayVersion(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function getAuthenticatedLeadPlayVersion(
  rawScope: unknown,
  versionId: string,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<LeadPlayVersionView>> {
  const { session, scope } = await authorize(
    rawScope, "play:read", "play:read", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getLeadPlayVersion(
      scope, versionId, createPostgresStrategyRepository(db))));
}

export async function listAuthenticatedLeadPlayVersions(
  rawScope: unknown,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<readonly LeadPlayVersionView[]>> {
  const { session, scope } = await authorize(
    rawScope, "play:read", "play:list", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => listLeadPlayVersions(
      scope, createPostgresStrategyRepository(db))));
}

export async function transitionAuthenticatedLeadPlayReview(
  rawScope: unknown,
  request: TransitionReviewRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<LeadPlayVersionView>> {
  const { session, scope } = await authorize(
    rawScope,
    request.to === "in_review" ? "play:edit" : "play:approve",
    `play:review:${request.to}`,
    dependencies,
  );
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => transitionLeadPlayVersionReview(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function simulateAuthenticatedLeadPlay(
  rawScope: unknown,
  request: SimulateLeadPlayRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<StoredLeadPlaySimulation>> {
  const { session, scope } = await authorize(
    rawScope, "play:edit", "play:simulate", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => simulateLeadPlayVersion(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function reviewAuthenticatedLeadPlaySimulation(
  rawScope: unknown,
  request: ReviewSimulationEligibilityRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<StoredLeadPlaySimulationReview>> {
  const { session, scope } = await authorize(
    rawScope, "play:approve", "play:simulation-review", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => reviewLeadPlaySimulationEligibilityDecision(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function transitionAuthenticatedLeadPlayActivation(
  rawScope: unknown,
  request: LeadPlayActivationTransitionRequest,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<StoredLeadPlayActivation>> {
  const { session, scope } = await authorize(
    rawScope, "play:activate", `play:${request?.action ?? "activation"}`, dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => transitionLeadPlayActivationState(scope, request, {
      repository: createPostgresStrategyRepository(db),
      understanding: createPostgresUnderstandingRepository(db),
    })));
}

export async function getAuthenticatedLeadPlayActivation(
  rawScope: unknown,
  stableKey: string,
  dependencies: AuthenticatedStrategyDependencies,
): Promise<StrategyServiceResult<StoredLeadPlayActivation | null>> {
  const { session, scope } = await authorize(
    rawScope, "play:read", "play:activation-read", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getLeadPlayActivationState(
      scope, stableKey, createPostgresStrategyRepository(db))));
}
