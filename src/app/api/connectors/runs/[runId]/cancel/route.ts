import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { l05Route, privateJsonError, readJsonBody } from "@/app/api/_shared/l05";
import { connectorDeps, isPlainBody } from "@/app/api/_shared/l05-deps";
import {
  killSourceRun,
  requestSourceRunCancellation,
} from "@/lib/connectors/service";

/**
 * Cooperative cancel or immediate kill for a source run. `mode: "kill"`
 * requires connector:manage; default cancellation requires connector:use.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return privateJsonError("The request body is invalid.", 400);
  }
  const record = isPlainBody(body) ? body : {};
  const kill = record.mode === "kill";
  return l05Route({
    selector: { tenantId: record.tenantId, workspaceId: record.workspaceId },
    permission: kill ? "connector:manage" : "connector:use",
    action: kill ? "l05:connectors:run:kill" : "l05:connectors:run:cancel",
    scopeClass: "workspace-optional",
    resourceWorkspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    resourceId: runId,
    resourceType: "source_run",
    correlationId: `l05:connectors:run:cancel:${randomUUID()}`,
  }, async ({ session, db }) => {
    const input = {
      tenantId: session.tenantId,
      workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
      runId,
      reason: record.reason,
    };
    if (kill) {
      await killSourceRun(connectorDeps(db), input);
      return { kind: "killed" };
    }
    return requestSourceRunCancellation(connectorDeps(db), input);
  });
}
