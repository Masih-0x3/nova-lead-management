import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import type { DbClient } from "@/lib/db";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import {
  createLocalTenantLifecycleOperationsService,
} from "@/lib/tenancy/local-lifecycle-operations";
import { TENANT_INVITATION_LOCAL_DDL } from "@/lib/tenancy/tenant-invitation-schema";

const OPERATOR_ID = "50000000-0000-4000-8000-000000000001";
const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const VERIFIER_ID = "50000000-0000-4000-8000-000000000005";
const APPROVER_ID = "50000000-0000-4000-8000-000000000006";
const RESEARCHER_ID = "50000000-0000-4000-8000-000000000007";
const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const POLICY_ID = "20000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const VERIFIER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000002";
const APPROVER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000003";
const RESEARCHER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000004";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const VERIFIER_BINDING_ID = "40000000-0000-4000-8000-000000000002";
const APPROVER_BINDING_ID = "40000000-0000-4000-8000-000000000003";
const RESEARCHER_BINDING_ID = "40000000-0000-4000-8000-000000000004";

vi.mock("server-only", () => ({}));

const openDatabases: Database.Database[] = [];

function createDb(): { database: Database.Database; client: DbClient } {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  database.exec(TENANT_INVITATION_LOCAL_DDL);
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

async function seedTenant(client: DbClient, status: "active" | "suspended" | "archived") {
  const repository = createTenantQueryRepository(client);
  await repository.createTenant({
    id: TENANT_ID, slug: "lifecycle-tenant", name: "Lifecycle Tenant", status,
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
    id: VERIFIER_MEMBERSHIP_ID, authIdentityId: VERIFIER_ID, workspaceId: null, status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: VERIFIER_BINDING_ID, membershipId: VERIFIER_MEMBERSHIP_ID, role: "owner", reasonCode: "invitation",
  });
  await repository.createMembership(TENANT_ID, {
    id: APPROVER_MEMBERSHIP_ID, authIdentityId: APPROVER_ID, workspaceId: null, status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: APPROVER_BINDING_ID, membershipId: APPROVER_MEMBERSHIP_ID, role: "owner", reasonCode: "invitation",
  });
  await repository.createMembership(TENANT_ID, {
    id: RESEARCHER_MEMBERSHIP_ID, authIdentityId: RESEARCHER_ID, workspaceId: null, status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: RESEARCHER_BINDING_ID, membershipId: RESEARCHER_MEMBERSHIP_ID, role: "researcher", reasonCode: "invitation",
  });
  return repository;
}

function auditRows(database: Database.Database) {
  return database
    .prepare("SELECT action, scope_kind, actor_layer, tenant_id FROM audit_logs ORDER BY created_at, id")
    .all() as Record<string, unknown>[];
}

function auditActions(database: Database.Database): string[] {
  return auditRows(database).map((row) => row.action as string).sort();
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

function service(client: DbClient, options: { clock?: () => Date } = {}) {
  return createLocalTenantLifecycleOperationsService(client, options);
}

/** Approval schedules deletion `primaryDeleteWithinDays` (30d) out; run it past that point. */
const PAST_SCHEDULE = () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

const operatorActor = { authIdentityId: OPERATOR_ID, layer: "system" as const };

describe("suspend / resume / archive", () => {
  it("suspends an active tenant and resumes it as the exercised rollback", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);

    const suspended = await ops.suspend({
      tenantId: TENANT_ID, actor: operatorActor, expectedCurrentState: "active",
      reasonCode: "billing.delinquency", reason: "Invoice unpaid", correlationId: "corr-suspend-1",
    });
    expect(suspended.tenant.status).toBe("suspended");

    const resumed = await ops.resume({
      tenantId: TENANT_ID, actor: operatorActor, expectedCurrentState: "suspended",
      reasonCode: "billing.delinquency", reason: "Invoice paid", correlationId: "corr-resume-1",
    });
    expect(resumed.tenant.status).toBe("active");

    expect(auditActions(database)).toEqual(["tenant.resumed", "tenant.suspended"]);
    expect(auditRows(database).every((row) => row.scope_kind === "platform")).toBe(true);
  });

  it("rejects a stale expected state without enumerating", async () => {
    const { client } = createDb();
    await seedTenant(client, "active");
    await expect(service(client).suspend({
      tenantId: TENANT_ID, actor: operatorActor, expectedCurrentState: "suspended",
      reasonCode: "ops.suspend", reason: "Suspend", correlationId: "corr-stale-1",
    })).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
  });
});

