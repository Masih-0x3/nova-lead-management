import { transitionAuthenticatedUnderstandingReview } from "@/lib/understanding/authenticated-service";
import type { TransitionUnderstandingReviewRequest } from "@/lib/understanding/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  serviceJson,
} from "../../../l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/understanding/versions/[versionId]/review";

interface RouteContext {
  readonly params: Promise<{ versionId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { versionId } = await context.params;
    const body = await readJson(request);
    const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const result = await transitionAuthenticatedUnderstandingReview(
      scopeFromBody(body),
      {
        ...fields,
        versionId,
      } as TransitionUnderstandingReviewRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
