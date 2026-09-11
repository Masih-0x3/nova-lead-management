import { getAuthenticatedAgentRun } from "@/lib/agent-runtime/authenticated-service";

import {
  correlationId,
  routeError,
  scopeFromUrl,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/agent-runtime/runs/[runId]";

interface RouteContext {
  readonly params: Promise<{ runId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const result = await getAuthenticatedAgentRun(
      scopeFromUrl(new URL(request.url)),
      runId,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