describe("tenant export", () => {
  it("runs request → snapshot → redact → artifact → released with committed artifact facts", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);

    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-1", correlationId: "corr-export-1",
    });
    expect(requested.job.status).toBe("requested");
    expect(requested.replayed).toBe(false);

    const ran = await ops.runExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-export-run-1",
    });

    expect(ran.job.status).toBe("released");
    expect(ran.job.artifactStorageRef).toBe(`tenants/${TENANT_ID}/exports/${requested.job.id}/export.json`);
    expect(ran.job.artifactChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ran.job.includedCount).toBeGreaterThan(0);
    expect(ran.job.expiresAt).not.toBeNull();
    expect(ran.job.snapshotAt).not.toBeNull();

    expect(auditActions(database)).toEqual(["tenant.export.released", "tenant.export.requested"]);
  });

  it("replays the same idempotency key and rejects conflicting input", async () => {
    const { client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);

    const first = await ops.requestExport({
      tenantId: TENANT_ID, workspaceId: WORKSPACE_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-replay", correlationId: "corr-export-2",
    });
    const replay = await ops.requestExport({
      tenantId: TENANT_ID, workspaceId: WORKSPACE_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-replay", correlationId: "corr-export-2",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.job.id).toBe(first.job.id);

    await expect(ops.requestExport({
      tenantId: TENANT_ID, workspaceId: null,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-replay", correlationId: "corr-export-3",
    })).rejects.toMatchObject({ code: "BLOCKED_REPLAY_CONFLICT" });
  });

  it("cancels a requested export and records the tombstone error", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-cancel", correlationId: "corr-export-4",
    });
    const canceled = await ops.cancelExport({
      tenantId: TENANT_ID, jobId: requested.job.id, actor: operatorActor, correlationId: "corr-export-5",
    });
    expect(canceled.job.status).toBe("canceled");
    expect(canceled.job.errorCode).toBe("EXPORT_CANCELED");
    expect(auditRows(database).map((row) => row.action)).toContain("tenant.export.canceled");
  });

  it("cancels as a member actor with a bound tenant-scope audit row", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-member-cancel", correlationId: "corr-export-mc",
    });
    const canceled = await ops.cancelExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      actor: { authIdentityId: OWNER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
      correlationId: "corr-export-mc-2",
    });
    expect(canceled.job.status).toBe("canceled");
    const row = auditRows(database).find((entry) => entry.action === "tenant.export.canceled");
    expect(row).toMatchObject({
      scope_kind: "tenant",
      tenant_id: TENANT_ID,
      actor_layer: "member",
    });
  });

  it("rejects a member cancel from a non-admin member", async () => {
    const { client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-member-denied", correlationId: "corr-export-md",
    });
    await expect(ops.cancelExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      actor: { authIdentityId: RESEARCHER_ID, layer: "member", membershipId: RESEARCHER_MEMBERSHIP_ID },
      correlationId: "corr-export-md-2",
    })).rejects.toMatchObject({ code: "BLOCKED_ACTOR_SCOPE" });
  });

  it("requeues a failed export inside its retry budget and completes on retry", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-retry", correlationId: "corr-export-r1",
    });
    const failing = createLocalTenantLifecycleOperationsService(client, {
      exportRunner: { execute: async () => { throw new Error("storage unavailable"); }, purge: async () => {} },
    });
    await expect(failing.runExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-export-r2",
    })).rejects.toMatchObject({ code: "FAILED_INTERNAL" });
    const failedJob = await failing.getExportJob(TENANT_ID, requested.job.id);
    expect(failedJob.status).toBe("failed");
    expect(failedJob.retryCount).toBe(0);

    const requeued = await ops.requeueExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      actor: { authIdentityId: OWNER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
      correlationId: "corr-export-r3",
    });
    expect(requeued.job.status).toBe("retry_wait");
    expect(requeued.job.retryCount).toBe(1);
    expect(requeued.job.nextRetryAt).not.toBeNull();

    const ran = await ops.runExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-export-r4",
    });
    expect(ran.job.status).toBe("released");
    expect(ran.job.nextRetryAt).toBeNull();
    expect(auditActions(database)).toEqual([
      "tenant.export.failed", "tenant.export.released", "tenant.export.requested", "tenant.export.requeued",
    ]);
  });

  it("rejects requeue for a job that is not failed", async () => {
    const { client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-requeue-conflict", correlationId: "corr-export-rc",
    });
    await expect(ops.requeueExport({
      tenantId: TENANT_ID, jobId: requested.job.id, actor: operatorActor, correlationId: "corr-export-rc2",
    })).rejects.toMatchObject({ code: "BLOCKED_STATE_CONFLICT" });
  });

  it("rejects a requester without owner/admin role and never enumerates other tenants", async () => {
    const { client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    await expect(ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: RESEARCHER_ID, membershipId: RESEARCHER_MEMBERSHIP_ID },
      idempotencyKey: "export-denied", correlationId: "corr-export-6",
    })).rejects.toMatchObject({ code: "BLOCKED_ACTOR_SCOPE" });
    await expect(ops.requestExport({
      tenantId: "00000000-0000-4000-8000-000000000099",
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-foreign", correlationId: "corr-export-7",
    })).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
  });
});

