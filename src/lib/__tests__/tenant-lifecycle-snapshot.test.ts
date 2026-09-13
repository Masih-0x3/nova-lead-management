import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import type { DbClient } from "@/lib/db";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { loadLatestDataLifecycleJobs, loadTenantLifecycleSnapshot } from "@/lib/tenancy/lifecycle-snapshot";
import { createLocalTenantLifecycleOperationsService } from "@/lib/tenancy/local-lifecycle-operations";

vi.mock("server-only", () => ({}));

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-000000000009";
const POLICY_ID = "20000000-0000-4000-8000-000000000001";
const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const ADMIN_ID = "50000000-0000-4000-8000-000000000003";
const OWNER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000002";
const OWNER_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const ADMIN_BINDING_ID = "40000000-0000-4000-8000-000000000002";

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

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

async function seed(client: DbClient, tenantStatus: "provisioning" | "active" | "archived" = "active") {
  const repository = createTenantQueryRepository(client);
  await repository.createTenant({ id: TENANT_ID, slug: "ops-tenant", name: "Ops Tenant", status: tenantStatus });
  await repository.createTenantPolicy(TENANT_ID, { id: POLICY_ID });
  await repository.createMembership(TENANT_ID, { id: OWNER_MEMBERSHIP_ID, authIdentityId: OWNER_ID, workspaceId: null, status: "active" });
  await repository.createRoleBinding(TENANT_ID, { id: OWNER_BINDING_ID, membershipId: OWNER_MEMBERSHIP_ID, role: "owner", reasonCode: "initial_provisioning" });
  await repository.createMembership(TENANT_ID, { id: ADMIN_MEMBERSHIP_ID, authIdentityId: ADMIN_ID, workspaceId: null, status: "active" });
  await repository.createRoleBinding(TENANT_ID, { id: ADMIN_BINDING_ID, membershipId: ADMIN_MEMBERSHIP_ID, role: "admin", reasonCode: "invitation" });
}

function memberActor() {
  return { authIdentityId: OWNER_ID, layer: "member" as const, membershipId: OWNER_MEMBERSHIP_ID };
}

