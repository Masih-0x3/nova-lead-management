import { NextResponse } from "next/server";

import { applyNoStoreHeaders } from "@/lib/http-cache";
import { TenantAuthorizationError } from "@/lib/tenancy/authorize";

/**
 * Shared response plumbing for the L-04 member JSON routes. Every response is
 * private/no-store; service result codes map to a stable HTTP surface without
 * leaking internals.
 */

export function privateNoStore<T extends { headers: Headers }>(response: T): T {
  const secured = applyNoStoreHeaders(response);
  secured.headers.set("Vary", "Cookie");
  return secured;
}

const CODE_STATUS: Readonly<Record<string, number>> = {
  MALFORMED_INPUT: 400,
  NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  STALE_VERSION: 409,
  STALE_STATE: 409,
  VERSION_CONFLICT: 409,
  PERSISTENCE_CONFLICT: 409,
  REJECTED_IDEMPOTENCY_CONFLICT: 409,
  RUN_LEASE_CONFLICT: 409,
  RUN_TERMINAL: 409,
  SCOPE_MISMATCH: 403,
  REJECTED_SECRET: 422,
  REJECTED_INJECTION: 422,
  REJECTED_MODEL_POLICY_GAP: 422,
  REJECTED_COST_CAP: 422,
  AI_PROVIDER_DISABLED: 423,
  EVIDENCE_UNRESOLVABLE: 422,
  EVIDENCE_INELIGIBLE: 422,
  INVALID_TRANSITION: 422,
  HUMAN_REVIEW_REQUIRED: 422,
  UNDERSTANDING_NOT_APPROVED: 422,
  ICP_NOT_APPROVED: 422,
  SIMULATION_NOT_READY: 422,
  SIMULATION_ELIGIBILITY_REQUIRED: 422,
  NO_ELIGIBLE_QUESTIONS: 422,
  RUN_EXECUTION_BLOCKED: 422,
  INTEGRITY_VIOLATION: 500,
};

export function codeStatus(code: string): number {
  return CODE_STATUS[code] ?? 400;
}

interface ServiceResultLike {
  readonly ok: boolean;
  readonly code: string;
  readonly value?: unknown;
}

export function serviceJson(result: ServiceResultLike, extra?: Record<string, unknown>) {
  if (!result.ok) {
    return privateNoStore(NextResponse.json(
      { ok: false, code: result.code, error: result.code },
      { status: codeStatus(result.code) },
    ));
  }
  return privateNoStore(NextResponse.json(
    { ok: true, code: result.code, value: result.value ?? null, ...extra },
    { status: 200 },
  ));
}

export function routeError(error: unknown, route: string) {
  if (error instanceof TenantAuthorizationError) {
    return privateNoStore(NextResponse.json(
      { ok: false, code: error.code ?? "PERMISSION_DENIED", error: "Permission denied" },
      { status: error.status },
    ));
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("l04_route_error", { route, error: message });
  return privateNoStore(NextResponse.json(
    { ok: false, code: "INTERNAL", error: "Request failed" },
    { status: 500 },
  ));
}

export function scopeFromUrl(url: URL): { tenantId: string; workspaceId: string | null } {
  return {
    tenantId: url.searchParams.get("tenantId") ?? "",
    workspaceId: url.searchParams.get("workspaceId"),
  };
}

export function scopeFromBody(body: unknown): { tenantId: unknown; workspaceId: unknown } {
  const candidate = (body && typeof body === "object" ? body : {}) as {
    tenantId?: unknown;
    workspaceId?: unknown;
  };
  return { tenantId: candidate.tenantId, workspaceId: candidate.workspaceId };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function correlationId(request: Request): string {
  const header = request.headers.get("x-correlation-id");
  return header && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(header)
    ? header
    : `l04:${crypto.randomUUID()}`;
}
