import { enqueueAuthenticatedAgentRun } from "@/lib/agent-runtime/authenticated-service";
import type { EnqueueAgentRunRequest } from "@/lib/agent-runtime/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/agent-runtime/runs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const result = await enqueueAuthenticatedAgentRun(
      scopeFromBody(body),
      (body ?? {}) as EnqueueAgentRunRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
