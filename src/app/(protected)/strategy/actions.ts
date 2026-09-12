"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { getTenantSession } from "@/lib/auth";
import { TenantAuthorizationError } from "@/lib/tenancy/authorize";
import {
  createAuthenticatedIcpVersion,
  createAuthenticatedLeadPlayVersion,
  reviewAuthenticatedLeadPlaySimulation,
  simulateAuthenticatedLeadPlay,
  transitionAuthenticatedIcpReview,
  transitionAuthenticatedLeadPlayActivation,
  transitionAuthenticatedLeadPlayReview,
} from "@/lib/strategy/authenticated-service";
import type {
  CreateIcpVersionRequest,
  CreateLeadPlayVersionRequest,
} from "@/lib/strategy/service";

export type StrategyActionResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; message: string }>;

function failure(error: unknown, fallback: string): StrategyActionResult {
  if (error instanceof TenantAuthorizationError) {
    return { ok: false, message: "This action is not allowed for your tenant role." };
  }
  return { ok: false, message: fallback };
}

function serviceFailure(code: string): StrategyActionResult {
  if (/STALE|CONFLICT|DUPLICATE/u.test(code)) {
    return { ok: false, message: "The record changed since it was loaded. Reload and retry." };
  }
  if (code === "NOT_FOUND") return { ok: false, message: "The record is not available." };
  if (code === "UNDERSTANDING_NOT_APPROVED") {
    return { ok: false, message: "The bound understanding version is not approved." };
  }
  if (code === "MISSING_RATIONALE_REFERENCE") {
    return { ok: false, message: "Every criterion and hypothesis needs at least one evidence reference from the approved understanding." };
  }
  if (code === "UNSAFE_CRITERION" || code === "UNSAFE_PLAY") {
    return { ok: false, message: "The text failed the safety screen. Remove links, markup, or sensitive content." };
  }
  if (code === "SIMULATION_NOT_READY" || code === "SIMULATION_ELIGIBILITY_REQUIRED" || code === "SIMULATION_MISMATCH") {
    return { ok: false, message: "A fully-included, human-reviewed simulation is required before activation." };
  }
  return { ok: false, message: `The service rejected the request (${code}).` };
}

function scopeOf(session: Readonly<{ tenantId: string; workspaceId: string | null }>) {
  return { tenantId: session.tenantId, workspaceId: session.workspaceId };
}

const REVIEW_TARGETS = new Set(["in_review", "approved", "rejected", "superseded"]);
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export async function createIcpAction(input: Readonly<{
  stableKey: string;
  understandingVersionId: string;
  title: string;
  segment: string;
  useCase: string;
  positiveCriteria: readonly unknown[];
  exclusions: readonly unknown[];
  uncertainties: readonly unknown[];
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!REF.test(input.stableKey)) return { ok: false, message: "The stable key is invalid." };
  if (input.positiveCriteria.length === 0) {
    return { ok: false, message: "At least one inclusion criterion is required." };
  }
  try {
    const request: CreateIcpVersionRequest = {
      stableKey: input.stableKey,
      understandingVersionId: input.understandingVersionId,
      title: input.title,
      segment: input.segment,
      useCase: input.useCase,
      positiveCriteria: input.positiveCriteria,
      exclusions: input.exclusions,
      uncertainties: input.uncertainties,
    };
    const result = await createAuthenticatedIcpVersion(scopeOf(session), request, {
      correlationId: `l07:strategy:icp-create:${randomUUID()}`,
    });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    revalidatePath("/onboarding");
    return { ok: true, message: "ICP draft created." };
  } catch (error) {
    return failure(error, "The ICP version could not be created.");
  }
}

