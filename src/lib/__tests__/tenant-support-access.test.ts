import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import type { DbClient } from "@/lib/db";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  createLocalSupportAccessPolicyEvaluator,
  createLocalSupportAccessRepository,
  createLocalSupportPrincipalResolver,
  ensureLocalSupportAccessSchema,
} from "@/lib/tenancy/local-support-access";
import {
  createSupportAccessService,
  getSupportAccessContext,
} from "@/lib/tenancy/support-access";

vi.mock("server-only", () => ({}));

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const POLICY_ID = "20000000-0000-4000-8000-000000000001";
const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const ADMIN_ID = "50000000-0000-4000-8000-000000000003";
const RESEARCHER_ID = "50000000-0000-4000-8000-000000000004";
const OWNER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000002";
const RESEARCHER_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000003";
const OWNER_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const ADMIN_BINDING_ID = "40000000-0000-4000-8000-000000000002";
const RESEARCHER_BINDING_ID = "40000000-0000-4000-8000-000000000003";
const SUPPORT_ID = "60000000-0000-4000-8000-000000000001";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const APPROVE_AT = new Date("2026-07-27T12:30:00.000Z");
const START = "2026-07-27T11:00:00.000Z";
const EXPIRY = "2026-07-27T13:00:00.000Z";
const PAST_EXPIRY = new Date("2026-07-27T14:00:00.000Z");

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

async function seed(client: DbClient, tenantStatus: "active" | "suspended" | "archived" | "deletion_pending" = "active") {
  const repository = createTenantQueryRepository(client);
  await repository.createTenant({ id: TENANT_ID, slug: "support-tenant", name: "Support Tenant", status: tenantStatus });
  await repository.createWorkspace(TENANT_ID, { id: WORKSPACE_ID, slug: "ops", name: "Ops", status: "active" });
  await repository.createWorkspace(TENANT_ID, { id: OTHER_WORKSPACE_ID, slug: "lab", name: "Lab", status: "active" });
  await repository.createTenantPolicy(TENANT_ID, { id: POLICY_ID });
  await repository.createMembership(TENANT_ID, { id: OWNER_MEMBERSHIP_ID, authIdentityId: OWNER_ID, workspaceId: null, status: "active" });
  await repository.createRoleBinding(TENANT_ID, { id: OWNER_BINDING_ID, membershipId: OWNER_MEMBERSHIP_ID, role: "owner", reasonCode: "initial_provisioning" });
  await repository.createMembership(TENANT_ID, { id: ADMIN_MEMBERSHIP_ID, authIdentityId: ADMIN_ID, workspaceId: null, status: "active" });
  await repository.createRoleBinding(TENANT_ID, { id: ADMIN_BINDING_ID, membershipId: ADMIN_MEMBERSHIP_ID, role: "admin", reasonCode: "invitation" });
  await repository.createMembership(TENANT_ID, { id: RESEARCHER_MEMBERSHIP_ID, authIdentityId: RESEARCHER_ID, workspaceId: null, status: "active" });
  await repository.createRoleBinding(TENANT_ID, { id: RESEARCHER_BINDING_ID, membershipId: RESEARCHER_MEMBERSHIP_ID, role: "researcher", reasonCode: "invitation" });
  await ensureLocalSupportAccessSchema(client);
  await client
    .prepare("INSERT INTO platform_support_principals (reference, auth_identity_id, status) VALUES (?, ?, 'active')")
    .run("support-agent", SUPPORT_ID);
  // A principal entry bound to the owner's own identity exercises self-action denial.
  await client
    .prepare("INSERT INTO platform_support_principals (reference, auth_identity_id, status) VALUES (?, ?, 'active')")
    .run("support-self", OWNER_ID);
}

type MemberRole = "owner" | "admin" | "researcher";
const MEMBERS: Record<MemberRole, { userId: string; membershipId: string; roleBindingId: string }> = {
  owner: { userId: OWNER_ID, membershipId: OWNER_MEMBERSHIP_ID, roleBindingId: OWNER_BINDING_ID },
  admin: { userId: ADMIN_ID, membershipId: ADMIN_MEMBERSHIP_ID, roleBindingId: ADMIN_BINDING_ID },
  researcher: { userId: RESEARCHER_ID, membershipId: RESEARCHER_MEMBERSHIP_ID, roleBindingId: RESEARCHER_BINDING_ID },
};

