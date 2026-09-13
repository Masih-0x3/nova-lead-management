import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import type { DbClient } from "@/lib/db";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { hashAuthIdentitySelector } from "@/lib/tenancy/memberships";
import {
  createLocalAuthUserProvisioner,
  createLocalInvitationDeliveryAdapter,
  createLocalTenantInvitationService,
  createLocalTenantProvisioningService,
} from "@/lib/tenancy/local-tenant-provisioning";
import { TENANT_INVITATION_LOCAL_DDL } from "@/lib/tenancy/tenant-invitation-schema";
import type {
  TenantInvitationDeliveryOutcome,
  TenantInvitationDeliveryPort,
} from "@/lib/tenancy/provisioning";

const OPERATOR_ID = "50000000-0000-4000-8000-000000000001";
const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const MEMBER_ID = "50000000-0000-4000-8000-000000000003";
const STRANGER_ID = "50000000-0000-4000-8000-000000000004";
const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-000000000099";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const POLICY_ID = "20000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const INVITATION_ID = "80000000-0000-4000-8000-000000000001";

vi.mock("server-only", () => ({}));

const openDatabases: Database.Database[] = [];

function createDb(): { database: Database.Database; client: DbClient } {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  database.exec(TENANT_INVITATION_LOCAL_DDL);
  openDatabases.push(database);
  // A single SQLite connection cannot nest transactions; serialize writers so
  // concurrent service calls behave like a pool-level transaction coordinator.
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

function provisioningCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationName: "Apex Materials",
    organizationSlug: "apex-materials",
    requestedPolicyVersion: "policy-v1",
    idempotencyKey: "tenant-create-01",
    correlationId: "correlation-01",
    ownerIdentityId: OWNER_ID,
    locale: "en-US",
    timezone: "UTC",
    workspace: {
      workspaceName: "North America Industrial",
      workspaceSlug: "north-america-industrial",
    },
    ...overrides,
  };
}

function createInvitationService(
  client: DbClient,
  options: { clock?: () => Date; delivery?: TenantInvitationDeliveryPort } = {},
) {
  return createLocalTenantInvitationService(client, {
    operatorIdentityId: OPERATOR_ID,
    authUserProvisioner: createLocalAuthUserProvisioner(),
    invitationDelivery: options.delivery ?? createLocalInvitationDeliveryAdapter(),
    clock: options.clock,
  });
}

async function provisionOwnerFoundation(
  client: DbClient,
  delivery: TenantInvitationDeliveryPort = createLocalInvitationDeliveryAdapter(),
  clock?: () => Date,
) {
  const provisioning = createLocalTenantProvisioningService(client, {
    operatorIdentityId: OPERATOR_ID,
    invitationDelivery: delivery,
    clock,
  });
  return provisioning.provisionTenant(provisioningCommand());
}

/** Seeds an active tenant + policy + active owner-actor membership. */
async function seedActiveTenant(client: DbClient) {
  const repository = createTenantQueryRepository(client);
  await repository.createTenant({
    id: TENANT_ID,
    slug: "active-tenant",
    name: "Active Tenant",
    status: "active",
  });
  await repository.createWorkspace(TENANT_ID, {
    id: WORKSPACE_ID,
    slug: "ops",
    name: "Ops",
    status: "active",
  });
  await repository.createTenantPolicy(TENANT_ID, { id: POLICY_ID });
  const actorMembership = await repository.createMembership(TENANT_ID, {
    id: MEMBERSHIP_ID,
    authIdentityId: OWNER_ID,
    workspaceId: null,
    status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: ROLE_BINDING_ID,
    membershipId: actorMembership.id,
    role: "owner",
    reasonCode: "initial_provisioning",
  });
  return repository;
}

function invitationRow(database: Database.Database, invitationId: string) {
  return database.prepare("SELECT * FROM tenant_invitations WHERE id = ?").get(invitationId) as Record<string, unknown> | undefined;
}

