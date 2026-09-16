import { NextRequest, NextResponse } from "next/server";
import { resolveConnectorFixtureExecutor } from "@/lib/connectors/fixture-executors";
import { executeNextSourceUnit } from "@/lib/connectors/service";
import { withTenantDbContext } from "@/lib/db";
import { applyNoStoreHeaders } from "@/lib/http-cache";
import { runTenantInternalWorkerRoute } from "@/lib/internal-worker-route";
import { connectorDeps } from "@/app/api/_shared/l05-deps";
import { createFailClosedWorkerLeaseResolverRuntime } from "@/lib/tenancy/worker-lease-runtime";

const CONNECTOR_WORKER_LEASE_MS = 60_000;

const resolveLease = createFailClosedWorkerLeaseResolverRuntime({
  workerName: "connector_execution",
  action: "connector_execution:process",
});

export async function POST(request: NextRequest) {
  return runTenantInternalWorkerRoute(
    request,
    "connector_execution",
    "source:execute",
    async (context) => withTenantDbContext(async (db) => {
      const outcome = await executeNextSourceUnit(connectorDeps(db), {
        authorizedTenantId: context.tenantId,
        authorizedWorkspaceId: context.workspaceId,
        workerId: context.leaseId,
        leaseMs: CONNECTOR_WORKER_LEASE_MS,
        resolveExecutor: resolveConnectorFixtureExecutor,
      });
      return outcome.status === "executed"
        ? {
          status: "processed",
          runId: outcome.runId,
          unitId: outcome.unitId,
          settle: outcome.settle,
        }
        : {
          status: "idle",
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        };
    }),
    {
      resolveLease,
      sessionPermission: "source:execute",
      action: "connector_execution:process",
    },
  );
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "POST" } },
  ));
}