function asMember<T>(role: MemberRole, correlationId: string, callback: () => Promise<T>): Promise<T> {
  const member = MEMBERS[role];
  return runWithTenantContext(
    {
      userId: member.userId,
      email: `${role}@example.test`,
      displayName: "Synthetic member",
      tenantId: TENANT_ID,
      workspaceId: null,
      membershipId: member.membershipId,
      role,
      roleBindingId: member.roleBindingId,
    },
    correlationId,
    callback,
  );
}

function makeService(client: DbClient, options: { now?: () => Date; currentReference?: string | null } = {}) {
  return createSupportAccessService({
    repository: createLocalSupportAccessRepository(client),
    principalResolver: createLocalSupportPrincipalResolver(client, {
      currentReference: () => options.currentReference === undefined ? "support-agent" : options.currentReference,
    }),
    policyEvaluator: createLocalSupportAccessPolicyEvaluator(client),
    now: options.now ?? (() => NOW),
    idFactory: () => randomUUID(),
  });
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    supportPrincipalRef: "support-agent",
    reasonCode: "incident.review",
    reason: "Synthetic support review",
    startsAt: START,
    expiresAt: EXPIRY,
    permissions: ["tenant:read"],
    dataClasses: ["tenant_metadata"],
    idempotencyKey: "request-001",
    ...overrides,
  } as const;
}

function checkInput(grantId: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_ID,
    supportPrincipalRef: "support-agent",
    grantId,
    permission: "tenant:read",
    dataClasses: ["tenant_metadata"],
    correlationId: "corr-check-001",
    idempotencyKey: "check-001",
    ...overrides,
  } as const;
}

function eventRows(database: Database.Database) {
  return database
    .prepare("SELECT * FROM support_access_events ORDER BY rowid")
    .all() as Record<string, unknown>[];
}

