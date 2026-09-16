import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb, withTenantDbContext } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  createPostgresTenantMembershipAdministrationService,
} from "@/lib/tenancy/postgres-membership-administration";
import { hashAuthIdentitySelector } from "@/lib/tenancy/memberships";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the member-side
 * membership-administration write path — the sixth Postgres-backed
 * service-port binding after T-031..T-036.
 *
 * The canonical createTenantMembershipAdministrationService orchestration is
 * unit-verified against the SQLite backend; this lane proves the Postgres
 * twin end to end. createPostgresTenantMembershipAdministrationService runs
 * the service's reserve → mutate → audit → complete pipeline inside
 * withTenantDbContext, with every write going through the SECURITY DEFINER
 * functions of migration 202609120010 (memberships/role bindings are
 * deny-all-else; the new mutation journal is zero-policy). The functions
 * re-validate the transaction-local member GUCs database-side and bind
 * tenant, actor-membership, and actor-binding facts to the accepted context.
 * Membership/workspace reads ride the owner/admin member-select policies.
 *
 * Requires a disposable database named `t037_membership_admin_rehearsal`
 * holding the migrated schema plus migration 202609120010, and a
 * `t037_runtime` role granted SELECT on tenants/workspaces/memberships/
 * role_bindings/audit_logs plus EXECUTE on the six membership-admin
 * functions. `DATABASE_URL` is staged to the runtime role with
 * `DATABASE_SSL=disable`. See docs/TESTING.md for provisioning.
 */

const RUN = process.env.T037_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t037_membership_admin_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000a2";
const WORKSPACE_A1 = "10000000-0000-4000-8000-0000000000a1";
const WORKSPACE_A2 = "10000000-0000-4000-8000-0000000000a2";
const MEMBER_A_OWNER = "20000000-0000-4000-8000-0000000000a1";
const MEMBER_A_ADMIN = "20000000-0000-4000-8000-0000000000a2";
const MEMBER_A_WS_ADMIN = "20000000-0000-4000-8000-0000000000a3";
const MEMBER_A_TARGET = "20000000-0000-4000-8000-0000000000a4";
const MEMBER_A_WS2_TARGET = "20000000-0000-4000-8000-0000000000a5";
const MEMBER_A_RESEARCHER = "20000000-0000-4000-8000-0000000000a6";
const MEMBER_A_REPLACEMENT = "20000000-0000-4000-8000-0000000000a7";
const MEMBER_B_OWNER = "20000000-0000-4000-8000-0000000000b1";
const BINDING_A_OWNER = "30000000-0000-4000-8000-0000000000a1";
const BINDING_A_ADMIN = "30000000-0000-4000-8000-0000000000a2";
const BINDING_A_WS_ADMIN = "30000000-0000-4000-8000-0000000000a3";
const BINDING_A_TARGET = "30000000-0000-4000-8000-0000000000a4";
const BINDING_A_WS2_TARGET = "30000000-0000-4000-8000-0000000000a5";
const BINDING_A_RESEARCHER = "30000000-0000-4000-8000-0000000000a6";
const BINDING_A_REPLACEMENT = "30000000-0000-4000-8000-0000000000a7";
const BINDING_B_OWNER = "30000000-0000-4000-8000-0000000000b1";
const ACTOR_A_OWNER = "50000000-0000-4000-8000-0000000000a1";
const ACTOR_A_ADMIN = "50000000-0000-4000-8000-0000000000a2";
const ACTOR_A_WS_ADMIN = "50000000-0000-4000-8000-0000000000a3";
const ACTOR_A_TARGET = "50000000-0000-4000-8000-0000000000a4";
const ACTOR_A_WS2_TARGET = "50000000-0000-4000-8000-0000000000a5";
const ACTOR_A_RESEARCHER = "50000000-0000-4000-8000-0000000000a6";
const ACTOR_A_REPLACEMENT = "50000000-0000-4000-8000-0000000000a7";
const ACTOR_B_OWNER = "50000000-0000-4000-8000-0000000000b1";

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_OWNER,
    email: "t037-owner-a@example.test",
    displayName: "T037 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_OWNER,
    role: "owner",
    roleBindingId: BINDING_A_OWNER,
    ...overrides,
  };
}

function adminSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_ADMIN,
    email: "t037-admin-a@example.test",
    displayName: "T037 Admin A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_ADMIN,
    role: "admin",
    roleBindingId: BINDING_A_ADMIN,
    ...overrides,
  };
}

function wsAdminSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_WS_ADMIN,
    email: "t037-ws-admin-a@example.test",
    displayName: "T037 Workspace Admin A",
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A1,
    membershipId: MEMBER_A_WS_ADMIN,
    role: "admin",
    roleBindingId: BINDING_A_WS_ADMIN,
    ...overrides,
  };
}

function researcherSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_RESEARCHER,
    email: "t037-researcher-a@example.test",
    displayName: "T037 Researcher A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_RESEARCHER,
    role: "researcher",
    roleBindingId: BINDING_A_RESEARCHER,
    ...overrides,
  };
}

function service() {
  return createPostgresTenantMembershipAdministrationService();
}

function inviteCommand(overrides: Record<string, unknown> = {}) {
  return {
    identitySelectorHash: hashAuthIdentitySelector(crypto.randomUUID()),
    role: "researcher" as const,
    workspaceId: null,
    reasonCode: "membership.invite-ok",
    correlationId: "t037-invite-1",
    idempotencyKey: "t037-invite-1",
    ...overrides,
  };
}

