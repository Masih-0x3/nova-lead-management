import { getAuthenticatedApprovedUnderstanding } from "@/lib/understanding/authenticated-service";

import {
  correlationId,
  routeError,
  scopeFromUrl,
  serviceJson,
} from "../l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/understanding/approved";

export async function GET(request: Request) {
  try {
    const result = await getAuthenticatedApprovedUnderstanding(
      scopeFromUrl(new URL(request.url)),
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
