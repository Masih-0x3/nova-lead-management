import {
  listAuthenticatedQuestionAnswers,
  recordAuthenticatedQuestionAnswer,
} from "@/lib/understanding/authenticated-service";
import type { RecordQuestionAnswerRequest } from "@/lib/understanding/question-service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  scopeFromUrl,
  serviceJson,
} from "../../../../l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/understanding/questions/sessions/[sessionRef]/answers";

interface RouteContext {
  readonly params: Promise<{ sessionRef: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionRef } = await context.params;
    const result = await listAuthenticatedQuestionAnswers(
      scopeFromUrl(new URL(request.url)),
      sessionRef,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { sessionRef } = await context.params;
    const body = await readJson(request);
    const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const result = await recordAuthenticatedQuestionAnswer(
      scopeFromBody(body),
      { ...fields, sessionRef } as RecordQuestionAnswerRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
