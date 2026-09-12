import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { isPlainBody, reviewDeps } from "@/app/api/_shared/l05-deps";
import { createPostgresReviewRepository } from "@/lib/review/repository";
import {
  enqueueItem,
  listReviewItemViews,
  summarizeReviewQueue,
  transitionItem,
} from "@/lib/review/service";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workspaceId = params.get("workspaceId");
  const kind = params.get("kind");
  const status = params.get("status");
  return l05Route({
    selector: { tenantId: params.get("tenantId"), workspaceId },
    permission: "queue:read",
    action: "l05:review-queue:list",
    scopeClass: "workspace-required",
    correlationId: `l05:review-queue:list:${randomUUID()}`,
  }, async ({ session, db }) => {
    const repository = createPostgresReviewRepository(db);
    const scope = { tenantId: session.tenantId, workspaceId: workspaceId ?? "" };
    const [summary, items] = await Promise.all([
      summarizeReviewQueue(repository, scope),
      listReviewItemViews(repository, scope, {
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
      }),
    ]);
    return { summary, items };
  });
}

/**
 * Queue mutation: `itemId` present → claim/release/resolve under lease +
 * optimistic concurrency; absent → enqueue a new review item.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const isTransition = typeof record.itemId === "string";
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: "queue:operate",
    action: isTransition ? "l05:review-queue:transition" : "l05:review-queue:enqueue",
    scopeClass: "workspace-required",
    resourceId: isTransition ? record.itemId as string : undefined,
    resourceType: "review_queue",
    correlationId: `l05:review-queue:${randomUUID()}`,
  }, async ({ session, db }) => {
    const deps = reviewDeps(db);
    const input = { ...record, tenantId: session.tenantId };
    if (isTransition) {
      return transitionItem(deps, { ...input, actorId: session.userId });
    }
    return enqueueItem(deps, input);
  });
}
