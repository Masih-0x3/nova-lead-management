/**
 * L-02 Postgres tenant status-transition adapter — the lifecycle slice of
 * the DATABASE_URL write path after T-031/T-032/T-033.
 *
 * `tenants` is a foundation table with member-select + support-select read
 * policies and a deny-all-else write posture, so the member-facing
 * suspend/archive transition goes through the SECURITY DEFINER
 * `novatrade_transition_tenant_status` (migration 202609120007) inside
 * `withTenantDbContext`. The function re-validates the transaction-local
 * member GUCs database-side, binds request tenant/actor to the accepted
 * context, applies the canonical transition matrix's member edges
 * (active ↔ suspended, → archived), CAS-updates the status, and appends the
 * member-layer audit row atomically.
 *
 * Two consequences of the member-context helper requiring an active tenant
 * shape this adapter:
 *  - Once a tenant leaves `active`, its member context is dead — so the
 *    function returns the post-transition tenant row itself; a member-RLS
 *    re-read could not see it.
 *  - A suspended tenant cannot produce a member context at all, so `resume`
 *    and archive-from-suspended fail closed here (NOT_FOUND_NON_ENUMERATING)
 *    — they belong to a support/platform context lane, matching the fact
 *    that session bootstrap cannot mint a member session for a suspended
 *    tenant either.
 *
 * The deletion edges (archived → deletion_pending, deletion_pending →
 * archived/deleted) mutate the deletion-job ledger and belong to the
 * deletion port; export/deletion job orchestration lands with its own
 * slices.
 */
import { randomUUID } from "node:crypto";

import { withTenantDbContext } from "@/lib/db";
import {
  TenantLifecycleOpsError,
  type SuspendResumeArchiveInput,
  type TenantLifecycleOperationsService,
  type TenantLifecycleOpsCode,
} from "@/lib/tenancy/lifecycle-operations";
import type { TenantQueryRepository } from "@/lib/tenancy/queries";

interface TransitionOutcomeRow {
  readonly outcome: string;
  readonly tenant_status: string | null;
  readonly tenant: Record<string, unknown> | null;
}

type ResolvedTenant = NonNullable<Awaited<ReturnType<TenantQueryRepository["getTenant"]>>>;
type LifecycleTransitionTarget = "suspended" | "active" | "archived";

const TRANSITION_OK_CODES: Record<LifecycleTransitionTarget, TenantLifecycleOpsCode> = {
  suspended: "OK_SUSPENDED",
  active: "OK_RESUMED",
  archived: "OK_ARCHIVED",
};

/** Maps the function's snake_case tenant row onto the repository's Tenant shape. */
function mapReturnedTenant(value: Record<string, unknown>): ResolvedTenant | null {
  const tenant = {
    id: value.id,
    slug: value.slug,
    name: value.name,
    status: value.status,
    locale: value.locale,
    timezone: value.timezone,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
  const allStrings = Object.values(tenant).every((field) => typeof field === "string" && field !== "");
  return allStrings ? (tenant as ResolvedTenant) : null;
}

export function createPostgresTenantLifecycleService(): Pick<
  TenantLifecycleOperationsService,
  "suspend" | "resume" | "archive"
> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("The Postgres tenant lifecycle service requires DATABASE_URL.");
  }

  async function transition(
    input: SuspendResumeArchiveInput,
    toStatus: LifecycleTransitionTarget,
  ): Promise<{ code: TenantLifecycleOpsCode; tenant: ResolvedTenant }> {
    const row = await withTenantDbContext((db) =>
      db
        .prepare(
          `SELECT outcome, tenant_status, tenant
           FROM public.novatrade_transition_tenant_status(?)`,
        )
        .get<TransitionOutcomeRow>(JSON.stringify({
          tenantId: input.tenantId,
          actorId: input.actor.authIdentityId,
          expectedCurrentState: input.expectedCurrentState,
          toStatus,
          reasonCode: input.reasonCode,
          reason: input.reason,
          correlationId: input.correlationId,
          auditEventId: randomUUID(),
        })),
    );

    if (!row || typeof row.outcome !== "string") {
      throw new TenantLifecycleOpsError("FAILED_INTERNAL");
    }
    if (row.outcome === "applied") {
      const tenant = row.tenant ? mapReturnedTenant(row.tenant) : null;
      if (row.tenant_status !== toStatus || !tenant || tenant.status !== toStatus || tenant.id !== input.tenantId) {
        throw new TenantLifecycleOpsError("FAILED_INTERNAL");
      }
      return { code: TRANSITION_OK_CODES[toStatus], tenant };
    }
    switch (row.outcome) {
      case "invalid_request":
        throw new TenantLifecycleOpsError("BLOCKED_MALFORMED");
      case "state_conflict":
        throw new TenantLifecycleOpsError("BLOCKED_STATE_CONFLICT");
      case "actor_scope":
        throw new TenantLifecycleOpsError("BLOCKED_ACTOR_SCOPE");
      // denied / not_found both collapse to the canonical non-enumerating
      // refusal: context, scope, absence, staleness, and foreign rows are
      // deliberately indistinguishable.
      default:
        throw new TenantLifecycleOpsError("NOT_FOUND_NON_ENUMERATING");
    }
  }

  return {
    suspend: (input) => transition(input, "suspended"),
    resume: (input) => transition(input, "active"),
    archive: (input) => transition(input, "archived"),
  };
}
