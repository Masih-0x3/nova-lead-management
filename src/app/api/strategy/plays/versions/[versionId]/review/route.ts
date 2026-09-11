import { transitionAuthenticatedLeadPlayReview } from "@/lib/strategy/authenticated-service";
import type { TransitionReviewRequest } from "@/lib/strategy/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/strategy/plays/versions/[versionId]/review";

interface RouteContext {
  readonly params: Promise<{ versionId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { versionId } = await context.params;
    const body = await readJson(request);
    const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const result = await transitionAuthenticatedLeadPlayReview(
      scopeFromBody(body),
      { ...fields, versionId } as TransitionReviewRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
