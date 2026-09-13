import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import type { DbClient } from "@/lib/db";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  createLocalTenantLimitBackend,
  createLocalTenantLimitService,
  ensureLocalTenantLimitsSchema,
} from "@/lib/tenancy/local-tenant-limits";
import {
  createTenantLimitService,
  type TenantLimitCommand,
  type TenantLimitService,
} from "@/lib/tenancy/limits";
import { createLocalTenantLifecycleOperationsService } from "@/lib/tenancy/local-lifecycle-operations";
import { TENANT_FEATURE_POLICY_FIELDS, type TenantFeatureId } from "@/lib/tenancy/features";
import type { TenantId } from "@/lib/tenancy/types";

vi.mock("server-only", () => ({}));

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const MISSING_TENANT = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const POLICY_ID = "20000000-0000-4000-8000-000000000001";
const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const BINDING_ID = "40000000-0000-4000-8000-000000000001";

const openDatabases: Database.Database[] = [];

function createDb(): { database: Database.Database; client: DbClient } {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  openDatabases.push(database);
  let queue: Promise<void> = Promise.resolve();
  const client: DbClient = {
    prepare(query) {
      const statement = database.prepare(query);
      return {
        all: async <T = Record<string, unknown>>(...params: unknown[]) => statement.all(...params) as T[],
        get: async <T = Record<string, unknown>>(...params: unknown[]) => statement.get(...params) as T | undefined,
        run: async (...params: unknown[]) => ({ changes: statement.run(...params).changes }),
      };
    },
    exec: async (query) => {
      database.exec(query);
    },
    withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      const result = new Promise<T>((resolve, reject) => {
        queue = queue.then(async () => {
          database.exec("BEGIN");
          try {
            const value = await fn();
            database.exec("COMMIT");
            resolve(value);
          } catch (error) {
            database.exec("ROLLBACK");
            reject(error);
          }
        }, (error) => reject(error));
      });
      return result;
    },
  };
  return { database, client };
}

async function seed(client: DbClient, status: "active" | "suspended" = "active") {
  const repository = createTenantQueryRepository(client);
  await repository.createTenant({ id: TENANT_ID, slug: "limits-tenant", name: "Limits Tenant", status });
  await repository.createWorkspace(TENANT_ID, { id: WORKSPACE_ID, slug: "ops", name: "Ops", status: "active" });
  await repository.createTenantPolicy(TENANT_ID, { id: POLICY_ID });
  await repository.createMembership(TENANT_ID, { id: MEMBERSHIP_ID, authIdentityId: OWNER_ID, workspaceId: null, status: "active" });
  await repository.createRoleBinding(TENANT_ID, { id: BINDING_ID, membershipId: MEMBERSHIP_ID, role: "owner", reasonCode: "initial_provisioning" });
  await ensureLocalTenantLimitsSchema(client);
}

let clockMs = 1_000_000;

function makeService(client: DbClient, options: { realFeatures?: boolean } = {}): TenantLimitService {
  if (options.realFeatures) {
    return createLocalTenantLimitService(client, {
      servicePrincipalResolver: { resolve: async () => null },
      platformOperatorResolver: {
        resolve: async (principalId) =>
          principalId === "operator-1" ? { operatorId: "operator-1", permission: "platform:limit_manage" } : null,
      },
      policyEvaluator: async (context) => ({ allowed: true, context }),
      clock: () => clockMs,
    });
  }
  return createTenantLimitService({
    backend: createLocalTenantLimitBackend(client),
    featureService: {
      enforceFeature: async (tenantId: string, featureId: TenantFeatureId) => {
        return {
          tenantId: tenantId as TenantId,
          featureId,
          policyField: TENANT_FEATURE_POLICY_FIELDS[featureId],
          state: "enabled" as const,
          policyEnabled: true,
          policyVersion: 1,
          reasonCode: "FEATURE_ENABLED" as const,
        };
      },
    },
    servicePrincipalResolver: { resolve: async () => null },
    platformOperatorResolver: {
      resolve: async (principalId) =>
        principalId === "operator-1" ? { operatorId: "operator-1", permission: "platform:limit_manage" } : null,
    },
    policyEvaluator: async (context) => ({ allowed: true, context }),
    clock: () => clockMs,
  });
}

function asOwner<T>(callback: () => T, tenantId = TENANT_ID): T {
  return runWithTenantContext(
    {
      userId: OWNER_ID,
      email: "owner@example.test",
      displayName: "Owner",
      tenantId,
      workspaceId: null,
      membershipId: MEMBERSHIP_ID,
      role: "owner" as const,
      roleBindingId: BINDING_ID,
    },
    `corr-${tenantId.slice(-2)}-owner`,
    callback,
  );
}