async function requestAndApprove(client: DbClient, requestOverrides: Record<string, unknown> = {}) {
  // The clock advances between request and approve: the grants table bumps
  // updated_at when an update leaves it unchanged, so a same-timestamp
  // request+approve cannot satisfy the service's updatedAt postcondition.
  let clock = NOW;
  const service = makeService(client, { now: () => clock });
  const requested = await asMember("owner", "corr-request-1", () => service.request(requestInput(requestOverrides)));
  if (!requested.ok || !requested.grant) throw new Error(`request failed: ${requested.code}`);
  clock = APPROVE_AT;
  const approveWorkspace =
    typeof requestOverrides.workspaceId === "string" ? { workspaceId: requestOverrides.workspaceId } : {};
  const approved = await asMember("admin", "corr-approve-1", () =>
    service.approve({ tenantId: TENANT_ID, grantId: requested.grant!.id, idempotencyKey: "approve-001", ...approveWorkspace }));
  if (!approved.ok) throw new Error(`approve failed: ${approved.code}`);
  return { service, grant: approved.grant! };
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("local support access adapter", () => {
  it("runs request → approve → check → authorizeAndRun → revoke durably with a full event ledger", async () => {
    const { client, database } = createDb();
    await seed(client);
    // Distinct operation timestamps: the grants table bumps updated_at when an
    // update leaves it unchanged, so lifecycle mutations need a moving clock.
    let clock = NOW;
    const service = makeService(client, { now: () => clock });

    const requested = await asMember("owner", "corr-request-1", () => service.request(requestInput()));
    expect(requested).toMatchObject({
      ok: true,
      code: "OK_SUPPORT_GRANT_REQUESTED",
      grant: { tenantId: TENANT_ID, workspaceId: null, state: "pending", supportActorAuthIdentityId: SUPPORT_ID, reasonCode: "incident.review" },
    });
    const grantId = requested.grant!.id;

    clock = APPROVE_AT;
    const approved = await asMember("admin", "corr-approve-1", () =>
      service.approve({ tenantId: TENANT_ID, grantId, idempotencyKey: "approve-001" }));
    expect(approved).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_APPROVED", grant: { state: "approved", approvedByAuthIdentityId: ADMIN_ID } });

    expect(await service.check(checkInput(grantId))).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });

    let ranInside = false;
    const authorized = await service.authorizeAndRun(checkInput(grantId, { idempotencyKey: "run-001", correlationId: "corr-run-001" }), async (context) => {
      ranInside = true;
      expect(getSupportAccessContext()).toMatchObject({ supportGrantId: grantId, tenantId: TENANT_ID, source: "support" });
      return context.expiresAt;
    });
    expect(authorized).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED", value: EXPIRY });
    expect(ranInside).toBe(true);
    expect(getSupportAccessContext()).toBeNull();

    clock = new Date("2026-07-27T12:45:00.000Z");
    const revoked = await asMember("owner", "corr-revoke-1", () =>
      service.revoke({ tenantId: TENANT_ID, grantId, idempotencyKey: "revoke-001" }));
    expect(revoked).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_REVOKED", grant: { state: "revoked", revokedByAuthIdentityId: OWNER_ID } });

    // After revocation the grant no longer authorizes.
    expect(await service.check(checkInput(grantId, { idempotencyKey: "check-after-revoke" }))).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    const events = eventRows(database);
    expect(events.map((row) => `${row.operation}:${row.decision_code}`)).toEqual([
      "request:OK_SUPPORT_GRANT_REQUESTED",
      "approve:OK_SUPPORT_GRANT_APPROVED",
      "check:OK_SUPPORT_AUTHORIZED",
      "authorize_and_run:OK_SUPPORT_AUTHORIZED",
      "revoke:OK_SUPPORT_GRANT_REVOKED",
      "check:SUPPORT_GRANT_REQUIRED",
    ]);
    expect(events.every((row) => row.tenant_id === TENANT_ID)).toBe(true);

    const journal = database.prepare("SELECT operation, status FROM support_access_journal ORDER BY rowid").all() as Record<string, unknown>[];
    expect(journal).toHaveLength(6);
    expect(journal.every((row) => row.status === "completed")).toBe(true);
  });

  it("replays identical idempotent requests and conflicts on different payloads", async () => {
    const { client } = createDb();
    await seed(client);
    const service = makeService(client);

    const first = await asMember("owner", "corr-request-1", () => service.request(requestInput()));
    expect(first).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_REQUESTED" });

    const replay = await asMember("owner", "corr-request-1", () => service.request(requestInput()));
    expect(replay).toMatchObject({ ok: true, code: "OK_SUPPORT_REPLAY", grant: { id: first.grant!.id } });

    const conflict = await asMember("owner", "corr-request-1", () =>
      service.request(requestInput({ reason: "A different reason entirely" })));
    expect(conflict).toEqual({ ok: false, code: "SUPPORT_STATE_CONFLICT" });
  });

  it("denies support:grant and audit:read to non-privileged member roles and still audits", async () => {
    const { client, database } = createDb();
    await seed(client);
    const service = makeService(client);

    const requested = await asMember("researcher", "corr-request-r", () => service.request(requestInput()));
    expect(requested).toEqual({ ok: false, code: "SUPPORT_POLICY_BLOCKED" });

    const listed = await asMember("researcher", "corr-list-r", () =>
      service.listHistory({ tenantId: TENANT_ID, idempotencyKey: "list-r-001" }));
    expect(listed).toEqual({ ok: false, code: "SUPPORT_POLICY_BLOCKED" });

    const events = eventRows(database);
    expect(events).toHaveLength(2);
    expect(events.every((row) => row.decision_code === "SUPPORT_POLICY_BLOCKED" && row.actor_layer === "member")).toBe(true);
  });

  it("does not grant default document visibility; permission and data-class scope is enforced", async () => {
    const { client } = createDb();
    await seed(client);
    const { grant } = await requestAndApprove(client);

    // The grant carries tenant:read + tenant_metadata only; broader asks deny.
    const service = makeService(client, { now: () => new Date("2026-07-27T12:40:00.000Z") });
    const escalatedPermission = await service.check(checkInput(grant.id, { permission: "knowledge:read", idempotencyKey: "check-esc-perm" }));
    expect(escalatedPermission).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    const documents = await service.check(checkInput(grant.id, { dataClasses: ["documents"], idempotencyKey: "check-esc-docs" }));
    expect(documents).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });
  });

  it("enforces the grant time window and workspace scope", async () => {
    const { client } = createDb();
    await seed(client);
    const { grant } = await requestAndApprove(client, { workspaceId: WORKSPACE_ID });
    expect(grant.workspaceId).toBe(WORKSPACE_ID);

    const service = makeService(client, { now: () => new Date("2026-07-27T12:40:00.000Z") });
    const wrongWorkspace = await service.check(checkInput(grant.id, { workspaceId: OTHER_WORKSPACE_ID, idempotencyKey: "check-ws-other" }));
    expect(wrongWorkspace).toEqual({ ok: false, code: "SUPPORT_WORKSPACE_SCOPE_INVALID" });

    const tenantWide = await service.check(checkInput(grant.id, { idempotencyKey: "check-ws-none" }));
    expect(tenantWide).toEqual({ ok: false, code: "SUPPORT_WORKSPACE_SCOPE_INVALID" });

    const inScope = await service.check(checkInput(grant.id, { workspaceId: WORKSPACE_ID, idempotencyKey: "check-ws-ok" }));
    expect(inScope).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });

    const expiredService = makeService(client, { now: () => PAST_EXPIRY });
    const expired = await expiredService.check(checkInput(grant.id, { workspaceId: WORKSPACE_ID, idempotencyKey: "check-expired" }));
    expect(expired).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });
  });

  it("never enumerates grants across tenants and blocks self-action", async () => {
    const { client } = createDb();
    await seed(client);
    const service = makeService(client);

    const missing = await asMember("owner", "corr-approve-missing", () =>
      service.approve({ tenantId: TENANT_ID, grantId: randomUUID(), idempotencyKey: "approve-missing" }));
    expect(missing).toEqual({ ok: false, code: "SUPPORT_NOT_FOUND_OR_FORBIDDEN" });

    const selfRequest = await asMember("owner", "corr-request-self", () =>
      service.request(requestInput({ supportPrincipalRef: "support-self", idempotencyKey: "request-self" })));
    expect(selfRequest).toEqual({ ok: false, code: "SUPPORT_SELF_ACTION" });
  });

  it("exposes current and historical grants to tenant members with audit:read", async () => {
    const { client } = createDb();
    await seed(client);
    const { service, grant } = await requestAndApprove(client);

    const current = await asMember("owner", "corr-list-cur", () =>
      service.listCurrent({ tenantId: TENANT_ID, idempotencyKey: "list-current-1" }));
    expect(current).toMatchObject({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    expect(current.grants!.map((entry) => entry.id)).toEqual([grant.id]);

    // A later clock for the revoke: the grants table bumps updated_at when an
    // update leaves it unchanged.
    const later = makeService(client, { now: () => new Date("2026-07-27T12:45:00.000Z") });
    await asMember("owner", "corr-revoke-1", () =>
      later.revoke({ tenantId: TENANT_ID, grantId: grant.id, idempotencyKey: "revoke-001" }));

    const afterRevoke = await asMember("admin", "corr-list-cur2", () =>
      later.listCurrent({ tenantId: TENANT_ID, idempotencyKey: "list-current-2" }));
    expect(afterRevoke).toMatchObject({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    expect(afterRevoke.grants).toHaveLength(0);

    const history = await asMember("admin", "corr-list-hist", () =>
      later.listHistory({ tenantId: TENANT_ID, idempotencyKey: "list-history-1" }));
    expect(history).toMatchObject({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    expect(history.grants!.map((entry) => `${entry.id}:${entry.state}`)).toEqual([`${grant.id}:revoked`]);
  });

  it("denies support operations on deletion-bound tenants at the policy layer", async () => {
    const { client } = createDb();
    await seed(client, "deletion_pending");
    const service = makeService(client);

    const requested = await asMember("owner", "corr-request-dp", () => service.request(requestInput()));
    expect(requested).toEqual({ ok: false, code: "SUPPORT_POLICY_BLOCKED" });
  });

  it("rolls back the grant insert when a later statement in the transaction fails", async () => {
    const { client, database } = createDb();
    await seed(client);
    // Sabotage the scope table so child inserts fail after the parent insert.
    database.exec("DROP TRIGGER trg_novatrade_support_access_grant_permissions_guard");
    database.exec(`CREATE TRIGGER trg_novatrade_support_access_grant_permissions_guard
      BEFORE INSERT ON support_access_grant_permissions FOR EACH ROW
      BEGIN SELECT RAISE(ABORT, 'sabotaged'); END;`);
    const service = makeService(client);

    const requested = await asMember("owner", "corr-request-fail", () => service.request(requestInput()));
    expect(requested).toEqual({ ok: false, code: "SUPPORT_INTERNAL" });

    const grants = database.prepare("SELECT id FROM support_access_grants").all();
    expect(grants).toHaveLength(0);
    const journal = database.prepare("SELECT idempotency_key_hash FROM support_access_journal").all();
    expect(journal).toHaveLength(0);
  });
});