export async function reviewIcpAction(input: Readonly<{
  versionId: string;
  expectedReviewHash: string;
  to: string;
  reason: string;
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!REVIEW_TARGETS.has(input.to) || input.to === "superseded") {
    return { ok: false, message: "The review transition is invalid." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: false, message: "A decision reason is required." };
  try {
    const result = await transitionAuthenticatedIcpReview(scopeOf(session), {
      versionId: input.versionId,
      expectedReviewHash: input.expectedReviewHash,
      to: input.to as "in_review" | "approved" | "rejected",
      reason,
      actor: { kind: "human", actorId: session.userId },
    }, { correlationId: `l07:strategy:icp-review:${randomUUID()}` });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    revalidatePath("/onboarding");
    return { ok: true, message: "ICP review decision recorded." };
  } catch (error) {
    return failure(error, "The review decision could not be recorded.");
  }
}

export async function createPlayAction(input: Readonly<{
  stableKey: string;
  icpVersionId: string;
  title: string;
  objective: string;
  motion: string;
  searchHypotheses: readonly unknown[];
  sourceAllowlist: readonly string[];
  bounds: Readonly<{ maxAccounts: number; maxProviderRequests: number; maxSpendCents: number }>;
  rationaleRefs: readonly unknown[];
  uncertainties: readonly unknown[];
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!REF.test(input.stableKey)) return { ok: false, message: "The stable key is invalid." };
  if (input.searchHypotheses.length === 0) {
    return { ok: false, message: "At least one search hypothesis is required." };
  }
  if (input.sourceAllowlist.length === 0) {
    return { ok: false, message: "At least one allowed source is required." };
  }
  try {
    const request: CreateLeadPlayVersionRequest = {
      stableKey: input.stableKey,
      icpVersionId: input.icpVersionId,
      title: input.title,
      objective: input.objective,
      motion: input.motion,
      searchHypotheses: input.searchHypotheses,
      sourceAllowlist: input.sourceAllowlist,
      bounds: input.bounds,
      rationaleRefs: input.rationaleRefs,
      uncertainties: input.uncertainties,
    };
    const result = await createAuthenticatedLeadPlayVersion(scopeOf(session), request, {
      correlationId: `l07:strategy:play-create:${randomUUID()}`,
    });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    revalidatePath("/onboarding");
    return { ok: true, message: "Lead-play draft created." };
  } catch (error) {
    return failure(error, "The lead-play version could not be created.");
  }
}

export async function reviewPlayAction(input: Readonly<{
  versionId: string;
  expectedReviewHash: string;
  to: string;
  reason: string;
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!REVIEW_TARGETS.has(input.to) || input.to === "superseded") {
    return { ok: false, message: "The review transition is invalid." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: false, message: "A decision reason is required." };
  try {
    const result = await transitionAuthenticatedLeadPlayReview(scopeOf(session), {
      versionId: input.versionId,
      expectedReviewHash: input.expectedReviewHash,
      to: input.to as "in_review" | "approved" | "rejected",
      reason,
      actor: { kind: "human", actorId: session.userId },
    }, { correlationId: `l07:strategy:play-review:${randomUUID()}` });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    revalidatePath("/onboarding");
    return { ok: true, message: "Lead-play review decision recorded." };
  } catch (error) {
    return failure(error, "The review decision could not be recorded.");
  }
}

export async function simulatePlayAction(input: Readonly<{
  playVersionId: string;
  providerRequests: number;
  spendCents: number;
  accounts: readonly unknown[];
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  if (!Number.isSafeInteger(input.providerRequests) || input.providerRequests < 0
    || !Number.isSafeInteger(input.spendCents) || input.spendCents < 0) {
    return { ok: false, message: "Estimates must be non-negative integers." };
  }
  try {
    const result = await simulateAuthenticatedLeadPlay(scopeOf(session), {
      playVersionId: input.playVersionId,
      estimates: { providerRequests: input.providerRequests, spendCents: input.spendCents },
      accounts: input.accounts as never,
    }, { correlationId: `l07:strategy:play-simulate:${randomUUID()}` });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    return { ok: true, message: "Simulation recorded." };
  } catch (error) {
    return failure(error, "The simulation could not be recorded.");
  }
}

export async function reviewSimulationAction(input: Readonly<{
  playVersionId: string;
  simulationId: string;
  decision: "eligible" | "ineligible";
  reason: string;
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: false, message: "A decision reason is required." };
  if (input.decision !== "eligible" && input.decision !== "ineligible") {
    return { ok: false, message: "The eligibility decision is invalid." };
  }
  try {
    const result = await reviewAuthenticatedLeadPlaySimulation(scopeOf(session), {
      playVersionId: input.playVersionId,
      simulationId: input.simulationId,
      decision: input.decision,
      reason,
      actor: { kind: "human", actorId: session.userId },
    }, { correlationId: `l07:strategy:sim-review:${randomUUID()}` });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    return { ok: true, message: "Simulation eligibility recorded." };
  } catch (error) {
    return failure(error, "The eligibility review could not be recorded.");
  }
}

export async function transitionActivationAction(input: Readonly<{
  stableKey: string;
  playVersionId: string;
  expectedStateHash: string;
  action: "activate" | "rollback";
  reason: string;
}>): Promise<StrategyActionResult> {
  const session = await getTenantSession({}).catch(() => null);
  if (!session) return { ok: false, message: "A tenant scope is required." };
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: false, message: "A decision reason is required." };
  if (input.action !== "activate" && input.action !== "rollback") {
    return { ok: false, message: "The activation transition is invalid." };
  }
  try {
    const result = await transitionAuthenticatedLeadPlayActivation(scopeOf(session), {
      stableKey: input.stableKey,
      playVersionId: input.playVersionId,
      expectedStateHash: input.expectedStateHash,
      action: input.action,
      reason,
      actor: { kind: "human", actorId: session.userId },
    }, { correlationId: `l07:strategy:activation:${randomUUID()}` });
    if (!result.ok) return serviceFailure(result.code);
    revalidatePath("/strategy");
    revalidatePath("/onboarding");
    return { ok: true, message: input.action === "activate" ? "Lead play activated." : "Lead play rolled back." };
  } catch (error) {
    return failure(error, "The activation transition could not be recorded.");
  }
}