function auditRows(database: Database.Database) {
  return database.prepare("SELECT action, entity_type, scope_kind, actor_layer FROM audit_logs ORDER BY created_at, id").all() as Record<string, unknown>[];
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("tenant invitation local schema", () => {
  it("applies on top of the frozen v1 schema", () => {
    const { database } = createDb();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tenant_invitation%' OR name = 'tenant_provisioning_journal'")
      .all() as { name: string }[];
    expect(tables.map((row) => row.name).sort()).toEqual([
      "tenant_invitation_journal",
      "tenant_invitations",
      "tenant_provisioning_journal",
    ]);
  });
});

describe("owner provisioning + acceptance", () => {
  it("creates a durable issued invitation and records delivery via the local adapter", async () => {
    const { database, client } = createDb();
    const result = await provisionOwnerFoundation(client);

    expect(result.resultCode).toBe("PROVISIONING_FOUNDATION_CREATED");
    expect(result.invitationId).toBeDefined();
    expect(result.activationBlockers).toEqual(["OWNER_ACCEPTANCE_REQUIRED"]);

    const row = invitationRow(database, result.invitationId);
    expect(row).toMatchObject({
      tenant_id: result.tenantId,
      membership_id: result.membershipId,
      provisioning_request_id: result.requestId,
      kind: "owner",
      role: "owner",
      status: "issued",
      delivery_state: "delivered",
      delivery_adapter: "local-noop",
      generation: 1,
    });
    expect(row!.expected_identity_ref_hash).toBe(hashAuthIdentitySelector(OWNER_ID));
    expect(row!.policy_version).toBe("tenant-policy-v1");

    const actions = auditRows(database).map((entry) => entry.action);
    expect(actions).toContain("tenant.provisioning_started");
    expect(actions).toContain("tenant.invitation_delivery_recorded");
  });

  it("keeps the invitation queued when no delivery adapter is bound", async () => {
    const { database, client } = createDb();
    const provisioning = createLocalTenantProvisioningService(client, { operatorIdentityId: OPERATOR_ID });
    const result = await provisioning.provisionTenant(provisioningCommand());
    expect(invitationRow(database, result.invitationId)).toMatchObject({
      status: "issued",
      delivery_state: "queued",
      delivery_adapter: null,
    });
  });

  it("records a failed delivery without blocking the durable invitation", async () => {
    const { database, client } = createDb();
    const failing = {
      adapterId: "local-noop",
      deliver: async (): Promise<TenantInvitationDeliveryOutcome> => ({
        adapterId: "local-noop",
        state: "delivery_failed",
        deliveryRefHash: null,
        deliveryDetail: "provider_timeout",
      }),
    };
    const result = await provisionOwnerFoundation(client, failing);
    expect(invitationRow(database, result.invitationId)).toMatchObject({
      status: "issued",
      delivery_state: "delivery_failed",
      delivery_detail: "provider_timeout",
    });
  });

  it("accepts the owner invitation and activates tenant, workspace, membership, and role binding", async () => {
    const { database, client } = createDb();
    const provisioned = await provisionOwnerFoundation(client);
    const invitations = createInvitationService(client);

    const accepted = await invitations.acceptInvitation(OWNER_ID, {
      invitationId: provisioned.invitationId,
      idempotencyKey: "owner-accept-01",
      correlationId: "correlation-accept-01",
    });

    expect(accepted).toMatchObject({
      resultCode: "INVITATION_ACCEPTED",
      invitationId: provisioned.invitationId,
      tenantId: provisioned.tenantId,
      membershipId: provisioned.membershipId,
      role: "owner",
      tenantStatus: "active",
      workspaceStatus: "active",
      membershipStatus: "active",
      activationState: "active",
      activationBlockers: [],
    });

    const repository = createTenantQueryRepository(client);
    expect(await repository.getTenant(provisioned.tenantId)).toMatchObject({ status: "active" });
    expect(await repository.getWorkspace(provisioned.tenantId, provisioned.workspaceId!)).toMatchObject({ status: "active" });
    expect(await repository.getMembership(provisioned.tenantId, provisioned.membershipId)).toMatchObject({
      status: "active",
      authIdentityId: OWNER_ID,
    });
    expect(invitationRow(database, provisioned.invitationId)).toMatchObject({
      status: "accepted",
      accepted_auth_identity_id: OWNER_ID,
    });
    const actions = auditRows(database).map((entry) => entry.action);
    expect(actions).toContain("tenant.provisioned");
    const provisionedAudit = database
      .prepare("SELECT * FROM audit_logs WHERE action = 'tenant.provisioned'")
      .get() as Record<string, unknown>;
    expect(provisionedAudit).toMatchObject({
      scope_kind: "tenant",
      actor_layer: "member",
      actor_auth_identity_id: OWNER_ID,
      actor_membership_id: provisioned.membershipId,
      actor_launch_role: "owner",
    });
  });

  it("replays acceptance idempotently with the exact stored result", async () => {
    const { client } = createDb();
    const provisioned = await provisionOwnerFoundation(client);
    const invitations = createInvitationService(client);
    const command = {
      invitationId: provisioned.invitationId,
      idempotencyKey: "owner-accept-02",
      correlationId: "correlation-accept-02",
    };

    const first = await invitations.acceptInvitation(OWNER_ID, command);
    const second = await invitations.acceptInvitation(OWNER_ID, command);
    expect(second).toEqual(first);
  });

  it("rejects acceptance by a different identity without disclosing invitation state", async () => {
    const { client } = createDb();
    const provisioned = await provisionOwnerFoundation(client);
    const invitations = createInvitationService(client);

    await expect(invitations.acceptInvitation(STRANGER_ID, {
      invitationId: provisioned.invitationId,
      idempotencyKey: "owner-accept-03",
      correlationId: "correlation-accept-03",
    })).rejects.toMatchObject({ code: "INVITE_RECIPIENT_MISMATCH" });
  });

  it("returns the same not-found for unknown and well-formed-but-absent ids", async () => {
    const { client } = createDb();
    const invitations = createInvitationService(client);
    await expect(invitations.acceptInvitation(OWNER_ID, {
      invitationId: "80000000-0000-4000-8000-000000000099",
      idempotencyKey: "accept-missing",
      correlationId: "correlation-accept-x",
    })).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
  });
});

describe("member invitation issuance", () => {
  async function seedPendingMembership(client: DbClient) {
    const repository = await seedActiveTenant(client);
    const memberHash = hashAuthIdentitySelector(MEMBER_ID);
    const pending = await repository.createMembership(TENANT_ID, {
      id: "30000000-0000-4000-8000-000000000777",
      pendingIdentityRefHash: memberHash,
      workspaceId: WORKSPACE_ID,
      status: "pending",
      invitedByMembershipId: MEMBERSHIP_ID,
    });
    await repository.createRoleBinding(TENANT_ID, {
      id: "40000000-0000-4000-8000-000000000777",
      membershipId: pending.id,
      role: "researcher",
      reasonCode: "invitation",
      assignedByMembershipId: MEMBERSHIP_ID,
    });
    return { repository, pending, memberHash };
  }

  function issueCommand(pendingId: string, memberHash: string, overrides: Record<string, unknown> = {}) {
    return {
      tenantId: TENANT_ID,
      membershipId: pendingId,
      role: "researcher",
      workspaceId: WORKSPACE_ID,
      expectedIdentityRefHash: memberHash,
      actorMembershipId: MEMBERSHIP_ID,
      actorIdentityId: OWNER_ID,
      idempotencyKey: "member-invite-01",
      correlationId: "correlation-invite-01",
      ...overrides,
    };
  }

  it("issues a durable member invitation and delivers it", async () => {
    const { database, client } = createDb();
    const { pending, memberHash } = await seedPendingMembership(client);
    const invitations = createInvitationService(client);

    const issued = await invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash));
    expect(issued).toMatchObject({
      resultCode: "INVITATION_ISSUED",
      tenantId: TENANT_ID,
      membershipId: pending.id,
      generation: 1,
      // The journaled result captures the committed state; post-commit
      // delivery updates the durable row (visible via getInvitationStatus).
      deliveryState: "queued",
    });

    const row = invitationRow(database, issued.invitationId);
    expect(row).toMatchObject({
      kind: "member",
      role: "researcher",
      status: "issued",
      delivery_state: "delivered",
      delivery_adapter: "local-noop",
      provisioning_request_id: null,
      policy_version: "tenant-policy-v1",
    });
    expect(row!.expected_identity_ref_hash).toBe(memberHash);
    expect(auditRows(database).map((entry) => entry.action)).toContain("tenant.invitation_issued");
  });

  it("rejects issuance by a non-owner/admin actor", async () => {
    const { client } = createDb();
    const { repository, pending, memberHash } = await seedPendingMembership(client);
    // Demote the actor binding to a non-inviting role.
    await repository.revokeCurrentRoleBinding(TENANT_ID, MEMBERSHIP_ID);
    await repository.createRoleBinding(TENANT_ID, {
      id: "40000000-0000-4000-8000-000000000888",
      membershipId: MEMBERSHIP_ID,
      role: "researcher",
      reasonCode: "role_change",
    });
    const invitations = createInvitationService(client);
    await expect(invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash)))
      .rejects.toMatchObject({ code: "INVITATION_NOT_AUTHORIZED" });
  });

  it("rejects member issuance for the owner role", async () => {
    const { client } = createDb();
    const { pending, memberHash } = await seedPendingMembership(client);
    const invitations = createInvitationService(client);
    await expect(invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash, { role: "owner" })))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a second live invitation for the same membership", async () => {
    const { client } = createDb();
    const { pending, memberHash } = await seedPendingMembership(client);
    const invitations = createInvitationService(client);
    await invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash));
    await expect(invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash, { idempotencyKey: "member-invite-02" })))
      .rejects.toMatchObject({ code: "PROVISIONING_CONFLICT" });
  });

  it("accepts a member invitation by replacing the pending membership atomically", async () => {
    const { database, client } = createDb();
    const { repository, pending, memberHash } = await seedPendingMembership(client);
    const invitations = createInvitationService(client);
    const issued = await invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash));

    const accepted = await invitations.acceptInvitation(MEMBER_ID, {
      invitationId: issued.invitationId,
      idempotencyKey: "member-accept-01",
      correlationId: "correlation-accept-m1",
    });

    expect(accepted).toMatchObject({
      resultCode: "INVITATION_ACCEPTED",
      tenantId: TENANT_ID,
      role: "researcher",
      tenantStatus: "active",
      workspaceStatus: "active",
      membershipStatus: "active",
      activationBlockers: [],
    });
    expect(accepted.membershipId).not.toBe(pending.id);

    // Pending placeholder is closed; the effective membership carries the identity.
    expect(await repository.getMembership(TENANT_ID, pending.id)).toMatchObject({ status: "expired" });
    const effective = await repository.getMembership(TENANT_ID, accepted.membershipId);
    expect(effective).toMatchObject({
      status: "active",
      authIdentityId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
    });
    const binding = await repository.getCurrentRoleBinding(TENANT_ID, accepted.membershipId);
    expect(binding).toMatchObject({ role: "researcher", revokedAt: null, reasonCode: "invitation" });
    expect(auditRows(database).map((entry) => entry.action)).toContain("tenant.invitation_accepted");
  });

  it("replays member issuance with the same key, returning the journaled result", async () => {
    const { database, client } = createDb();
    const { pending, memberHash } = await seedPendingMembership(client);
    const invitations = createInvitationService(client);

    const first = await invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash));
    const replayed = await invitations.issueMembershipInvitation(issueCommand(pending.id, memberHash));
    expect(replayed).toEqual(first);

    // The replay must not mint a second invitation row.
    const rows = database.prepare("SELECT count(*) AS count FROM tenant_invitations").get() as { count: number };
    expect(rows.count).toBe(1);
  });
});

