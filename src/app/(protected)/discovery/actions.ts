"use server";

import {
  createDiscoveryPlanService,
  createDiscoveryRunService,
  transitionDiscoveryRunService,
} from "@/lib/discovery/service";
import {
  discoveryDeps,
} from "@/app/api/_shared/l05-deps";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";

export async function createPlanAction(input: Readonly<{
  playVersionId: string;
  sourceKeys: readonly string[];
  limits: Readonly<{ maxAccounts: number; maxProviderRequests: number; maxSpendCents: number }>;
}>): Promise<SurfaceActionResult> {
  return runSurfaceAction({
    permission: "source:plan",
    action: "l07:discovery:plan:create",
    scopeClass: "workspace-optional",
    resourceType: "discovery_plan",
    revalidate: ["/discovery", "/onboarding"],
  }, async (db, session) => {
    const result = await createDiscoveryPlanService(discoveryDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      playVersionId: input.playVersionId,
      sourceKeys: input.sourceKeys,
      limits: input.limits,
    });
    return result.kind === "created" ? "Discovery plan created." : "An identical plan already exists.";
  });
}

export async function createRunAction(input: Readonly<{ planId: string }>): Promise<SurfaceActionResult> {
  return runSurfaceAction({
    permission: "source:execute",
    action: "l07:discovery:run:create",
    scopeClass: "workspace-optional",
    resourceType: "discovery_run",
    revalidate: "/discovery",
  }, async (db, session) => {
    const result = await createDiscoveryRunService(discoveryDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      planId: input.planId,
    });
    return result.kind === "created" ? "Discovery run created." : "A run for this plan already exists.";
  });
}

export async function transitionRunAction(input: Readonly<{
  runId: string;
  expectedRunHash: string;
  action: "start" | "cancel";
  reason: string;
}>): Promise<SurfaceActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { ok: false, kind: "invalid", message: "A decision reason is required." };
  }
  if (input.action !== "start" && input.action !== "cancel") {
    return { ok: false, kind: "invalid", message: "Only start and cancel transitions are available here." };
  }
  return runSurfaceAction({
    permission: "source:execute",
    action: `l07:discovery:run:${input.action}`,
    scopeClass: "workspace-optional",
    resourceType: "discovery_run",
    revalidate: "/discovery",
  }, async (db, session) => {
    await transitionDiscoveryRunService(discoveryDeps(db), {
      tenantId: session.tenantId,
      workspaceId: session.workspaceId,
      runId: input.runId,
      expectedRunHash: input.expectedRunHash,
      action: input.action,
      reason,
    });
    return input.action === "start" ? "Discovery run started." : "Discovery run cancelled.";
  });
}
