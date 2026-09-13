import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";

import { closeDb, withTenantDbContext, type DbClient } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { runWithSupportSession, type SupportSessionAssertion } from "@/lib/tenancy/support-session";
import { createSupportAccessService, getSupportAccessContext, type SupportAccessCheckInput } from "@/lib/tenancy/support-access";
import {
  createPostgresSupportAccessPolicyEvaluator,
  createPostgresSupportAccessRepository,
  createPostgresSupportPrincipalResolver,
} from "@/lib/tenancy/postgres-support-access";
import type { TenantSession } from "@/lib/auth";

/**
 * T-042 gated rehearsal for the support-authorization lane on PostgreSQL 16 —
 * check/authorizeAndRun under the edge-asserted support-session envelope
 * (migration 202609120015).
 *
 * The edge asserts a platform-support principal's session as transaction-local
 * GUCs via runWithSupportSession; the service re-validates the asserted grant
 * through lane-bound SECURITY DEFINER reads before the run context installs.
 * Two authority levels stay distinct: the structural lane shape admits the
 * journal/event/readback path so denials ledger honestly, while scoped data
 * reads still require novatrade_rls_support_context() — the approved,
 * unrevoked, in-window, bound grant on an active tenant.
 *
 * The lane replays against a disposable `t042_support_authorization_rehearsal`
 * db (seeded schema plus migration 202609120015) with a `t042_runtime` role
 * holding EXECUTE on the check-path API functions and SELECT on the
 * support-readable tables only.
 */
const RUN = process.env.T042_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t042_support_authorization_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000a2";
const WORKSPACE_A1 = "10000000-0000-4000-8000-0000000000a1";
const WORKSPACE_FOREIGN = "10000000-0000-4000-8000-0000000000b1";

const SUPPORT_ACTOR = "50000000-0000-4000-8000-0000000000a1";
const EXPIRED_ACTOR = "50000000-0000-4000-8000-0000000000a2";
const DISABLED_ACTOR = "50000000-0000-4000-8000-0000000000a3";
const FOREIGN_ACTOR = "50000000-0000-4000-8000-0000000000a4";
const REQUESTER = "50000000-0000-4000-8000-0000000000a9";

const GRANT_A = "60000000-0000-4000-8000-0000000000a1";
const GRANT_A_WS = "60000000-0000-4000-8000-0000000000a2";
const GRANT_A_EXPIRED = "60000000-0000-4000-8000-0000000000a3";
const GRANT_A_REVOKED = "60000000-0000-4000-8000-0000000000a4";
const GRANT_DISABLED = "60000000-0000-4000-8000-0000000000a5";
const GRANT_B = "60000000-0000-4000-8000-0000000000b1";
const GRANT_FOREIGN = "60000000-0000-4000-8000-0000000000c1";

const TENANT_IDS = [TENANT_A, TENANT_B] as const;
const WORKSPACE_IDS = [WORKSPACE_A1, WORKSPACE_FOREIGN] as const;
const GRANT_IDS = [GRANT_A, GRANT_A_WS, GRANT_A_EXPIRED, GRANT_A_REVOKED, GRANT_DISABLED, GRANT_B, GRANT_FOREIGN] as const;
const PRINCIPAL_REFS = ["support-agent", "support-expired", "support-disabled"] as const;

function session(assertion: {
  tenantId: string;
  workspaceId?: string | null;
  actorAuthIdentityId?: string;
  supportGrantId: string;
  correlationId: string;
}): SupportSessionAssertion {
  return {
    tenantId: assertion.tenantId,
    workspaceId: assertion.workspaceId ?? null,
    actorAuthIdentityId: assertion.actorAuthIdentityId ?? SUPPORT_ACTOR,
    supportGrantId: assertion.supportGrantId,
    correlationId: assertion.correlationId,
  };
}

function checkInput(grantId: string, correlationId: string, overrides: Record<string, unknown> = {}): SupportAccessCheckInput {
  return {
    tenantId: TENANT_A,
    supportPrincipalRef: "support-agent",
    grantId,
    permission: "tenant:read",
    dataClasses: ["tenant_metadata"],
    correlationId,
    idempotencyKey: `check-${randomUUID()}`,
    ...overrides,
  };
}

function memberSession(): TenantSession {
  return {
    userId: REQUESTER,
    email: "t042-owner@example.test",
    displayName: "T042 Owner",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: "20000000-0000-4000-8000-0000000000a1",
    role: "owner",
    roleBindingId: "30000000-0000-4000-8000-0000000000a1",
  };
}

