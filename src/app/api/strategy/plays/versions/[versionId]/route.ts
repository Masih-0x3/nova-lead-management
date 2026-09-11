import { getAuthenticatedLeadPlayVersion } from "@/lib/strategy/authenticated-service";

import {
  correlationId,
  routeError,
  scopeFromUrl,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/strategy/plays/versions/[versionId]";

interface RouteContext {
  readonly params: Promise<{ versionId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { versionId } = await context.params;
    const result = await getAuthenticatedLeadPlayVersion(
      scopeFromUrl(new URL(request.url)),
      versionId,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