function command(action: unknown = "membership_invite", overrides: Record<string, unknown> = {}): TenantLimitCommand {
  return { action, amount: 1, idempotencyKey: "idem-key-0001", ...overrides };
}

function bucketCount(database: Database.Database): number {
  return (database.prepare("SELECT COALESCE(SUM(used), 0) AS total FROM tenant_limit_buckets").get() as { total: number }).total;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  clockMs = 1_000_000;
});

describe("local tenant limit backend", () => {
  it("consumes within bounds durably and replays idempotent requests", async () => {
    const { client, database } = createDb();
    await seed(client);
    const service = makeService(client);

    const first = await asOwner(() => service.consume(command("membership_invite")));
    expect(first).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(bucketCount(database)).toBe(2); // tenant bucket + actor bucket

    const replay = await asOwner(() => service.consume(command("membership_invite")));
    expect(replay).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(bucketCount(database)).toBe(2); // replay did not double-count

    const conflict = await asOwner(() => service.consume(command("membership_invite", { amount: 2 })));
    expect(conflict).toMatchObject({ outcome: "blocked", code: "BLOCKED_IDEMPOTENCY_CONFLICT" });

    const second = await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "idem-key-0002" })));
    expect(second).toMatchObject({ outcome: "allowed" });
    expect(bucketCount(database)).toBe(4);
  });

  it("enforces per-tenant policy caps and tenant action kills durably", async () => {
    const { client, database } = createDb();
    await seed(client);
    const service = makeService(client);

    const configured = await asOwner(() =>
      service.changeConfiguration({
        action: "membership_invite",
        expectedVersion: 1,
        tenantPolicyCap: 2,
        reason: "Tight invite budget",
        correlationId: "corr-cap-0001",
      }));
    expect(configured).toMatchObject({ code: "CONFIGURATION_CHANGED", previousVersion: 1, resultingVersion: 2 });

    await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "cap-key-0001" })));
    await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "cap-key-0002" })));
    const limited = await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "cap-key-0003" })));
    expect(limited).toMatchObject({ outcome: "rate_limited", code: "RATE_LIMITED" });
    expect(limited.retryAfterMs).toBeGreaterThan(0);

    // Buckets retain exactly the capped amount.
    expect(bucketCount(database)).toBe(4);

    const killed = await asOwner(() =>
      service.changeConfiguration({
        action: "membership_invite",
        expectedVersion: 2,
        tenantActionKill: true,
        reason: "Freeze invites",
        correlationId: "corr-kill-0001",
      }));
    expect(killed).toMatchObject({ code: "CONFIGURATION_CHANGED", resultingVersion: 3 });

    clockMs += 25 * 60 * 60 * 1000; // past the window: only the kill switch blocks
    const denied = await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "kill-key-0001" })));
    expect(denied).toMatchObject({ outcome: "blocked", code: "BLOCKED_KILL_SWITCH" });

    const events = database
      .prepare("SELECT event_type, action FROM tenant_limit_events ORDER BY rowid")
      .all() as Record<string, unknown>[];
    expect(events).toEqual([
      { event_type: "tenant_limit_configuration_changed", action: "membership_invite" },
      { event_type: "tenant_limit_configuration_changed", action: "membership_invite" },
    ]);
  });

  it("enforces the platform kill switch atomically across tenants", async () => {
    const { client } = createDb();
    await seed(client);
    const service = makeService(client);

    const switched = await service.changePlatformKillSwitch(
      { scope: "action", action: "membership_invite", enabled: true, expectedVersion: 1, reason: "platform freeze", correlationId: "corr-platform-1" },
      { kind: "platform_operator", principalId: "operator-1" },
    );
    expect(switched).toMatchObject({ code: "PLATFORM_CONFIGURATION_CHANGED", resultingVersion: 2 });

    const denied = await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "pkill-0001" })));
    expect(denied).toMatchObject({ outcome: "blocked", code: "BLOCKED_KILL_SWITCH" });
  });

  it("blocks lifecycle-incompatible and feature-gated actions without consuming", async () => {
    const { client, database } = createDb();
    await seed(client, "suspended");
    const service = makeService(client);

    // membership_invite requires business_mutation; suspended tenants only read/status/export.
    const lifecycle = await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "life-0001" })));
    expect(lifecycle).toMatchObject({ outcome: "blocked", code: "BLOCKED_LIFECYCLE" });
    expect(bucketCount(database)).toBe(0);
  });

  it("enforces feature-gated actions against the durable tenant policy", async () => {
    const { client } = createDb();
    await seed(client);
    const service = makeService(client, { realFeatures: true });

    // copy_export_enabled defaults to 0 in tenant_policies → export denied.
    const denied = await asOwner(() => service.consume(command("export_request", { idempotencyKey: "exp-key-0000" })));
    expect(denied).toMatchObject({ outcome: "blocked", code: "BLOCKED_FEATURE" });

    // Feature change bumps the policy version exactly once (schema trigger).
    await client.prepare("UPDATE tenant_policies SET copy_export_enabled = 1, version = 2, updated_at = ? WHERE tenant_id = ?")
      .run(new Date().toISOString(), TENANT_ID);
    const allowed = await asOwner(() => service.consume(command("export_request", { idempotencyKey: "exp-key-0001" })));
    expect(allowed).toMatchObject({ outcome: "allowed", code: "ALLOWED" });

    // The backend pins the resolved feature-policy version inside the consume
    // transaction — a stale pin is a policy_blocked, not a silent consume.
    const backend = createLocalTenantLimitBackend(client);
    const stale = await backend.consume({
      tenantId: TENANT_ID,
      actorId: OWNER_ID,
      workspaceId: null,
      action: "export_request",
      buckets: [
        { scope: "tenant", key: "tenant:export_request:pin-test" },
        { scope: "actor", key: "actor:export_request:pin-test" },
      ],
      idempotencyKey: "0".repeat(64),
      requestHash: "1".repeat(64),
      windowMs: 60_000,
      amount: 1,
      hardBound: 50,
      nowMs: clockMs,
      expectedTenantStatus: "active",
      expectedConfigurationVersion: 1,
      expectedPlatformConfigurationVersion: 1,
      expectedPlatformGlobalKill: false,
      expectedPlatformActionKill: false,
      expectedTenantActionKill: false,
      expectedTenantPolicyCap: 50,
      expectedFeaturePolicyVersion: 1, // stale — actual version is 2
    });
    expect(stale).toEqual({ status: "policy_blocked" });
  });

  it("fails closed without enumerating missing or foreign tenants", async () => {
    const { client } = createDb();
    await seed(client);
    const service = makeService(client);

    const missing = await asOwner(() => service.consume(command("membership_invite", { idempotencyKey: "miss-0001" })), MISSING_TENANT);
    expect(missing).toMatchObject({ outcome: "blocked", code: "BLOCKED_BACKEND" });

    // Compatibility selector for a different tenant is ignored/denied.
    const foreign = await asOwner(() =>
      service.consume(command("membership_invite", { idempotencyKey: "foreign-1", tenantId: MISSING_TENANT })));
    expect(foreign).toMatchObject({ outcome: "blocked", code: "BLOCKED_TENANT_SCOPE" });
  });

  it("rejects stale configuration versions and audits every change", async () => {
    const { client, database } = createDb();
    await seed(client);
    const service = makeService(client);

    await asOwner(() =>
      service.changeConfiguration({
        action: "export_request",
        expectedVersion: 1,
        tenantPolicyCap: 5,
        reason: "cap exports",
        correlationId: "corr-cap-0002",
      }));

    await expect(
      asOwner(() =>
        service.changeConfiguration({
          action: "export_request",
          expectedVersion: 1,
          tenantPolicyCap: 3,
          reason: "stale write",
          correlationId: "corr-cap-0003",
        })),
    ).rejects.toMatchObject({ code: "CONFIGURATION_VERSION_CONFLICT" });

    const state = await createLocalTenantLimitBackend(client).getRuntimeState({ tenantId: TENANT_ID, action: "export_request" });
    expect(state).toMatchObject({ configurationVersion: 2, tenantPolicyCaps: { export_request: 5 } });

    const events = database.prepare("SELECT event_type, action, tenant_id FROM tenant_limit_events").all() as Record<string, unknown>[];
    expect(events).toEqual([{ event_type: "tenant_limit_configuration_changed", action: "export_request", tenant_id: TENANT_ID }]);
  });

  it("gates a wired lifecycle operation end-to-end", async () => {
    const { client } = createDb();
    await seed(client);
    const limits = makeService(client);
    const ops = createLocalTenantLifecycleOperationsService(client, { limits });

    await asOwner(() =>
      limits.changeConfiguration({
        action: "export_request",
        expectedVersion: 1,
        tenantPolicyCap: 1,
        reason: "one export only",
        correlationId: "corr-cap-0004",
      }));

    const first = await asOwner(() =>
      ops.requestExport({
        tenantId: TENANT_ID,
        requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
        idempotencyKey: "export-idem-0001",
        correlationId: "corr-export-001",
      }));
    expect(first.code).toBe("OK_EXPORT_REQUESTED");

    await expect(
      asOwner(() =>
        ops.requestExport({
          tenantId: TENANT_ID,
          requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
          idempotencyKey: "export-idem-0002",
          correlationId: "corr-export-002",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_LIMIT" });
  });
});
