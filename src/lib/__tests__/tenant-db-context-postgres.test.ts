import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb, getDb, withTenantDbContext, type DbClient } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { runWithWorkerTenantContext } from "@/lib/tenancy/worker-context";
import type { TenantSession } from "@/lib/auth";
import type { TenantWorkerAuthorization } from "@/lib/internal-worker-auth";

/**
 * T-030 disposable-Postgres rehearsal for the canonical tenant database
 * transaction boundary (`withTenantDbContext` in src/lib/db/index.ts).
 *
 * tenant-db-context.test.ts verifies the AsyncLocalStorage contract against a
 * mock client; tenant-foundation-rls-postgres.test.ts (T-027) proves the RLS
 * policies respond to hand-installed `app.*` GUCs. This lane joins them
 * end-to-end: accepted member/worker context -> installTransactionLocalContext
 * -> transaction-local set_config -> real RLS row filtering under a restricted
 * NOSUPERUSER NOBYPASSRLS runtime role, all through the production
 * PostgresClient.
 *
 * Requires a disposable database named `t030_db_context_rehearsal` holding the
 * migrated schema plus a `t030_runtime` role granted foundation-table CRUD and
 * EXECUTE on the T-027 RLS context helpers. See docs/TESTING.md for
 * provisioning.
 */

const RUN = process.env.T030_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t030_db_context_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-000000000031";
const TENANT_B = "00000000-0000-4000-8000-000000000032";
const WORKSPACE_A1 = "10000000-0000-4000-8000-000000000031";
const WORKSPACE_A2 = "10000000-0000-4000-8000-000000000032";
const WORKSPACE_B1 = "10000000-0000-4000-8000-000000000033";
const MEMBER_A = "20000000-0000-4000-8000-000000000031";
const MEMBER_A2 = "20000000-0000-4000-8000-000000000032";
const MEMBER_B = "20000000-0000-4000-8000-000000000033";
const BINDING_A = "30000000-0000-4000-8000-000000000031";
const BINDING_A2 = "30000000-0000-4000-8000-000000000032";
const BINDING_B = "30000000-0000-4000-8000-000000000033";
const ACTOR_A = "50000000-0000-4000-8000-000000000031";
const ACTOR_A2 = "50000000-0000-4000-8000-000000000032";
const ACTOR_B = "50000000-0000-4000-8000-000000000033";
const POLICY_A = "90000000-0000-4000-8000-000000000031";
const POLICY_B = "90000000-0000-4000-8000-000000000032";
const JOB_A = "60000000-0000-4000-8000-000000000031";
const RUN_A = "70000000-0000-4000-8000-000000000031";
const LEASE_A = "80000000-0000-4000-8000-000000000031";

const MEMBERSHIP_IDS = [MEMBER_A, MEMBER_A2, MEMBER_B];
const BINDING_IDS = [BINDING_A, BINDING_A2, BINDING_B];
const WORKSPACE_IDS = [WORKSPACE_A1, WORKSPACE_A2, WORKSPACE_B1];
const TENANT_IDS = [TENANT_A, TENANT_B];
const POLICY_IDS = [POLICY_A, POLICY_B];

const FOUNDATION_TABLES = [
  "tenants",
  "workspaces",
  "tenant_memberships",
  "tenant_role_bindings",
  "tenant_policies",
  "support_access_grants",
  "support_access_grant_permissions",
  "support_access_grant_data_classes",
];

function memberSession(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A,
    email: "t030-owner-a@example.test",
    displayName: "T030 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A,
    role: "owner",
    roleBindingId: BINDING_A,
    ...overrides,
  };
}

function workerAuthorization(tenantId: string, workspaceId: string | null): TenantWorkerAuthorization {
  return {
    source: "cron",
    context: {
      tenantId,
      workspaceId,
      jobId: JOB_A,
      runId: RUN_A,
      leaseId: LEASE_A,
      leaseGeneration: 3,
      workerName: "crawl",
      action: "crawl:process",
      sourcePrincipalKind: "cron",
      correlationId: "t030-worker-correlation",
    },
  };
}

async function readGucs(db: DbClient): Promise<Record<string, string | null>> {
  const row = await db.prepare(`
    SELECT
      current_setting('app.tenant_id', true) AS tenant_id,
      current_setting('app.workspace_id', true) AS workspace_id,
      current_setting('app.actor_id', true) AS actor_id,
      current_setting('app.membership_id', true) AS membership_id,
      current_setting('app.role', true) AS role,
      current_setting('app.role_binding_id', true) AS role_binding_id,
      current_setting('app.support_grant_id', true) AS support_grant_id,
      current_setting('app.worker_name', true) AS worker_name,
      current_setting('app.worker_principal_kind', true) AS worker_principal_kind
  `).get<Record<string, string | null>>();
  if (!row) throw new Error("T-030 GUC read returned no row");
  return row;
}