describe.skipIf(!RUN)("T-042 support authorization lane on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-042 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T042_ADMIN_DATABASE_URL) {
      throw new Error("T-042 disposable test requires DATABASE_URL and T042_ADMIN_DATABASE_URL");
    }
    if (!process.env.T042_RUNTIME_ROLE) {
      throw new Error("T-042 disposable test requires T042_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T042_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-042 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-042 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-042 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T042_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-042 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_support_lane_shape',
        'novatrade_support_access_reserve',
        'novatrade_support_access_commit',
        'novatrade_support_access_append_event',
        'novatrade_support_access_grant_read',
        'novatrade_support_access_workspace_exists',
        'novatrade_support_principal_resolve',
        'novatrade_support_principal_current'
      )
    `);
    if (
      posture.length !== 8
      || posture.some((fn) => !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)
    ) {
      throw new Error("T-042 preflight refused: API functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-042 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't042-tenant-a', 'Support Tenant A', 'active'), ($2, 't042-tenant-b', 'Support Tenant B', 'suspended')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
          ($1, $2, 't042-ws-a1', 'Support Workspace A1', 'active'),
          ($3, $4, 't042-ws-foreign', 'Foreign Workspace', 'active')`,
        [WORKSPACE_A1, TENANT_A, WORKSPACE_FOREIGN, TENANT_B],
      );
      await tx.unsafe(
        `INSERT INTO public.platform_support_principals (reference, auth_identity_id, status) VALUES
          ('support-agent', $1, 'active'),
          ('support-expired', $2, 'active'),
          ('support-disabled', $3, 'disabled')`,
        [SUPPORT_ACTOR, EXPIRED_ACTOR, DISABLED_ACTOR],
      );
      // Grant fixtures ride the real state machine: children land first so the
      // grant's deferrable permission/data-class anchors resolve at commit.
      await tx.unsafe("ALTER TABLE public.support_access_grant_permissions DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_data_classes DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grants DISABLE TRIGGER ALL");
      await tx.unsafe(
        `INSERT INTO public.support_access_grant_permissions (grant_id, permission) VALUES
          ($1, 'tenant:read'), ($1, 'workspace:read'), ($1, 'audit:read'),
          ($2, 'workspace:read'),
          ($3, 'tenant:read'),
          ($4, 'tenant:read'),
          ($5, 'tenant:read'),
          ($6, 'tenant:read'),
          ($7, 'tenant:read')`,
        [...GRANT_IDS],
      );
      await tx.unsafe(
        `INSERT INTO public.support_access_grant_data_classes (grant_id, data_class) VALUES
          ($1, 'tenant_metadata'), ($1, 'workspace_metadata'), ($1, 'audit_operational_metadata'),
          ($2, 'workspace_metadata'),
          ($3, 'tenant_metadata'),
          ($4, 'tenant_metadata'),
          ($5, 'tenant_metadata'),
          ($6, 'tenant_metadata'),
          ($7, 'tenant_metadata')`,
        [...GRANT_IDS],
      );
      await tx.unsafe(
        `INSERT INTO public.support_access_grants
           (id, tenant_id, workspace_id, support_actor_auth_identity_id, requested_by_auth_identity_id,
            approved_by_auth_identity_id, approved_at, revoked_by_auth_identity_id, revoked_at, state,
            reason_code, reason, starts_at, expires_at, correlation_id, audit_event_id,
            permission_anchor, data_class_anchor, created_at, updated_at)
         VALUES
           ($1, $8, NULL, $9, $10, $10, now() - interval '30 minutes', NULL, NULL, 'approved',
            'incident.review', 'T-042 tenant-wide grant', now() - interval '1 hour', now() + interval '1 hour',
            't042-grant-a', $11, 'tenant:read', 'tenant_metadata', now() - interval '90 minutes', now() - interval '30 minutes'),
           ($2, $8, $12, $9, $10, $10, now() - interval '30 minutes', NULL, NULL, 'approved',
            'incident.review', 'T-042 workspace-scoped grant', now() - interval '1 hour', now() + interval '1 hour',
            't042-grant-a-ws', $11, 'workspace:read', 'workspace_metadata', now() - interval '90 minutes', now() - interval '30 minutes'),
           ($3, $8, NULL, $13, $10, $10, now() - interval '3 hours', NULL, NULL, 'approved',
            'incident.review', 'T-042 expired grant', now() - interval '2 hours', now() - interval '1 hour',
            't042-grant-expired', $11, 'tenant:read', 'tenant_metadata', now() - interval '4 hours', now() - interval '3 hours'),
           ($4, $8, NULL, $9, $10, $10, now() - interval '30 minutes', $10, now() - interval '10 minutes', 'revoked',
            'incident.review', 'T-042 revoked grant', now() - interval '1 hour', now() + interval '1 hour',
            't042-grant-revoked', $11, 'tenant:read', 'tenant_metadata', now() - interval '90 minutes', now() - interval '10 minutes'),
           ($5, $8, NULL, $16, $10, $10, now() - interval '30 minutes', NULL, NULL, 'approved',
            'incident.review', 'T-042 disabled-principal grant', now() - interval '1 hour', now() + interval '1 hour',
            't042-grant-disabled', $11, 'tenant:read', 'tenant_metadata', now() - interval '90 minutes', now() - interval '30 minutes'),
           ($6, $14, NULL, $9, $10, $10, now() - interval '30 minutes', NULL, NULL, 'approved',
            'incident.review', 'T-042 suspended-tenant grant', now() - interval '1 hour', now() + interval '1 hour',
            't042-grant-b', $11, 'tenant:read', 'tenant_metadata', now() - interval '90 minutes', now() - interval '30 minutes'),
           ($7, $8, NULL, $15, $10, $10, now() - interval '30 minutes', NULL, NULL, 'approved',
            'incident.review', 'T-042 foreign-actor grant', now() - interval '1 hour', now() + interval '1 hour',
            't042-grant-foreign', $11, 'tenant:read', 'tenant_metadata', now() - interval '90 minutes', now() - interval '30 minutes')`,
        [
          ...GRANT_IDS,
          TENANT_A, SUPPORT_ACTOR, REQUESTER, randomUUID(), WORKSPACE_A1, EXPIRED_ACTOR, TENANT_B, FOREIGN_ACTOR, DISABLED_ACTOR,
        ],
      );
      await tx.unsafe("ALTER TABLE public.support_access_grant_permissions ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_data_classes ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grants ENABLE TRIGGER ALL");
    });
  }

  async function cleanRows(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.support_access_events DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_journal DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_permissions DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_data_classes DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grants DISABLE TRIGGER ALL");
      await tx.unsafe("DELETE FROM public.support_access_events WHERE tenant_id = ANY($1::uuid[])", [TENANT_IDS]);
      await tx.unsafe("DELETE FROM public.support_access_journal WHERE tenant_id = ANY($1::uuid[])", [TENANT_IDS]);
      await tx.unsafe("DELETE FROM public.support_access_grant_permissions WHERE grant_id = ANY($1::uuid[])", [GRANT_IDS]);
      await tx.unsafe("DELETE FROM public.support_access_grant_data_classes WHERE grant_id = ANY($1::uuid[])", [GRANT_IDS]);
      await tx.unsafe("DELETE FROM public.support_access_grants WHERE id = ANY($1::uuid[])", [GRANT_IDS]);
      await tx.unsafe("DELETE FROM public.platform_support_principals WHERE reference = ANY($1::text[])", [PRINCIPAL_REFS]);
      await tx.unsafe("DELETE FROM public.workspaces WHERE id = ANY($1::uuid[])", [WORKSPACE_IDS]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [TENANT_IDS]);
      await tx.unsafe("ALTER TABLE public.support_access_events ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_journal ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_permissions ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grant_data_classes ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.support_access_grants ENABLE TRIGGER ALL");
    });
  }

  function service() {
    return createSupportAccessService({
      repository: createPostgresSupportAccessRepository(),
      principalResolver: createPostgresSupportPrincipalResolver(),
      policyEvaluator: createPostgresSupportAccessPolicyEvaluator(),
      idFactory: () => randomUUID(),
    });
  }

  function check(assertion: SupportSessionAssertion, input: SupportAccessCheckInput) {
    return runWithSupportSession(assertion, () => service().check(input));
  }

  beforeEach(async () => {
    if (!targetValidated) await assertDisposableTarget();
    await fixture();
  });

  afterAll(async () => {
    await closeDb();
    if (targetValidated) await cleanRows();
    await runtime?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("authorizes check and authorizeAndRun under the asserted session envelope and scopes callback reads", async () => {
    const correlation = `t042-ok-${randomUUID()}`;
    const envelope = session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: correlation });

    const allowed = await check(envelope, checkInput(GRANT_A, correlation));
    expect(allowed).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    expect(allowed.grant).toBeUndefined();
    expect(allowed.context).toBeUndefined();

    const runCorrelation = `t042-run-${randomUUID()}`;
    const runEnvelope = session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: runCorrelation });
    const ran = await runWithSupportSession(runEnvelope, () =>
      service().authorizeAndRun(
        checkInput(GRANT_A, runCorrelation, { permission: "tenant:read" }),
        async (context) => {
          expect(context).toMatchObject({
            source: "support",
            tenantId: TENANT_A,
            workspaceId: null,
            supportActorAuthIdentityId: SUPPORT_ACTOR,
            supportGrantId: GRANT_A,
            permission: "tenant:read",
            correlationId: runCorrelation,
          });
          // Inside the callback the run context installs the same GUC
          // envelope: scoped reads ride the grant's permission + data class.
          const read = await withTenantDbContext(async (db: DbClient) => ({
            grant: (await db.prepare("SELECT current_setting('app.support_grant_id', true) AS v").get<{ v: string | null }>())?.v,
            member: (await db.prepare("SELECT current_setting('app.membership_id', true) AS v").get<{ v: string | null }>())?.v,
            tenants: (await db.prepare("SELECT id::text AS id FROM public.tenants ORDER BY id").all<{ id: string }>()).map((row) => row.id),
          }));
          expect(read.grant).toBe(GRANT_A);
          expect(read.member).toBe("");
          expect(read.tenants).toEqual([TENANT_A]);
          return "inside";
        },
      ),
    );
    expect(ran).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED", value: "inside" });
    expect(getSupportAccessContext()).toBeNull();

    // Both decisions journaled + evented under the support actor's namespace.
    const journal = await admin.unsafe<{ operation: string; status: string; tenant_id: string; actor_namespace: string }[]>(
      "SELECT operation, status, tenant_id::text, actor_namespace FROM public.support_access_journal WHERE tenant_id = $1",
      [TENANT_A],
    );
    expect(journal).toHaveLength(2);
    expect(journal).toEqual(expect.arrayContaining([
      { operation: "check", status: "completed", tenant_id: TENANT_A, actor_namespace: SUPPORT_ACTOR },
      { operation: "authorize_and_run", status: "completed", tenant_id: TENANT_A, actor_namespace: SUPPORT_ACTOR },
    ]));
    const events = await admin.unsafe<{ operation: string; decision_code: string; actor_layer: string; actor_id: string }[]>(
      "SELECT operation, decision_code, actor_layer, actor_id::text FROM public.support_access_events WHERE tenant_id = $1",
      [TENANT_A],
    );
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      { operation: "check", decision_code: "OK_SUPPORT_AUTHORIZED", actor_layer: "support", actor_id: SUPPORT_ACTOR },
      { operation: "authorize_and_run", decision_code: "OK_SUPPORT_AUTHORIZED", actor_layer: "support", actor_id: SUPPORT_ACTOR },
    ]));
  });

  it("replays an identical check and conflicts a different input on the same key", async () => {
    const correlation = `t042-replay-${randomUUID()}`;
    const envelope = session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: correlation });
    const input = checkInput(GRANT_A, correlation, { idempotencyKey: "t042-check-replay" });

    expect(await check(envelope, input)).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });
    // Volatile replays return the recorded denial/success without re-running.
    expect(await check(envelope, input)).toEqual({ ok: true, code: "OK_SUPPORT_REPLAY" });

    const conflict = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: correlation }),
      checkInput(GRANT_A, correlation, { idempotencyKey: "t042-check-replay", permission: "audit:read" }),
    );
    expect(conflict).toEqual({ ok: false, code: "SUPPORT_STATE_CONFLICT" });
  });

  it("denies foreign-actor, expired, revoked, disabled-principal, and wrong-reference envelopes", async () => {
    // The envelope's grant belongs to a different support actor — the
    // server-side context validation refuses before the grant is readable.
    const foreignCorrelation = `t042-foreign-${randomUUID()}`;
    const foreign = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_FOREIGN, correlationId: foreignCorrelation }),
      checkInput(GRANT_FOREIGN, foreignCorrelation, {}),
    );
    expect(foreign).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    // Expired grant: window elapsed — the envelope fails authority validation.
    const expiredCorrelation = `t042-expired-${randomUUID()}`;
    const expired = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A_EXPIRED, correlationId: expiredCorrelation, actorAuthIdentityId: EXPIRED_ACTOR }),
      checkInput(GRANT_A_EXPIRED, expiredCorrelation, { supportPrincipalRef: "support-expired" }),
    );
    expect(expired).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    // Revoked grant: the recorded denial still ledgers under the lane shape.
    const revokedCorrelation = `t042-revoked-${randomUUID()}`;
    const revoked = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A_REVOKED, correlationId: revokedCorrelation }),
      checkInput(GRANT_A_REVOKED, revokedCorrelation),
    );
    expect(revoked).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });
    const revokedEvent = await admin.unsafe<{ decision_code: string }[]>(
      "SELECT decision_code FROM public.support_access_events WHERE tenant_id = $1 AND correlation_id = $2",
      [TENANT_A, revokedCorrelation],
    );
    expect(revokedEvent).toEqual([{ decision_code: "SUPPORT_GRANT_REQUIRED" }]);

    // Disabled principal: the grant itself validates (approved, in-window,
    // bound to this actor) but the registry status check refuses it.
    const disabledCorrelation = `t042-disabled-${randomUUID()}`;
    const disabled = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_DISABLED, correlationId: disabledCorrelation, actorAuthIdentityId: DISABLED_ACTOR }),
      checkInput(GRANT_DISABLED, disabledCorrelation, { supportPrincipalRef: "support-disabled" }),
    );
    expect(disabled).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    // A reference naming a different principal resolves self-bound → null.
    const wrongRefCorrelation = `t042-wrongref-${randomUUID()}`;
    const wrongRef = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: wrongRefCorrelation }),
      checkInput(GRANT_A, wrongRefCorrelation, { supportPrincipalRef: "support-expired" }),
    );
    expect(wrongRef).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });
  });

  it("refuses permission, data-class, and workspace-scope escalation without enumeration", async () => {
    const permissionCorrelation = `t042-perm-${randomUUID()}`;
    const escalated = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: permissionCorrelation }),
      checkInput(GRANT_A, permissionCorrelation, { permission: "data:export" }),
    );
    expect(escalated).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    const dataCorrelation = `t042-data-${randomUUID()}`;
    const dataEscalated = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: dataCorrelation }),
      checkInput(GRANT_A, dataCorrelation, { dataClasses: ["tenant_metadata", "documents"] }),
    );
    expect(dataEscalated).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    // Workspace-scoped session: the workspace grant authorizes its own scope.
    const wsCorrelation = `t042-ws-${randomUUID()}`;
    const wsAllowed = await check(
      session({ tenantId: TENANT_A, workspaceId: WORKSPACE_A1, supportGrantId: GRANT_A_WS, correlationId: wsCorrelation }),
      checkInput(GRANT_A_WS, wsCorrelation, { workspaceId: WORKSPACE_A1, permission: "workspace:read", dataClasses: ["workspace_metadata"] }),
    );
    expect(wsAllowed).toEqual({ ok: true, code: "OK_SUPPORT_AUTHORIZED" });

    // The same workspace grant cannot run tenant-wide (workspaceId absent).
    const wsTenantCorrelation = `t042-ws-tenant-${randomUUID()}`;
    const wsTenantWide = await check(
      session({ tenantId: TENANT_A, workspaceId: WORKSPACE_A1, supportGrantId: GRANT_A_WS, correlationId: wsTenantCorrelation }),
      checkInput(GRANT_A_WS, wsTenantCorrelation, { permission: "workspace:read", dataClasses: ["workspace_metadata"] }),
    );
    expect(wsTenantWide).toEqual({ ok: false, code: "SUPPORT_WORKSPACE_SCOPE_INVALID" });

    // A workspace outside the asserted tenant reads as a scope denial.
    const wsForeignCorrelation = `t042-ws-foreign-${randomUUID()}`;
    const wsForeign = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: wsForeignCorrelation }),
      checkInput(GRANT_A, wsForeignCorrelation, { workspaceId: WORKSPACE_FOREIGN, permission: "workspace:read", dataClasses: ["workspace_metadata"] }),
    );
    expect(wsForeign).toEqual({ ok: false, code: "SUPPORT_WORKSPACE_SCOPE_INVALID" });

    // A check naming a grant the envelope does not carry reads back the
    // asserted grant instead — the identity mismatch is a scope refusal.
    const mismatchCorrelation = `t042-mismatch-${randomUUID()}`;
    const mismatched = await check(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: mismatchCorrelation }),
      checkInput(GRANT_A_WS, mismatchCorrelation, { workspaceId: WORKSPACE_A1, permission: "workspace:read", dataClasses: ["workspace_metadata"] }),
    );
    expect(mismatched).toEqual({ ok: false, code: "SUPPORT_SCOPE_MISMATCH" });
  });

  it("keeps the suspended-tenant edge closed and ledgers the denial", async () => {
    const correlation = `t042-suspended-${randomUUID()}`;
    const denied = await check(
      session({ tenantId: TENANT_B, supportGrantId: GRANT_B, correlationId: correlation }),
      checkInput(GRANT_B, correlation, { tenantId: TENANT_B }),
    );
    expect(denied).toEqual({ ok: false, code: "SUPPORT_GRANT_REQUIRED" });

    // The structural lane still journals the refusal for the suspended tenant.
    const journal = await admin.unsafe<{ status: string; actor_namespace: string }[]>(
      "SELECT status, actor_namespace FROM public.support_access_journal WHERE tenant_id = $1",
      [TENANT_B],
    );
    expect(journal).toEqual([{ status: "completed", actor_namespace: SUPPORT_ACTOR }]);
    const event = await admin.unsafe<{ decision_code: string; actor_layer: string }[]>(
      "SELECT decision_code, actor_layer FROM public.support_access_events WHERE tenant_id = $1",
      [TENANT_B],
    );
    expect(event).toEqual([{ decision_code: "SUPPORT_GRANT_REQUIRED", actor_layer: "support" }]);

    // And nothing under the suspended envelope can read scoped data.
    const scoped = await runtime.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [TENANT_B]);
      await tx.unsafe("SELECT set_config('app.actor_id', $1, true)", [SUPPORT_ACTOR]);
      await tx.unsafe("SELECT set_config('app.support_grant_id', $1, true)", [GRANT_B]);
      await tx.unsafe("SELECT set_config('app.correlation_id', 't042-suspended-probe', true)");
      return tx.unsafe<{ one: number }[]>("SELECT 1 AS one FROM public.tenants");
    });
    expect(scoped).toEqual([]);
  });

  it("fails closed without an envelope and under a mixed member+session context", async () => {
    const noEnvelope = await service().check(checkInput(GRANT_A, `t042-none-${randomUUID()}`));
    expect(noEnvelope.ok).toBe(false);

    const correlation = `t042-mixed-${randomUUID()}`;
    const mixed = await runWithTenantContext(memberSession(), correlation, () =>
      runWithSupportSession(
        session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: correlation }),
        () => service().check(checkInput(GRANT_A, correlation)),
      ),
    );
    expect(mixed.ok).toBe(false);
    expect(getSupportAccessContext()).toBeNull();
  });

  it("keeps internal helpers unreachable and binds readback to the asserted grant", async () => {
    await expect(runtime.unsafe("SELECT public.novatrade_support_lane_shape()")).rejects.toThrowError(/permission denied/iu);

    // No envelope → the asserted-grant read returns NULL rather than probing.
    const unenveloped = await runtime.unsafe<{ grant: unknown }[]>(
      "SELECT public.novatrade_support_access_grant_read() AS grant",
    );
    expect(unenveloped).toEqual([{ grant: null }]);

    // Under the envelope the read returns exactly the asserted grant bundle.
    const correlation = `t042-read-${randomUUID()}`;
    const grant = await runWithSupportSession(
      session({ tenantId: TENANT_A, supportGrantId: GRANT_A, correlationId: correlation }),
      () => withTenantDbContext((db) =>
        db
          .prepare("SELECT public.novatrade_support_access_grant_read() AS grant")
          .get<{ grant: { id: string; permissions: string[]; dataClasses: string[] } }>(),
      ),
    );
    expect(grant?.grant?.id).toBe(GRANT_A);
    expect(grant?.grant?.permissions).toEqual(["audit:read", "tenant:read", "workspace:read"]);
    expect(grant?.grant?.dataClasses).toEqual(["audit_operational_metadata", "tenant_metadata", "workspace_metadata"]);
  });
});
