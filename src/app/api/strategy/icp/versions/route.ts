import {
  createAuthenticatedIcpVersion,
  listAuthenticatedIcpVersions,
} from "@/lib/strategy/authenticated-service";
import type { CreateIcpVersionRequest } from "@/lib/strategy/service";

import {
  correlationId,
  readJson,
  routeError,
  scopeFromBody,
  scopeFromUrl,
  serviceJson,
} from "@/app/api/understanding/l04-http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/strategy/icp/versions";

export async function GET(request: Request) {
  try {
    const result = await listAuthenticatedIcpVersions(
      scopeFromUrl(new URL(request.url)),
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
    const result = await createAuthenticatedIcpVersion(
      scopeFromBody(body),
      (body ?? {}) as CreateIcpVersionRequest,
      { correlationId: correlationId(request) },
    );
    return serviceJson(result);
  } catch (error) {
    return routeError(error, ROUTE);
  }
}
