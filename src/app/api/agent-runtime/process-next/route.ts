import { NextRequest, NextResponse } from "next/server";

import { createDeterministicFixtureProvider } from "@/lib/agent-runtime/fixture-provider";
import { createSeededAgentRuntimeRegistry } from "@/lib/agent-runtime/registry";
import { createPostgresAgentRunStore } from "@/lib/agent-runtime/run-store";
import {
  claimAgentRun,
  executeAgentRunAttempt,
  type AgentRuntimeDependencies,
} from "@/lib/agent-runtime/service";
import type { AgentRuntimeRegistry } from "@/lib/agent-runtime/prompts";
import { withTenantDbContext } from "@/lib/db";
import { applyNoStoreHeaders } from "@/lib/http-cache";
import { runTenantInternalWorkerRoute } from "@/lib/internal-worker-route";
import { createOutreachAgentRegistry } from "@/lib/outreach/agent-seeds";
import { createFailClosedWorkerLeaseResolverRuntime } from "@/lib/tenancy/worker-lease-runtime";

const resolveLease = createFailClosedWorkerLeaseResolverRuntime({
  workerName: "agent_runtime",
  action: "agent_runtime:execute",
});

/**
 * Tenant-authorized agent-runtime worker surface. The dispatch lease binds
 * run_id to the agent run it may claim, so the worker gate inside the claim
 * RPC can only ever be satisfied for that single run. Claim failures are
 * idle work, not route errors; an executed attempt reports the run outcome.
 */
export async function POST(request: NextRequest) {
  return runTenantInternalWorkerRoute(
    request,
    "agent_runtime",
    "outreach:draft",
    async (context, signal) => withTenantDbContext(async (db) => {
      const scope = { tenantId: context.tenantId, workspaceId: context.workspaceId };
      const outreach = await createOutreachAgentRegistry(db);
      const l04 = await createSeededAgentRuntimeRegistry(db);
      const registry: AgentRuntimeRegistry = Object.freeze({
        getPrompt: (key: string, version: number) =>
          outreach.getPrompt(key, version) ?? l04.getPrompt(key, version),
        getLatestPrompt: (key: string) =>
          outreach.getLatestPrompt(key) ?? l04.getLatestPrompt(key),
        getPolicy: (key: string, version: number) =>
          outreach.getPolicy(key, version) ?? l04.getPolicy(key, version),
        getLatestPolicy: (key: string) =>
          outreach.getLatestPolicy(key) ?? l04.getLatestPolicy(key),
      });
      const deps: AgentRuntimeDependencies = {
        store: createPostgresAgentRunStore(db),
        registry,
        provider: createDeterministicFixtureProvider(),
      };
      const claimed = await claimAgentRun(scope, {
        runId: context.runId,
        workerId: context.leaseId,
      }, deps);
      if (!claimed.ok) {
        return { status: "idle", reason: claimed.code };
      }
      const executed = await executeAgentRunAttempt(scope, {
        runId: context.runId,
        leaseToken: claimed.value.leaseToken,
        signal,
      }, deps);
      if (!executed.ok) {
        return { status: "error", runId: context.runId, error: executed.code };
      }
      return {
        status: "processed",
        runId: context.runId,
        outcome: executed.code,
        resultRef: executed.value.resultRef,
      };
    }),
    {
      resolveLease,
      sessionPermission: "outreach:draft",
      action: "agent_runtime:execute",
    },
  );
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  ));
}
