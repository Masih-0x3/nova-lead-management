import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql, type TransactionSql } from "postgres";

/**
 * T-015 disposable-Postgres rehearsal for the tenant-aware audit contract.
 *
 * The local SQLite guard is unit-verified in tenant-audit-schema.test.ts; this
 * lane proves the same contract on real PostgreSQL 16 — that
 * `trg_novatrade_audit_logs_guard` fires for the trusted writer (the table
 * owner bypasses RLS but never triggers) and that no `audit_logs` RLS policy
 * exists, so a member runtime role cannot read or write audit rows directly
 * even while presenting a fully valid tenant context.
 *
 * Requires a disposable database named `t015_audit_context_rehearsal` holding
 * the migrated schema plus a `NOSUPERUSER NOBYPASSRLS` runtime role granted
 * SELECT/INSERT on audit_logs, SELECT on the membership/binding tables the
 * guard cross-checks, and EXECUTE on the T-027 RLS helpers. See
 * docs/TESTING.md for provisioning.
 */

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const WORKSPACE_A = "10000000-0000-4000-8000-0000000000a1";
const WORKSPACE_B = "10000000-0000-4000-8000-0000000000b2";
const MEMBERSHIP_A = "20000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP_B = "20000000-0000-4000-8000-0000000000b2";
const BINDING_A = "30000000-0000-4000-8000-0000000000a1";
const BINDING_B = "30000000-0000-4000-8000-0000000000b2";
const ACTOR_A = "50000000-0000-4000-8000-0000000000a1";
const ACTOR_B = "50000000-0000-4000-8000-0000000000b2";
const EXPECTED_DATABASE_NAME = "t015_audit_context_rehearsal";
const RUN_DISPOSABLE_AUDIT_TESTS = process.env.T015_RUN_DISPOSABLE_AUDIT_TESTS === "1";
const AUDIT_ID_PREFIX = "t015-%";

type Db = Sql | TransactionSql;

type AuditRow = {
  id: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  scopeKind: "tenant" | "platform" | "legacy_unscoped" | string;
  tenantId?: string | null;
  workspaceId?: string | null;
  correlationId?: string | null;
  actorAuthIdentityId?: string | null;
  actorMembershipId?: string | null;
  actorLaunchRole?: string | null;
  actorRoleBindingId?: string | null;
  actorLayer?: string | null;
  actorEmail?: string | null;
};

type MemberContext = {
  tenantId: string;
  workspaceId: string;
  actorId: string;
  membershipId: string;
  role: string;
  roleBindingId: string;
  correlationId: string;
};

const memberA: MemberContext = {
  tenantId: TENANT_A,
  workspaceId: WORKSPACE_A,
  actorId: ACTOR_A,
  membershipId: MEMBERSHIP_A,
  role: "owner",
  roleBindingId: BINDING_A,
  correlationId: "t015-member-a",
};

function validTenantRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: `t015-${Math.random().toString(36).slice(2, 10)}`,
    action: "tenant.test.rehearsal",
    scopeKind: "tenant",
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    correlationId: "t015-valid-tenant",
    actorAuthIdentityId: ACTOR_A,
    actorMembershipId: MEMBERSHIP_A,
    actorLaunchRole: "owner",
    actorRoleBindingId: BINDING_A,
    actorLayer: "member",
    ...overrides,
  };
}

