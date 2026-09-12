import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route } from "@/app/api/_shared/l05";
import { createPostgresOutreachRepository } from "@/lib/outreach/repository";
import { getCurrentDraftView } from "@/lib/outreach/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return l05Route({
    selector: {
      tenantId: params.get("tenantId"),
      workspaceId: params.get("workspaceId"),
    },
    permission: "outreach:read",
    action: "l06:outreach:drafts:current",
    scopeClass: "workspace-required",
    requirePolicy: (policy) => policy.outreachDraftingEnabled === true,
    correlationId: `l06:outreach:drafts:current:${randomUUID()}`,
  }, async ({ session, db }) => ({
    current: await getCurrentDraftView(
      { outreach: createPostgresOutreachRepository(db) },
      {
        tenantId: session.tenantId,
        workspaceId: params.get("workspaceId") ?? "",
        accountId: params.get("accountId") ?? "",
        stableKey: params.get("stableKey") ?? "",
      },
    ),
  }));
}
