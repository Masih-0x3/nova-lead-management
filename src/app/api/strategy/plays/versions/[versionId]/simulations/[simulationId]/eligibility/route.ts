import { reviewAuthenticatedLeadPlaySimulation } from "@/lib/strategy/authenticated-service";
import type { ReviewSimulationEligibilityRequest } from "@/lib/strategy/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/strategy/plays/versions/[versionId]/simulations/[simulationId]/eligibility";

interface RouteContext {
  readonly params: Promise<{ versionId: string; simulationId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { versionId, simulationId } = await context.params;
    const body = await readJson(request);
    const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const result = await reviewAuthenticatedLeadPlaySimulation(
      scopeFromBody(body),
      {
        ...fields,
        playVersionId: versionId,
        simulationId,
      } as ReviewSimulationEligibilityRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
