/**
 * L-02 Postgres tenant-limit (quota) adapter.
 *
 * The twin of `createLocalTenantLimitService` for the DATABASE_URL runtime.
 * The limit store tables are RLS-enabled with zero policies, so the
 * restricted runtime role cannot read or write them at all — every backend
 * method runs inside `withTenantDbContext` and goes through the SECURITY
 * DEFINER family in migration 202609120006, which re-validates the
 * transaction-local member GUCs database-side and binds the request
 * tenant/actor to the accepted context.
 *
 * `consume` replays the canonical atomic flow inside
 * `novatrade_tenant_limit_consume`: advisory-locked (tenant, action) lane,
 * expected-state revalidation, idempotency replay/conflict, sliding-window
 * bucket accounting, and the bucket + idempotency reservation in one
 * statement. `changeConfiguration` is the same CAS + event append shape as
 * the policy functions.
 *
 * `changePlatformConfiguration` stays fail-closed: platform-operator
 * authority is not part of the member-GUC context model, so the platform
 * kill-switch path is unavailable until a dedicated platform lane exists.
 */
import { withTenantDbContext } from "@/lib/db";
import type { TenantPolicyEvaluator } from "@/lib/tenancy/authorize";
import {
  createTenantLimitService,
  TENANT_LIMIT_ACTION_POLICY,
  type TenantLimitService,
} from "@/lib/tenancy/limits";
import { createPostgresTenantFeatureService } from "@/lib/tenancy/postgres-features";

export interface PostgresTenantLimitServiceOptions {
  readonly servicePrincipalResolver?: { resolve(principalId: string): Promise<unknown> };
  readonly platformOperatorResolver?: { resolve(principalId: string): Promise<unknown> };
  readonly policyEvaluator?: TenantPolicyEvaluator;
  readonly clock?: () => number;
}

interface ConsumeOutcomeRow {
  readonly outcome: string;
  // bigint columns arrive as string from the postgres driver.
  readonly remaining: number | string | null;
  readonly reset_at_ms: number | string | null;
}

interface ConfigurationOutcomeRow {
  readonly outcome: string;
  readonly configuration_version: number | string | null;
}

function safeInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" || typeof value === "bigint" ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) ? numeric : null;
}

export function createPostgresTenantLimitService(
  options: PostgresTenantLimitServiceOptions = {},
): TenantLimitService {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("The Postgres tenant limit service requires DATABASE_URL.");
  }

  return createTenantLimitService({
    backend: {
      getRuntimeState: ({ tenantId, action }) =>
        withTenantDbContext(async (db) => {
          const row = await db
            .prepare("SELECT public.novatrade_tenant_limit_runtime_state(?, ?) AS state")
            .get<{ state: unknown }>(tenantId, action);
          return row?.state ?? null;
        }),
      // Platform kill-switch authority is a platform-operator surface outside
      // the member-GUC model; the backend read is only needed by that path and
      // stays fail-closed with it.
      getPlatformRuntimeState: () => {
        throw new Error("Platform limit state is unavailable on Postgres.");
      },
      consume: (input) =>
        withTenantDbContext(async (db) => {
          const row = await db
            .prepare(
              `SELECT outcome, remaining, reset_at_ms
               FROM public.novatrade_tenant_limit_consume(?)`,
            )
            .get<ConsumeOutcomeRow>(JSON.stringify({
              ...input,
              platformHardCap: TENANT_LIMIT_ACTION_POLICY[input.action].platformHardCap,
            }));
          if (!row) throw new Error("Tenant limit consume returned no outcome.");
          switch (row.outcome) {
            case "consumed":
            case "replayed":
            case "rate_limited": {
              const remaining = safeInteger(row.remaining);
              const resetAt = safeInteger(row.reset_at_ms);
              if (remaining === null || resetAt === null) {
                throw new Error("Tenant limit consume returned a malformed outcome.");
              }
              return { status: row.outcome, remaining, resetAt };
            }
            case "idempotency_conflict":
            case "state_changed":
            case "policy_blocked":
              return { status: row.outcome };
            default:
              throw new Error(`Tenant limit consume was not committed: ${row.outcome}.`);
          }
        }),
      changeConfiguration: (input) =>
        withTenantDbContext(async (db) => {
          const row = await db
            .prepare(
              `SELECT outcome, configuration_version
               FROM public.novatrade_change_tenant_limit_configuration(?, ?, ?, ?, ?, ?)`,
            )
            .get<ConfigurationOutcomeRow>(
              input.tenantId,
              input.action,
              input.expectedVersion,
              input.mutation.tenantPolicyCap ?? null,
              input.mutation.tenantActionKill ?? null,
              JSON.stringify(input.auditEvent),
            );
          if (row?.outcome === "conflict") return { status: "conflict" as const };
          const resultingVersion = safeInteger(row?.configuration_version);
          if (!row || row.outcome !== "applied" || resultingVersion !== input.resultingVersion) {
            throw new Error(`Tenant limit configuration change was not committed: ${row?.outcome ?? "no outcome"}.`);
          }
          return {
            tenantId: input.tenantId,
            action: input.action,
            previousVersion: input.expectedVersion,
            resultingVersion,
          };
        }),
      changePlatformConfiguration: () => {
        throw new Error("Platform limit configuration is unavailable on Postgres.");
      },
    },
    featureService: createPostgresTenantFeatureService(),
    servicePrincipalResolver: options.servicePrincipalResolver,
    platformOperatorResolver: options.platformOperatorResolver,
    policyEvaluator: options.policyEvaluator,
    clock: options.clock,
  });
}
