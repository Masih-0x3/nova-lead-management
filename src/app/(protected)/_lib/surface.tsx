import "server-only";

import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";

import { gateL05Policy } from "@/app/api/_shared/l05-deps";
import { AsyncState } from "@/components/async-state";
import { PageShell } from "@/components/page-shell";
import { getTenantSession, type TenantSession } from "@/lib/auth";
import { withDbStatementTimeout, withTenantDbContext, type DbClient } from "@/lib/db";
import {
  TenantAuthorizationError,
  type TenantResourceScopeClass,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext, TenantContextError } from "@/lib/tenancy/context";
import type { TenantPolicySchemaType } from "@/lib/tenancy/schemas";
import type { TenantPermission } from "@/lib/permissions";

export type SurfaceFailureKind =
  | "unavailable"
  | "workspace-required"
  | "denied"
  | "error";

export type SurfaceOutcome<T> =
  | Readonly<{ state: "ready"; session: TenantSession; data: T }>
  | Readonly<{ state: "failed"; kind: SurfaceFailureKind }>;

export type SurfaceLoadOptions<T> = Readonly<{
  /** Route label used in the correlation id and reload link, e.g. "/strategy". */
  route: string;
  /** D-002 permission guarding the surface read. */
  permission: TenantPermission;
  /** Audit/policy action label, e.g. "l07:strategy:read". */
  action: string;
  /** Resource scope class; workspace-required surfaces refuse tenant-wide sessions. */
  scopeClass?: TenantResourceScopeClass;
  resourceType?: string;
  /**
   * Tenant-policy predicate evaluated when the permission resolves to "C".
   * Defaults to `sourceResearchEnabled`, matching the L-05 route helper.
   */
  requirePolicy?: (policy: TenantPolicySchemaType) => boolean;
  timeoutMs?: number;
  load: (db: DbClient, session: TenantSession) => Promise<T>;
}>;

/**
 * Shared protected-surface loader: resolves the tenant session, enforces the
 * read permission (including the conditional policy gate), then runs the
 * caller's queries inside the tenant context + scoped transaction. All
 * failures collapse into a typed, non-enumerating outcome.
 */
export async function loadSurface<T>(options: SurfaceLoadOptions<T>): Promise<SurfaceOutcome<T>> {
  let session: TenantSession | null;
  try {
    session = await getTenantSession({});
  } catch {
    return { state: "failed", kind: "unavailable" };
  }
  if (!session) return { state: "failed", kind: "unavailable" };

  const scopeClass = options.scopeClass ?? "workspace-optional";
  if (scopeClass === "workspace-required" && session.workspaceId === null) {
    return { state: "failed", kind: "workspace-required" };
  }

  try {
    const data = await runWithTenantContext(
      session,
      `l07:${options.route.replace(/[^A-Za-z0-9._:/-]/g, "_")}:${randomUUID()}`,
      () => withTenantDbContext(async (db) => {
        await gateL05Policy(session, db, options.permission, {
          workspaceId: session.workspaceId,
          scopeClass,
          action: options.action,
          resourceType: options.resourceType,
          requirePolicy: options.requirePolicy,
        });
        return withDbStatementTimeout(options.timeoutMs ?? 15_000, () =>
          options.load(db, session));
      }),
    );
    return { state: "ready", session, data };
  } catch (error) {
    if (error instanceof TenantAuthorizationError) {
      return { state: "failed", kind: "denied" };
    }
    if (error instanceof TenantContextError) {
      return { state: "failed", kind: "denied" };
    }
    return { state: "failed", kind: "error" };
  }
}

const FAILURE_COPY: Readonly<Record<SurfaceFailureKind, Readonly<{
  variant: "access-denied" | "error" | "empty";
  title: string;
  body: string;
}>>> = {
  unavailable: {
    variant: "access-denied",
    title: "Tenant scope unavailable",
    body: "A canonical tenant membership could not be verified for this session. No tenant records were read.",
  },
  "workspace-required": {
    variant: "access-denied",
    title: "Workspace scope required",
    body: "This surface is workspace-scoped. Your membership does not resolve a workspace, so nothing was read.",
  },
  denied: {
    variant: "access-denied",
    title: "Not authorized",
    body: "Your tenant role or the current tenant policy does not allow this surface. No records were read.",
  },
  error: {
    variant: "error",
    title: "Surface unavailable",
    body: "The tenant-scoped read failed. Retry to load the latest canonical state.",
  },
};

/**
 * Consistent typed failure state for protected surfaces — access-denied,
 * workspace-required, unavailable, and retryable error variants all share the
 * same landmarks and reload affordance.
 */
export function SurfaceNotice(props: Readonly<{
  route: string;
  title: string;
  description: string;
  kind: SurfaceFailureKind;
  action?: ReactNode;
}>) {
  const copy = FAILURE_COPY[props.kind];
  return (
    <PageShell title={props.title} description={props.description}>
      <AsyncState
        variant={copy.variant}
        title={copy.title}
        description={copy.body}
        action={props.action ?? (
          <a href={props.route} className="btn-primary inline-flex min-h-11 items-center text-center">
            Reload surface
          </a>
        )}
      />
    </PageShell>
  );
}

/**
 * Pending-state card for a surface whose durable read seam has not landed yet.
 * Used deliberately — never render dead controls for a missing capability.
 */
export function PendingSeamNotice(props: Readonly<{
  title: string;
  description: string;
}>) {
  return (
    <AsyncState
      variant="empty"
      title={props.title}
      description={props.description}
    />
  );
}
