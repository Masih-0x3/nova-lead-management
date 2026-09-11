import { getAuthenticatedQuestionSession } from "@/lib/understanding/authenticated-service";

import {
  correlationId,
  routeError,
  scopeFromUrl,
  serviceJson,
} from "../../../l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/understanding/questions/sessions/[sessionRef]";

interface RouteContext {
  readonly params: Promise<{ sessionRef: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionRef } = await context.params;
    const result = await getAuthenticatedQuestionSession(
      scopeFromUrl(new URL(request.url)),
      sessionRef,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
