import { planAuthenticatedQuestionSession } from "@/lib/understanding/authenticated-service";
import type { PlanQuestionSessionRequest } from "@/lib/understanding/question-service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  serviceJson,
} from "../../l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/understanding/questions/sessions";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const result = await planAuthenticatedQuestionSession(
      scopeFromBody(body),
      (body ?? {}) as PlanQuestionSessionRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