describe("tenant deletion", () => {
  async function requestDeletion(ops: ReturnType<typeof service>, idempotencyKey = "delete-1") {
    return ops.requestDeletion({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey, correlationId: `corr-${idempotencyKey}`,
    });
  }

  it("requires an archived tenant and never enumerates", async () => {
    const { client } = createDb();
    await seedTenant(client, "active");
    await expect(requestDeletion(service(client))).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
  });

  it("drives request → verify → approve → run → completed with tombstone and deleted tenant", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);

    const requested = await requestDeletion(ops);
    expect(requested.job.status).toBe("requested");
    expect(requested.replayed).toBe(false);
    expect((await createTenantQueryRepository(client).getTenant(TENANT_ID))!.status).toBe("deletion_pending");

    const verified = await ops.verifyDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      verifier: { authIdentityId: VERIFIER_ID, membershipId: VERIFIER_MEMBERSHIP_ID },
      correlationId: "corr-verify-1",
    });
    expect(verified.job.status).toBe("verified");

    const approved = await ops.approveDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      approver: { authIdentityId: APPROVER_ID, membershipId: APPROVER_MEMBERSHIP_ID },
      correlationId: "corr-approve-1",
    });
    expect(approved.job.status).toBe("scheduled");

    const ran = await service(client, { clock: PAST_SCHEDULE }).runDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-run-1",
    });
    expect(ran.job.status).toBe("completed");
    expect(ran.job.primaryDeletedAt).not.toBeNull();
    expect(ran.job.backupAgingAt).not.toBeNull();
    expect(ran.job.completedAt).not.toBeNull();

    expect((await createTenantQueryRepository(client).getTenant(TENANT_ID))!.status).toBe("deleted");

    const checkpoints = await ops.listDeletionCheckpoints(TENANT_ID, requested.job.id);
    expect(checkpoints).toHaveLength(10);
    expect(checkpoints.every((checkpoint) => checkpoint.status === "complete")).toBe(true);

    const tombstone = database
      .prepare("SELECT * FROM tenant_deletion_tombstones WHERE job_id = ?")
      .get(requested.job.id) as Record<string, unknown> | undefined;
    expect(tombstone).toBeDefined();
    expect(tombstone!.tenant_identity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(String(tombstone!.retention_until) > ran.job.completedAt!).toBe(true);

    expect(auditActions(database)).toEqual([
      "tenant.deletion.completed",
      "tenant.deletion.primary_deleted",
      "tenant.deletion.requested",
      "tenant.deletion.running",
      "tenant.deletion.scheduled",
      "tenant.deletion.verified",
    ]);
  });

  it("rolls back deletion_pending → archived on cancel before running", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);

    const requested = await requestDeletion(ops, "delete-cancel");
    const verified = await ops.verifyDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      verifier: { authIdentityId: VERIFIER_ID, membershipId: VERIFIER_MEMBERSHIP_ID },
      correlationId: "corr-verify-2",
    });
    expect(verified.job.status).toBe("verified");

    const canceled = await ops.cancelDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id, actor: operatorActor, correlationId: "corr-cancel-1",
    });
    expect(canceled.job.status).toBe("canceled");
    expect(canceled.job.canceledAt).not.toBeNull();
    expect((await createTenantQueryRepository(client).getTenant(TENANT_ID))!.status).toBe("archived");
    expect(auditRows(database).map((row) => row.action)).toContain("tenant.deletion.canceled");
  });

  it("rolls back deletion_pending → archived on a member cancel with a bound audit row", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);

    const requested = await requestDeletion(ops, "delete-member-cancel");
    const canceled = await ops.cancelDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      actor: { authIdentityId: OWNER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
      correlationId: "corr-cancel-member",
    });
    expect(canceled.job.status).toBe("canceled");
    expect((await createTenantQueryRepository(client).getTenant(TENANT_ID))!.status).toBe("archived");
    const row = auditRows(database).find((entry) => entry.action === "tenant.deletion.canceled");
    expect(row).toMatchObject({ scope_kind: "tenant", tenant_id: TENANT_ID, actor_layer: "member" });
  });

  it("requeues a failed deletion as a member and resumes the run to completion", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);
    const requested = await requestDeletion(ops, "delete-retry");
    await ops.verifyDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      verifier: { authIdentityId: VERIFIER_ID, membershipId: VERIFIER_MEMBERSHIP_ID },
      correlationId: "corr-verify-retry",
    });
    await ops.approveDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      approver: { authIdentityId: APPROVER_ID, membershipId: APPROVER_MEMBERSHIP_ID },
      correlationId: "corr-approve-retry",
    });

    let failOnce = true;
    const flaky = createLocalTenantLifecycleOperationsService(client, {
      clock: PAST_SCHEDULE,
      deletionStore: {
        execute: async ({ checkpoint }) => {
          if (failOnce && checkpoint.storeClass === "queues_leases") {
            failOnce = false;
            throw new Error("provider unavailable");
          }
          return { receiptHash: "b".repeat(64), observedCount: 0, expectedCount: 0 };
        },
      },
    });
    await expect(flaky.runDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-run-retry-1",
    })).rejects.toMatchObject({ code: "FAILED_INTERNAL" });
    const failedJob = await flaky.getDeletionJob(TENANT_ID, requested.job.id);
    expect(failedJob.status).toBe("failed");

    const requeued = await flaky.requeueDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: { authIdentityId: OWNER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
      correlationId: "corr-requeue-1",
    });
    expect(requeued.job.status).toBe("retry_wait");
    expect(requeued.job.retryCount).toBe(1);
    expect(auditRows(database).map((row) => row.action)).toContain("tenant.deletion.requeued");

    const ran = await flaky.runDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-run-retry-2",
    });
    expect(ran.job.status).toBe("completed");
    expect(ran.job.nextRetryAt).toBeNull();
    expect(ran.job.errorCode).toBeNull();
    expect((await createTenantQueryRepository(client).getTenant(TENANT_ID))!.status).toBe("deleted");
  });

  it("enforces the two-person rule: requester cannot verify, verifier cannot approve", async () => {
    const { client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);
    const requested = await requestDeletion(ops, "delete-2p");

    await expect(ops.verifyDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      verifier: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      correlationId: "corr-verify-self",
    })).rejects.toMatchObject({ code: "BLOCKED_APPROVAL_INDEPENDENCE" });

    await ops.verifyDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      verifier: { authIdentityId: VERIFIER_ID, membershipId: VERIFIER_MEMBERSHIP_ID },
      correlationId: "corr-verify-3",
    });
    await expect(ops.approveDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      approver: { authIdentityId: VERIFIER_ID, membershipId: VERIFIER_MEMBERSHIP_ID },
      correlationId: "corr-approve-self",
    })).rejects.toMatchObject({ code: "BLOCKED_APPROVAL_INDEPENDENCE" });
    await expect(ops.approveDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      approver: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      correlationId: "corr-approve-req",
    })).rejects.toMatchObject({ code: "BLOCKED_APPROVAL_INDEPENDENCE" });
  });

  it("rejects deletion requests by non-owner members and foreign tenants identically", async () => {
    const { client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);
    await expect(ops.requestDeletion({
      tenantId: TENANT_ID,
      requester: { authIdentityId: RESEARCHER_ID, membershipId: RESEARCHER_MEMBERSHIP_ID },
      idempotencyKey: "delete-nonowner", correlationId: "corr-d-1",
    })).rejects.toMatchObject({ code: "BLOCKED_ACTOR_SCOPE" });
    await expect(ops.requestDeletion({
      tenantId: "00000000-0000-4000-8000-000000000099",
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "delete-foreign", correlationId: "corr-d-2",
    })).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
  });

  it("marks a failed run durably and preserves the deletion_pending tenant", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "archived");
    const ops = service(client);
    const requested = await requestDeletion(ops, "delete-fail");
    await ops.verifyDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      verifier: { authIdentityId: VERIFIER_ID, membershipId: VERIFIER_MEMBERSHIP_ID },
      correlationId: "corr-verify-4",
    });
    await ops.approveDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      approver: { authIdentityId: APPROVER_ID, membershipId: APPROVER_MEMBERSHIP_ID },
      correlationId: "corr-approve-4",
    });
    const failingOps = createLocalTenantLifecycleOperationsService(client, {
      clock: PAST_SCHEDULE,
      deletionStore: {
        execute: async ({ checkpoint }) => {
          if (checkpoint.storeClass === "queues_leases") throw new Error("provider unavailable");
          return { receiptHash: "a".repeat(64), observedCount: 0, expectedCount: 0 };
        },
      },
    });
    await expect(failingOps.runDeletion({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-run-fail",
    })).rejects.toMatchObject({ code: "FAILED_INTERNAL" });

    const job = await failingOps.getDeletionJob(TENANT_ID, requested.job.id);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("DELETE_INTERNAL");
    expect((await createTenantQueryRepository(client).getTenant(TENANT_ID))!.status).toBe("deletion_pending");
    expect(auditRows(database).map((row) => row.action)).toContain("tenant.deletion.failed");
  });
});

