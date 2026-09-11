import {
  createAuthenticatedUnderstandingVersion,
  listAuthenticatedUnderstandingVersions,
} from "@/lib/understanding/authenticated-service";
import type { CreateUnderstandingVersionRequest } from "@/lib/understanding/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  scopeFromUrl,
  serviceJson,
} from "../l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/understanding/versions";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const result = await listAuthenticatedUnderstandingVersions(scopeFromUrl(url), {
      correlationId: correlationId(request),
    });
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    // The service boundary validates every field; the route only forwards the
    // raw payload and the tenant/workspace selector.
    const result = await createAuthenticatedUnderstandingVersion(
      scopeFromBody(body),
      (body ?? {}) as CreateUnderstandingVersionRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}