describe.skipIf(!RUN)("T-037 membership administration on Postgres", () => {
  let admin: Sql;
  let runtime: Sql;
  let targetValidated = false;

  interface ConnectionReceipt {
    database_name: string;
    server_addr: string;
    server_port: number;
    postmaster_started_at: string;
    server_version_num: number;
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }

  async function connectionReceipt(db: Sql): Promise<ConnectionReceipt> {
    const rows = await db.unsafe<ConnectionReceipt[]>(`
      SELECT current_database() AS database_name,
        coalesce(inet_server_addr()::text, 'local') AS server_addr,
        inet_server_port() AS server_port,
        pg_postmaster_start_time()::text AS postmaster_started_at,
        current_setting('server_version_num')::int AS server_version_num,
        current_user,
        role.rolsuper,
        role.rolbypassrls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user
    `);
    if (rows.length !== 1) throw new Error("T-037 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T037_ADMIN_DATABASE_URL) {
      throw new Error("T-037 disposable test requires DATABASE_URL and T037_ADMIN_DATABASE_URL");
    }
    if (!process.env.T037_RUNTIME_ROLE) {
      throw new Error("T-037 disposable test requires T037_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T037_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-037 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-037 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-037 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T037_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-037 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_membership_snapshot_json',
        'novatrade_membership_journal_find',
        'novatrade_membership_journal_reserve',
        'novatrade_membership_journal_complete',
        'novatrade_membership_create_pending',
        'novatrade_membership_apply_mutation',
        'novatrade_membership_audit_append',
        'novatrade_membership_actor_ctx_valid'
      )
    `);
    if (posture.length !== 8 || posture.some((fn) => !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)) {
      throw new Error("T-037 preflight refused: membership functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }

    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-037 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-037 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't037-tenant-a', 'Membership Tenant A', 'active'), ($2, 't037-tenant-b', 'Membership Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
          ($1, $3, 't037-ws-a1', 'Membership Workspace A1', 'active'),
          ($2, $3, 't037-ws-a2', 'Membership Workspace A2', 'active')`,
        [WORKSPACE_A1, WORKSPACE_A2, TENANT_A],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status) VALUES
          ($1, $9, $10, NULL, 'active'),
          ($2, $9, $11, NULL, 'active'),
          ($3, $9, $12, $13, 'active'),
          ($4, $9, $14, NULL, 'active'),
          ($5, $9, $15, $16, 'active'),
          ($6, $9, $17, NULL, 'active'),
          ($7, $9, $18, NULL, 'active'),
          ($8, $19, $20, NULL, 'active')`,
        [
          MEMBER_A_OWNER,
          MEMBER_A_ADMIN,
          MEMBER_A_WS_ADMIN,
          MEMBER_A_TARGET,
          MEMBER_A_WS2_TARGET,
          MEMBER_A_RESEARCHER,
          MEMBER_A_REPLACEMENT,
          MEMBER_B_OWNER,
          TENANT_A,
          ACTOR_A_OWNER,
          ACTOR_A_ADMIN,
          ACTOR_A_WS_ADMIN,
          WORKSPACE_A1,
          ACTOR_A_TARGET,
          ACTOR_A_WS2_TARGET,
          WORKSPACE_A2,
          ACTOR_A_RESEARCHER,
          ACTOR_A_REPLACEMENT,
          TENANT_B,
          ACTOR_B_OWNER,
        ],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, created_at, valid_from, revoked_at) VALUES
          ($1, $9, $10, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($2, $9, $11, 'admin', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($3, $9, $12, 'admin', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($4, $9, $13, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($5, $9, $14, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($6, $9, $15, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($7, $9, $16, 'analyst_read_only', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($8, $17, $18, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null)`,
        [
          BINDING_A_OWNER,
          BINDING_A_ADMIN,
          BINDING_A_WS_ADMIN,
          BINDING_A_TARGET,
          BINDING_A_WS2_TARGET,
          BINDING_A_RESEARCHER,
          BINDING_A_REPLACEMENT,
          BINDING_B_OWNER,
          TENANT_A,
          MEMBER_A_OWNER,
          MEMBER_A_ADMIN,
          MEMBER_A_WS_ADMIN,
          MEMBER_A_TARGET,
          MEMBER_A_WS2_TARGET,
          MEMBER_A_RESEARCHER,
          MEMBER_A_REPLACEMENT,
          TENANT_B,
          MEMBER_B_OWNER,
        ],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    // The audit log is append-only — the privileged cleanup disables its
    // guard, matching the T-033/T-035 lanes.
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      try {
        await tx.unsafe(
          "DELETE FROM public.audit_logs WHERE correlation_id LIKE $1 OR tenant_id = ANY($2::uuid[])",
          ["t037-%", [TENANT_A, TENANT_B]],
        );
      } finally {
        await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
      }
      await tx.unsafe(
        "DELETE FROM public.tenant_membership_mutation_journal WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        `DELETE FROM public.tenant_role_bindings WHERE tenant_id = ANY($1::uuid[])`,
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        `DELETE FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[])`,
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [[WORKSPACE_A1, WORKSPACE_A2]]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
    });
  }

  async function journalRows(): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT operation, status, tenant_id::text AS tenant_id,
              actor_membership_id::text AS actor_membership_id,
              target_membership_id::text AS target_membership_id,
              replacement_membership_id::text AS replacement_membership_id
       FROM public.tenant_membership_mutation_journal ORDER BY created_at`,
    );
  }

  async function membershipRow(id: string): Promise<Record<string, unknown> | null> {
    const rows = await admin.unsafe<Record<string, unknown>[]>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, status,
              workspace_id::text AS workspace_id,
              pending_identity_ref_hash, auth_identity_id::text AS auth_identity_id,
              invited_by_membership_id::text AS invited_by_membership_id
       FROM public.tenant_memberships WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async function bindingRows(membershipId: string): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT id::text AS id, role, reason_code,
              assigned_by_membership_id::text AS assigned_by_membership_id,
              revoked_at IS NOT NULL AS revoked
       FROM public.tenant_role_bindings
       WHERE membership_id = $1 ORDER BY valid_from, id`,
      [membershipId],
    );
  }

  async function auditRows(): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT action, entity_type, entity_id, scope_kind, actor_layer,
              tenant_id::text AS tenant_id, workspace_id::text AS workspace_id,
              correlation_id, actor_membership_id::text AS actor_membership_id,
              actor_launch_role
       FROM public.audit_logs WHERE correlation_id LIKE 't037-%' ORDER BY created_at`,
    );
  }

  beforeAll(async () => {
    await assertDisposableTarget();
    await fixture();
  });

  afterAll(async () => {
    await cleanRows().catch(() => undefined);
    await closeDb().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await runtime?.end().catch(() => undefined);
  });

  it("commits an invite end to end: pending membership, binding, journal, audit, replay, conflict", async () => {
    // Ambient and command correlations differ in production (the action layer
    // wraps mutations in 'membership-admin:{op}:{requestId}' while commands
    // carry their own correlation); the ledger records the command's.
    const command = inviteCommand({ idempotencyKey: "t037-invite-main", correlationId: "t037-invite-main" });
    const result = await runWithTenantContext(ownerSessionA(), "membership-admin:invite:t037-invite-main", () =>
      service().invitePendingMember(ownerSessionA(), command));

    expect(result.code).toBe("OK");
    expect(result.operation).toBe("invite");
    expect(result.membership.status).toBe("pending");
    expect(result.membership.role).toBe("researcher");
    expect(result.membership.tenantId).toBe(TENANT_A);
    const membershipId = result.membership.membershipId;

    const membership = await membershipRow(membershipId);
    expect(membership).toMatchObject({
      tenant_id: TENANT_A,
      status: "pending",
      workspace_id: null,
      invited_by_membership_id: MEMBER_A_OWNER,
      pending_identity_ref_hash: command.identitySelectorHash,
    });
    const bindings = await bindingRows(membershipId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      role: "researcher", reason_code: "invitation", revoked: false,
      assigned_by_membership_id: MEMBER_A_OWNER,
    });

    const journal = (await journalRows()).filter((row) => row.operation === "invite");
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      status: "completed", tenant_id: TENANT_A,
      actor_membership_id: MEMBER_A_OWNER, target_membership_id: membershipId,
    });

    const audit = (await auditRows()).filter((row) => row.correlation_id === "t037-invite-main");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "tenant.membership.mutated",
      entity_type: "tenant_membership",
      entity_id: membershipId,
      scope_kind: "tenant",
      actor_layer: "member",
      actor_membership_id: MEMBER_A_OWNER,
      actor_launch_role: "owner",
      tenant_id: TENANT_A,
    });

    // Idempotent replay returns the recorded result; a same-key different-input
    // call produces the canonical conflict and leaves no new rows.
    const replay = await runWithTenantContext(ownerSessionA(), "t037-invite-main", () =>
      service().invitePendingMember(ownerSessionA(), command));
    expect(replay).toEqual(result);

    await expect(
      runWithTenantContext(ownerSessionA(), "t037-invite-conflict", () =>
        service().invitePendingMember(ownerSessionA(), {
          ...command,
          correlationId: "t037-invite-conflict",
          role: "admin",
        })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("commits role, workspace, disable, reactivate, and revoke mutations with expected-state CAS", async () => {
    const promoted = await runWithTenantContext(adminSessionA(), "t037-role-1", () =>
      service().assignMemberRole(adminSessionA(), {
        membershipId: MEMBER_A_TARGET,
        role: "admin",
        reasonCode: "membership.role-ok",
        correlationId: "t037-role-1",
        idempotencyKey: "t037-role-1",
      }));
    expect(promoted.membership.role).toBe("admin");
    let bindings = await bindingRows(MEMBER_A_TARGET);
    expect(bindings).toHaveLength(2);
    expect(bindings[1]).toMatchObject({ role: "admin", reason_code: "role_change", revoked: false });
    expect(bindings[0]).toMatchObject({ role: "researcher", revoked: true });

    const scoped = await runWithTenantContext(adminSessionA(), "t037-ws-1", () =>
      service().assignMemberWorkspace(adminSessionA(), {
        membershipId: MEMBER_A_TARGET,
        workspaceId: WORKSPACE_A1,
        reasonCode: "membership.ws-ok",
        correlationId: "t037-ws-1",
        idempotencyKey: "t037-ws-1",
      }));
    expect(scoped.membership.workspaceId).toBe(WORKSPACE_A1);

    const disabled = await runWithTenantContext(adminSessionA(), "t037-disable-1", () =>
      service().disableMember(adminSessionA(), {
        membershipId: MEMBER_A_TARGET,
        reasonCode: "membership.disable-ok",
        correlationId: "t037-disable-1",
        idempotencyKey: "t037-disable-1",
      }));
    expect(disabled.membership.status).toBe("disabled");
    // Disable keeps the open binding so reactivation can restore the role.
    bindings = await bindingRows(MEMBER_A_TARGET);
    expect(bindings[1].revoked).toBe(false);

    const reactivated = await runWithTenantContext(adminSessionA(), "t037-reactivate-1", () =>
      service().reactivateMember(adminSessionA(), {
        membershipId: MEMBER_A_TARGET,
        reasonCode: "membership.reactivate-ok",
        correlationId: "t037-reactivate-1",
        idempotencyKey: "t037-reactivate-1",
      }));
    expect(reactivated.membership.status).toBe("active");
    expect(reactivated.membership.role).toBe("admin");

    const revoked = await runWithTenantContext(adminSessionA(), "t037-revoke-1", () =>
      service().revokeMember(adminSessionA(), {
        membershipId: MEMBER_A_TARGET,
        reasonCode: "membership.revoke-ok",
        correlationId: "t037-revoke-1",
        idempotencyKey: "t037-revoke-1",
      }));
    expect(revoked.membership.status).toBe("revoked");
    expect(revoked.membership.role).toBeNull();
    bindings = await bindingRows(MEMBER_A_TARGET);
    expect(bindings.every((binding) => binding.revoked === true)).toBe(true);

    // Every mutation above journaled and audited once.
    const journal = await journalRows();
    for (const operation of ["assign_role", "assign_workspace", "disable", "reactivate", "revoke"]) {
      expect(journal.filter((row) => row.operation === operation && row.status === "completed"))
        .toHaveLength(1);
    }
    const audit = await auditRows();
    for (const correlation of ["t037-role-1", "t037-ws-1", "t037-disable-1", "t037-reactivate-1", "t037-revoke-1"]) {
      expect(audit.filter((row) => row.correlation_id === correlation)).toHaveLength(1);
    }
  });

  it("enforces the last-owner guard and commits an atomic replacement swap", async () => {
    // MEMBER_A_OWNER is tenant A's sole active owner: demoting without a
    // replacement is refused with OWNER_GUARD and mutates nothing.
    await expect(
      runWithTenantContext(ownerSessionA(), "t037-owner-guard", () =>
        service().assignMemberRole(ownerSessionA(), {
          membershipId: MEMBER_A_OWNER,
          role: "admin",
          reasonCode: "membership.owner-guard",
          correlationId: "t037-owner-guard",
          idempotencyKey: "t037-owner-guard",
        })),
    ).rejects.toMatchObject({ code: "OWNER_GUARD" });
    expect((await membershipRow(MEMBER_A_OWNER))!.status).toBe("active");
    expect(await bindingRows(MEMBER_A_OWNER)).toHaveLength(1);

    // With an eligible replacement the swap is atomic: target demoted to
    // admin, candidate promoted to owner with an owner_replacement binding.
    const swapped = await runWithTenantContext(ownerSessionA(), "t037-owner-swap", () =>
      service().assignMemberRole(ownerSessionA(), {
        membershipId: MEMBER_A_OWNER,
        role: "admin",
        replacementOwnerMembershipId: MEMBER_A_REPLACEMENT,
        reasonCode: "membership.owner-swap",
        correlationId: "t037-owner-swap",
        idempotencyKey: "t037-owner-swap",
      }));
    expect(swapped.membership.role).toBe("admin");
    expect(swapped.replacementMembership?.role).toBe("owner");

    const ownerBindings = await bindingRows(MEMBER_A_OWNER);
    expect(ownerBindings[1]).toMatchObject({ role: "admin", reason_code: "role_change" });
    const replacementBindings = await bindingRows(MEMBER_A_REPLACEMENT);
    expect(replacementBindings[1]).toMatchObject({ role: "owner", reason_code: "owner_replacement" });
    expect(replacementBindings[0].revoked).toBe(true);

    const journal = (await journalRows()).filter((row) => row.operation === "assign_role" && row.status === "completed");
    expect(journal.some((row) => row.replacement_membership_id === MEMBER_A_REPLACEMENT)).toBe(true);
  });

  it("scopes member-RLS reads and cross-tenant targets to the accepted slice", async () => {
    // A workspace-scoped admin sees tenant-wide and same-workspace members,
    // never members of another workspace.
    const list = await runWithTenantContext(wsAdminSessionA(), "t037-list-ws", () =>
      service().listCurrent(wsAdminSessionA()));
    const ids = list.map((view) => view.membershipId);
    // Tenant-wide members are visible; another workspace's members are not.
    expect(ids).toContain(MEMBER_A_OWNER);
    expect(ids).not.toContain(MEMBER_A_WS2_TARGET);

    // Disabling an out-of-slice member resolves to the non-enumerating
    // not-found code rather than a scope disclosure.
    await expect(
      runWithTenantContext(wsAdminSessionA(), "t037-ws-boundary", () =>
        service().disableMember(wsAdminSessionA(), {
          membershipId: MEMBER_A_WS2_TARGET,
          reasonCode: "membership.ws-boundary",
          correlationId: "t037-ws-boundary",
          idempotencyKey: "t037-ws-boundary",
        })),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND_OR_FORBIDDEN" });
    expect((await membershipRow(MEMBER_A_WS2_TARGET))!.status).toBe("active");

    // A cross-tenant target is equally non-enumerating for a tenant-A admin.
    await expect(
      runWithTenantContext(adminSessionA(), "t037-cross-tenant", () =>
        service().disableMember(adminSessionA(), {
          membershipId: MEMBER_B_OWNER,
          reasonCode: "membership.cross-tenant",
          correlationId: "t037-cross-tenant",
          idempotencyKey: "t037-cross-tenant",
        })),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND_OR_FORBIDDEN" });
    expect((await membershipRow(MEMBER_B_OWNER))!.status).toBe("active");

    // A non-capable member gets the canonical permission denial.
    await expect(
      runWithTenantContext(researcherSessionA(), "t037-researcher", () =>
        service().disableMember(researcherSessionA(), {
          membershipId: MEMBER_A_TARGET,
          reasonCode: "membership.researcher",
          correlationId: "t037-researcher",
          idempotencyKey: "t037-researcher",
        })),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("keeps journal and mutation lanes honest under direct EXECUTE calls", async () => {
    await runWithTenantContext(adminSessionA(), "t037-direct", () =>
      withTenantDbContext(async (db) => {
        // A forged actor membership cannot reserve another member's lane.
        const forged = await db.prepare(
          `SELECT outcome FROM public.novatrade_membership_journal_reserve(?)`,
        ).all<{ outcome: string }>(JSON.stringify({
          idempotencyKeyHash: "a".repeat(64),
          inputHash: "b".repeat(64),
          tenantId: TENANT_A,
          actorMembershipId: MEMBER_A_OWNER,
          actorRoleBindingId: BINDING_A_OWNER,
          operation: "disable",
          targetMembershipId: MEMBER_A_TARGET,
          replacementMembershipId: null,
        }));
        expect(forged).toEqual([{ outcome: "denied" }]);

        // Malformed payloads fail closed.
        const malformed = await db.prepare(
          `SELECT outcome FROM public.novatrade_membership_journal_reserve(?)`,
        ).all<{ outcome: string }>(JSON.stringify({
          idempotencyKeyHash: "not-a-hash",
          inputHash: "b".repeat(64),
          tenantId: TENANT_A,
          actorMembershipId: MEMBER_A_ADMIN,
          actorRoleBindingId: BINDING_A_ADMIN,
          operation: "disable",
          targetMembershipId: MEMBER_A_TARGET,
        }));
        expect(malformed).toEqual([{ outcome: "invalid_request" }]);

        // A cross-tenant target inside apply_mutation resolves to the same
        // non-enumerating state conflict — nothing mutates.
        const crossTenant = await db.prepare(
          `SELECT outcome FROM public.novatrade_membership_apply_mutation(?)`,
        ).all<{ outcome: string }>(JSON.stringify({
          targetMembershipId: MEMBER_B_OWNER,
          actorMembershipId: MEMBER_A_ADMIN,
          expectedStatus: ["active"],
          status: "disabled",
          expectedWorkspaceId: null,
          expectedCurrentRoleBindingId: null,
          expectedCurrentRole: null,
          effectiveAt: new Date().toISOString(),
        }));
        expect(crossTenant).toEqual([{ outcome: "state_conflict" }]);

        const forgedActor = await db.prepare(
          `SELECT outcome FROM public.novatrade_membership_apply_mutation(?)`,
        ).all<{ outcome: string }>(JSON.stringify({
          targetMembershipId: MEMBER_A_TARGET,
          actorMembershipId: MEMBER_A_OWNER,
          expectedStatus: ["active"],
          status: "disabled",
          expectedWorkspaceId: WORKSPACE_A1,
          expectedCurrentRoleBindingId: null,
          expectedCurrentRole: "admin",
          effectiveAt: new Date().toISOString(),
        }));
        expect(forgedActor).toEqual([{ outcome: "denied" }]);

        // create_pending refuses a foreign inviter and a foreign workspace.
        const strayInviter = await db.prepare(
          `SELECT record FROM public.novatrade_membership_create_pending(?)`,
        ).all<{ record: unknown }>(JSON.stringify({
          membershipId: crypto.randomUUID(),
          tenantId: TENANT_A,
          pendingIdentityRefHash: "c".repeat(64),
          workspaceId: null,
          invitedByMembershipId: MEMBER_A_OWNER,
          role: "researcher",
          effectiveAt: new Date().toISOString(),
        }));
        expect(strayInviter).toHaveLength(0);

        // Audit append refuses an event whose actor disagrees with context.
        const forgedAudit = await db.prepare(
          `SELECT applied FROM public.novatrade_membership_audit_append(?)`,
        ).all<{ applied: boolean }>(JSON.stringify({
          action: "tenant.membership.mutated",
          tenantId: TENANT_A,
          operation: "disable",
          targetMembershipId: MEMBER_A_TARGET,
          actor: {
            authIdentityId: ACTOR_A_OWNER,
            membershipId: MEMBER_A_OWNER,
            role: "owner",
            roleBindingId: BINDING_A_OWNER,
          },
          before: null,
          after: { workspaceId: null },
          correlationId: "t037-direct",
        }));
        expect(forgedAudit).toEqual([{ applied: false }]);
      }));
  });

  it("fails closed without a member context and on a suspended tenant", async () => {
    await expect(
      service().disableMember(adminSessionA(), {
        membershipId: MEMBER_A_TARGET,
        reasonCode: "membership.no-context",
        correlationId: "t037-no-context",
        idempotencyKey: "t037-no-context",
      }),
    ).rejects.toThrow();

    // A suspended tenant cannot produce a member context — every write path
    // fails closed and the target stays untouched.
    await admin.unsafe("UPDATE public.tenants SET status = 'suspended' WHERE id = $1", [TENANT_A]);
    try {
      await expect(
        runWithTenantContext(adminSessionA(), "t037-suspended", () =>
          service().disableMember(adminSessionA(), {
            membershipId: MEMBER_A_TARGET,
            reasonCode: "membership.suspended",
            correlationId: "t037-suspended",
            idempotencyKey: "t037-suspended",
          })),
      ).rejects.toThrow();
    } finally {
      await admin.unsafe("UPDATE public.tenants SET status = 'active' WHERE id = $1", [TENANT_A]);
    }
  });
});
