import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb, withTenantDbContext } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { createPostgresTenantLimitService } from "@/lib/tenancy/postgres-tenant-limits";
import { TenantLimitConfigurationError } from "@/lib/tenancy/limits";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the tenant-limit (quota) write path —
 * the third Postgres-backed service-port adapter after T-031/T-032.
 *
 * The canonical limit contract is unit-verified against the SQLite backend;
 * this lane proves the Postgres twin end-to-end:
 * createPostgresTenantLimitService resolves the member context through
 * withTenantDbContext, reads runtime state through the SECURITY DEFINER
 * novatrade_tenant_limit_runtime_state, consumes through the atomic
 * novatrade_tenant_limit_consume (advisory-locked lane, expected-state
 * revalidation, idempotency, sliding-window buckets), and CAS-changes
 * configuration through novatrade_change_tenant_limit_configuration — each
 * re-validating the transaction-local member GUCs database-side. The limit
 * tables carry zero RLS policies, so without the functions the restricted
 * role can neither read nor write them.
 *
 * Requires a disposable database named `t033_tenant_limits_rehearsal` holding
 * the migrated schema plus a `t033_runtime` role granted foundation-table
 * CRUD, EXECUTE on the four novatrade_rls_* helpers, the three limit
 * functions, and the feature-policy change function (the feature-gate case).
 * `DATABASE_URL` is staged to the runtime role with `DATABASE_SSL=disable`
 * (the production PostgresClient requires TLS otherwise). See
 * docs/TESTING.md for provisioning.
 */

const RUN = process.env.T033_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t033_tenant_limits_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-000000000061";
const TENANT_B = "00000000-0000-4000-8000-000000000062";
const WORKSPACE_A1 = "10000000-0000-4000-8000-000000000061";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000062";
const MEMBER_A = "20000000-0000-4000-8000-000000000061";
const MEMBER_B = "20000000-0000-4000-8000-000000000062";
const BINDING_A = "30000000-0000-4000-8000-000000000061";
const BINDING_B = "30000000-0000-4000-8000-000000000062";
const ACTOR_A = "50000000-0000-4000-8000-000000000061";
const ACTOR_B = "50000000-0000-4000-8000-000000000062";
const POLICY_A = "90000000-0000-4000-8000-000000000061";
const POLICY_B = "90000000-0000-4000-8000-000000000062";

/** The bucket-key digest material joins fields with NUL separators. */
function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tenantBucketKey(action: string, tenantId: string): string {
  return `tenant:${sha256hex(`${action}\u0000${tenantId}`)}`;
}

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A,
    email: "t033-owner-a@example.test",
    displayName: "T033 Owner A",
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
    email: "t033-researcher-b@example.test",
    displayName: "T033 Researcher B",
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

