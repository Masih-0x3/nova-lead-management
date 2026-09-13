import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb, withTenantDbContext } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { createPostgresTenantRetentionService } from "@/lib/tenancy/postgres-retention-policy";
import { TenantRetentionPolicyChangeError } from "@/lib/tenancy/retention-policy";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the tenant retention-policy write
 * path — the second Postgres-backed service-port mutation after T-031.
 *
 * The canonical `requestRetentionChange` contract is unit-verified against
 * the SQLite adapter; this lane proves the Postgres twin end-to-end:
 * createPostgresTenantRetentionService resolves the actor from the accepted
 * member context, reads the policy under member-select RLS, and commits
 * through the SECURITY DEFINER
 * novatrade_apply_tenant_retention_policy_change — which re-validates the
 * transaction-local member GUCs database-side, enforces the schema's
 * per-knob day bounds for direct EXECUTE callers, and CAS-updates
 * tenant_policies + the member-layer audit row atomically.
 *
 * Requires a disposable database named `t032_retention_policy_rehearsal`
 * holding the migrated schema plus a `t032_runtime` role granted
 * foundation-table CRUD, EXECUTE on the four novatrade_rls_* helpers, and
 * EXECUTE on the change function. `DATABASE_URL` is staged to the runtime
 * role with `DATABASE_SSL=disable` (the production PostgresClient requires
 * TLS otherwise). See docs/TESTING.md for provisioning.
 */

const RUN = process.env.T032_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t032_retention_policy_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-000000000051";
const TENANT_B = "00000000-0000-4000-8000-000000000052";
const WORKSPACE_A1 = "10000000-0000-4000-8000-000000000051";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000052";
const MEMBER_A = "20000000-0000-4000-8000-000000000051";
const MEMBER_B = "20000000-0000-4000-8000-000000000052";
const BINDING_A = "30000000-0000-4000-8000-000000000051";
const BINDING_B = "30000000-0000-4000-8000-000000000052";
const ACTOR_A = "50000000-0000-4000-8000-000000000051";
const ACTOR_B = "50000000-0000-4000-8000-000000000052";
const POLICY_A = "90000000-0000-4000-8000-000000000051";
const POLICY_B = "90000000-0000-4000-8000-000000000052";
const AUDIT_CORRELATION_PREFIX = "t032-%";

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A,
    email: "t032-owner-a@example.test",
    displayName: "T032 Owner A",
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
    email: "t032-researcher-b@example.test",
    displayName: "T032 Researcher B",
    tenantId: TENANT_B,
    workspaceId: null,
    membershipId: MEMBER_B,
    role: "researcher",
    roleBindingId: BINDING_B,
    ...overrides,
  };
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

