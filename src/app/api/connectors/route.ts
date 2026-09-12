import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route } from "@/app/api/_shared/l05";
import { describeConnectorRegistryState } from "@/lib/connectors/service";
import { createPostgresConnectorAuthorityRepository } from "@/lib/connectors/repository";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.has("workspaceId") ? params.get("workspaceId") : null;
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "connector:read",
    action: "l05:connectors:list",
    scopeClass: "workspace-optional",
    correlationId: `l05:connectors:list:${randomUUID()}`,
  }, async ({ session, db }) => {
    const authority = createPostgresConnectorAuthorityRepository(db);
    const [registry, accounts, policies] = await Promise.all([
      describeConnectorRegistryState(authority),
      authority.listAccounts(session.tenantId, workspaceId),
      authority.listPolicies(session.tenantId, workspaceId),
    ]);
    return { registry, accounts, policies };
  });
}