describe.skipIf(!RUN)("T-033 tenant-limit runtime on Postgres", () => {
  const admin = postgres(process.env.T033_ADMIN_DATABASE_URL ?? "postgres://invalid", { max: 1, connect_timeout: 5 });
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
    if (rows.length !== 1) throw new Error("T-033 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T033_ADMIN_DATABASE_URL) {
      throw new Error("T-033 disposable test requires DATABASE_URL and T033_ADMIN_DATABASE_URL");
    }
    if (!process.env.T033_RUNTIME_ROLE) {
      throw new Error("T-033 disposable test requires T033_RUNTIME_ROLE");
    }
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-033 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-033 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-033 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T033_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-033 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
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
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_tenant_limit_runtime_state',
        'novatrade_tenant_limit_consume',
        'novatrade_change_tenant_limit_configuration'
      )
    `);
    if (posture.length !== 3 || posture.some((fn) =>
      !fn.prosecdef || (!fn.owner_super && !fn.owner_bypass) || fn.anon_execute || fn.authenticated_execute)) {
      throw new Error("T-033 preflight refused: limit functions must be SECURITY DEFINER owned by a privileged role with no anon/authenticated EXECUTE");
    }

    // Prove the production PostgresClient itself connects — without this, a
    // transport failure (e.g. missing DATABASE_SSL=disable) is swallowed by
    // the service's non-enumerating error mapping and masquerades as a
    // designed denial.
    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-033 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-033 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't033-tenant-a', 'Limit Tenant A', 'active'), ($2, 't033-tenant-b', 'Limit Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
          ($1, $2, 't033-ws-a1', 'Limit Workspace A1', 'active'),
          ($3, $4, 't033-ws-b', 'Limit Workspace B', 'active')`,
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
    // The event ledger, idempotency table, and audit log are append-only —
    // the privileged cleanup disables their triggers, matching the T-031
    // lane's pattern. The feature-flip test's audit rows also hold an FK to
    // the fixture role bindings, so they must go first.
    await admin.unsafe("ALTER TABLE public.tenant_limit_events DISABLE TRIGGER ALL");
    await admin.unsafe("ALTER TABLE public.tenant_limit_idempotency DISABLE TRIGGER ALL");
    await admin.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
    try {
      await admin.unsafe("DELETE FROM public.tenant_limit_events WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
      await admin.unsafe("DELETE FROM public.tenant_limit_idempotency WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
      await admin.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE $1 OR tenant_id = ANY($2::uuid[])", ["t033-%", [TENANT_A, TENANT_B]]);
    } finally {
      await admin.unsafe("ALTER TABLE public.tenant_limit_events ENABLE TRIGGER ALL");
      await admin.unsafe("ALTER TABLE public.tenant_limit_idempotency ENABLE TRIGGER ALL");
      await admin.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
    }
    await admin.unsafe("DELETE FROM public.tenant_limit_configuration WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
    // Bucket keys are opaque hashes — delete them via the digest material for
    // the two fixture tenants (and their member actors) rather than scanning.
    const members = await admin.unsafe<{ actor_id: string }[]>(
      "SELECT DISTINCT auth_identity_id::text AS actor_id FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    if (members.length > 0) {
      const actions = [
        "membership_invite", "support_grant_request", "support_grant_approval",
        "knowledge_upload", "export_request", "deletion_request", "worker_start",
        "agent_plan_expensive", "recovery_bookkeeping",
      ];
      const keys: string[] = [];
      for (const tenantId of [TENANT_A, TENANT_B]) {
        for (const action of actions) {
          keys.push(tenantBucketKey(action, tenantId));
          for (const { actor_id } of members) {
            keys.push(`actor:${sha256hex(`${action}\u0000${tenantId}\u0000${actor_id}`)}`);
          }
        }
      }
      await admin.unsafe("DELETE FROM public.tenant_limit_buckets WHERE bucket_key = ANY($1::text[])", [keys]);
    }
    await admin.begin(async (tx) => {
      await tx.unsafe("DELETE FROM public.tenant_policies WHERE id = ANY($1::uuid[])", [[POLICY_A, POLICY_B]]);
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id = ANY($1::uuid[])", [[BINDING_A, BINDING_B]]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id = ANY($1::uuid[])", [[MEMBER_A, MEMBER_B]]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [[WORKSPACE_A1, WORKSPACE_B]]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
    });
  }

  async function limitEvents(action: string): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT event_type, tenant_id::text, action, payload_json
       FROM public.tenant_limit_events WHERE tenant_id = $1 AND action = $2 ORDER BY created_at`,
      [TENANT_A, action],
    );
  }

  async function tenantBucketUsed(tenantId: string, action: string): Promise<number> {
    const key = tenantBucketKey(action, tenantId);
    const rows = await admin.unsafe<{ used: number }[]>(
      "SELECT used FROM public.tenant_limit_buckets WHERE bucket_key = $1",
      [key],
    );
    return rows[0]?.used ?? 0;
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

  it("consumes quota through the canonical path and replays the same idempotency key without double-counting", async () => {
    const service = createPostgresTenantLimitService();
    const first = await runWithTenantContext(ownerSessionA(), "t033-consume-1", () =>
      service.consume({ action: "membership_invite", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-1" }));
    expect(first).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(await tenantBucketUsed(TENANT_A, "membership_invite")).toBe(1);

    const replay = await runWithTenantContext(ownerSessionA(), "t033-consume-2", () =>
      service.consume({ action: "membership_invite", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-1" }));
    expect(replay).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(await tenantBucketUsed(TENANT_A, "membership_invite")).toBe(1);
  });

  it("rejects an idempotency-key reuse with a different request shape", async () => {
    const service = createPostgresTenantLimitService();
    const conflict = await runWithTenantContext(ownerSessionA(), "t033-consume-conflict", () =>
      service.consume({ action: "membership_invite", tenantId: TENANT_A, amount: 2, idempotencyKey: "t033-idem-1" }));
    expect(conflict).toMatchObject({ outcome: "blocked", code: "BLOCKED_IDEMPOTENCY_CONFLICT" });
    expect(await tenantBucketUsed(TENANT_A, "membership_invite")).toBe(1);
  });

  it("CAS-changes the per-tenant cap and rate-limits once the bucket fills", async () => {
    const service = createPostgresTenantLimitService({
      policyEvaluator: async (context) => ({ allowed: context.tenantId === TENANT_A, context }),
    });
    const changed = await runWithTenantContext(ownerSessionA(), "t033-config-1", () =>
      service.changeConfiguration({
        action: "support_grant_request",
        tenantId: TENANT_A,
        expectedVersion: 1,
        tenantPolicyCap: 3,
        reason: "t033 tightens the support-request quota",
        correlationId: "t033-config-1",
      }));
    expect(changed).toMatchObject({ code: "CONFIGURATION_CHANGED", previousVersion: 1, resultingVersion: 2 });
    const events = await limitEvents("support_grant_request");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "tenant_limit_configuration_changed", tenant_id: TENANT_A, action: "support_grant_request" });

    const filled = await runWithTenantContext(ownerSessionA(), "t033-consume-fill", () =>
      service.consume({ action: "support_grant_request", tenantId: TENANT_A, amount: 3, idempotencyKey: "t033-idem-fill" }));
    expect(filled).toMatchObject({ outcome: "allowed", code: "ALLOWED" });

    const limited = await runWithTenantContext(ownerSessionA(), "t033-consume-limited", () =>
      service.consume({ action: "support_grant_request", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-over" }));
    expect(limited).toMatchObject({ outcome: "rate_limited", code: "RATE_LIMITED" });
    expect(limited.retryAfterMs).not.toBeNull();
    expect(await tenantBucketUsed(TENANT_A, "support_grant_request")).toBe(3);
  });

  it("reports a version conflict on a stale configuration CAS", async () => {
    const service = createPostgresTenantLimitService({
      policyEvaluator: async (context) => ({ allowed: context.tenantId === TENANT_A, context }),
    });
    await expect(runWithTenantContext(ownerSessionA(), "t033-config-stale", () =>
      service.changeConfiguration({
        action: "support_grant_request",
        tenantId: TENANT_A,
        expectedVersion: 99,
        tenantPolicyCap: 4,
        reason: "stale version must conflict",
        correlationId: "t033-config-stale",
      }),
    )).rejects.toMatchObject({ code: "CONFIGURATION_VERSION_CONFLICT" });
    expect(await limitEvents("support_grant_request")).toHaveLength(1);
  });

  it("blocks consume behind the tenant action kill switch", async () => {
    const service = createPostgresTenantLimitService({
      policyEvaluator: async (context) => ({ allowed: context.tenantId === TENANT_A, context }),
    });
    await runWithTenantContext(ownerSessionA(), "t033-config-kill", () =>
      service.changeConfiguration({
        action: "recovery_bookkeeping",
        tenantId: TENANT_A,
        expectedVersion: 1,
        tenantActionKill: true,
        reason: "t033 kills recovery bookkeeping",
        correlationId: "t033-config-kill",
      }));
    const denied = await runWithTenantContext(ownerSessionA(), "t033-consume-kill", () =>
      service.consume({ action: "recovery_bookkeeping", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-kill" }));
    expect(denied).toMatchObject({ outcome: "blocked", code: "BLOCKED_KILL_SWITCH" });
    expect(await tenantBucketUsed(TENANT_A, "recovery_bookkeeping")).toBe(0);
  });

  it("enforces the feature gate and opens consume once the flag flips", async () => {
    const service = createPostgresTenantLimitService();
    const denied = await runWithTenantContext(ownerSessionA(), "t033-consume-feature", () =>
      service.consume({ action: "export_request", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-export" }));
    expect(denied).toMatchObject({ outcome: "blocked", code: "BLOCKED_FEATURE" });

    // Flip copyExportEnabled at the database boundary through the T-031
    // function under a valid owner member context — cross-adapter proof that
    // the feature write path and the limit consume path compose.
    await runtime.begin(async (tx) => {
      for (const [key, value] of [
        ["app.tenant_id", TENANT_A],
        ["app.actor_id", ACTOR_A],
        ["app.membership_id", MEMBER_A],
        ["app.role", "owner"],
        ["app.role_binding_id", BINDING_A],
        ["app.correlation_id", "t033-feature-flip"],
      ] as const) {
        await tx.unsafe("SELECT set_config($1, $2, true)", [key, value]);
      }
      const rows = await tx.unsafe<{ outcome: string }[]>(
        `SELECT outcome FROM public.novatrade_apply_tenant_feature_policy_change('copyExportEnabled', true, 1, '{}')`,
      );
      expect(rows[0]?.outcome).toBe("applied");
    });

    const allowed = await runWithTenantContext(ownerSessionA(), "t033-consume-export", () =>
      service.consume({ action: "export_request", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-export" }));
    expect(allowed).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(await tenantBucketUsed(TENANT_A, "export_request")).toBe(1);
  });

  it("denies a non-capable member the configuration change but still lets them consume", async () => {
    const service = createPostgresTenantLimitService({
      policyEvaluator: async (context) => ({ allowed: true, context }),
    });
    await expect(runWithTenantContext(researcherSessionB(), "t033-config-denied", () =>
      service.changeConfiguration({
        action: "membership_invite",
        tenantId: TENANT_B,
        expectedVersion: 1,
        tenantPolicyCap: 5,
        reason: "researcher must not change quotas",
        correlationId: "t033-config-denied",
      }),
    )).rejects.toBeInstanceOf(TenantLimitConfigurationError);

    const consumed = await runWithTenantContext(researcherSessionB(), "t033-consume-b", () =>
      service.consume({ action: "membership_invite", tenantId: TENANT_B, amount: 1, idempotencyKey: "t033-idem-b" }));
    expect(consumed).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(await tenantBucketUsed(TENANT_B, "membership_invite")).toBe(1);
    expect(await tenantBucketUsed(TENANT_A, "membership_invite")).toBe(1);
  });

  it("lets a workspace-scoped member consume against the tenant bucket", async () => {
    const service = createPostgresTenantLimitService();
    const consumed = await runWithTenantContext(ownerSessionA({ workspaceId: WORKSPACE_A1 }), "t033-consume-ws", () =>
      service.consume({ action: "support_grant_approval", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-ws" }));
    expect(consumed).toMatchObject({ outcome: "allowed", code: "ALLOWED" });
    expect(await tenantBucketUsed(TENANT_A, "support_grant_approval")).toBe(1);
  });

  it("fails closed without a member context and refuses direct-call bypasses inside the function", async () => {
    const service = createPostgresTenantLimitService();
    const denied = await service.consume({ action: "membership_invite", tenantId: TENANT_A, amount: 1, idempotencyKey: "t033-idem-nocontext" });
    expect(denied).toMatchObject({ outcome: "blocked", code: "BLOCKED_TENANT_SCOPE" });

    // A payload that is fully valid under tenant A's owner context — every
    // server-derived fact (window, caps, bucket digests) computed correctly.
    const validPayload = () => ({
      tenantId: TENANT_A,
      actorId: ACTOR_A,
      workspaceId: null,
      action: "membership_invite",
      buckets: [
        { scope: "tenant", key: tenantBucketKey("membership_invite", TENANT_A) },
        { scope: "actor", key: `actor:${sha256hex(`membership_invite\u0000${TENANT_A}\u0000${ACTOR_A}`)}` },
      ],
      idempotencyKey: sha256hex("t033-direct-idem"),
      requestHash: sha256hex("t033-direct-request"),
      windowMs: 86_400_000,
      amount: 1,
      hardBound: 100,
      platformHardCap: 100,
      nowMs: Date.now(),
      expectedTenantStatus: "active",
      expectedConfigurationVersion: 1,
      expectedPlatformConfigurationVersion: 1,
      expectedPlatformGlobalKill: false,
      expectedPlatformActionKill: false,
      expectedTenantActionKill: false,
      expectedTenantPolicyCap: 100,
      expectedFeaturePolicyVersion: null,
    });
    const callDirect = (payload: Record<string, unknown>) =>
      runWithTenantContext(ownerSessionA(), "t033-direct", () =>
        withTenantDbContext((db) =>
          db.prepare("SELECT outcome FROM public.novatrade_tenant_limit_consume($1)").all<{ outcome: string }>(JSON.stringify(payload)),
        ),
      );

    // Cross-tenant: the request tenant must equal the accepted context's.
    expect((await callDirect({ ...validPayload(), tenantId: TENANT_B }))[0]?.outcome).toBe("denied");
    // Forged bucket keys: digests are recomputed server-side from the
    // context-bound tenant/actor/action — caller keys that do not match are
    // refused, so another tenant's counters can never be addressed.
    expect((await callDirect({
      ...validPayload(),
      buckets: [
        { scope: "tenant", key: `tenant:${"0".repeat(64)}` },
        { scope: "actor", key: `actor:${"0".repeat(64)}` },
      ],
    }))[0]?.outcome).toBe("invalid_request");
    // Inflated platform cap: the function derives it, never trusts it.
    expect((await callDirect({ ...validPayload(), platformHardCap: 999_999 }))[0]?.outcome).toBe("invalid_request");
    // Shrunken window: a 1ms window would reset the bucket every consume.
    expect((await callDirect({ ...validPayload(), windowMs: 1 }))[0]?.outcome).toBe("invalid_request");
    // Far-future clock: nowMs is bounded against the database clock.
    expect((await callDirect({ ...validPayload(), nowMs: Date.now() + 25 * 60 * 60 * 1000 }))[0]?.outcome).toBe("invalid_request");
  });

  it("rejects consume for a suspended tenant through runtime-state validation", async () => {
    const service = createPostgresTenantLimitService();
    await admin.unsafe("UPDATE public.tenants SET status = 'suspended' WHERE id = $1", [TENANT_B]);
    try {
      // A suspended tenant fails the member-context helper itself, so the
      // runtime-state function returns NULL and the canonical service maps
      // that to the non-enumerating backend refusal.
      const result = await runWithTenantContext(researcherSessionB(), "t033-consume-suspended", () =>
        service.consume({ action: "membership_invite", tenantId: TENANT_B, amount: 1, idempotencyKey: "t033-idem-susp" }));
      expect(result).toMatchObject({ outcome: "blocked" });
      expect(result.code).not.toBe("ALLOWED");
      expect(await tenantBucketUsed(TENANT_B, "membership_invite")).toBe(1);
    } finally {
      await admin.unsafe("UPDATE public.tenants SET status = 'active' WHERE id = $1", [TENANT_B]);
    }
  });

  it("keeps the platform kill switch fail-closed without a platform-operator context", async () => {
    const service = createPostgresTenantLimitService();
    await expect(service.changePlatformKillSwitch(
      { scope: "global", enabled: true, expectedVersion: 1, reason: "t033 platform kill", correlationId: "t033-platform" },
      { kind: "platform_operator", principalId: "t033-operator" },
    )).rejects.toMatchObject({ code: "PLATFORM_CONFIGURATION_UNAUTHORIZED" });
  });
});
