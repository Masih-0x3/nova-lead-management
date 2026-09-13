import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb, withTenantDbContext } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { createPostgresTenantLifecycleService } from "@/lib/tenancy/postgres-lifecycle";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the tenant status-transition write
 * path — the fourth Postgres-backed service-port adapter after
 * T-031/T-032/T-033.
 *
 * The canonical lifecycle transition is unit-verified against the SQLite
 * backend; this lane proves the Postgres twin end-to-end:
 * createPostgresTenantLifecycleService resolves the member context through
 * withTenantDbContext and drives suspend/resume/archive through the
 * SECURITY DEFINER novatrade_transition_tenant_status (migration
 * 202609120007). `tenants` is a foundation table whose write posture denies
 * every member-context mutation, so the function is the only member-facing
 * transition path: it re-validates the member GUCs database-side, binds
 * request tenant/actor to the accepted context, applies the canonical
 * transition matrix's member edges (active ↔ suspended, → archived), CAS-
 * updates the status, and appends the member-layer audit row atomically.
 * The deletion edges (archived → deletion_pending, deletion_pending →
 * archived/deleted) mutate the deletion-job ledger and are deliberately not
 * exposed here.
 *
 * Requires a disposable database named `t034_lifecycle_rehearsal` holding the
 * migrated schema plus migration 202609120007, and a `t034_runtime` role
 * granted foundation-table CRUD, EXECUTE on the four novatrade_rls_*
 * helpers, and EXECUTE on the transition function. `DATABASE_URL` is staged
 * to the runtime role with `DATABASE_SSL=disable` (the production
 * PostgresClient requires TLS otherwise). See docs/TESTING.md for
 * provisioning.
 */

const RUN = process.env.T034_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t034_lifecycle_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-000000000071";
const TENANT_B = "00000000-0000-4000-8000-000000000072";
const WORKSPACE_A1 = "10000000-0000-4000-8000-000000000071";
const MEMBER_A = "20000000-0000-4000-8000-000000000071";
const MEMBER_B = "20000000-0000-4000-8000-000000000072";
const BINDING_A = "30000000-0000-4000-8000-000000000071";
const BINDING_B = "30000000-0000-4000-8000-000000000072";
const ACTOR_A = "50000000-0000-4000-8000-000000000071";
const ACTOR_B = "50000000-0000-4000-8000-000000000072";

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A,
    email: "t034-owner-a@example.test",
    displayName: "T034 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A,
    role: "owner",
    roleBindingId: BINDING_A,
    ...overrides,
  };
}

function researcherSessionB(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_B,
    email: "t034-researcher-b@example.test",
    displayName: "T034 Researcher B",
    tenantId: TENANT_B,
    workspaceId: null,
    membershipId: MEMBER_B,
    role: "researcher",
    roleBindingId: BINDING_B,
    ...overrides,
  };
}

function transitionInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A,
    actor: { authIdentityId: ACTOR_A, layer: "member" as const, membershipId: MEMBER_A },
    expectedCurrentState: "active" as const,
    reasonCode: "ops.suspend",
    reason: "t034 rehearsal transition",
    correlationId: "t034-transition",
    ...overrides,
  };
}

