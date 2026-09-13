import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb, withTenantDbContext } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { createSupportAccessService } from "@/lib/tenancy/support-access";
import {
  createPostgresSupportAccessPolicyEvaluator,
  createPostgresSupportAccessRepository,
  createPostgresSupportPrincipalResolver,
} from "@/lib/tenancy/postgres-support-access";
import { createPostgresTenantLimitService } from "@/lib/tenancy/postgres-tenant-limits";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the member-side support-access
 * write path — the fifth Postgres-backed service-port binding after
 * T-031..T-034.
 *
 * The canonical createSupportAccessService orchestration is unit-verified
 * against the SQLite backend; this lane proves the Postgres twins end to
 * end. createPostgresSupportAccessRepository runs the service's atomic
 * journal → mutation → event → commit pipeline inside withTenantDbContext,
 * with every write going through the SECURITY DEFINER functions of
 * migration 202609120008 (the journal, event ledger, and principal registry
 * are zero-policy; grant writes are deny-all-else). The member-context
 * functions re-validate the transaction-local GUCs database-side, derive
 * the journal key hash from context-bound tenant/actor/operation/key, and
 * bind every written fact to the accepted context. Grant/workspace/
 * membership reads ride the existing member-select policies.
 *
 * Requires a disposable database named `t035_support_access_rehearsal`
 * holding the migrated schema plus migration 202609120008, and a
 * `t035_runtime` role granted foundation-table SELECT, EXECUTE on the four
 * novatrade_rls_* helpers, and EXECUTE on the eight support-access
 * functions. `DATABASE_URL` is staged to the runtime role with
 * `DATABASE_SSL=disable`. See docs/TESTING.md for provisioning.
 */

const RUN = process.env.T035_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t035_support_access_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-000000000081";
const TENANT_B = "00000000-0000-4000-8000-000000000082";
const WORKSPACE_A1 = "10000000-0000-4000-8000-000000000081";
const MEMBER_A = "20000000-0000-4000-8000-000000000081";
const MEMBER_A_WS = "20000000-0000-4000-8000-000000000083";
const MEMBER_A_RESEARCHER = "20000000-0000-4000-8000-000000000084";
const MEMBER_B = "20000000-0000-4000-8000-000000000082";
const BINDING_A = "30000000-0000-4000-8000-000000000081";
const BINDING_A_WS = "30000000-0000-4000-8000-000000000083";
const BINDING_A_RESEARCHER = "30000000-0000-4000-8000-000000000084";
const BINDING_B = "30000000-0000-4000-8000-000000000082";
const ACTOR_A = "50000000-0000-4000-8000-000000000081";
const ACTOR_A_WS = "50000000-0000-4000-8000-000000000083";
const ACTOR_A_RESEARCHER = "50000000-0000-4000-8000-000000000084";
const ACTOR_B = "50000000-0000-4000-8000-000000000082";
const SUPPORT_ACTOR_1 = "50000000-0000-4000-8000-000000000091";
const SUPPORT_ACTOR_2 = "50000000-0000-4000-8000-000000000092";
const SUPPORT_ACTOR_3 = "50000000-0000-4000-8000-000000000093";
const SUPPORT_REF_1 = "t035-support-ref-1";
const SUPPORT_REF_2 = "t035-support-ref-2";
const SUPPORT_REF_SELF = "t035-support-ref-self";
const SUPPORT_REF_DISABLED = "t035-support-ref-disabled";

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A,
    email: "t035-owner-a@example.test",
    displayName: "T035 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A,
    role: "owner",
    roleBindingId: BINDING_A,
    ...overrides,
  };
}

function workspaceOwnerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_WS,
    email: "t035-ws-owner-a@example.test",
    displayName: "T035 Workspace Owner A",
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A1,
    membershipId: MEMBER_A_WS,
    role: "owner",
    roleBindingId: BINDING_A_WS,
    ...overrides,
  };
}

function researcherSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_RESEARCHER,
    email: "t035-researcher-a@example.test",
    displayName: "T035 Researcher A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_RESEARCHER,
    role: "researcher",
    roleBindingId: BINDING_A_RESEARCHER,
    ...overrides,
  };
}