describe.skipIf(!RUN)("T-032 tenant retention-policy change on Postgres", () => {
  const admin = postgres(process.env.T032_ADMIN_DATABASE_URL ?? "postgres://invalid", { max: 1, connect_timeout: 5 });
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
    if (rows.length !== 1) throw new Error("T-032 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T032_ADMIN_DATABASE_URL) {
      throw new Error("T-032 disposable test requires DATABASE_URL and T032_ADMIN_DATABASE_URL");
    }
    if (!process.env.T032_RUNTIME_ROLE) {
      throw new Error("T-032 disposable test requires T032_RUNTIME_ROLE");
    }
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-032 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-032 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-032 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T032_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-032 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ prosecdef: boolean; owner_super: boolean | null; owner_bypass: boolean | null; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.prosecdef,
             owner_role.rolsuper AS owner_super,
             owner_role.rolbypassrls AS owner_bypass,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
      WHERE n.nspname = 'public' AND p.proname = 'novatrade_apply_tenant_retention_policy_change'
    `);
    const fn = posture[0];
    if (!fn || !fn.prosecdef || (!fn.owner_super && !fn.owner_bypass) || fn.anon_execute || fn.authenticated_execute) {
      throw new Error("T-032 preflight refused: change function must be SECURITY DEFINER owned by a privileged role with no anon/authenticated EXECUTE");
    }

    // Prove the production PostgresClient itself connects — without this, a
    // transport failure (e.g. missing DATABASE_SSL=disable) is swallowed by
    // the service's non-enumerating error mapping and masquerades as a
    // designed authorization denial.
    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-032 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-032 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't032-tenant-a', 'Retention Tenant A', 'active'), ($2, 't032-tenant-b', 'Retention Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
          ($1, $2, 't032-ws-a1', 'Retention Workspace A1', 'active'),
          ($3, $4, 't032-ws-b', 'Retention Workspace B', 'active')`,
        [WORKSPACE_A1, TENANT_A, WORKSPACE_B, TENANT_B],
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
      await tx.unsafe(
        "INSERT INTO public.tenant_policies (id, tenant_id) VALUES ($1, $2), ($3, $4)",
        [POLICY_A, TENANT_A, POLICY_B, TENANT_B],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    await admin.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
    try {
      await admin.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE $1", [AUDIT_CORRELATION_PREFIX]);
    } finally {
      await admin.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
    }
    await admin.begin(async (tx) => {
      await tx.unsafe("DELETE FROM public.tenant_policies WHERE id = ANY($1::uuid[])", [[POLICY_A, POLICY_B]]);
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id = ANY($1::uuid[])", [[BINDING_A, BINDING_B]]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id = ANY($1::uuid[])", [[MEMBER_A, MEMBER_B]]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [[WORKSPACE_A1, WORKSPACE_B]]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
    });
  }

  async function policyA(): Promise<{ version: number; export_retention_days: number }> {
    const rows = await admin.unsafe<{ version: number; export_retention_days: number }[]>(
      "SELECT version, export_retention_days FROM public.tenant_policies WHERE id = $1",
      [POLICY_A],
    );
    if (rows.length !== 1) throw new Error("T-032 fixture policy missing");
    return rows[0];
  }

  async function auditRows(correlationId: string): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT action, scope_kind, tenant_id::text, workspace_id::text, correlation_id,
              actor_auth_identity_id::text, actor_membership_id::text,
              actor_launch_role, actor_role_binding_id::text, actor_layer, actor_email
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

  it("applies an owner retention change through the canonical path and writes the member audit row", async () => {
    const service = createPostgresTenantRetentionService();
    const accepted = await runWithTenantContext(ownerSessionA(), "t032-change-1", () =>
      service.requestRetentionChange({
        tenantId: TENANT_A,
        knob: "export_retention_days",
        days: 5,
        expectedPolicyVersion: 1,
        reason: "t032 rehearsal tightens export retention",
        correlationId: "t032-change-1",
      }));
    expect(accepted).toMatchObject({ status: "changed", previousPolicyVersion: 1, resultingPolicyVersion: 2 });
    expect(await policyA()).toMatchObject({ version: 2, export_retention_days: 5 });

    const audit = await auditRows("t032-change-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "tenant_retention_policy_changed",
      scope_kind: "tenant",
      tenant_id: TENANT_A,
      workspace_id: null,
      correlation_id: "t032-change-1",
      actor_auth_identity_id: ACTOR_A,
      actor_membership_id: MEMBER_A,
      actor_launch_role: "owner",
      actor_role_binding_id: BINDING_A,
      actor_layer: "member",
      actor_email: null,
    });
  });

  it("rejects a non-capable member without touching policy or audit state", async () => {
    const service = createPostgresTenantRetentionService();
    const before = await policyA();
    await expect(runWithTenantContext(researcherSessionB(), "t032-change-denied", () =>
      service.requestRetentionChange({
        tenantId: TENANT_B,
        knob: "export_retention_days",
        days: 3,
        expectedPolicyVersion: 1,
        reason: "researcher must not manage retention",
        correlationId: "t032-change-denied",
      }),
    )).rejects.toMatchObject({ code: "RETENTION_MANAGER_UNAUTHORIZED" });
    expect(await policyA()).toEqual(before);
    expect(await auditRows("t032-change-denied")).toHaveLength(0);
  });

  it("enforces the per-knob day bounds at the database boundary for a direct caller", async () => {
    // The canonical service validates days against the schema, but the
    // runtime role holds EXECUTE on the function itself — a caller bypassing
    // the service under a fully valid owner member context must still be
    // refused an out-of-contract value (export_retention_days max is 7).
    const before = await policyA();
    const rows = await runtime.begin(async (tx) => {
      for (const [key, value] of [
        ["app.tenant_id", TENANT_A],
        ["app.actor_id", ACTOR_A],
        ["app.membership_id", MEMBER_A],
        ["app.role", "owner"],
        ["app.role_binding_id", BINDING_A],
        ["app.correlation_id", "t032-change-bounds"],
      ] as const) {
        await tx.unsafe("SELECT set_config($1, $2, true)", [key, value]);
      }
      return tx.unsafe<{ outcome: string; policy_version: number | null }[]>(
        `SELECT outcome, policy_version
         FROM public.novatrade_apply_tenant_retention_policy_change('exportRetentionDays', 8, $1, '{}')`,
        [before.version],
      );
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("invalid_field");
    expect(await policyA()).toEqual(before);
    expect(await auditRows("t032-change-bounds")).toHaveLength(0);
  });

  it("denies a workspace-scoped owner session inside the function", async () => {
    // The session is a valid tenant-wide owner membership but scoped to a
    // workspace: member RLS still resolves the facts, so the canonical service
    // reaches the executor — and the function itself refuses the
    // non-tenant-wide context without writing anything.
    const service = createPostgresTenantRetentionService();
    const before = await policyA();
    await expect(runWithTenantContext(ownerSessionA({ workspaceId: WORKSPACE_A1 }), "t032-change-ws", () =>
      service.requestRetentionChange({
        tenantId: TENANT_A,
        knob: "export_retention_days",
        days: before.export_retention_days === 5 ? 6 : 5,
        expectedPolicyVersion: before.version,
        reason: "workspace-scoped session must not change tenant policy",
        correlationId: "t032-change-ws",
      }),
    )).rejects.toBeInstanceOf(TenantRetentionPolicyChangeError);
    expect(await policyA()).toEqual(before);
    expect(await auditRows("t032-change-ws")).toHaveLength(0);
  });

  it("returns a version conflict from the service pre-check and from the function CAS", async () => {
    const service = createPostgresTenantRetentionService();
    const before = await policyA();
    await expect(runWithTenantContext(ownerSessionA(), "t032-change-stale", () =>
      service.requestRetentionChange({
        tenantId: TENANT_A,
        knob: "export_retention_days",
        days: 5,
        expectedPolicyVersion: 99,
        reason: "stale version must conflict",
        correlationId: "t032-change-stale",
      }),
    )).rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });

    // The deeper CAS: invoke the function directly with the stale version so a
    // race that slips past the service pre-check is still refused at the row.
    const outcome = await runWithTenantContext(ownerSessionA(), "t032-change-cas", () =>
      withTenantDbContext(async (db) =>
        db.prepare(
          "SELECT outcome, policy_version FROM public.novatrade_apply_tenant_retention_policy_change(?, ?, ?, ?)",
        ).get<{ outcome: string; policy_version: number | null }>(
          "exportRetentionDays", 5, 99, "{}",
        )),
    );
    expect(outcome).toMatchObject({ outcome: "version_conflict", policy_version: before.version });
    expect(await policyA()).toEqual(before);
    expect(await auditRows("t032-change-cas")).toHaveLength(0);
  });

  it("fails closed without a member context and on cross-tenant requests", async () => {
    const service = createPostgresTenantRetentionService();
    const before = await policyA();
    await expect(service.requestRetentionChange({
      tenantId: TENANT_A,
      knob: "export_retention_days",
      days: 5,
      expectedPolicyVersion: before.version,
      reason: "no context",
      correlationId: "t032-change-nocontext",
    })).rejects.toMatchObject({ code: "RETENTION_MANAGER_UNAUTHORIZED" });

    await expect(runWithTenantContext(ownerSessionA(), "t032-change-cross", () =>
      service.requestRetentionChange({
        tenantId: TENANT_B,
        knob: "export_retention_days",
        days: 5,
        expectedPolicyVersion: 1,
        reason: "cross-tenant request",
        correlationId: "t032-change-cross",
      }),
    )).rejects.toMatchObject({ code: "RETENTION_MANAGER_UNAUTHORIZED" });
    expect(await policyA()).toEqual(before);
    expect(await auditRows("t032-change-nocontext")).toHaveLength(0);
    expect(await auditRows("t032-change-cross")).toHaveLength(0);
  });

  it("reports unchanged when the requested value already matches policy", async () => {
    const service = createPostgresTenantRetentionService();
    const before = await policyA();
    const accepted = await runWithTenantContext(ownerSessionA(), "t032-change-noop", () =>
      service.requestRetentionChange({
        tenantId: TENANT_A,
        knob: "export_retention_days",
        days: before.export_retention_days,
        expectedPolicyVersion: before.version,
        reason: "idempotent no-op",
        correlationId: "t032-change-noop",
      }));
    expect(accepted).toMatchObject({ status: "unchanged", resultingPolicyVersion: before.version });
    expect(await policyA()).toEqual(before);
    expect(await auditRows("t032-change-noop")).toHaveLength(0);
  });
});
