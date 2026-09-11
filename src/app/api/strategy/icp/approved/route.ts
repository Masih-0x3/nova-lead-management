import { getAuthenticatedApprovedIcp } from "@/lib/strategy/authenticated-service";

import {
  correlationId,
  routeError,
  scopeFromUrl,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/strategy/icp/approved";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const result = await getAuthenticatedApprovedIcp(
      scopeFromUrl(url),
      url.searchParams.get("stableKey") ?? "",
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
