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

import { createDeterministicFixtureProvider } from "./fixture-provider";
import {
  createSeededAgentRuntimeRegistry,
  seedL04AgentRuntimeRegistry,
} from "./registry";
import { createPostgresAgentRunStore } from "./run-store";
import {
  cancelAgentRun,
  enqueueAgentRun,
  getAgentRun,
  type AgentRuntimeResult,
  type AgentRuntimeScope,
  type EnqueueAgentRunRequest,
} from "./service";
import type { AgentRunRecord } from "./records";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AuthenticatedAgentRuntimeDependencies {
  readonly correlationId: string;
  readonly sessionBoundary?: TenantSessionBoundary;
  /**
   * Conditional-permission evaluator. The conservative default admits only
   * owner/admin for C-rated permissions; replaceable once a durable policy
   * record exists.
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

function assertScope(session: TenantSession, scope: AgentRuntimeScope): void {
  if (session.tenantId !== scope.tenantId || session.workspaceId !== scope.workspaceId) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
}

function parseScope(raw: unknown): AgentRuntimeScope {
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
  action: string,
  dependencies: AuthenticatedAgentRuntimeDependencies,
): Promise<{ session: TenantSession; scope: AgentRuntimeScope }> {
  const scope = parseScope(rawScope);
  const session = await requireTenantPermission(scope, "queue:operate", {
    action,
    policyEvaluator: dependencies.policyEvaluator ?? conservativeConditionalEvaluator,
    sessionBoundary: dependencies.sessionBoundary,
  });
  assertScope(session, scope);
  return { session, scope };
}

/**
 * Idempotent member enqueue. The seeded registry is attested inside the same
 * member-context transaction so an unattested or drifted prompt/policy row
 * resolves as a policy gap, never as ambient code authority.
 */
export async function enqueueAuthenticatedAgentRun(
  rawScope: unknown,
  request: EnqueueAgentRunRequest,
  dependencies: AuthenticatedAgentRuntimeDependencies,
): Promise<AgentRuntimeResult<AgentRunRecord>> {
  const { session, scope } = await authorize(
    rawScope, "agent-runtime:enqueue", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext(async (db) => {
      await seedL04AgentRuntimeRegistry(db);
      const registry = await createSeededAgentRuntimeRegistry(db);
      return enqueueAgentRun(scope, request, {
        store: createPostgresAgentRunStore(db),
        registry,
        provider: createDeterministicFixtureProvider(),
      });
    }));
}

export async function getAuthenticatedAgentRun(
  rawScope: unknown,
  runId: string,
  dependencies: AuthenticatedAgentRuntimeDependencies,
): Promise<AgentRuntimeResult<AgentRunRecord>> {
  const { session, scope } = await authorize(
    rawScope, "agent-runtime:read", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => getAgentRun(
      scope, runId, createPostgresAgentRunStore(db))));
}

export async function cancelAuthenticatedAgentRun(
  rawScope: unknown,
  runId: string,
  dependencies: AuthenticatedAgentRuntimeDependencies,
): Promise<AgentRuntimeResult<AgentRunRecord>> {
  const { session, scope } = await authorize(
    rawScope, "agent-runtime:cancel", dependencies);
  return runWithTenantContext(session, dependencies.correlationId, () =>
    withTenantDbContext((db) => cancelAgentRun(scope, runId, {
      store: createPostgresAgentRunStore(db),
    })));
}