describe("loadTenantLifecycleSnapshot", () => {
  it("returns null for a missing tenant", async () => {
    const { client } = createDb();
    expect(await loadTenantLifecycleSnapshot(client, TENANT_ID)).toBeNull();
  });

  it("reports a missing audit receipt for a tenant with no lifecycle events", async () => {
    const { client } = createDb();
    await seed(client);
    const snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tenant.id).toBe(TENANT_ID);
    expect(snapshot!.tenant.status).toBe("active");
    expect(snapshot!.workspace).toBeNull();
    expect(snapshot!.lifecycleVersion).toBe(1);
    expect(snapshot!.audit).toEqual({ state: "missing" });
    expect(snapshot!.freezeHandoffStatus).toBe("not_started");
    expect(snapshot!.accessRevocationHandoffStatus).toBe("not_started");
    expect(snapshot!.changedAt).toBe(snapshot!.tenant.updatedAt);
  });

  it("binds the provisioned receipt and synthesizes the owner-acceptance rationale", async () => {
    const { client } = createDb();
    await seed(client);
    await client.prepare(
      `INSERT INTO audit_logs
        (id, action, entity_type, entity_id, metadata, scope_kind, tenant_id, workspace_id,
         correlation_id, actor_auth_identity_id, actor_membership_id, actor_launch_role,
         actor_role_binding_id, actor_layer)
       VALUES (?, 'tenant.provisioned', 'tenant_invitation', ?, ?, 'tenant', ?, NULL, ?, ?, ?, 'owner', ?, 'member')`,
    ).run(
      randomUUID(), randomUUID(),
      JSON.stringify({
        eventId: "evt-provisioned-1",
        eventType: "tenant.provisioned",
        tenantId: TENANT_ID,
        workspaceId: null,
        actorIdentityId: OWNER_ID,
        actorLayer: "member",
        resultCode: "INVITATION_ACCEPTED",
      }),
      TENANT_ID, randomUUID(), OWNER_ID, OWNER_MEMBERSHIP_ID, OWNER_BINDING_ID,
    );
    const snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot!.lifecycleVersion).toBe(1);
    expect(snapshot!.audit.state).toBe("recorded");
    if (snapshot!.audit.state === "recorded") {
      expect(snapshot!.audit.eventId).toBe("evt-provisioned-1");
      expect(snapshot!.audit.tenantId).toBe(TENANT_ID);
      expect(snapshot!.audit.workspaceId).toBeNull();
      expect(snapshot!.audit.fromStatus).toBe("provisioning");
      expect(snapshot!.audit.toStatus).toBe("active");
      expect(snapshot!.audit.lifecycleVersion).toBe(1);
    }
    expect(snapshot!.reasonCode).toBe("owner_acceptance");
  });

  it("records suspend and resume transitions with version, rationale, and receipts", async () => {
    const { client } = createDb();
    await seed(client);
    const service = createLocalTenantLifecycleOperationsService(client);

    const suspended = await service.suspend({
      tenantId: TENANT_ID,
      actor: memberActor(),
      expectedCurrentState: "active",
      reasonCode: "operations.freeze",
      reason: "Freeze while a deletion request is reviewed.",
      correlationId: randomUUID(),
    });
    expect(suspended.code).toBe("OK_SUSPENDED");

    let snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot!.tenant.status).toBe("suspended");
    expect(snapshot!.lifecycleVersion).toBe(1);
    expect(snapshot!.audit.state).toBe("recorded");
    if (snapshot!.audit.state === "recorded") {
      expect(snapshot!.audit.fromStatus).toBe("active");
      expect(snapshot!.audit.toStatus).toBe("suspended");
      expect(snapshot!.audit.actorId).toBe(OWNER_ID);
      expect(snapshot!.audit.workspaceId).toBeNull();
    }
    expect(snapshot!.reasonCode).toBe("operations.freeze");
    expect(snapshot!.reason).toBe("Freeze while a deletion request is reviewed.");

    const resumed = await service.resume({
      tenantId: TENANT_ID,
      actor: memberActor(),
      expectedCurrentState: "suspended",
      reasonCode: "operations.resume",
      reason: "Review cleared.",
      correlationId: randomUUID(),
    });
    expect(resumed.code).toBe("OK_RESUMED");

    snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot!.tenant.status).toBe("active");
    expect(snapshot!.lifecycleVersion).toBe(2);
    if (snapshot!.audit.state === "recorded") {
      expect(snapshot!.audit.fromStatus).toBe("suspended");
      expect(snapshot!.audit.toStatus).toBe("active");
      expect(snapshot!.audit.lifecycleVersion).toBe(2);
    }
    expect(snapshot!.reasonCode).toBe("operations.resume");
  });

  it("marks the audit pending when the latest transition no longer produces the current status", async () => {
    const { client } = createDb();
    await seed(client);
    const service = createLocalTenantLifecycleOperationsService(client);
    await service.suspend({
      tenantId: TENANT_ID,
      actor: memberActor(),
      expectedCurrentState: "active",
      reasonCode: "operations.freeze",
      reason: "Freeze.",
      correlationId: randomUUID(),
    });
    // A state drift the audit ledger does not describe — the loader must not fabricate a receipt.
    await client.prepare("UPDATE tenants SET status = 'archived' WHERE id = ?").run(TENANT_ID);
    const snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot!.tenant.status).toBe("archived");
    expect(snapshot!.audit.state).toBe("pending");
    expect(snapshot!.lifecycleVersion).toBe(1);
  });

  it("surfaces the latest deletion-job handoff receipts", async () => {
    const { client, database } = createDb();
    await seed(client, "archived");
    const service = createLocalTenantLifecycleOperationsService(client);
    const requested = await service.requestDeletion({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: OWNER_MEMBERSHIP_ID },
      idempotencyKey: "delete-handoff-1",
      correlationId: randomUUID(),
    });
    expect(requested.code).toBe("OK_DELETION_REQUESTED");
    const verified = await service.verifyDeletion({
      tenantId: TENANT_ID,
      jobId: requested.job.id,
      verifier: { authIdentityId: ADMIN_ID, membershipId: ADMIN_MEMBERSHIP_ID },
      correlationId: randomUUID(),
    });
    expect(verified.code).toBe("OK_DELETION_VERIFIED");
    // Handoffs advance through their schema-enforced transitions once the job
    // is past 'requested'.
    database.prepare(
      "UPDATE tenant_deletion_jobs SET freeze_handoff_status = 'requested', access_revocation_handoff_status = 'requested' WHERE id = ?",
    ).run(requested.job.id);
    database.prepare(
      "UPDATE tenant_deletion_jobs SET access_revocation_handoff_status = 'acknowledged' WHERE id = ?",
    ).run(requested.job.id);
    const snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot!.freezeHandoffStatus).toBe("requested");
    expect(snapshot!.accessRevocationHandoffStatus).toBe("acknowledged");
    // The deletion request also moved the tenant status — the receipt binds it.
    expect(snapshot!.tenant.status).toBe("deletion_pending");
    if (snapshot!.audit.state === "recorded") {
      expect(snapshot!.audit.toStatus).toBe("deletion_pending");
      expect(snapshot!.audit.fromStatus).toBe("archived");
    }
  });

  it("drops rows whose metadata binds a foreign tenant even when entity_id matches", async () => {
    const { client } = createDb();
    await seed(client);
    await client.prepare(
      `INSERT INTO tenants (id, slug, name, status, locale, timezone, created_at, updated_at)
       VALUES (?, 'other', 'Other', 'active', 'en-US', 'UTC', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(OTHER_TENANT_ID);
    // Platform-scope row: entity_id points at our tenant but the event metadata
    // binds a foreign tenant — the loader must not count it.
    await client.prepare(
      `INSERT INTO audit_logs
        (id, action, entity_type, entity_id, metadata, scope_kind, tenant_id, workspace_id,
         correlation_id, actor_auth_identity_id, actor_layer)
       VALUES (?, 'tenant.suspended', 'tenant', ?, ?, 'platform', NULL, NULL, ?, ?, 'worker')`,
    ).run(
      randomUUID(), TENANT_ID,
      JSON.stringify({
        eventId: randomUUID(), eventType: "tenant.suspended", tenantId: OTHER_TENANT_ID,
        workspaceId: null, actorIdentityId: OWNER_ID, actorLayer: "worker",
        occurredAt: "2026-08-01T00:00:00.000Z",
        tenantFromStatus: "active", tenantToStatus: "suspended",
        reasonCode: "x.y", reason: "foreign",
      }),
      randomUUID(), OWNER_ID,
    );
    const snapshot = await loadTenantLifecycleSnapshot(client, TENANT_ID);
    expect(snapshot!.lifecycleVersion).toBe(1);
    expect(snapshot!.audit.state).toBe("missing");
  });
});

describe("loadLatestDataLifecycleJobs", () => {
  it("returns null jobs when no export or deletion ledger rows exist", async () => {
    const { client } = createDb();
    await seed(client);
    const service = createLocalTenantLifecycleOperationsService(client);
    const jobs = await loadLatestDataLifecycleJobs(client, TENANT_ID, service);
    expect(jobs).toEqual({ exportJob: null, deletionJob: null });
  });

  it("loads the latest export job and a pre-run deletion job with empty checkpoints", async () => {
    const { client } = createDb();
    await seed(client);
    const service = createLocalTenantLifecycleOperationsService(client);

    const exported = await service.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: OWNER_MEMBERSHIP_ID },
      idempotencyKey: "export-view-1",
      correlationId: randomUUID(),
    });
    expect(exported.code).toBe("OK_EXPORT_REQUESTED");

    // Archive first — deletion requests are gated on the archived status.
    await service.archive({
      tenantId: TENANT_ID,
      actor: memberActor(),
      expectedCurrentState: "active",
      reasonCode: "operations.archive",
      reason: "Retire for deletion review.",
      correlationId: randomUUID(),
    });
    const requested = await service.requestDeletion({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: OWNER_MEMBERSHIP_ID },
      idempotencyKey: "delete-view-1",
      correlationId: randomUUID(),
    });
    expect(requested.code).toBe("OK_DELETION_REQUESTED");

    const jobs = await loadLatestDataLifecycleJobs(client, TENANT_ID, service);
    expect(jobs.exportJob).not.toBeNull();
    expect(jobs.exportJob!.id).toBe(exported.job.id);
    expect(jobs.exportJob!.status).toBe("requested");
    expect(jobs.deletionJob).not.toBeNull();
    expect(jobs.deletionJob!.id).toBe(requested.job.id);
    expect(jobs.deletionJob!.status).toBe("requested");
    // Checkpoints are only materialized once the approved run starts.
    expect(jobs.deletionJob!.checkpoints).toEqual([]);
    expect(jobs.deletionJob!.requestedByAuthIdentityId).toBe(OWNER_ID);
    expect(jobs.deletionJob!.verifiedByAuthIdentityId).toBeNull();
    expect(jobs.deletionJob!.approvedByAuthIdentityId).toBeNull();
  });

  it("binds verifier and approver identity fields for the two-person gate", async () => {
    const { client } = createDb();
    await seed(client, "archived");
    const service = createLocalTenantLifecycleOperationsService(client);
    const requested = await service.requestDeletion({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: OWNER_MEMBERSHIP_ID },
      idempotencyKey: "delete-view-2",
      correlationId: randomUUID(),
    });
    await service.verifyDeletion({
      tenantId: TENANT_ID,
      jobId: requested.job.id,
      verifier: { authIdentityId: ADMIN_ID, membershipId: ADMIN_MEMBERSHIP_ID },
      correlationId: randomUUID(),
    });
    const jobs = await loadLatestDataLifecycleJobs(client, TENANT_ID, service);
    expect(jobs.deletionJob!.status).toBe("verified");
    expect(jobs.deletionJob!.requestedByAuthIdentityId).toBe(OWNER_ID);
    expect(jobs.deletionJob!.verifiedByAuthIdentityId).toBe(ADMIN_ID);
    expect(jobs.deletionJob!.approvedByAuthIdentityId).toBeNull();
  });
});
