import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import type { DbClient } from "@/lib/db";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { createLocalTenantRetentionService } from "@/lib/tenancy/local-retention-policy";
import type { TenantRetentionKnob } from "@/lib/tenancy/retention-policy";

const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const RESEARCHER_ID = "50000000-0000-4000-8000-000000000007";
const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const POLICY_ID = "20000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const RESEARCHER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000004";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const RESEARCHER_BINDING_ID = "40000000-0000-4000-8000-000000000004";

vi.mock("server-only", () => ({}));

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

async function seedTenant(client: DbClient) {
  const repository = createTenantQueryRepository(client);
  await repository.createTenant({
    id: TENANT_ID, slug: "retention-tenant", name: "Retention Tenant", status: "active",
  });
  await repository.createWorkspace(TENANT_ID, {
    id: WORKSPACE_ID, slug: "ops", name: "Ops", status: "active",
  });
  await repository.createTenantPolicy(TENANT_ID, { id: POLICY_ID });
  await repository.createMembership(TENANT_ID, {
    id: MEMBERSHIP_ID, authIdentityId: OWNER_ID, workspaceId: null, status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: ROLE_BINDING_ID, membershipId: MEMBERSHIP_ID, role: "owner", reasonCode: "initial_provisioning",
  });
  await repository.createMembership(TENANT_ID, {
    id: RESEARCHER_MEMBERSHIP_ID, authIdentityId: RESEARCHER_ID, workspaceId: null, status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: RESEARCHER_BINDING_ID, membershipId: RESEARCHER_MEMBERSHIP_ID, role: "researcher", reasonCode: "invitation",
  });
}

const ownerService = (client: DbClient) =>
  createLocalTenantRetentionService(client, {
    actor: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
  });

const change = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT_ID,
  knob: "primary_delete_within_days" as TenantRetentionKnob,
  days: 7,
  expectedPolicyVersion: 1,
  reason: "Shorten the deletion schedule",
  correlationId: "corr-retention-local-0001",
  ...overrides,
});

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("local tenant retention policy adapters", () => {
  it("commits a capable member's retention change: CAS + member-scope audit in one tx", async () => {
    const { database, client } = createDb();
    await seedTenant(client);

    const result = await ownerService(client).requestRetentionChange(change());

    expect(result).toMatchObject({
      status: "changed", previousPolicyVersion: 1, resultingPolicyVersion: 2,
    });
    const policy = await client.prepare(
      "SELECT version, primary_delete_within_days FROM tenant_policies WHERE tenant_id = ?",
    ).get<{ version: number; primary_delete_within_days: number }>(TENANT_ID);
    expect(policy).toMatchObject({ version: 2, primary_delete_within_days: 7 });

    const audit = database.prepare(
      `SELECT action, scope_kind, actor_layer, actor_membership_id, actor_launch_role,
              actor_role_binding_id, actor_auth_identity_id, metadata
       FROM audit_logs WHERE action = 'tenant_retention_policy_changed'`,
    ).get() as Record<string, unknown>;
    expect(audit).toMatchObject({
      scope_kind: "tenant",
      actor_layer: "member",
      actor_membership_id: MEMBERSHIP_ID,
      actor_launch_role: "owner",
      actor_role_binding_id: ROLE_BINDING_ID,
      actor_auth_identity_id: OWNER_ID,
    });
    expect(JSON.parse(audit.metadata as string)).toMatchObject({
      eventType: "tenant_retention_policy_changed",
      knob: "primary_delete_within_days",
      previousDays: 30,
      days: 7,
      previousPolicyVersion: 1,
      resultingPolicyVersion: 2,
    });
  });

  it("denies a member without tenant:manage capability", async () => {
    const { client } = createDb();
    await seedTenant(client);
    const researcher = createLocalTenantRetentionService(client, {
      actor: { authIdentityId: RESEARCHER_ID, membershipId: RESEARCHER_MEMBERSHIP_ID },
    });
    await expect(researcher.requestRetentionChange(change()))
      .rejects.toMatchObject({ code: "RETENTION_MANAGER_UNAUTHORIZED" });
  });

  it("rejects a stale expectedPolicyVersion without writing", async () => {
    const { database, client } = createDb();
    await seedTenant(client);
    await expect(ownerService(client).requestRetentionChange(change({ expectedPolicyVersion: 7 })))
      .rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number },
    ).toMatchObject({ count: 0 });
  });

  it("no-ops a same-value change without bumping the version", async () => {
    const { database, client } = createDb();
    await seedTenant(client);
    const service = ownerService(client);
    await service.requestRetentionChange(change());
    const again = await service.requestRetentionChange(
      change({ days: 7, expectedPolicyVersion: 2 }),
    );
    expect(again).toMatchObject({ status: "unchanged", resultingPolicyVersion: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number },
    ).toMatchObject({ count: 1 });
  });

  it("rejects days outside the knob's schema bound", async () => {
    const { database, client } = createDb();
    await seedTenant(client);
    const service = ownerService(client);
    // primary_delete_within_days is bounded 1–30; export_retention_days 1–7.
    await expect(service.requestRetentionChange(change({ days: 0 })))
      .rejects.toMatchObject({ code: "INVALID_DAYS_VALUE" });
    await expect(service.requestRetentionChange(change({ days: 31 })))
      .rejects.toMatchObject({ code: "INVALID_DAYS_VALUE" });
    await expect(
      service.requestRetentionChange(change({ knob: "export_retention_days", days: 8 })),
    ).rejects.toMatchObject({ code: "INVALID_DAYS_VALUE" });
    await expect(service.requestRetentionChange(change({ days: 1.5 })))
      .rejects.toMatchObject({ code: "INVALID_DAYS_VALUE" });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number },
    ).toMatchObject({ count: 0 });
  });

  it("rejects fields that are not retention knobs", async () => {
    const { client } = createDb();
    await seedTenant(client);
    // tombstone_retention_years is literal-fixed; review gates and enablement
    // fields belong to other surfaces — none pass the knob vocabulary.
    await expect(
      ownerService(client).requestRetentionChange(
        change({ knob: "tombstone_retention_years", days: 7 }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_KNOB" });
    await expect(
      ownerService(client).requestRetentionChange(
        change({ knob: "copy_export_enabled", days: 1 }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_KNOB" });
  });

  it("rolls the whole commit back when the audit append fails", async () => {
    const { database, client } = createDb();
    await seedTenant(client);
    // Force the audit insert to fail inside the executor's transaction by
    // blocking audit_logs writes; the policy CAS must roll back with it.
    database.exec(
      `CREATE TRIGGER block_audit_insert BEFORE INSERT ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;`,
    );
    await expect(ownerService(client).requestRetentionChange(change()))
      .rejects.toMatchObject({ code: "POLICY_CHANGE_EXECUTION_FAILED" });
    const policy = database.prepare(
      "SELECT version, primary_delete_within_days FROM tenant_policies WHERE tenant_id = ?",
    ).get(TENANT_ID) as { version: number; primary_delete_within_days: number };
    expect(policy).toMatchObject({ version: 1, primary_delete_within_days: 30 });
  });
});