async function visibleIds(db: DbClient, table: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT id::text AS id FROM public.${table} ORDER BY id`).all<{ id: string }>();
  return rows.map((row) => row.id);
}

type ConnectionReceipt = {
  database_name: string;
  server_addr: string;
  server_port: number | null;
  postmaster_started_at: string;
  server_version_num: number;
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

describe.skipIf(!RUN)("T-030 tenant database context boundary on Postgres", () => {
  const admin = postgres(process.env.T030_ADMIN_DATABASE_URL ?? "postgres://invalid", { max: 1, connect_timeout: 5 });
  const runtime = postgres(process.env.DATABASE_URL ?? "postgres://invalid", { max: 1, connect_timeout: 5 });
  let targetValidated = false;

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
    if (rows.length !== 1) throw new Error("T-030 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T030_ADMIN_DATABASE_URL) {
      throw new Error("T-030 disposable test requires DATABASE_URL and T030_ADMIN_DATABASE_URL");
    }
    if (!process.env.T030_RUNTIME_ROLE) {
      throw new Error("T-030 disposable test requires T030_RUNTIME_ROLE");
    }
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-030 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-030 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-030 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T030_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-030 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }
    if ((!adminReceipt.rolsuper && !adminReceipt.rolbypassrls) || adminReceipt.current_user === runtimeReceipt.current_user) {
      throw new Error("T-030 preflight refused: admin must be a privileged non-runtime owner");
    }

    const posture = await admin.unsafe<{ tablename: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(`
      SELECT cls.relname AS tablename, cls.relrowsecurity, cls.relforcerowsecurity
      FROM pg_catalog.pg_class AS cls
      WHERE cls.relnamespace = 'public'::regnamespace
        AND cls.relname = ANY($1::text[])
      ORDER BY cls.relname
    `, [FOUNDATION_TABLES]);
    if (posture.length !== FOUNDATION_TABLES.length
      || posture.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)) {
      throw new Error("T-030 preflight refused: every foundation table must have enabled and forced RLS");
    }

    const helpers = await admin.unsafe<{ proname: string; prosecdef: boolean }[]>(`
      SELECT p.proname, p.prosecdef
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('novatrade_rls_member_context', 'novatrade_rls_support_context')
      ORDER BY p.proname
    `);
    if (helpers.length !== 2 || helpers.some((row) => !row.prosecdef)) {
      throw new Error("T-030 preflight refused: RLS context helpers must be SECURITY DEFINER");
    }
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-030 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't030-tenant-a', 'Context Tenant A', 'active'), ($2, 't030-tenant-b', 'Context Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
          ($1, $2, 't030-ws-a1', 'Context Workspace A1', 'active'),
          ($3, $2, 't030-ws-a2', 'Context Workspace A2', 'active'),
          ($4, $5, 't030-ws-b1', 'Context Workspace B1', 'active')`,
        [WORKSPACE_A1, TENANT_A, WORKSPACE_A2, WORKSPACE_B1, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status) VALUES
          ($1, $2, $3, NULL, 'active'),
          ($4, $2, $5, $6, 'active'),
          ($7, $8, $9, $10, 'active')`,
        [MEMBER_A, TENANT_A, ACTOR_A, MEMBER_A2, ACTOR_A2, WORKSPACE_A2, MEMBER_B, TENANT_B, ACTOR_B, WORKSPACE_B1],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, valid_from, revoked_at) VALUES
          ($1, $2, $3, 'owner', now() - interval '1 minute', null),
          ($4, $2, $5, 'reviewer', now() - interval '1 minute', null),
          ($6, $7, $8, 'researcher', now() - interval '1 minute', null)`,
        [BINDING_A, TENANT_A, MEMBER_A, BINDING_A2, MEMBER_A2, BINDING_B, TENANT_B, MEMBER_B],
      );
      await tx.unsafe(
        "INSERT INTO public.tenant_policies (id, tenant_id) VALUES ($1, $2), ($3, $4)",
        [POLICY_A, TENANT_A, POLICY_B, TENANT_B],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx.unsafe("DELETE FROM public.tenant_policies WHERE id = ANY($1::uuid[])", [POLICY_IDS]);
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id = ANY($1::uuid[])", [BINDING_IDS]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id = ANY($1::uuid[])", [MEMBERSHIP_IDS]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [WORKSPACE_IDS]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [TENANT_IDS]);
    });
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

  it("installs member GUCs through the production adapter and enforces tenant isolation", async () => {
    await runWithTenantContext(memberSession(), "t030-member-a-tenant-wide", () =>
      withTenantDbContext(async (db) => {
        expect(await readGucs(db)).toMatchObject({
          tenant_id: TENANT_A,
          workspace_id: "",
          actor_id: ACTOR_A,
          membership_id: MEMBER_A,
          role: "owner",
          role_binding_id: BINDING_A,
          support_grant_id: "",
          worker_name: "",
        });
        expect(await visibleIds(db, "tenants")).toEqual([TENANT_A]);
        expect(await visibleIds(db, "workspaces")).toEqual([WORKSPACE_A1, WORKSPACE_A2]);
        expect(await visibleIds(db, "tenant_memberships")).toEqual([MEMBER_A, MEMBER_A2]);
        expect(await visibleIds(db, "tenant_role_bindings")).toEqual([BINDING_A, BINDING_A2]);
        expect(await visibleIds(db, "tenant_policies")).toEqual([POLICY_A]);
      }),
    );
  });

  it("scopes member visibility to the session workspace", async () => {
    await runWithTenantContext(memberSession({ workspaceId: WORKSPACE_A1 }), "t030-member-a-ws-scoped", () =>
      withTenantDbContext(async (db) => {
        expect((await readGucs(db)).workspace_id).toBe(WORKSPACE_A1);
        expect(await visibleIds(db, "tenants")).toEqual([TENANT_A]);
        expect(await visibleIds(db, "workspaces")).toEqual([WORKSPACE_A1]);
        expect(await visibleIds(db, "tenant_memberships")).toEqual([MEMBER_A]);
        expect(await visibleIds(db, "tenant_role_bindings")).toEqual([BINDING_A]);
        expect(await visibleIds(db, "tenant_policies")).toEqual([POLICY_A]);
      }),
    );
  });

  it("enforces cross-tenant isolation for a different member context", async () => {
    await runWithTenantContext(memberSession({
      userId: ACTOR_B,
      email: "t030-researcher-b@example.test",
      displayName: "T030 Researcher B",
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B1,
      membershipId: MEMBER_B,
      role: "researcher",
      roleBindingId: BINDING_B,
    }), "t030-member-b", () =>
      withTenantDbContext(async (db) => {
        expect(await visibleIds(db, "tenants")).toEqual([TENANT_B]);
        expect(await visibleIds(db, "workspaces")).toEqual([WORKSPACE_B1]);
        expect(await visibleIds(db, "tenant_memberships")).toEqual([]);
        expect(await visibleIds(db, "tenant_role_bindings")).toEqual([]);
        expect(await visibleIds(db, "tenant_policies")).toEqual([POLICY_B]);
      }),
    );
  });

  it("denies member-context mutations on foundation tables", async () => {
    await expect(runWithTenantContext(memberSession(), "t030-member-insert", () =>
      withTenantDbContext(async (db) => {
        await db.prepare(
          "INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES (?, ?, ?, ?, ?)",
        ).run("10000000-0000-4000-8000-000000000099", TENANT_A, "t030-forged", "Forged", "active");
      }),
    )).rejects.toThrow();
    const survivors = await admin.unsafe<{ count: string }[]>(
      "SELECT count(*)::text AS count FROM public.workspaces WHERE slug = 't030-forged'",
    );
    expect(survivors[0]?.count).toBe("0");
  });

  it("installs worker GUCs without manufacturing member visibility", async () => {
    await runWithWorkerTenantContext(workerAuthorization(TENANT_A, null), () =>
      withTenantDbContext(async (db) => {
        expect(await readGucs(db)).toMatchObject({
          tenant_id: TENANT_A,
          membership_id: "",
          role: "",
          worker_name: "crawl",
          worker_principal_kind: "cron",
        });
        expect(await visibleIds(db, "tenants")).toEqual([]);
        expect(await visibleIds(db, "workspaces")).toEqual([]);
        expect(await visibleIds(db, "tenant_policies")).toEqual([]);
      }),
    );
  });

  it("rejects missing and mixed contexts and reuses the transaction client for identical nesting", async () => {
    await expect(withTenantDbContext(async () => undefined)).rejects.toMatchObject({
      code: "TENANT_DB_CONTEXT_REQUIRED",
    });

    await runWithTenantContext(memberSession(), "t030-nested", () =>
      withTenantDbContext(async (outerDb) => {
        await expect(runWithWorkerTenantContext(workerAuthorization(TENANT_B, null), () =>
          withTenantDbContext(async () => undefined),
        )).rejects.toMatchObject({ code: "TENANT_DB_CONTEXT_CONFLICT" });
        await withTenantDbContext(async (nestedDb) => {
          expect(nestedDb).toBe(outerDb);
          expect(await visibleIds(nestedDb, "tenants")).toEqual([TENANT_A]);
        });
      }),
    );
  });

  it("clears transaction-local GUCs after commit and rollback on the pooled connection", async () => {
    await runWithTenantContext(memberSession(), "t030-commit", () =>
      withTenantDbContext(async (db) => {
        expect((await readGucs(db)).tenant_id).toBe(TENANT_A);
      }),
    );
    await expect(runWithTenantContext(memberSession(), "t030-rollback", () =>
      withTenantDbContext(async (db) => {
        expect((await readGucs(db)).tenant_id).toBe(TENANT_A);
        throw new Error("synthetic rollback");
      }),
    )).rejects.toThrow("synthetic rollback");

    const pooled = await (await getDb()).prepare(`
      SELECT
        NULLIF(current_setting('app.tenant_id', true), '') AS tenant_id,
        NULLIF(current_setting('app.membership_id', true), '') AS membership_id,
        NULLIF(current_setting('app.worker_name', true), '') AS worker_name
    `).get<{ tenant_id: string | null; membership_id: string | null; worker_name: string | null }>();
    expect(pooled).toEqual({ tenant_id: null, membership_id: null, worker_name: null });
  });
});