describe("invitation lifecycle — reissue, revoke, expiry, status", () => {
  async function seedIssued(client: DbClient) {
    const result = await provisionOwnerFoundation(client);
    return result;
  }

  it("reissues: supersedes the prior row and mints generation 2", async () => {
    const { database, client } = createDb();
    const provisioned = await seedIssued(client);
    const invitations = createInvitationService(client);

    const reissued = await invitations.reissueInvitation({
      invitationId: provisioned.invitationId,
      reasonCode: "delivery_retry",
      reason: "delivery channel recovered",
      idempotencyKey: "reissue-01",
      correlationId: "correlation-reissue-01",
    });

    expect(reissued).toMatchObject({
      resultCode: "INVITATION_REISSUED",
      priorInvitationId: provisioned.invitationId,
      tenantId: provisioned.tenantId,
      membershipId: provisioned.membershipId,
      generation: 2,
      deliveryState: "queued",
    });
    expect(reissued.invitationId).not.toBe(provisioned.invitationId);
    expect(invitationRow(database, provisioned.invitationId)).toMatchObject({
      status: "superseded",
      superseded_by_invitation_id: reissued.invitationId,
    });
    expect(invitationRow(database, reissued.invitationId)).toMatchObject({
      status: "issued",
      generation: 2,
    });
    expect(auditRows(database).map((entry) => entry.action)).toContain("tenant.invitation_reissued");
  });

  it("replays reissue with the same key, returning the journaled generation-2 result", async () => {
    const { database, client } = createDb();
    const provisioned = await seedIssued(client);
    const invitations = createInvitationService(client);
    const command = {
      invitationId: provisioned.invitationId,
      reasonCode: "delivery_retry",
      reason: "delivery channel recovered",
      idempotencyKey: "reissue-replay-01",
      correlationId: "correlation-reissue-r1",
    };

    const first = await invitations.reissueInvitation(command);
    const replayed = await invitations.reissueInvitation(command);
    expect(replayed).toEqual(first);

    // The replay must not mint another generation or supersede the new invite.
    const rows = database
      .prepare("SELECT id, status, generation FROM tenant_invitations ORDER BY generation")
      .all() as Array<{ id: string; status: string; generation: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "superseded", generation: 1 });
    expect(rows[1]).toMatchObject({ status: "issued", generation: 2 });
  });

  it("revokes an issued invitation and blocks acceptance", async () => {
    const { client } = createDb();
    const provisioned = await seedIssued(client);
    const invitations = createInvitationService(client);

    const revoked = await invitations.revokeInvitation({
      invitationId: provisioned.invitationId,
      reasonCode: "operator_recall",
      reason: "approval rescinded",
      idempotencyKey: "revoke-01",
      correlationId: "correlation-revoke-01",
    });
    expect(revoked).toMatchObject({ resultCode: "INVITATION_REVOKED", status: "revoked" });

    await expect(invitations.acceptInvitation(OWNER_ID, {
      invitationId: provisioned.invitationId,
      idempotencyKey: "accept-after-revoke",
      correlationId: "correlation-accept-r1",
    })).rejects.toMatchObject({ code: "INVITE_REVOKED" });
  });

  it("reports effectiveStatus expired without mutating the row at read time", async () => {
    const { database, client } = createDb();
    let now = new Date("2026-09-12T00:00:00.000Z");
    const provisioning = createLocalTenantProvisioningService(client, {
      operatorIdentityId: OPERATOR_ID,
      clock: () => now,
    });
    const provisioned = await provisioning.provisionTenant(provisioningCommand());
    const invitations = createInvitationService(client, { clock: () => now });

    now = new Date("2026-09-20T00:00:00.000Z"); // past the 7-day TTL
    const status = await invitations.getInvitationStatus({ invitationId: provisioned.invitationId });
    expect(status).toMatchObject({ status: "issued", effectiveStatus: "expired" });
    expect(invitationRow(database, provisioned.invitationId)!.status).toBe("issued");

    await expect(invitations.acceptInvitation(OWNER_ID, {
      invitationId: provisioned.invitationId,
      idempotencyKey: "accept-expired",
      correlationId: "correlation-accept-exp",
    })).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
  });

  it("non-enumerates status lookups for unknown and cross-tenant ids", async () => {
    const { client } = createDb();
    const invitations = createInvitationService(client);
    await expect(invitations.getInvitationStatus({ invitationId: OTHER_TENANT_ID }))
      .rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
  });

  it("requires the operator identity for operator-scoped operations", async () => {
    const { client } = createDb();
    const invitations = createLocalTenantInvitationService(client, {
      authUserProvisioner: createLocalAuthUserProvisioner(),
    });
    await expect(invitations.getInvitationStatus({ invitationId: INVITATION_ID }))
      .rejects.toMatchObject({ code: "INVITATION_NOT_AUTHORIZED" });
  });
});