describe("sweepExportRetention", () => {
  const SHORT_LIVED = {
    // Schema requires artifact_created_at >= snapshot_at >= job.created_at —
    // the artifact facts are real-now; only the committed expiry is shortened
    // so a 100ms wait makes the artifact legitimately past-due.
    execute: async (input: { job: { id: string } }) => {
      const at = new Date().toISOString();
      return {
        snapshotAt: at,
        artifactStorageRef: `tenants/${TENANT_ID}/exports/${input.job.id}/export.json`,
        checksumSha256: "a".repeat(64),
        includedCount: 1, excludedCount: 0, redactedCount: 0,
        artifactCreatedAt: at,
        expiresAt: new Date(Date.now() + 50).toISOString(),
      };
    },
    purge: vi.fn(async () => {}),
  };

  const waitPastExpiry = () => new Promise((resolve) => setTimeout(resolve, 100));

  async function requestAndRelease(ops: ReturnType<typeof service>, client: DbClient, runner = SHORT_LIVED) {
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: `export-sweep.${Math.random()}`,
      correlationId: "corr-sweep-req",
    });
    await createLocalTenantLifecycleOperationsService(client, { exportRunner: runner }).runExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-sweep-run",
    });
    return requested.job.id;
  }

  it("advances released→expired then expired→deleted across passes with audit", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const jobId = await requestAndRelease(ops, client);
    await waitPastExpiry();

    const first = await ops.sweepExportRetention({
      tenantId: TENANT_ID, executor: operatorActor, correlationId: "corr-sweep-1",
    });
    expect(first.code).toBe("OK_EXPORT_SWEPT");
    expect(first.expiredJobIds).toEqual([jobId]);
    expect(first.deletedJobIds).toEqual([]);
    expect((await ops.getExportJob(TENANT_ID, jobId)).status).toBe("expired");
    expect(SHORT_LIVED.purge).not.toHaveBeenCalled();

    // The sweeping service's own runner port owns the bytes — the purge call
    // lands on whatever adapter the sweeper holds, not the producer's.
    const sweeping = createLocalTenantLifecycleOperationsService(client, { exportRunner: SHORT_LIVED });
    const second = await sweeping.sweepExportRetention({
      tenantId: TENANT_ID, executor: operatorActor, correlationId: "corr-sweep-2",
    });
    expect(second.expiredJobIds).toEqual([]);
    expect(second.deletedJobIds).toEqual([jobId]);
    expect((await ops.getExportJob(TENANT_ID, jobId)).status).toBe("deleted");
    expect(SHORT_LIVED.purge).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }));

    const actions = auditActions(database);
    expect(actions).toContain("tenant.export.expired");
    expect(actions).toContain("tenant.export.deleted");
  });

  it("leaves an in-window released artifact untouched", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const requested = await ops.requestExport({
      tenantId: TENANT_ID,
      requester: { authIdentityId: OWNER_ID, membershipId: MEMBERSHIP_ID },
      idempotencyKey: "export-sweep-live", correlationId: "corr-sweep-live",
    });
    await ops.runExport({
      tenantId: TENANT_ID, jobId: requested.job.id,
      executor: operatorActor, correlationId: "corr-sweep-live-run",
    });

    const result = await ops.sweepExportRetention({
      tenantId: TENANT_ID, executor: operatorActor, correlationId: "corr-sweep-live-sweep",
    });
    expect(result.code).toBe("OK_EXPORT_SWEPT");
    expect(result.expiredJobIds).toEqual([]);
    expect(result.deletedJobIds).toEqual([]);
    expect((await ops.getExportJob(TENANT_ID, requested.job.id)).status).toBe("released");
    expect(auditActions(database)).not.toContain("tenant.export.expired");
  });

  it("rolls the whole pass back when the byte purge fails", async () => {
    const { database, client } = createDb();
    await seedTenant(client, "active");
    const ops = service(client);
    const jobId = await requestAndRelease(ops, client);
    await waitPastExpiry();
    await ops.sweepExportRetention({ tenantId: TENANT_ID, executor: operatorActor, correlationId: "corr-sweep-3" });

    const broken = createLocalTenantLifecycleOperationsService(client, {
      exportRunner: { execute: SHORT_LIVED.execute, purge: async () => { throw new Error("storage purge failed"); } },
    });
    await expect(broken.sweepExportRetention({
      tenantId: TENANT_ID, executor: operatorActor, correlationId: "corr-sweep-4",
    })).rejects.toThrow("storage purge failed");
    expect((await ops.getExportJob(TENANT_ID, jobId)).status).toBe("expired");
    expect(auditActions(database)).not.toContain("tenant.export.deleted");
  });

  it("fails closed non-enumerating for an unknown tenant", async () => {
    const { client } = createDb();
    const ops = service(client);
    await expect(ops.sweepExportRetention({
      tenantId: TENANT_ID, executor: operatorActor, correlationId: "corr-sweep-none",
    })).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
  });
});