describe.skipIf(!RUN)("T-034 tenant status transitions on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-034 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T034_ADMIN_DATABASE_URL) {
      throw new Error("T-034 disposable test requires DATABASE_URL and T034_ADMIN_DATABASE_URL");
    }
    if (!process.env.T034_RUNTIME_ROLE) {
      throw new Error("T-034 disposable test requires T034_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T034_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-034 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-034 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-034 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T034_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-034 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; owner_super: boolean | null; owner_bypass: boolean | null; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             owner_role.rolsuper AS owner_super,
             owner_role.rolbypassrls AS owner_bypass,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
      WHERE n.nspname = 'public' AND p.proname = 'novatrade_transition_tenant_status'
    `);
    if (posture.length !== 1 || posture.some((fn) =>
      !fn.prosecdef || (!fn.owner_super && !fn.owner_bypass) || fn.anon_execute || fn.authenticated_execute)) {
      throw new Error("T-034 preflight refused: the transition function must be SECURITY DEFINER owned by a privileged role with no anon/authenticated EXECUTE");
    }

    // Prove the production PostgresClient itself connects — without this, a
    // transport failure (e.g. missing DATABASE_SSL=disable) is swallowed by
    // the service's non-enumerating error mapping and masquerades as a
    // designed denial.
    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-034 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-034 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't034-tenant-a', 'Lifecycle Tenant A', 'active'), ($2, 't034-tenant-b', 'Lifecycle Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES ($1, $2, 't034-ws-a1', 'Lifecycle Workspace A1', 'active')",
        [WORKSPACE_A1, TENANT_A],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status) VALUES
          ($1, $2, $3, NULL, 'active'),
          ($4, $5, $6, NULL, 'active')`,
        [MEMBER_A, TENANT_A, ACTOR_A, MEMBER_B, TENANT_B, ACTOR_B],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, valid_from, revoked_at) VALUES
          ($1, $2, $3, 'owner', now() - interval '1 minute', null),
          ($4, $5, $6, 'researcher', now() - interval '1 minute', null)`,
        [BINDING_A, TENANT_A, MEMBER_A, BINDING_B, TENANT_B, MEMBER_B],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    // The audit log is append-only — the privileged cleanup disables its
    // triggers, matching the T-031 lane's pattern. Audit rows hold an FK to
    // the fixture role bindings, so they must go first.
    await admin.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
    try {
      await admin.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE $1 OR tenant_id = ANY($2::uuid[])", ["t034-%", [TENANT_A, TENANT_B]]);
    } finally {
      await admin.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
    }
    await admin.begin(async (tx) => {
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id = ANY($1::uuid[])", [[BINDING_A, BINDING_B]]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id = ANY($1::uuid[])", [[MEMBER_A, MEMBER_B]]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [[WORKSPACE_A1]]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
    });
  }

  async function tenantStatus(tenantId: string): Promise<string> {
    const rows = await admin.unsafe<{ status: string }[]>(
      "SELECT status::text AS status FROM public.tenants WHERE id = $1",
      [tenantId],
    );
    return rows[0]?.status ?? "";
  }

  async function resetTenantA(status: "active" | "suspended" | "archived" = "active"): Promise<void> {
    await admin.unsafe("UPDATE public.tenants SET status = $1 WHERE id = $2", [status, TENANT_A]);
  }

  async function auditRows(correlationId: string): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT action, scope_kind, tenant_id::text, workspace_id::text, correlation_id,
              actor_auth_identity_id::text, actor_membership_id::text,
              actor_launch_role, actor_role_binding_id::text, actor_layer, actor_email, metadata
       FROM public.audit_logs WHERE correlation_id = $1 ORDER BY created_at`,
      [correlationId],
    );
  }

  beforeAll(async () => {
    await assertDisposableTarget();
    await fixture();
  });

  afterAll(async () => {
    await closeDb();
    if (targetValidated) await cleanRows();
    await runtime.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  });

  it("suspends an active tenant through the canonical path and writes the member audit row", async () => {
    await resetTenantA("active");
    const service = createPostgresTenantLifecycleService();
    const result = await runWithTenantContext(ownerSessionA(), "t034-suspend-1", () =>
      service.suspend(transitionInput({ correlationId: "t034-suspend-1" })));
    expect(result.code).toBe("OK_SUSPENDED");
    expect(result.tenant).toMatchObject({ id: TENANT_A, status: "suspended" });
    expect(await tenantStatus(TENANT_A)).toBe("suspended");

    const audit = await auditRows("t034-suspend-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "tenant.suspended",
      scope_kind: "tenant",
      tenant_id: TENANT_A,
      workspace_id: null,
      correlation_id: "t034-suspend-1",
      actor_auth_identity_id: ACTOR_A,
      actor_membership_id: MEMBER_A,
      actor_launch_role: "owner",
      actor_role_binding_id: BINDING_A,
      actor_layer: "member",
      actor_email: null,
    });
    expect(audit[0].metadata).toMatchObject({
      eventType: "tenant.suspended",
      tenantFromStatus: "active",
      tenantToStatus: "suspended",
      reasonCode: "ops.suspend",
    });
  });

  it("archives an active tenant and returns the post-transition row the dead member context can no longer read", async () => {
    await resetTenantA("active");
    const service = createPostgresTenantLifecycleService();
    const archived = await runWithTenantContext(ownerSessionA(), "t034-archive-1", () =>
      service.archive(transitionInput({ expectedCurrentState: "active", correlationId: "t034-archive-1" })));
    expect(archived.code).toBe("OK_ARCHIVED");
    // The member context dies with the status flip — the function returns
    // the committed row itself; a member-RLS re-read cannot see it.
    expect(archived.tenant).toMatchObject({ id: TENANT_A, status: "archived" });
    expect(await tenantStatus(TENANT_A)).toBe("archived");
    const audit = await auditRows("t034-archive-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "tenant.archived", actor_layer: "member" });
  });

  it("fails closed on member-initiated resume — a suspended tenant has no member context", async () => {
    await resetTenantA("suspended");
    const service = createPostgresTenantLifecycleService();
    // novatrade_rls_member_context requires an active tenant, so the member
    // path cannot resume; resume belongs to a support/platform context lane.
    await expect(runWithTenantContext(ownerSessionA(), "t034-resume-1", () =>
      service.resume(transitionInput({ expectedCurrentState: "suspended", correlationId: "t034-resume-1" })),
    )).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
    expect(await tenantStatus(TENANT_A)).toBe("suspended");
    expect(await auditRows("t034-resume-1")).toHaveLength(0);
    await resetTenantA("active");
  });

  it("maps a stale expected state and a same-status edge non-enumeratingly", async () => {
    await resetTenantA("active");
    const service = createPostgresTenantLifecycleService();
    await expect(runWithTenantContext(ownerSessionA(), "t034-stale", () =>
      service.suspend(transitionInput({ expectedCurrentState: "suspended", correlationId: "t034-stale" })),
    )).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
    expect(await tenantStatus(TENANT_A)).toBe("active");
    expect(await auditRows("t034-stale")).toHaveLength(0);

    // active → active is not an edge in the canonical matrix (the member
    // context must stay valid, so the illegal edge has to start active).
    await expect(runWithTenantContext(ownerSessionA(), "t034-samestate", () =>
      service.resume(transitionInput({ expectedCurrentState: "active", correlationId: "t034-samestate" })),
    )).rejects.toMatchObject({ code: "BLOCKED_STATE_CONFLICT" });
    expect(await tenantStatus(TENANT_A)).toBe("active");
    expect(await auditRows("t034-samestate")).toHaveLength(0);
  });

  it("denies a non-owner member and a workspace-scoped owner", async () => {
    await resetTenantA("active");
    const service = createPostgresTenantLifecycleService();
    // researcher holds membership on tenant B; the transition still requires
    // the owner/admin tenant:lifecycle capability.
    await expect(runWithTenantContext(researcherSessionB(), "t034-role", () =>
      service.suspend(transitionInput({
        tenantId: TENANT_B,
        actor: { authIdentityId: ACTOR_B, layer: "member", membershipId: MEMBER_B },
        correlationId: "t034-role",
      })),
    )).rejects.toMatchObject({ code: "BLOCKED_ACTOR_SCOPE" });
    expect(await tenantStatus(TENANT_B)).toBe("active");
    expect(await auditRows("t034-role")).toHaveLength(0);

    // A workspace-scoped owner session cannot produce a tenant-scoped audit
    // row — the function requires a tenant-wide member context.
    await expect(runWithTenantContext(ownerSessionA({ workspaceId: WORKSPACE_A1 }), "t034-ws", () =>
      service.suspend(transitionInput({ correlationId: "t034-ws" })),
    )).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
    expect(await tenantStatus(TENANT_A)).toBe("active");
  });

  it("refuses cross-tenant scope and a missing member context fail-closed", async () => {
    await resetTenantA("active");
    const service = createPostgresTenantLifecycleService();
    await expect(runWithTenantContext(ownerSessionA(), "t034-cross", () =>
      service.suspend(transitionInput({ tenantId: TENANT_B, correlationId: "t034-cross" })),
    )).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
    expect(await tenantStatus(TENANT_B)).toBe("active");
    expect(await auditRows("t034-cross")).toHaveLength(0);

    await expect(service.suspend(transitionInput({ correlationId: "t034-noctx" })))
      .rejects.toThrow();
    expect(await tenantStatus(TENANT_A)).toBe("active");
  });

  it("refuses direct-call bypasses inside the function", async () => {
    await resetTenantA("active");
    const validPayload = () => ({
      tenantId: TENANT_A,
      actorId: ACTOR_A,
      expectedCurrentState: "active",
      toStatus: "suspended",
      reasonCode: "ops.suspend",
      reason: "t034 direct rehearsal",
      correlationId: "t034-direct",
      auditEventId: "80000000-0000-4000-8000-000000000071",
    });
    const callDirect = (payload: Record<string, unknown>, session: TenantSession = ownerSessionA()) =>
      runWithTenantContext(session, "t034-direct", () =>
        withTenantDbContext((db) =>
          db.prepare("SELECT outcome FROM public.novatrade_transition_tenant_status($1)").all<{ outcome: string }>(JSON.stringify(payload)),
        ),
      );

    // Out-of-scope request fields deny non-enumeratingly.
    expect((await callDirect({ ...validPayload(), tenantId: TENANT_B }))[0]?.outcome).toBe("denied");
    expect((await callDirect({ ...validPayload(), actorId: ACTOR_B }))[0]?.outcome).toBe("denied");
    // The deletion edges are not exposed: deletion_pending as source or
    // target is malformed for the member-facing transition.
    expect((await callDirect({ ...validPayload(), toStatus: "deletion_pending" }))[0]?.outcome).toBe("invalid_request");
    expect((await callDirect({ ...validPayload(), expectedCurrentState: "deletion_pending", toStatus: "archived" }))[0]?.outcome).toBe("invalid_request");
    // Field-shape validation is server-side, not trusted from the caller.
    expect((await callDirect({ ...validPayload(), reasonCode: "BAD CODE!" }))[0]?.outcome).toBe("invalid_request");
    expect((await callDirect({ ...validPayload(), auditEventId: "not-a-uuid" }))[0]?.outcome).toBe("invalid_request");
    // In-context but below the owner/admin capability.
    expect((await callDirect(
      { ...validPayload(), tenantId: TENANT_B, actorId: ACTOR_B },
      researcherSessionB(),
    ))[0]?.outcome).toBe("actor_scope");
    // Nothing mutated anywhere.
    expect(await tenantStatus(TENANT_A)).toBe("active");
    expect(await tenantStatus(TENANT_B)).toBe("active");
    expect(await auditRows("t034-direct")).toHaveLength(0);
  });
});