function ownerSessionB(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_B,
    email: "t035-owner-b@example.test",
    displayName: "T035 Owner B",
    tenantId: TENANT_B,
    workspaceId: null,
    membershipId: MEMBER_B,
    role: "owner",
    roleBindingId: BINDING_B,
    ...overrides,
  };
}

function service() {
  return createSupportAccessService({
    repository: createPostgresSupportAccessRepository(),
    principalResolver: createPostgresSupportPrincipalResolver(),
    policyEvaluator: createPostgresSupportAccessPolicyEvaluator(),
    limits: createPostgresTenantLimitService(),
  });
}

function window(): { startsAt: string; expiresAt: string } {
  return {
    startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A,
    supportPrincipalRef: SUPPORT_REF_1,
    reasonCode: "support.incident-1",
    reason: "t035 rehearsal support access",
    ...window(),
    permissions: ["tenant:read"],
    dataClasses: ["tenant_metadata"],
    idempotencyKey: "t035-req-1",
    ...overrides,
  };
}

describe.skipIf(!RUN)("T-035 member-side support access on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-035 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T035_ADMIN_DATABASE_URL) {
      throw new Error("T-035 disposable test requires DATABASE_URL and T035_ADMIN_DATABASE_URL");
    }
    if (!process.env.T035_RUNTIME_ROLE) {
      throw new Error("T-035 disposable test requires T035_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T035_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-035 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-035 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-035 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T035_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-035 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_support_access_grant_json',
        'novatrade_support_access_reserve',
        'novatrade_support_access_commit',
        'novatrade_support_access_append_event',
        'novatrade_support_access_create_grant',
        'novatrade_support_access_approve_grant',
        'novatrade_support_access_revoke_grant',
        'novatrade_support_principal_resolve',
        'novatrade_support_principal_current'
      )
    `);
    if (posture.length !== 9 || posture.some((fn) => !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)) {
      throw new Error("T-035 preflight refused: support-access functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }

    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-035 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-035 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't035-tenant-a', 'Support Tenant A', 'active'), ($2, 't035-tenant-b', 'Support Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES ($1, $2, 't035-ws-a1', 'Support Workspace A1', 'active')",
        [WORKSPACE_A1, TENANT_A],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status) VALUES
          ($1, $2, $3, NULL, 'active'),
          ($4, $2, $5, $6, 'active'),
          ($7, $2, $8, NULL, 'active'),
          ($9, $10, $11, NULL, 'active')`,
        [
          MEMBER_A, TENANT_A, ACTOR_A,
          MEMBER_A_WS, ACTOR_A_WS, WORKSPACE_A1,
          MEMBER_A_RESEARCHER, ACTOR_A_RESEARCHER,
          MEMBER_B, TENANT_B, ACTOR_B,
        ],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, valid_from, revoked_at) VALUES
          ($1, $2, $3, 'owner', now() - interval '1 minute', null),
          ($4, $2, $5, 'owner', now() - interval '1 minute', null),
          ($6, $2, $7, 'researcher', now() - interval '1 minute', null),
          ($8, $9, $10, 'owner', now() - interval '1 minute', null)`,
        [
          BINDING_A, TENANT_A, MEMBER_A,
          BINDING_A_WS, MEMBER_A_WS,
          BINDING_A_RESEARCHER, MEMBER_A_RESEARCHER,
          BINDING_B, TENANT_B, MEMBER_B,
        ],
      );
      await tx.unsafe(
        `INSERT INTO public.platform_support_principals (reference, auth_identity_id, status) VALUES
          ($1, $2, 'active'),
          ($3, $4, 'active'),
          ($5, $6, 'active'),
          ($7, $8, 'disabled')`,
        [
          SUPPORT_REF_1, SUPPORT_ACTOR_1,
          SUPPORT_REF_SELF, ACTOR_A,
          SUPPORT_REF_2, SUPPORT_ACTOR_3,
          SUPPORT_REF_DISABLED, SUPPORT_ACTOR_2,
        ],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    // Journal, events, grant-scope rows, and the audit log are append-only —
    // the privileged cleanup disables their guards, matching the T-033 lane.
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_journal DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_events DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_permissions DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_data_classes DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_limit_idempotency DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_limit_events DISABLE TRIGGER ALL");
      try {
        await tx.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE $1 OR tenant_id = ANY($2::uuid[])", ["t035-%", [TENANT_A, TENANT_B]]);
        await tx.unsafe("DELETE FROM public.support_access_journal WHERE actor_namespace = ANY($1::text[])", [[ACTOR_A, ACTOR_A_WS, ACTOR_A_RESEARCHER, ACTOR_B]]);
        await tx.unsafe("DELETE FROM public.support_access_events WHERE tenant_id = ANY($1::uuid[]) OR correlation_id LIKE $2", [[TENANT_A, TENANT_B], "t035-%"]);
        await tx.unsafe("DELETE FROM public.tenant_limit_idempotency WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
        await tx.unsafe("DELETE FROM public.tenant_limit_events WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
        await tx.unsafe("DELETE FROM public.support_access_grant_permissions WHERE grant_id IN (SELECT id FROM public.support_access_grants WHERE tenant_id = ANY($1::uuid[]))", [[TENANT_A, TENANT_B]]);
        await tx.unsafe("DELETE FROM public.support_access_grant_data_classes WHERE grant_id IN (SELECT id FROM public.support_access_grants WHERE tenant_id = ANY($1::uuid[]))", [[TENANT_A, TENANT_B]]);
      } finally {
        await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.support_access_journal ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.support_access_events ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.support_access_grant_permissions ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.support_access_grant_data_classes ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.tenant_limit_idempotency ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.tenant_limit_events ENABLE TRIGGER ALL");
      }
      await tx.unsafe("DELETE FROM public.support_access_grants WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
      await tx.unsafe("DELETE FROM public.tenant_limit_buckets WHERE bucket_key LIKE 'tenant:%' OR bucket_key LIKE 'actor:%'");
      await tx.unsafe("DELETE FROM public.platform_support_principals WHERE reference LIKE 't035-%'");
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE id = ANY($1::uuid[])", [[BINDING_A, BINDING_A_WS, BINDING_A_RESEARCHER, BINDING_B]]);
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE id = ANY($1::uuid[])", [[MEMBER_A, MEMBER_A_WS, MEMBER_A_RESEARCHER, MEMBER_B]]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [[WORKSPACE_A1]]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
    });
  }

  async function journalRows(): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      "SELECT operation, status, tenant_id::text AS tenant_id, actor_namespace FROM public.support_access_journal ORDER BY created_at",
    );
  }

  async function eventRows(operation?: string): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT operation, decision_code, actor_layer, actor_id::text AS actor_id,
              support_grant_id::text AS support_grant_id, reason_code, correlation_id
       FROM public.support_access_events
       WHERE ($1::text IS NULL OR operation = $1)
       ORDER BY created_at, event_id`,
      [operation ?? null],
    );
  }

  async function grantRows(): Promise<Record<string, unknown>[]> {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, workspace_id::text AS workspace_id,
              support_actor_auth_identity_id::text AS support_actor,
              requested_by_auth_identity_id::text AS requested_by,
              approved_by_auth_identity_id::text AS approved_by,
              revoked_by_auth_identity_id::text AS revoked_by, state
       FROM public.support_access_grants ORDER BY created_at`,
    );
  }

  async function resetTenantA(status: "active" | "suspended" = "active"): Promise<void> {
    await admin.unsafe("UPDATE public.tenants SET status = $1 WHERE id = $2", [status, TENANT_A]);
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

  it("runs request → approve → revoke through the journal, grant, and event writes", async () => {
    const svc = service();
    const requested = await runWithTenantContext(ownerSessionA(), "t035-flow-req", () =>
      svc.request(requestInput({ idempotencyKey: "t035-flow-req" })));
    expect(requested).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_REQUESTED" });
    const grantId = requested.grant!.id;

    const approved = await runWithTenantContext(ownerSessionA(), "t035-flow-approve", () =>
      svc.approve({ tenantId: TENANT_A, grantId, idempotencyKey: "t035-flow-approve" }));
    expect(approved).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_APPROVED" });
    expect(approved.grant).toMatchObject({ id: grantId, state: "approved", approvedByAuthIdentityId: ACTOR_A });

    const revoked = await runWithTenantContext(ownerSessionA(), "t035-flow-revoke", () =>
      svc.revoke({ tenantId: TENANT_A, grantId, idempotencyKey: "t035-flow-revoke" }));
    expect(revoked).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_REVOKED" });
    expect(revoked.grant).toMatchObject({ state: "revoked", revokedByAuthIdentityId: ACTOR_A });

    const grants = await grantRows();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      tenant_id: TENANT_A,
      workspace_id: null,
      support_actor: SUPPORT_ACTOR_1,
      requested_by: ACTOR_A,
      approved_by: ACTOR_A,
      revoked_by: ACTOR_A,
      state: "revoked",
    });

    const journal = await journalRows();
    expect(journal).toHaveLength(3);
    expect(journal.map((row) => row.operation)).toEqual(["request", "approve", "revoke"]);
    expect(journal.every((row) => row.status === "completed" && row.tenant_id === TENANT_A && row.actor_namespace === ACTOR_A)).toBe(true);

    const events = await eventRows();
    expect(events.map((row) => row.decision_code)).toEqual([
      "OK_SUPPORT_GRANT_REQUESTED",
      "OK_SUPPORT_GRANT_APPROVED",
      "OK_SUPPORT_GRANT_REVOKED",
    ]);
    expect(events.every((row) => row.actor_layer === "member" && row.actor_id === ACTOR_A && row.support_grant_id === grantId)).toBe(true);
  });

  it("replays an identical request and conflicts a different input on the same key", async () => {
    const svc = service();
    const grantsBefore = (await grantRows()).length;
    // The input hash covers the full request body — the window must be fixed
    // across the replay calls or each attempt hashes differently.
    const fixedWindow = window();
    const first = await runWithTenantContext(ownerSessionA(), "t035-replay", () =>
      svc.request(requestInput({ ...fixedWindow, idempotencyKey: "t035-replay-key" })));
    expect(first.code).toBe("OK_SUPPORT_GRANT_REQUESTED");

    const replayed = await runWithTenantContext(ownerSessionA(), "t035-replay", () =>
      svc.request(requestInput({ ...fixedWindow, idempotencyKey: "t035-replay-key" })));
    expect(replayed).toMatchObject({ ok: true, code: "OK_SUPPORT_REPLAY" });
    expect(replayed.grant).toMatchObject({ id: first.grant!.id, state: "pending" });

    const conflicted = await runWithTenantContext(ownerSessionA(), "t035-conflict", () =>
      svc.request(requestInput({ ...fixedWindow, reason: "a different request body", idempotencyKey: "t035-replay-key" })));
    expect(conflicted).toMatchObject({ ok: false, code: "SUPPORT_STATE_CONFLICT" });

    // The replay lane produced exactly one new grant across all three calls.
    expect(await grantRows()).toHaveLength(grantsBefore + 1);
    const decisions = (await eventRows("request")).map((row) => row.decision_code);
    expect(decisions).toContain("OK_SUPPORT_REPLAY");
    expect(decisions).toContain("SUPPORT_STATE_CONFLICT");
  });

  it("denies self-requests, unknown and disabled principals, and non-owner members", async () => {
    const svc = service();
    const self = await runWithTenantContext(ownerSessionA(), "t035-self", () =>
      svc.request(requestInput({ supportPrincipalRef: SUPPORT_REF_SELF, idempotencyKey: "t035-self" })));
    expect(self).toMatchObject({ ok: false, code: "SUPPORT_SELF_ACTION" });

    const unknown = await runWithTenantContext(ownerSessionA(), "t035-unknown", () =>
      svc.request(requestInput({ supportPrincipalRef: "t035-no-such-ref", idempotencyKey: "t035-unknown" })));
    expect(unknown).toMatchObject({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    const disabled = await runWithTenantContext(ownerSessionA(), "t035-disabled", () =>
      svc.request(requestInput({ supportPrincipalRef: SUPPORT_REF_DISABLED, idempotencyKey: "t035-disabled" })));
    expect(disabled).toMatchObject({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    const grantsBefore = (await grantRows()).length;
    const researcher = await runWithTenantContext(researcherSessionA(), "t035-researcher", () =>
      svc.request(requestInput({ idempotencyKey: "t035-researcher" })));
    expect(researcher).toMatchObject({ ok: false, code: "SUPPORT_POLICY_BLOCKED" });

    expect(await grantRows()).toHaveLength(grantsBefore);
    const denials = (await eventRows("request")).map((row) => row.decision_code);
    for (const code of ["SUPPORT_SELF_ACTION", "SUPPORT_GRANT_REQUIRED", "SUPPORT_POLICY_BLOCKED"]) {
      expect(denials).toContain(code);
    }
  });

  it("scopes workspace-context grants and refuses workspace approvals of tenant-wide grants", async () => {
    const svc = service();
    const requested = await runWithTenantContext(workspaceOwnerSessionA(), "t035-ws-req", () =>
      svc.request(requestInput({ workspaceId: WORKSPACE_A1, idempotencyKey: "t035-ws-req" })));
    expect(requested).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_REQUESTED" });
    expect(requested.grant).toMatchObject({ workspaceId: WORKSPACE_A1 });
    const wsGrantId = requested.grant!.id;

    const wsApproved = await runWithTenantContext(workspaceOwnerSessionA(), "t035-ws-approve", () =>
      svc.approve({ tenantId: TENANT_A, grantId: wsGrantId, idempotencyKey: "t035-ws-approve" }));
    expect(wsApproved).toMatchObject({ ok: true, code: "OK_SUPPORT_GRANT_APPROVED" });

    // A tenant-wide grant cannot be approved through a workspace-scoped
    // member context — the service's scope comparison refuses it. The wide
    // request targets a second principal: the schema's partial unique index
    // permits only one pending/approved tenant-wide grant per support actor.
    const wide = await runWithTenantContext(ownerSessionA(), "t035-wide-req", () =>
      svc.request(requestInput({ supportPrincipalRef: SUPPORT_REF_2, idempotencyKey: "t035-wide-req" })));
    expect(wide.code).toBe("OK_SUPPORT_GRANT_REQUESTED");
    const wsApproveWide = await runWithTenantContext(workspaceOwnerSessionA(), "t035-ws-approve-wide", () =>
      svc.approve({ tenantId: TENANT_A, grantId: wide.grant!.id, idempotencyKey: "t035-ws-approve-wide" }));
    expect(wsApproveWide).toMatchObject({ ok: false, code: "SUPPORT_SCOPE_MISMATCH" });

    const grants = await grantRows();
    expect(grants.some((row) => row.id === wsGrantId && row.state === "approved" && row.workspace_id === WORKSPACE_A1)).toBe(true);
    expect(grants.some((row) => row.id === wide.grant!.id && row.state === "pending" && row.workspace_id === null)).toBe(true);
  });

  it("lists current and historical grants through member-RLS reads", async () => {
    const svc = service();
    const listed = await runWithTenantContext(ownerSessionA(), "t035-list", () =>
      svc.listCurrent({ tenantId: TENANT_A, idempotencyKey: "t035-list-current" }));
    expect(listed).toMatchObject({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    // The approved workspace grant from the previous test is inside its
    // window; the revoked grant and the still-pending wide request are not
    // "current" (pending is not eligible).
    const currentIds = (listed.grants ?? []).map((grant) => grant.id);
    const history = await runWithTenantContext(ownerSessionA(), "t035-list", () =>
      svc.listHistory({ tenantId: TENANT_A, idempotencyKey: "t035-list-history" }));
    expect(history).toMatchObject({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    expect((history.grants ?? []).length).toBeGreaterThanOrEqual(currentIds.length);

    const listEvents = await eventRows("list_current");
    expect(listEvents.some((row) => row.decision_code === "OK_SUPPORT_AUTHORIZED")).toBe(true);
  });

  it("fails closed with no member context and on a suspended tenant", async () => {
    const svc = service();
    const noContext = await svc.request(requestInput({ idempotencyKey: "t035-noctx" }));
    expect(noContext).toMatchObject({ ok: false, code: "SUPPORT_MALFORMED" });

    const grantsBefore = (await grantRows()).length;
    const journalBefore = (await journalRows()).length;
    await resetTenantA("suspended");
    const suspended = await runWithTenantContext(ownerSessionA(), "t035-susp", () =>
      svc.request(requestInput({ idempotencyKey: "t035-susp" })));
    expect(suspended).toMatchObject({ ok: false, code: "SUPPORT_INTERNAL" });
    await resetTenantA("active");

    // The suspended-tenant attempt rolls back before any ledger write.
    expect(await grantRows()).toHaveLength(grantsBefore);
    expect(await journalRows()).toHaveLength(journalBefore);
  });

  it("rejects direct function calls that escape the member-context binding", async () => {
    await runWithTenantContext(ownerSessionA(), "t035-direct", () =>
      withTenantDbContext(async (db) => {
        // A direct caller cannot plant an event under another tenant id.
        const badEvent = await db
          .prepare("SELECT recorded FROM public.novatrade_support_access_append_event(?)")
          .get<{ recorded: boolean }>(JSON.stringify({
            eventId: "90000000-0000-4000-8000-000000000001",
            operation: "request",
            tenantId: TENANT_B,
            workspaceId: null,
            actorLayer: "member",
            actorId: ACTOR_A,
            supportGrantId: null,
            permission: "support:grant",
            dataClasses: [],
            decisionCode: "OK_SUPPORT_GRANT_REQUESTED",
            reasonCode: "support.grant.request",
            correlationId: "t035-direct",
            attemptId: "90000000-0000-4000-8000-000000000002",
            inputHash: "a".repeat(64),
          }));
        expect(badEvent?.recorded).toBe(false);

        // Nor create a grant for an unregistered support principal.
        const badGrant = await db
          .prepare("SELECT grant_json FROM public.novatrade_support_access_create_grant(?)")
          .get<{ grant_json: unknown }>(JSON.stringify({
            id: "90000000-0000-4000-8000-000000000003",
            tenantId: TENANT_A,
            workspaceId: null,
            supportActorAuthIdentityId: ACTOR_B,
            platformRole: "platform_support",
            requestedByAuthIdentityId: ACTOR_A,
            reasonCode: "support.incident-9",
            reason: "forged principal",
            ...window(),
            correlationId: "t035-direct",
            auditEventId: "90000000-0000-4000-8000-000000000004",
            permissions: ["tenant:read"],
            dataClasses: ["tenant_metadata"],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
        expect(badGrant).toBeUndefined();

        // Nor borrow another member's journal lane — the derived key binds
        // the context actor, so a foreign-tenant session sees only 'denied'.
        return Promise.resolve();
      }));

    await runWithTenantContext(ownerSessionB(), "t035-direct-b", () =>
      withTenantDbContext(async (db) => {
        const denied = await db
          .prepare("SELECT outcome FROM public.novatrade_support_access_reserve(?)")
          .get<{ outcome: string }>(JSON.stringify({
            operation: "request",
            idempotencyKey: "t035-replay-key",
            inputHash: "b".repeat(64),
          }));
        // Tenant B's context derives a different lane — 'new', never a leak
        // of tenant A's reservation.
        expect(denied?.outcome).toBe("new");
        return Promise.resolve();
      }));

    const events = await eventRows();
    expect(events.some((row) => row.correlation_id === "t035-direct")).toBe(false);
    expect((await grantRows()).every((row) => row.support_actor !== ACTOR_B)).toBe(true);
  });
});
