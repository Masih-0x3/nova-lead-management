import { randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import type { TenantPolicyEvaluator } from "@/lib/tenancy/authorize";
import { createTenantFeatureService } from "@/lib/tenancy/features";
import {
  createTenantLimitService,
  TENANT_LIMIT_ACTIONS,
  TENANT_LIMIT_ACTION_POLICY,
  type TenantLimitAction,
  type TenantLimitBackend,
  type TenantLimitService,
} from "@/lib/tenancy/limits";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { TENANT_LIMITS_LOCAL_DDL } from "@/lib/tenancy/tenant-limits-schema";

type Row = Record<string, unknown>;

const LIMIT_ACTION_SET = new Set<string>(TENANT_LIMIT_ACTIONS);

/** Applies the tenant-limit store tables to a local SQLite database. */
export async function ensureLocalTenantLimitsSchema(db: DbClient): Promise<void> {
  await db.exec(TENANT_LIMITS_LOCAL_DDL);
}

export interface LocalTenantLimitServiceOptions {
  readonly servicePrincipalResolver?: { resolve(principalId: string): Promise<unknown> };
  readonly platformOperatorResolver?: { resolve(principalId: string): Promise<unknown> };
  readonly policyEvaluator?: TenantPolicyEvaluator;
  readonly clock?: () => number;
}

/**
 * Composes the durable local backend with the tenant feature evaluator backed
 * by tenant_policies. Feature-flag changes remain unavailable locally (the
 * executor port is intentionally unset), but every resolution pins the durable
 * policy row and its version.
 */
export function createLocalTenantLimitService(
  db: DbClient,
  options: LocalTenantLimitServiceOptions = {},
): TenantLimitService {
  return createTenantLimitService({
    backend: createLocalTenantLimitBackend(db),
    featureService: createTenantFeatureService({
      policyRepository: createTenantQueryRepository(db),
      actorResolver: { resolveFeatureManager: async () => null },
      changeExecutor: { execute: async () => { throw new Error("tenant feature change executor is not configured locally"); } },
    }),
    servicePrincipalResolver: options.servicePrincipalResolver,
    platformOperatorResolver: options.platformOperatorResolver,
    policyEvaluator: options.policyEvaluator,
    clock: options.clock,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseActionKills(value: unknown): Partial<Record<TenantLimitAction, boolean>> {
  if (typeof value !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const kills: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (LIMIT_ACTION_SET.has(key) && entry === true) kills[key] = true;
  }
  return kills;
}

interface BucketState {
  readonly used: number;
  readonly resetAtMs: number;
}

async function readBucket(db: DbClient, key: string, nowMs: number, windowMs: number): Promise<BucketState> {
  const row = await db
    .prepare("SELECT used, reset_at_ms FROM tenant_limit_buckets WHERE bucket_key = ?")
    .get<Row>(key);
  if (!row || typeof row.used !== "number" || typeof row.reset_at_ms !== "number") {
    return { used: 0, resetAtMs: nowMs + windowMs };
  }
  if (nowMs >= row.reset_at_ms) return { used: 0, resetAtMs: nowMs + windowMs };
  return { used: row.used, resetAtMs: row.reset_at_ms };
}

async function writeBucket(db: DbClient, key: string, state: BucketState): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO tenant_limit_buckets (bucket_key, used, reset_at_ms, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET used = excluded.used, reset_at_ms = excluded.reset_at_ms, updated_at = excluded.updated_at`,
    )
    .run(key, state.used, state.resetAtMs, nowIso());
  if (result.changes !== 1) throw new Error("tenant limit bucket write failed");
}

async function readTenantConfig(db: DbClient, tenantId: string, action: TenantLimitAction) {
  const row = await db
    .prepare(
      "SELECT configuration_version, policy_cap, action_kill FROM tenant_limit_configuration WHERE tenant_id = ? AND action = ?",
    )
    .get<Row>(tenantId, action);
  return {
    configurationVersion: typeof row?.configuration_version === "number" ? row.configuration_version : 1,
    policyCap: typeof row?.policy_cap === "number" ? row.policy_cap : null,
    actionKill: row?.action_kill === 1,
  };
}

async function readPlatformConfig(db: DbClient) {
  const row = await db
    .prepare("SELECT configuration_version, global_kill, action_kills_json FROM platform_limit_configuration WHERE id = 'platform'")
    .get<Row>();
  return {
    configurationVersion: typeof row?.configuration_version === "number" ? row.configuration_version : 1,
    globalKill: row?.global_kill === 1,
    actionKills: parseActionKills(row?.action_kills_json),
  };
}

async function appendLimitEvent(
  db: DbClient,
  eventType: string,
  tenantId: string | null,
  action: string | null,
  payload: unknown,
): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO tenant_limit_events (event_id, event_type, tenant_id, action, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), eventType, tenantId, action, JSON.stringify(payload));
  if (result.changes !== 1) throw new Error("tenant limit event was not recorded");
}

/**
 * Durable SQLite backend for the tenant-limit service. `consume` revalidates
 * every expected fact — tenant status, configuration versions, kill switches,
 * policy cap, and the feature-policy version sourced from tenant_policies —
 * inside one transaction before reserving both buckets and the idempotency
 * record.
 */
export function createLocalTenantLimitBackend(db: DbClient): TenantLimitBackend {
  if (!db || typeof db.withTransaction !== "function") {
    throw new Error("The tenant limit store is unavailable.");
  }

  return {
    async getRuntimeState(input: { tenantId: string; action: TenantLimitAction }) {
      const tenant = await db
        .prepare("SELECT status FROM tenants WHERE id = ?")
        .get<Row>(input.tenantId);
      if (!tenant || typeof tenant.status !== "string") return null;
      const config = await readTenantConfig(db, input.tenantId, input.action);
      const platform = await readPlatformConfig(db);
      const rows = await db
        .prepare("SELECT action, policy_cap, action_kill FROM tenant_limit_configuration WHERE tenant_id = ?")
        .all<Row>(input.tenantId);
      const tenantActionKills: Record<string, boolean> = {};
      const tenantPolicyCaps: Record<string, number> = {};
      for (const row of rows) {
        if (typeof row.action !== "string" || !LIMIT_ACTION_SET.has(row.action)) continue;
        if (row.action_kill === 1) tenantActionKills[row.action] = true;
        if (typeof row.policy_cap === "number") tenantPolicyCaps[row.action] = row.policy_cap;
      }
      return {
        tenantId: input.tenantId,
        tenantStatus: tenant.status,
        configurationVersion: config.configurationVersion,
        platformConfigurationVersion: platform.configurationVersion,
        platformGlobalKill: platform.globalKill,
        platformActionKills: platform.actionKills,
        tenantActionKills,
        tenantPolicyCaps,
      };
    },

    async getPlatformRuntimeState() {
      const platform = await readPlatformConfig(db);
      return {
        configurationVersion: platform.configurationVersion,
        platformGlobalKill: platform.globalKill,
        platformActionKills: platform.actionKills,
      };
    },

    async consume(input) {
      return db.withTransaction!(async () => {
        const tenant = await db
          .prepare("SELECT status FROM tenants WHERE id = ?")
          .get<Row>(input.tenantId);
        const config = await readTenantConfig(db, input.tenantId, input.action);
        const platform = await readPlatformConfig(db);
        const hardCap = TENANT_LIMIT_ACTION_POLICY[input.action].platformHardCap;
        const effectiveCap = config.policyCap ?? hardCap;
        const stateUnchanged =
          !!tenant &&
          tenant.status === input.expectedTenantStatus &&
          config.configurationVersion === input.expectedConfigurationVersion &&
          platform.configurationVersion === input.expectedPlatformConfigurationVersion &&
          platform.globalKill === input.expectedPlatformGlobalKill &&
          (platform.actionKills[input.action] === true) === input.expectedPlatformActionKill &&
          config.actionKill === input.expectedTenantActionKill &&
          effectiveCap === input.expectedTenantPolicyCap &&
          Math.min(hardCap, effectiveCap) === input.hardBound;
        if (!stateUnchanged) return { status: "state_changed" as const };

        if (input.expectedFeaturePolicyVersion !== null) {
          const policy = await db
            .prepare("SELECT version FROM tenant_policies WHERE tenant_id = ?")
            .get<Row>(input.tenantId);
          if (!policy || policy.version !== input.expectedFeaturePolicyVersion) {
            return { status: "policy_blocked" as const };
          }
        }

        const prior = await db
          .prepare("SELECT request_hash FROM tenant_limit_idempotency WHERE idempotency_key = ?")
          .get<Row>(input.idempotencyKey);
        if (prior) {
          if (prior.request_hash !== input.requestHash) return { status: "idempotency_conflict" as const };
          const tenantBucket = await readBucket(db, input.buckets[0].key, input.nowMs, input.windowMs);
          return {
            status: "replayed" as const,
            remaining: Math.max(0, input.hardBound - tenantBucket.used),
            resetAt: Math.min(Math.max(tenantBucket.resetAtMs, input.nowMs), input.nowMs + input.windowMs),
          };
        }

        const buckets = await Promise.all(
          input.buckets.map((bucket) => readBucket(db, bucket.key, input.nowMs, input.windowMs)),
        );
        const blockedAt = buckets.findIndex((bucket) => bucket.used + input.amount > input.hardBound);
        if (blockedAt !== -1) {
          const blocking = buckets[blockedAt];
          return {
            status: "rate_limited" as const,
            remaining: Math.max(0, input.hardBound - blocking.used),
            resetAt: Math.min(Math.max(blocking.resetAtMs, input.nowMs), input.nowMs + input.windowMs),
          };
        }

        for (const [index, bucket] of input.buckets.entries()) {
          await writeBucket(db, bucket.key, { used: buckets[index].used + input.amount, resetAtMs: buckets[index].resetAtMs });
        }
        const idemResult = await db
          .prepare(
            `INSERT INTO tenant_limit_idempotency (idempotency_key, request_hash, tenant_id, action)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.idempotencyKey, input.requestHash, input.tenantId, input.action);
        if (idemResult.changes !== 1) throw new Error("tenant limit idempotency reservation failed");

        const remaining = Math.min(...buckets.map((bucket) => input.hardBound - (bucket.used + input.amount)));
        const resetAt = Math.min(...buckets.map((bucket) => bucket.resetAtMs));
        return { status: "consumed" as const, remaining, resetAt };
      });
    },

    async changeConfiguration(input) {
      return db.withTransaction!(async () => {
        const config = await readTenantConfig(db, input.tenantId, input.action);
        if (config.configurationVersion !== input.expectedVersion) return { status: "conflict" as const };
        const policyCap =
          input.mutation.tenantPolicyCap !== undefined ? input.mutation.tenantPolicyCap : config.policyCap;
        const actionKill =
          input.mutation.tenantActionKill !== undefined ? input.mutation.tenantActionKill : config.actionKill;
        const upsert = await db
          .prepare(
            `INSERT INTO tenant_limit_configuration (tenant_id, action, configuration_version, policy_cap, action_kill, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, action) DO UPDATE SET
               configuration_version = excluded.configuration_version,
               policy_cap = excluded.policy_cap,
               action_kill = excluded.action_kill,
               updated_at = excluded.updated_at
             WHERE tenant_limit_configuration.configuration_version = excluded.configuration_version - 1`,
          )
          .run(input.tenantId, input.action, input.resultingVersion, policyCap, actionKill ? 1 : 0, nowIso());
        if (upsert.changes !== 1) return { status: "conflict" as const };
        await appendLimitEvent(db, input.auditEvent.eventType, input.tenantId, input.action, input.auditEvent);
        return {
          tenantId: input.tenantId,
          action: input.action,
          previousVersion: input.expectedVersion,
          resultingVersion: input.resultingVersion,
        };
      });
    },

    async changePlatformConfiguration(input) {
      return db.withTransaction!(async () => {
        const platform = await readPlatformConfig(db);
        if (platform.configurationVersion !== input.expectedVersion) return { status: "conflict" as const };
        const kills = { ...platform.actionKills };
        if (input.scope === "action" && input.action) {
          if (input.enabled) kills[input.action] = true;
          else delete kills[input.action];
        }
        const globalKill = input.scope === "global" ? input.enabled : platform.globalKill;
        const upsert = await db
          .prepare(
            `INSERT INTO platform_limit_configuration (id, configuration_version, global_kill, action_kills_json, updated_at)
             VALUES ('platform', ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               configuration_version = excluded.configuration_version,
               global_kill = excluded.global_kill,
               action_kills_json = excluded.action_kills_json,
               updated_at = excluded.updated_at
             WHERE platform_limit_configuration.configuration_version = excluded.configuration_version - 1`,
          )
          .run(input.resultingVersion, globalKill ? 1 : 0, JSON.stringify(kills), nowIso());
        if (upsert.changes !== 1) return { status: "conflict" as const };
        await appendLimitEvent(db, input.auditEvent.eventType, null, input.action, input.auditEvent);
        return {
          scope: input.scope,
          action: input.action,
          previousVersion: input.expectedVersion,
          resultingVersion: input.resultingVersion,
        };
      });
    },
  };
}
