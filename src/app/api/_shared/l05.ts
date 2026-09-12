import { NextResponse } from "next/server";

import { withTenantDbContext, type DbClient } from "@/lib/db";
import {
  assertTenantPermission,
  requireTenantPermission,
  TenantAuthorizationError,
  type TenantPolicyEvaluator,
  type TenantResourceScopeClass,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext, TenantContextError } from "@/lib/tenancy/context";
import { tenantPolicySchema, type TenantPolicySchemaType } from "@/lib/tenancy/schemas";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import type { TenantSession } from "@/lib/auth";
import type { AccountServiceError } from "@/lib/discovery/account-service";
import type { ContactServiceError } from "@/lib/contacts/service";
import type { DiscoveryServiceError } from "@/lib/discovery/service";
import type { QualificationServiceError } from "@/lib/qualification/service";
import type { ReviewServiceError } from "@/lib/review/service";

export const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
} as const;

export function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export function privateJsonError(message: string, status: number): NextResponse {
  return privateJson({ error: message }, status);
}

export function readJsonBody(request: Request): Promise<unknown> {
  return request.json().then(
    (body: unknown) => body,
    () => {
      throw new L05RouteInputError();
    },
  );
}

export class L05RouteInputError extends Error {
  constructor() {
    super("The request body is not valid JSON.");
    this.name = "L05RouteInputError";
  }
}

type L05ServiceError =
  | AccountServiceError
  | ContactServiceError
  | DiscoveryServiceError
  | QualificationServiceError
  | ReviewServiceError;

function isL05ServiceError(error: unknown): error is L05ServiceError {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string"
    && /^(?:ACCOUNT|CONTACT|DISCOVERY|QUALIFICATION|REVIEW|RESOLUTION|CONNECTOR|PLAN|RUN|PLAY)_/u
      .test(code);
}

function serviceErrorStatus(code: string): number {
  if (/_INPUT_INVALID$/u.test(code)) return 400;
  if (/_NOT_FOUND$/u.test(code)) return 404;
  if (/_STALE$/u.test(code) || code.endsWith("STALE_VERSION") || code.endsWith("STALE_QUEUE")
    || code.endsWith("STALE_STATE") || code.endsWith("STALE_RUN")) return 409;
  if (/_CONFLICT$/u.test(code) || code.endsWith("VERSION_CONFLICT")
    || code.endsWith("DUPLICATE_ITEM") || code.endsWith("BOUNDS_EXCEEDED")
    || code.endsWith("CAP_EXCEEDED")) return 409;
  if (/_REVIEW_REQUIRED$/u.test(code) || code.endsWith("HUMAN_REVIEW_REQUIRED")
    || code.endsWith("HUMAN_ACTOR_REQUIRED")) return 403;
  if (code.endsWith("SCOPE_MISMATCH")) return 403;
  if (code.endsWith("MALFORMED_INPUT")) return 400;
  return 422;
}

/**
 * Normalizes authorization, input, service, and persistence failures into the
 * route's public error contract without leaking scope or record existence.
 */
export function mapL05RouteError(error: unknown): NextResponse {
  if (error instanceof TenantAuthorizationError) {
    return privateJsonError(error.message, error.status);
  }
  if (error instanceof TenantContextError) {
    return privateJsonError("Permission denied", 403);
  }
  if (error instanceof L05RouteInputError) {
    return privateJsonError("The request body is invalid.", 400);
  }
  if (isL05ServiceError(error)) {
    return privateJsonError("The request could not be completed.", serviceErrorStatus(error.code));
  }
  return privateJsonError("The request could not be completed.", 500);
}

/**
 * Runs `fn` inside the tenant context + tenant-scoped database transaction
 * that resolveTenantDbContext requires. `correlationId` binds the async
 * context to this request.
 */
export async function withL05TenantDb<T>(
  session: TenantSession,
  correlationId: string,
  fn: Parameters<typeof withTenantDbContext<T>>[0],
): Promise<T> {
  return runWithTenantContext(session, correlationId, () => withTenantDbContext(fn));
}

/** Evaluator used for "C" permissions that are service-policy gates. */
export function l05PolicyEvaluator(
  predicate: (context: Parameters<TenantPolicyEvaluator>[0]) => boolean,
): TenantPolicyEvaluator {
  return (context) => ({ allowed: predicate(context), context });
}

export type L05Selector = Readonly<{
  tenantId?: unknown;
  workspaceId?: unknown;
}>;

export type L05RouteOptions = Readonly<{
  /** Request selector fields (query params or body scope fields). */
  selector: L05Selector;
  /** The tenant permission this route enforces. */
  permission: string;
  /** Audit/policy action label, e.g. "l05:accounts:list". */
  action: string;
  /** Resource scope class for workspace validation. */
  scopeClass: TenantResourceScopeClass;
  /** The resource workspace after input normalization. */
  resourceWorkspaceId?: string | null;
  resourceId?: string;
  resourceType?: string;
  /**
   * Tenant-policy predicate evaluated when the permission resolves to "C".
   * Defaults to `sourceResearchEnabled`. Returning false denies.
   */
  requirePolicy?: (policy: TenantPolicySchemaType) => boolean;
  /** Correlation id bound to the tenant context, e.g. `l05:route:${uuid}`. */
  correlationId: string;
}>;

export type L05RouteContext = Readonly<{
  session: TenantSession;
  db: DbClient;
}>;

/**
 * Uniform L-05 route guard: resolves the session boundary, installs the
 * tenant context + transaction, then enforces the route permission. "A"
 * permissions pass on role; "C" permissions additionally require the tenant
 * policy predicate. Errors map through mapL05RouteError.
 */
export async function l05Route<T>(
  options: L05RouteOptions,
  handler: (context: L05RouteContext) => Promise<T>,
): Promise<NextResponse> {
  try {
    const session = await requireTenantPermission(
      { tenantId: options.selector.tenantId, workspaceId: options.selector.workspaceId },
      "workspace:read",
    );
    const result = await runWithTenantContext(session, options.correlationId, () =>
      withTenantDbContext(async (db) => {
        const currentPolicy = await createTenantQueryRepository(db)
          .getCurrentTenantPolicy(session.tenantId);
        const parsedPolicy = tenantPolicySchema.safeParse(currentPolicy);
        const requirePolicy = options.requirePolicy
          ?? ((policy: TenantPolicySchemaType) => policy.sourceResearchEnabled === true);
        await assertTenantPermission(session, options.permission, {
          action: options.action,
          scopeClass: options.scopeClass,
          resource: {
            tenantId: session.tenantId,
            workspaceId: options.resourceWorkspaceId === undefined
              ? options.selector.workspaceId : options.resourceWorkspaceId,
            resourceId: options.resourceId,
            resourceType: options.resourceType,
          },
          policyEvaluator: (context) => ({
            allowed: context.tenantId === session.tenantId
              && parsedPolicy.success
              && parsedPolicy.data.tenantId === session.tenantId
              && requirePolicy(parsedPolicy.data),
            context,
          }),
        });
        return handler({ session, db });
      }));
    return privateJson(result);
  } catch (error) {
    return mapL05RouteError(error);
  }
}