async function insertAudit(db: Db, row: AuditRow): Promise<void> {
  await db.unsafe(
    `INSERT INTO public.audit_logs (
      id, action, entity_type, entity_id, scope_kind,
      tenant_id, workspace_id, correlation_id,
      actor_auth_identity_id, actor_membership_id,
      actor_launch_role, actor_role_binding_id, actor_layer, actor_email
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      row.id, row.action, row.entityType ?? null, row.entityId ?? null, row.scopeKind,
      row.tenantId ?? null, row.workspaceId ?? null, row.correlationId ?? null,
      row.actorAuthIdentityId ?? null, row.actorMembershipId ?? null,
      row.actorLaunchRole ?? null, row.actorRoleBindingId ?? null, row.actorLayer ?? null,
      row.actorEmail ?? null,
    ],
  );
}

async function auditCount(db: Db): Promise<number> {
  const rows = await db.unsafe<{ count: string }[]>(
    "SELECT count(*)::text AS count FROM public.audit_logs WHERE id LIKE $1",
    [AUDIT_ID_PREFIX],
  );
  return Number(rows[0]?.count ?? 0);
}

async function expectAuditDenied(db: Db, row: AuditRow, pattern: RegExp): Promise<void> {
  const before = await auditCount(db);
  let message = "";
  try {
    await insertAudit(db, row);
  } catch (error) {
    message = String(error);
  }
  expect(message).toMatch(pattern);
  expect(await auditCount(db)).toBe(before);
}

async function installContext(db: Db, context: MemberContext): Promise<void> {
  const settings: Record<string, string> = {
    tenant_id: context.tenantId,
    workspace_id: context.workspaceId,
    actor_id: context.actorId,
    membership_id: context.membershipId,
    role: context.role,
    role_binding_id: context.roleBindingId,
    correlation_id: context.correlationId,
    support_grant_id: "",
    job_id: "",
    run_id: "",
    lease_id: "",
    lease_generation: "",
    worker_name: "",
    worker_action: "",
    worker_principal_kind: "",
  };
  for (const [name, value] of Object.entries(settings)) {
    await db.unsafe("SELECT set_config($1, $2, true)", [`app.${name}`, value]);
  }
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

describe.skipIf(!RUN_DISPOSABLE_AUDIT_TESTS)("T-015 tenant audit context Postgres guard", () => {
  const runtime = postgres(process.env.DATABASE_URL ?? "postgres://invalid", { max: 1, connect_timeout: 5 });
  const admin = postgres(process.env.T015_ADMIN_DATABASE_URL ?? "postgres://invalid", { max: 1, connect_timeout: 5 });
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
    if (rows.length !== 1) throw new Error("T-015 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T015_ADMIN_DATABASE_URL) {
      throw new Error("T-015 disposable test requires DATABASE_URL and T015_ADMIN_DATABASE_URL");
    }
    if (!process.env.T015_RUNTIME_ROLE) {
      throw new Error("T-015 disposable test requires T015_RUNTIME_ROLE");
    }
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-015 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE_NAME) throw new Error(`T-015 preflight refused: database must be ${EXPECTED_DATABASE_NAME}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-015 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T015_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-015 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }
    if (!adminReceipt.rolsuper && !adminReceipt.rolbypassrls || adminReceipt.current_user === runtimeReceipt.current_user) {
      throw new Error("T-015 preflight refused: admin must be a privileged non-runtime owner");
    }

    const auditPosture = await admin.unsafe<{
      tableowner: string;
      relrowsecurity: boolean;
      policy_count: string;
      trigger_enabled: string | null;
    }[]>(`
      SELECT tbl.tableowner, cls.relrowsecurity,
        (SELECT count(*)::text FROM pg_catalog.pg_policies pol
          WHERE pol.schemaname = 'public' AND pol.tablename = 'audit_logs') AS policy_count,
        (SELECT tg.tgenabled::text FROM pg_catalog.pg_trigger tg
          WHERE tg.tgname = 'trg_novatrade_audit_logs_guard'
            AND tg.tgrelid = 'public.audit_logs'::regclass) AS trigger_enabled
      FROM pg_catalog.pg_tables AS tbl
      JOIN pg_catalog.pg_class AS cls
        ON cls.relname = tbl.tablename AND cls.relnamespace = 'public'::regnamespace
      WHERE tbl.schemaname = 'public' AND tbl.tablename = 'audit_logs'
    `);
    const posture = auditPosture[0];
    if (!posture || posture.tableowner !== adminReceipt.current_user || posture.trigger_enabled !== "O") {
      throw new Error("T-015 preflight refused: audit_logs owner or enabled guard trigger missing");
    }
    if (!posture.relrowsecurity || posture.policy_count !== "0") {
      throw new Error("T-015 preflight refused: audit_logs must be RLS-enabled with zero member policies");
    }
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-015 fixture reached without disposable-target validation");
    await deleteSyntheticAuditRows();
    await admin.begin(async (tx) => {
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id IN ($1,$2)", [BINDING_A, BINDING_B]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id IN ($1,$2)", [MEMBERSHIP_A, MEMBERSHIP_B]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id IN ($1,$2)", [WORKSPACE_A, WORKSPACE_B]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id IN ($1,$2)", [TENANT_A, TENANT_B]);
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't015-tenant-a', 'Audit Synthetic Tenant A', 'active'), ($2, 't015-tenant-b', 'Audit Synthetic Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES ($1, $2, 't015-workspace-a', 'Audit Workspace A', 'active'), ($3, $4, 't015-workspace-b', 'Audit Workspace B', 'active')",
        [WORKSPACE_A, TENANT_A, WORKSPACE_B, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status) VALUES ($1, $2, $3, $4, 'active'), ($5, $6, $7, $8, 'active')",
        [MEMBERSHIP_A, TENANT_A, ACTOR_A, WORKSPACE_A, MEMBERSHIP_B, TENANT_B, ACTOR_B, WORKSPACE_B],
      );
      await tx.unsafe(
        "INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, valid_from, revoked_at) VALUES ($1, $2, $3, 'owner', now() - interval '1 minute', null), ($4, $5, $6, 'researcher', now() - interval '1 minute', null)",
        [BINDING_A, TENANT_A, MEMBERSHIP_A, BINDING_B, TENANT_B, MEMBERSHIP_B],
      );
    });
  }

  async function deleteSyntheticAuditRows(): Promise<void> {
    await admin.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
    try {
      await admin.unsafe("DELETE FROM public.audit_logs WHERE id LIKE $1", [AUDIT_ID_PREFIX]);
    } finally {
      await admin.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
    }
  }

  async function clean(): Promise<void> {
    await deleteSyntheticAuditRows();
    await admin.begin(async (tx) => {
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id IN ($1,$2)", [BINDING_A, BINDING_B]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id IN ($1,$2)", [MEMBERSHIP_A, MEMBERSHIP_B]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id IN ($1,$2)", [WORKSPACE_A, WORKSPACE_B]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id IN ($1,$2)", [TENANT_A, TENANT_B]);
    });
    await runtime.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }

  beforeAll(async () => {
    await assertDisposableTarget();
  });

  afterAll(async () => {
    if (targetValidated) await clean();
    else {
      await runtime.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  });

  it("accepts exactly-shaped tenant, platform, and legacy rows through the trusted writer", async () => {
    await fixture();
    await insertAudit(admin, validTenantRow({ entityType: "tenant", entityId: TENANT_A }));
    await insertAudit(admin, {
      id: "t015-valid-platform",
      action: "platform.limit_kill_switch_changed",
      scopeKind: "platform",
      correlationId: "t015-platform",
      actorLayer: "system",
    });
    await insertAudit(admin, {
      id: "t015-valid-legacy",
      action: "legacy.backfill.import",
      scopeKind: "legacy_unscoped",
      actorEmail: "legacy@nova.test",
    });
    const rows = await admin.unsafe<{ id: string; scope_kind: string; actor_layer: string | null }[]>(
      "SELECT id, scope_kind, actor_layer FROM public.audit_logs WHERE id LIKE $1 ORDER BY id",
      [AUDIT_ID_PREFIX],
    );
    expect(rows.map((row) => row.scope_kind).sort()).toEqual(["legacy_unscoped", "platform", "tenant"]);
  });

  it("rejects tenant rows missing any piece of the exact server-derived member context", async () => {
    await fixture();
    const shape = /tenant audit requires exact server-derived context and no actor email/;
    await expectAuditDenied(admin, validTenantRow({ correlationId: null }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorMembershipId: null }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorRoleBindingId: null }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorLaunchRole: null }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorAuthIdentityId: null }), shape);
    await expectAuditDenied(admin, validTenantRow({ tenantId: null }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorEmail: "spoofed@nova.test" }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorLayer: "system" }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorLayer: "worker" }), shape);
    await expectAuditDenied(admin, validTenantRow({ actorLayer: "support" }), shape);
  });

  it("cross-checks tenant audit membership and role binding against live rows", async () => {
    await fixture();
    const membership = /tenant audit membership does not match tenant and actor identity/;
    const binding = /tenant audit role binding does not match tenant and membership/;
    await expectAuditDenied(admin, validTenantRow({ actorMembershipId: MEMBERSHIP_B, actorAuthIdentityId: ACTOR_B, actorRoleBindingId: BINDING_B, actorLaunchRole: "researcher" }), membership);
    await expectAuditDenied(admin, validTenantRow({ actorAuthIdentityId: ACTOR_B }), membership);
    await expectAuditDenied(admin, validTenantRow({ actorMembershipId: "20000000-0000-4000-8000-0000000000ff" }), membership);
    await expectAuditDenied(admin, validTenantRow({ actorRoleBindingId: BINDING_B, actorLaunchRole: "researcher" }), binding);
    await expectAuditDenied(admin, validTenantRow({ actorLaunchRole: "admin" }), binding);
    await expectAuditDenied(admin, validTenantRow({ actorRoleBindingId: "30000000-0000-4000-8000-0000000000ff" }), binding);
  });

  it("rejects platform and legacy rows that carry tenant context", async () => {
    await fixture();
    const platform = /platform audit cannot carry tenant context/;
    await expectAuditDenied(admin, { id: "t015-platform-tenant", action: "platform.test", scopeKind: "platform", actorLayer: "system", tenantId: TENANT_A }, platform);
    await expectAuditDenied(admin, { id: "t015-platform-workspace", action: "platform.test", scopeKind: "platform", actorLayer: "system", workspaceId: WORKSPACE_A }, platform);
    await expectAuditDenied(admin, { id: "t015-platform-membership", action: "platform.test", scopeKind: "platform", actorLayer: "system", actorMembershipId: MEMBERSHIP_A }, platform);
    await expectAuditDenied(admin, { id: "t015-platform-member", action: "platform.test", scopeKind: "platform", actorLayer: "member" }, /platform_context_chk|platform audit cannot carry tenant context/);

    const legacy = /legacy audit rows cannot carry tenant context/;
    await expectAuditDenied(admin, { id: "t015-legacy-tenant", action: "legacy.test", scopeKind: "legacy_unscoped", tenantId: TENANT_A }, legacy);
    await expectAuditDenied(admin, { id: "t015-legacy-correlation", action: "legacy.test", scopeKind: "legacy_unscoped", correlationId: "t015-bad" }, legacy);
    await expectAuditDenied(admin, { id: "t015-legacy-layer", action: "legacy.test", scopeKind: "legacy_unscoped", actorLayer: "system" }, legacy);
  });

  it("keeps audit rows append-only and enforces the lexical envelopes", async () => {
    await fixture();
    await insertAudit(admin, validTenantRow({ id: "t015-immutable-target" }));
    const before = await auditCount(admin);
    await expect(admin.unsafe("UPDATE public.audit_logs SET action = 'tenant.tampered' WHERE id = 't015-immutable-target'"))
      .rejects.toThrow(/audit logs are append-only/);
    await expect(admin.unsafe("DELETE FROM public.audit_logs WHERE id = 't015-immutable-target'"))
      .rejects.toThrow(/audit logs are append-only/);
    expect(await auditCount(admin)).toBe(before);

    await expectAuditDenied(admin, validTenantRow({ action: "Tenant.Bad" }), /audit action is outside its safe lexical envelope/);
    await expectAuditDenied(admin, validTenantRow({ entityType: "Bad Type" }), /audit entity type is outside its safe lexical envelope/);
    await expectAuditDenied(admin, validTenantRow({ entityId: "not safe" }), /audit entity id is outside its safe lexical envelope/);
    await expectAuditDenied(admin, validTenantRow({ correlationId: "-leading-dash" }), /audit correlation id is outside its safe lexical envelope/);
    await expectAuditDenied(admin, validTenantRow({ actorLaunchRole: "superuser" }), /unknown audit launch role/);
    await expectAuditDenied(admin, validTenantRow({ actorLayer: "intruder" }), /unknown audit actor layer/);
    await expectAuditDenied(admin, validTenantRow({ scopeKind: "namespace" }), /unknown audit scope/);
  });

  it("denies direct audit reads and writes to the member runtime role under a valid context", async () => {
    await fixture();
    await insertAudit(admin, validTenantRow({ id: "t015-runtime-denied-read" }));

    const visible = await runtime.begin(async (tx) => {
      await installContext(tx, memberA);
      const rows = await tx.unsafe<{ id: string }[]>(
        "SELECT id FROM public.audit_logs WHERE id LIKE 't015-%'",
      );
      return rows.length;
    });
    expect(visible).toBe(0);

    await expect(runtime.begin(async (tx) => {
      await installContext(tx, memberA);
      await insertAudit(tx, validTenantRow({ id: "t015-runtime-denied-write" }));
    })).rejects.toThrow(/row-level security/);
    expect(await admin.unsafe<{ id: string }[]>("SELECT id FROM public.audit_logs WHERE id = 't015-runtime-denied-write'")).toHaveLength(0);

    const noContext = await runtime.unsafe<{ count: string }[]>("SELECT count(*)::text AS count FROM public.audit_logs");
    expect(Number(noContext[0]?.count)).toBe(0);
  });
});
