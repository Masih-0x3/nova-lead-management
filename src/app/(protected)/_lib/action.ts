import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { gateL05Policy } from "@/app/api/_shared/l05-deps";
import { getTenantSession, type TenantSession } from "@/lib/auth";
import { withTenantDbContext, type DbClient } from "@/lib/db";
import {
  TenantAuthorizationError,
  type TenantResourceScopeClass,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext, TenantContextError } from "@/lib/tenancy/context";
import type { TenantPolicySchemaType } from "@/lib/tenancy/schemas";
import type { TenantPermission } from "@/lib/permissions";

export type SurfaceActionResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; kind: "denied" | "conflict" | "invalid" | "error"; message: string }>;

const DENIED: SurfaceActionResult = Object.freeze({
  ok: false,
  kind: "denied",
  message: "This action is not available for your role or the current tenant policy.",
});

function isServiceError(error: unknown): error is Error & { code: string } {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === "string";
}

function mapServiceFailure(code: string): SurfaceActionResult {
  if (/(STALE|CONFLICT|VERSION_CONFLICT|DUPLICATE|BOUNDS_EXCEEDED|CAP_EXCEEDED)/u.test(code)) {
    return Object.freeze({
      ok: false,
      kind: "conflict",
      message: "The record changed or the request conflicts with current state. Reload and retry.",
    });
  }
  if (/(MALFORMED|INPUT_INVALID|INVALID_TRANSITION|NOT_FOUND|NOT_READY|REQUIRED)/u.test(code)) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      message: "The request was rejected by the service boundary. Review the record state and retry.",
    });
  }
  return Object.freeze({
    ok: false,
    kind: "error",
    message: "The action could not be completed. Retry or contact an administrator.",
  });
}

export type SurfaceActionOptions = Readonly<{
  /** D-002 permission the action requires, e.g. "icp:approve". */
  permission: TenantPermission;
  /** Audit action label, e.g. "l07:strategy:icp-review". */
  action: string;
  scopeClass?: TenantResourceScopeClass;
  resourceType?: string;
  /** Tenant-policy predicate for conditional (C) permissions. */
  requirePolicy?: (policy: TenantPolicySchemaType) => boolean;
  /** Paths to revalidate after a successful mutation. */
  revalidate?: string | readonly string[];
}>;

/**
 * Runs a tenant-scoped mutation: resolves the session, enforces the action
 * permission (with the tenant-policy gate for conditional rows), executes the
 * service call inside the tenant context transaction, then revalidates the
 * surface. Every failure collapses into a typed, non-enumerating result.
 */
export async function runSurfaceAction(
  options: SurfaceActionOptions,
  fn: (db: DbClient, session: TenantSession) => Promise<string | void>,
): Promise<SurfaceActionResult> {
  let session: TenantSession | null;
  try {
    session = await getTenantSession({});
  } catch {
    return DENIED;
  }
  if (!session) return DENIED;

  const scopeClass = options.scopeClass ?? "workspace-optional";
  if (scopeClass === "workspace-required" && session.workspaceId === null) return DENIED;

  try {
    const message = await runWithTenantContext(
      session,
      `l07:${options.action}:${randomUUID()}`,
      () => withTenantDbContext(async (db) => {
        await gateL05Policy(session, db, options.permission, {
          workspaceId: session.workspaceId,
          scopeClass,
          action: options.action,
          resourceType: options.resourceType,
          requirePolicy: options.requirePolicy,
        });
        return fn(db, session);
      }),
    );
    for (const path of options.revalidate ?? []) revalidatePath(path);
    return { ok: true, message: typeof message === "string" && message.length > 0 ? message : "Done." };
  } catch (error) {
    if (error instanceof TenantAuthorizationError || error instanceof TenantContextError) {
      return DENIED;
    }
    if (isServiceError(error)) return mapServiceFailure(error.code);
    return { ok: false, kind: "error", message: "The action could not be completed. Retry or contact an administrator." };
  }
}