describe("invitation idempotency and races", () => {
  it("conflicts when the same key carries different input material", async () => {
    const { client } = createDb();
    const provisioned = await provisionOwnerFoundation(client);
    const invitations = createInvitationService(client);
    const command = {
      invitationId: provisioned.invitationId,
      reasonCode: "delivery_retry",
      reason: "first",
      idempotencyKey: "reissue-same-key",
      correlationId: "correlation-reissue-x",
    };
    await invitations.reissueInvitation(command);
    await expect(invitations.reissueInvitation({ ...command, reason: "different" }))
      .rejects.toMatchObject({ code: "PROVISIONING_IDEMPOTENCY_CONFLICT" });
  });

  it("resolves concurrent acceptance attempts to exactly one winner", async () => {
    const { client } = createDb();
    const provisioned = await provisionOwnerFoundation(client);
    const invitations = createInvitationService(client);

    const outcomes = await Promise.allSettled([
      invitations.acceptInvitation(OWNER_ID, {
        invitationId: provisioned.invitationId,
        idempotencyKey: "accept-race-a",
        correlationId: "correlation-race-a",
      }),
      invitations.acceptInvitation(OWNER_ID, {
        invitationId: provisioned.invitationId,
        idempotencyKey: "accept-race-b",
        correlationId: "correlation-race-b",
      }),
    ]);

    const accepted = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: expect.stringMatching(/INVITE_ALREADY_ACCEPTED|PROVISIONING_(IN_PROGRESS|CONFLICT)/),
    });
    const repository = createTenantQueryRepository(client);
    expect((await repository.getTenant(provisioned.tenantId))!.status).toBe("active");
  });

  it("rolls back acceptance writes when the audit port fails", async () => {
    const { database, client } = createDb();
    const provisioned = await provisionOwnerFoundation(client);
    // Break the audit port by dropping the audit table's trigger dependency:
    // use a service whose transaction audit writer throws.
    const invitations = createInvitationService(client);
    const dbAny = client as DbClient;
    const originalPrepare = dbAny.prepare;
    (client as { prepare: DbClient["prepare"] }).prepare = (query: string) => {
      const statement = originalPrepare(query);
      if (query.includes("INSERT INTO audit_logs")) {
        return {
          all: statement.all,
          get: statement.get,
          run: async () => { throw new Error("synthetic audit failure"); },
        };
      }
      return statement;
    };

    await expect(invitations.acceptInvitation(OWNER_ID, {
      invitationId: provisioned.invitationId,
      idempotencyKey: "accept-audit-fail",
      correlationId: "correlation-accept-af",
    })).rejects.toMatchObject({ code: "PROVISIONING_RETRYABLE" });

    // Nothing committed: invitation still issued, tenant still provisioning.
    expect(invitationRow(database, provisioned.invitationId)!.status).toBe("issued");
    const repository = createTenantQueryRepository(client);
    expect((await repository.getTenant(provisioned.tenantId))!.status).toBe("provisioning");
    expect((await repository.getMembership(provisioned.tenantId, provisioned.membershipId))!.status).toBe("pending");
  });
});
