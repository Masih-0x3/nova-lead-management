import {
  getAuthenticatedLeadPlayActivation,
  transitionAuthenticatedLeadPlayActivation,
} from "@/lib/strategy/authenticated-service";
import type { LeadPlayActivationTransitionRequest } from "@/lib/strategy/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  scopeFromUrl,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/strategy/plays/activation";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const result = await getAuthenticatedLeadPlayActivation(
      scopeFromUrl(url),
      url.searchParams.get("stableKey") ?? "",
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const result = await transitionAuthenticatedLeadPlayActivation(
      scopeFromBody(body),
      (body ?? {}) as LeadPlayActivationTransitionRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
