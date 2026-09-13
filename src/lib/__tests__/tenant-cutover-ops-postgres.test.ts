import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { ensureAppUserForAuthUser } from "@/lib/app-users";
import { createPostgresExportOperationsService, createPostgresExportRunner } from "@/lib/tenancy/postgres-export-operations";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the 0X3-234 action/UI cutover —
 * migration 202609120014 (platform-lane app_users ensure functions and the
 * actor-context-gated read surface) plus the Postgres export runner the
 * requestTenantExportAction drives inline.
 *
 *   * app_user_session_profile ports ensureAppUserForAuthUser: existing-row
 *     touch, bootstrap-first-admin insert, pending phantom — all inside the
 *     definer because app_users is deny-all for the runtime role.
 *   * app_user_ensure_active ports the acceptance path's create-if-missing:
 *     persisted rows are never rewritten.
 *   * The snapshot/jobs reads run under the structural actor context
 *     (novatrade_deletion_actor_ctx), which does not require tenant status
 *     'active' — suspended tenants keep their recorded lifecycle truthful.
 *   * createPostgresExportRunner snapshots the five member-RLS tables inside
 *     the job transaction; runExport drives it end to end.
 *
 * Requires disposable database `t041_action_cutover_rehearsal` (schema through
 * migration 202609120014) and a `t041_runtime` role granted EXECUTE on the
 * API functions only. `DATABASE_URL` is staged to the runtime role with
 * `DATABASE_SSL=disable`. See docs/TESTING.md for provisioning.
 */

const RUN = process.env.T041_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t041_action_cutover_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000a2";
const WORKSPACE_A1 = "10000000-0000-4000-8000-0000000000a1";
const MEMBER_A_OWNER = "20000000-0000-4000-8000-0000000000a1";
const MEMBER_A_RESEARCHER = "20000000-0000-4000-8000-0000000000a2";
const MEMBER_B_OWNER = "20000000-0000-4000-8000-0000000000b1";
const MEMBER_A_ORDINARY = "20000000-0000-4000-8000-0000000000a3";
const BINDING_A_OWNER = "30000000-0000-4000-8000-0000000000a1";
const BINDING_A_RESEARCHER = "30000000-0000-4000-8000-0000000000a2";
const BINDING_B_OWNER = "30000000-0000-4000-8000-0000000000b1";
const BINDING_A_ORDINARY = "30000000-0000-4000-8000-0000000000a3";
const ACTOR_A_OWNER = "50000000-0000-4000-8000-0000000000a1";
const ACTOR_A_RESEARCHER = "50000000-0000-4000-8000-0000000000a2";
const ACTOR_B_OWNER = "50000000-0000-4000-8000-0000000000b1";
const EXPORT_JOB_A = "60000000-0000-4000-8000-0000000000a1";
const DELETION_JOB_A = "70000000-0000-4000-8000-0000000000a1";
const EXPORT_JOB_B = "60000000-0000-4000-8000-0000000000b1";
const DELETION_JOB_B = "70000000-0000-4000-8000-0000000000b1";

const BOOTSTRAP_USER = "80000000-0000-4000-8000-0000000000a1";
const ORDINARY_USER = "80000000-0000-4000-8000-0000000000a2";
const EXISTING_USER = "80000000-0000-4000-8000-0000000000a3";
const DISABLED_USER = "80000000-0000-4000-8000-0000000000a4";
const PHANTOM_USER = "80000000-0000-4000-8000-0000000000a5";

function hashRef(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_OWNER,
    email: "t041-owner-a@example.test",
    displayName: "T041 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_OWNER,
    role: "owner",
    roleBindingId: BINDING_A_OWNER,
    ...overrides,
  };
}

function researcherSessionA(): TenantSession {
  return {
    userId: ACTOR_A_RESEARCHER,
    email: "t041-researcher-a@example.test",
    displayName: "T041 Researcher A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_RESEARCHER,
    role: "researcher",
    roleBindingId: BINDING_A_RESEARCHER,
  };
}

function ownerSessionB(): TenantSession {
  return {
    userId: ACTOR_B_OWNER,
    email: "t041-owner-b@example.test",
    displayName: "T041 Owner B",
    tenantId: TENANT_B,
    workspaceId: null,
    membershipId: MEMBER_B_OWNER,
    role: "owner",
    roleBindingId: BINDING_B_OWNER,
  };
}

describe.skipIf(!RUN)("T-041 tenant cutover operations on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-041 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T041_ADMIN_DATABASE_URL) {
      throw new Error("T-041 disposable test requires DATABASE_URL and T041_ADMIN_DATABASE_URL");
    }
    if (!process.env.T041_RUNTIME_ROLE) {
      throw new Error("T-041 disposable test requires T041_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T041_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-041 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-041 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-041 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T041_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-041 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_app_user_session_profile',
        'novatrade_app_user_ensure_active',
        'novatrade_tenant_lifecycle_snapshot_read',
        'novatrade_tenant_deletion_job_latest',
        'novatrade_tenant_export_job_latest',
        'novatrade_tenant_export_job_read',
        'novatrade_deletion_actor_ctx'
      )
    `);
    const internal = new Set(["novatrade_deletion_actor_ctx"]);
    if (
      posture.length !== 7
      || posture.some((fn) =>
        internal.has(fn.proname)
          ? !fn.prosecdef // lane predicates are STABLE definers but internal-only
          : !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)
    ) {
      throw new Error("T-041 preflight refused: API functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }

    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-041 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-041 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't041-tenant-a', 'Cutover Tenant A', 'active'), ($2, 't041-tenant-b', 'Cutover Tenant B', 'suspended')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES ($1, $2, 't041-ws-a1', 'Cutover Workspace A1', 'active')",
        [WORKSPACE_A1, TENANT_A],
      );
      await tx.unsafe("INSERT INTO public.tenant_policies (tenant_id) VALUES ($1), ($2)", [TENANT_A, TENANT_B]);
      await tx.unsafe(
        `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id, status) VALUES
          ($1, $4, $5, NULL, NULL, 'active'),
          ($2, $4, $6, NULL, NULL, 'active'),
          ($3, $7, $8, NULL, NULL, 'active'),
          ($9, $4, $10, NULL, NULL, 'active')`,
        [MEMBER_A_OWNER, MEMBER_A_RESEARCHER, MEMBER_B_OWNER, TENANT_A, ACTOR_A_OWNER, ACTOR_A_RESEARCHER, TENANT_B, ACTOR_B_OWNER, MEMBER_A_ORDINARY, ORDINARY_USER],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, created_at, valid_from, revoked_at) VALUES
          ($1, $4, $5, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($2, $4, $6, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($3, $7, $8, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($9, $4, $10, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null)`,
        [BINDING_A_OWNER, BINDING_A_RESEARCHER, BINDING_B_OWNER, TENANT_A, MEMBER_A_OWNER, MEMBER_A_RESEARCHER, TENANT_B, MEMBER_B_OWNER, BINDING_A_ORDINARY, MEMBER_A_ORDINARY],
      );
      // Transition receipts for tenant A (provisioning → active) and tenant B
      // (provisioning → active → suspended): metadata is jsonb on Postgres;
      // the snapshot read must emit it as text for the canonical parser. The
      // append-only guard requires server-derived context, so fixture seeds
      // disable it the way cleanRows does.
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe(
        `INSERT INTO public.audit_logs (id, action, entity_type, entity_id, metadata, created_at, scope_kind, tenant_id, actor_auth_identity_id, actor_membership_id, actor_launch_role, actor_role_binding_id, actor_layer, correlation_id) VALUES
          ($1, 'tenant.provisioned', 'tenant', $5::text, $6::jsonb, now() - interval '3 minutes', 'tenant', $5::uuid, $7, $12, 'owner', $13, 'member', 't041-provisioned-a'),
          ($2, 'tenant.provisioned', 'tenant', $8::text, $9::jsonb, now() - interval '4 minutes', 'tenant', $8::uuid, $10, $14, 'owner', $15, 'member', 't041-provisioned-b'),
          ($3, 'tenant.suspended', 'tenant', $8::text, $11::jsonb, now() - interval '2 minutes', 'tenant', $8::uuid, $10, $14, 'owner', $15, 'member', 't041-suspended-b'),
          ($4, 'lead.created', 'lead', 'lead-1', '{}'::jsonb, now() - interval '1 minute', 'tenant', $5::uuid, $7, $12, 'owner', $13, 'member', 't041-nontransition-a')`,
        [
          randomUUID(), randomUUID(), randomUUID(), randomUUID(),
          TENANT_A,
          { tenantId: TENANT_A, actorIdentityId: ACTOR_A_OWNER, occurredAt: new Date(Date.now() - 180_000).toISOString(), eventId: "t041-event-provisioned-a" },
          ACTOR_A_OWNER,
          TENANT_B,
          { tenantId: TENANT_B, actorIdentityId: ACTOR_B_OWNER, occurredAt: new Date(Date.now() - 240_000).toISOString(), eventId: "t041-event-provisioned-b" },
          ACTOR_B_OWNER,
          { tenantId: TENANT_B, tenantFromStatus: "active", tenantToStatus: "suspended", actorIdentityId: ACTOR_B_OWNER, occurredAt: new Date(Date.now() - 120_000).toISOString(), eventId: "t041-event-suspended-b", reasonCode: "t041.suspend", reason: "Suspended for the cutover lane." },
          MEMBER_A_OWNER,
          BINDING_A_OWNER,
          MEMBER_B_OWNER,
          BINDING_B_OWNER,
        ],
      );
      await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_export_jobs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_jobs DISABLE TRIGGER ALL");
      await tx.unsafe(
        `INSERT INTO public.tenant_export_jobs
           (id, tenant_id, workspace_id, operation, requester_auth_identity_id, requester_membership_id,
            status, scope_hash, input_hash, idempotency_key_hash, policy_version, manifest_version,
            schema_version, requested_format, correlation_id, audit_event_id,
            artifact_storage_ref, artifact_checksum_sha256, included_count, excluded_count, redacted_count,
            snapshot_at, artifact_created_at, expires_at, created_at, updated_at)
         VALUES
           ($1, $3, NULL, 'tenant_data_export', $4, $5, 'released', $6, $7, $8, 'tenant-policy-v1', 'manifest-v1', 'schema-v1', 'json', 't041-export-a', $9,
            $17, $19, 4, 0, 2,
            now() - interval '9 minutes', now() - interval '8 minutes', now() + interval '6 days',
            now() - interval '10 minutes', now() - interval '8 minutes'),
           ($2, $10, NULL, 'tenant_data_export', $11, $12, 'released', $13, $14, $15, 'tenant-policy-v1', 'manifest-v1', 'schema-v1', 'json', 't041-export-b', $16,
            $18, $20, 3, 0, 1,
            now() - interval '9 minutes', now() - interval '8 minutes', now() + interval '6 days',
            now() - interval '10 minutes', now() - interval '8 minutes')`,
        [
          EXPORT_JOB_A, EXPORT_JOB_B,
          TENANT_A, ACTOR_A_OWNER, MEMBER_A_OWNER,
          hashRef("t041:export-scope-a"), hashRef("t041:export-input-a"), hashRef("t041:export-idem-a"), randomUUID(),
          TENANT_B, ACTOR_B_OWNER, MEMBER_B_OWNER,
          hashRef("t041:export-scope-b"), hashRef("t041:export-input-b"), hashRef("t041:export-idem-b"), randomUUID(),
          `tenants/${TENANT_A}/exports/${EXPORT_JOB_A}/export.json`,
          `tenants/${TENANT_B}/exports/${EXPORT_JOB_B}/export.json`,
          hashRef("t041:export-artifact-a"),
          hashRef("t041:export-artifact-b"),
        ],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_deletion_jobs
           (id, tenant_id, workspace_id, operation, scope_kind, scope_selector_hash,
            requested_by_auth_identity_id, requested_by_membership_id, status,
            policy_version, policy_snapshot_hash, input_hash, idempotency_key_hash,
            correlation_id, audit_event_id, created_at)
         VALUES
           ($1, $3, NULL, 'tenant_data_deletion', 'tenant', $4, $5, $6, 'requested', 'tenant-policy-v1', $7, $8, $9, 't041-deletion-a', $10,
            now() - interval '10 minutes'),
           ($2, $11, NULL, 'tenant_data_deletion', 'tenant', $12, $13, $14, 'requested', 'tenant-policy-v1', $15, $16, $17, 't041-deletion-b', $18,
            now() - interval '5 minutes')`,
        [
          DELETION_JOB_A, DELETION_JOB_B,
          TENANT_A, hashRef("t041:deletion-scope-a"), ACTOR_A_OWNER, MEMBER_A_OWNER,
          hashRef("t041:deletion-policy-a"), hashRef("t041:deletion-input-a"), hashRef("t041:deletion-idem-a"), randomUUID(),
          TENANT_B, hashRef("t041:deletion-scope-b"), ACTOR_B_OWNER, MEMBER_B_OWNER,
          hashRef("t041:deletion-policy-b"), hashRef("t041:deletion-input-b"), hashRef("t041:deletion-idem-b"), randomUUID(),
        ],
      );
      await tx.unsafe("ALTER TABLE public.tenant_export_jobs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_jobs ENABLE TRIGGER ALL");
      // app_users.user_id FK-references auth.users — seed the identity stubs
      // for every user the fixture or the definers will persist.
      await tx.unsafe(
        "INSERT INTO auth.users (id) VALUES ($1), ($2), ($3), ($4), ($5) ON CONFLICT (id) DO NOTHING",
        [EXISTING_USER, DISABLED_USER, BOOTSTRAP_USER, ORDINARY_USER, PHANTOM_USER],
      );
      await tx.unsafe(
        `INSERT INTO public.app_users (id, user_id, email, display_name, role, status, is_team_lead)
         VALUES
           ($1, $2, 't041-existing@example.test', 'T041 Existing', 'researcher', 'active', 0),
           ($3, $4, 't041-disabled@example.test', 'T041 Disabled', 'researcher', 'disabled', 0)`,
        [randomUUID(), EXISTING_USER, randomUUID(), DISABLED_USER],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_export_jobs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_jobs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.app_users DISABLE TRIGGER ALL");
      await tx.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE 't041-%'");
      await tx.unsafe("DELETE FROM public.tenant_export_jobs WHERE correlation_id LIKE 't041-%'");
      await tx.unsafe("DELETE FROM public.tenant_deletion_jobs WHERE correlation_id LIKE 't041-%'");
      await tx.unsafe("DELETE FROM public.app_users WHERE email LIKE 't041-%'");
      await tx.unsafe(
        "DELETE FROM auth.users WHERE id IN ('80000000-0000-4000-8000-0000000000a1','80000000-0000-4000-8000-0000000000a2','80000000-0000-4000-8000-0000000000a3','80000000-0000-4000-8000-0000000000a4')",
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_role_bindings WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't041-%')",
      );
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't041-%')");
      await tx.unsafe("DELETE FROM public.tenant_policies WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't041-%')");
      await tx.unsafe("DELETE FROM public.workspaces WHERE slug LIKE 't041-%'");
      await tx.unsafe("DELETE FROM public.tenants WHERE slug LIKE 't041-%'");
      await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_export_jobs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_jobs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.app_users ENABLE TRIGGER ALL");
    });
  }

  async function appUserRow(userId: string) {
    const rows = await admin.unsafe<{ status: string; role: string; last_seen_at: Date | null }[]>(
      "SELECT status, role::text AS role, last_seen_at FROM public.app_users WHERE user_id = $1",
      [userId],
    );
    return rows[0] ?? null;
  }

  interface SnapshotBundle {
    tenant: { id: string; status: string; slug: string };
    audit: { id: string; action: string; metadata: string; created_at: string; workspace_id: string | null; actor_auth_identity_id: string | null }[];
    deletion: { id: string; freeze_handoff_status: string; access_revocation_handoff_status: string } | null;
  }

  async function tenantDb<T>(session: TenantSession, correlation: string, fn: (db: import("@/lib/db").DbClient) => Promise<T>): Promise<T> {
    const { withTenantDbContext } = await import("@/lib/db");
    return runWithTenantContext(session, correlation, () => withTenantDbContext(fn));
  }

  beforeEach(async () => {
    if (!targetValidated) await assertDisposableTarget();
    await fixture();
  });

  afterAll(async () => {
    await closeDb();
    await admin?.end();
    await runtime?.end();
  });

  it("serves the app_users session profile through the definer: phantom, bootstrap admin, and existing-row touch", async () => {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    const call = (userId: string, email: string, bootstrapEmail: string) =>
      db.prepare("SELECT public.novatrade_app_user_session_profile(?::uuid, ?, ?) AS profile")
        .get<{ profile: { userId: string; email: string; displayName: string | null; role: string | null; status: string } }>(
          userId, email, bootstrapEmail,
        );

    // Unknown identity → pending phantom, no row persisted.
    const phantom = await call(ORDINARY_USER, "t041-ordinary@example.test", "");
    expect(phantom?.profile.status).toBe("pending");
    expect(phantom?.profile.role).toBeNull();
    expect(await appUserRow(ORDINARY_USER)).toBeNull();

    // Bootstrap email + zero admins → first admin is created server-side.
    const bootstrap = await call(BOOTSTRAP_USER, "t041-bootstrap@example.test", "t041-bootstrap@example.test");
    expect(bootstrap?.profile.status).toBe("active");
    expect(bootstrap?.profile.role).toBe("admin");
    const bootstrapRow = await appUserRow(BOOTSTRAP_USER);
    expect(bootstrapRow?.status).toBe("active");
    expect(bootstrapRow?.role).toBe("admin");

    // Second claimant with the bootstrap email while an admin exists → phantom.
    const second = await call(ORDINARY_USER, "t041-bootstrap@example.test", "t041-bootstrap@example.test");
    expect(second?.profile.status).toBe("pending");
    expect(await appUserRow(ORDINARY_USER)).toBeNull();

    // Existing row → profile read + last_seen touch.
    const before = await appUserRow(EXISTING_USER);
    const existing = await call(EXISTING_USER, "t041-existing@example.test", "");
    expect(existing?.profile.status).toBe("active");
    expect(existing?.profile.role).toBe("researcher");
    const after = await appUserRow(EXISTING_USER);
    expect(after?.status).toBe("active");
    expect(after?.last_seen_at).not.toBeNull();
    if (before?.last_seen_at && after?.last_seen_at) {
      expect(after.last_seen_at.getTime()).toBeGreaterThanOrEqual(before.last_seen_at.getTime());
    }

    // The exported app-level ensure dispatches to the same definer under DATABASE_URL.
    const ensured = await ensureAppUserForAuthUser(ORDINARY_USER, "t041-ordinary@example.test");
    expect(ensured.status).toBe("pending");
    expect(await appUserRow(ORDINARY_USER)).toBeNull();
  });

  it("ensures the accepted member's app_users profile insert-if-missing and never rewrites a persisted row", async () => {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    const ensure = (userId: string, email: string, displayName: string | null, role: string) =>
      db.prepare("SELECT public.novatrade_app_user_ensure_active(?::uuid, ?, ?, ?)")
        .run(userId, email, displayName, role);

    // The caller cannot choose the app role — it must match the role derived
    // from the identity's live owner/admin bindings (ORDINARY holds researcher).
    await expect(ensure(ORDINARY_USER, "t041-ordinary@example.test", "T041 Ordinary", "admin"))
      .rejects.toThrowError(/does not match derived membership role/iu);
    expect(await appUserRow(ORDINARY_USER)).toBeNull();

    // An identity with no active membership is not admitted — the insert
    // refuses before any profile is written, so a runtime credential alone
    // cannot mint an app_users row.
    await expect(ensure(PHANTOM_USER, "t041-phantom@example.test", "T041 Phantom", "researcher"))
      .rejects.toThrowError(/no active membership/iu);
    expect(await appUserRow(PHANTOM_USER)).toBeNull();

    // The admitted identity's derived role inserts the profile.
    await ensure(ORDINARY_USER, "t041-ordinary@example.test", "T041 Ordinary", "researcher");
    const created = await appUserRow(ORDINARY_USER);
    expect(created?.status).toBe("active");
    expect(created?.role).toBe("researcher");

    // A persisted disabled row is deliberate platform state — the call is a
    // no-op before the admission gate even runs (DISABLED holds no membership).
    await ensure(DISABLED_USER, "t041-disabled@example.test", "T041 Disabled", "admin");
    const stillDisabled = await appUserRow(DISABLED_USER);
    expect(stillDisabled?.status).toBe("disabled");
    expect(stillDisabled?.role).toBe("researcher");

    // Unsupported app role is refused inside the definer.
    await expect(ensure(ORDINARY_USER, "t041-ordinary@example.test", null, "superuser"))
      .rejects.toThrowError(/unsupported app role/iu);
  });

  it("returns the lifecycle snapshot bundle under the actor context and refuses without it", async () => {
    const { getDb } = await import("@/lib/db");
    const read = async (session: TenantSession | null, tenantId: string) => session === null
      ? (await getDb())
          .prepare("SELECT public.novatrade_tenant_lifecycle_snapshot_read(?::uuid) AS bundle")
          .get<{ bundle: SnapshotBundle | null }>(tenantId)
      : tenantDb(session, `t041-snapshot:${randomUUID()}`, (db) => db
          .prepare("SELECT public.novatrade_tenant_lifecycle_snapshot_read(?::uuid) AS bundle")
          .get<{ bundle: SnapshotBundle | null }>(tenantId));

    const owner = await read(ownerSessionA(), TENANT_A);
    const bundle = owner?.bundle;
    expect(bundle?.tenant.id).toBe(TENANT_A);
    expect(bundle?.tenant.status).toBe("active");
    const actions = (bundle?.audit ?? []).map((row) => row.action);
    expect(actions).toContain("tenant.provisioned");
    expect(actions).not.toContain("lead.created");
    const provisioned = (bundle?.audit ?? []).find((row) => row.action === "tenant.provisioned");
    expect(typeof provisioned?.metadata).toBe("string");
    expect(JSON.parse(provisioned!.metadata)).toMatchObject({ tenantId: TENANT_A });
    expect(bundle?.deletion?.id).toBe(DELETION_JOB_A);
    expect(bundle?.deletion?.freeze_handoff_status).toBe("not_started");

    // Any live member binding passes — the researcher reads the same bundle.
    const researcher = await read(researcherSessionA(), TENANT_A);
    expect((researcher?.bundle as SnapshotBundle | undefined)?.tenant.id).toBe(TENANT_A);

    // No ambient context → refuse; cross-tenant claim → refuse.
    expect((await read(null, TENANT_A))?.bundle ?? null).toBeNull();
    expect((await read(ownerSessionB(), TENANT_A))?.bundle ?? null).toBeNull();
  });

  it("keeps a suspended tenant's recorded lifecycle truthful under the actor context where member RLS cannot see it", async () => {
    const bundle = await tenantDb(ownerSessionB(), `t041-snapshot-b:${randomUUID()}`, (db) => db
      .prepare("SELECT public.novatrade_tenant_lifecycle_snapshot_read(?::uuid) AS bundle")
      .get<{ bundle: SnapshotBundle }>(TENANT_B));
    expect(bundle?.bundle.tenant.status).toBe("suspended");
    const actions = bundle?.bundle.audit.map((row) => row.action) ?? [];
    expect(actions).toEqual(expect.arrayContaining(["tenant.provisioned", "tenant.suspended"]));
    expect(bundle?.bundle.deletion?.id).toBe(DELETION_JOB_B);

    // Member RLS on the same rows returns nothing — proving the bundle is the
    // mechanism that keeps suspended tenants truthful.
    const memberRls = await tenantDb(ownerSessionB(), `t041-rls-b:${randomUUID()}`, (db) => db
      .prepare("SELECT id FROM public.audit_logs WHERE tenant_id = ?::uuid")
      .all(TENANT_B));
    expect(memberRls.length).toBe(0);

    // Latest-job lookups land for the suspended tenant too.
    const jobs = await tenantDb(ownerSessionB(), `t041-jobs-b:${randomUUID()}`, async (db) => ({
      exportId: (await db.prepare("SELECT public.novatrade_tenant_export_job_latest(?::uuid)::text AS id").get<{ id: string | null }>(TENANT_B))?.id,
      deletionId: (await db.prepare("SELECT public.novatrade_tenant_deletion_job_latest(?::uuid)::text AS id").get<{ id: string | null }>(TENANT_B))?.id,
    }));
    expect(jobs.exportId).toBe(EXPORT_JOB_B);
    expect(jobs.deletionId).toBe(DELETION_JOB_B);
  });

  it("reads export jobs through the actor-context definer and enforces the tenant binding", async () => {
    const readJob = (session: TenantSession, tenantId: string, jobId: string) =>
      tenantDb(session, `t041-export-read:${randomUUID()}`, (db) => db
        .prepare("SELECT * FROM public.novatrade_tenant_export_job_read(?::uuid, ?::uuid)")
        .get<{ id: string; tenant_id: string; status: string }>(tenantId, jobId));

    const row = await readJob(ownerSessionA(), TENANT_A, EXPORT_JOB_A);
    expect(row?.id).toBe(EXPORT_JOB_A);
    expect(row?.status).toBe("released");

    // Cross-tenant and foreign-job reads return nothing — non-enumerating.
    expect(await readJob(ownerSessionA(), TENANT_A, EXPORT_JOB_B)).toBeUndefined();
    expect(await readJob(ownerSessionB(), TENANT_A, EXPORT_JOB_A)).toBeUndefined();

    const latest = await tenantDb(ownerSessionA(), `t041-export-latest:${randomUUID()}`, (db) => db
      .prepare("SELECT public.novatrade_tenant_export_job_latest(?::uuid)::text AS id")
      .get<{ id: string | null }>(TENANT_A));
    expect(latest?.id).toBe(EXPORT_JOB_A);
  });

  it("drives requestExport + runExport end to end through the Postgres runner under the member lane", async () => {
    // The export_request limit consume has its own gated lane (T-033); this
    // lane exercises the runner + job reads, so no limits port is wired.
    const service = createPostgresExportOperationsService({
      exportRunner: createPostgresExportRunner(),
    });
    const requestId = randomUUID();
    const result = await runWithTenantContext(ownerSessionA(), `t041-export-e2e:${requestId}`, async () => {
      const requested = await service.requestExport({
        tenantId: TENANT_A,
        workspaceId: null,
        requester: { authIdentityId: ACTOR_A_OWNER, membershipId: MEMBER_A_OWNER },
        idempotencyKey: `t041-export-request.${requestId}`,
        correlationId: `t041-export:request:${requestId}`,
      });
      const ran = await service.runExport({
        tenantId: TENANT_A,
        jobId: requested.job.id,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: `t041-export:run:${requestId}`,
      });
      return { requested, ran };
    });

    expect(result.requested.code).toBe("OK_EXPORT_REQUESTED");
    expect(result.ran.code).toBe("OK_EXPORT_COMPLETED");
    expect(result.ran.job.status).toBe("released");
    expect(result.ran.job.artifactStorageRef).toBe(`tenants/${TENANT_A}/exports/${result.ran.job.id}/export.json`);
    expect(result.ran.job.artifactChecksumSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.ran.job.includedCount).toBeGreaterThanOrEqual(4); // tenant + workspace + policy + 2 memberships (+ bindings)
    expect(result.ran.job.redactedCount).toBeGreaterThanOrEqual(2); // auth_identity_id on the two memberships

    const auditRows = await admin.unsafe<{ action: string }[]>(
      "SELECT action FROM public.audit_logs WHERE entity_id = $1 ORDER BY created_at",
      [result.ran.job.id],
    );
    expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "tenant.export.requested",
      "tenant.export.released",
    ]));
  });

  it("keeps internal helpers unreachable to the runtime role while the new API stays callable", async () => {
    // Internal lane predicates must not be directly executable.
    await expect(
      runtime.unsafe("SELECT public.novatrade_deletion_actor_ctx()"),
    ).rejects.toThrowError(/permission denied/iu);
    await expect(
      runtime.unsafe("SELECT public.novatrade_invitation_accept_ctx('x', 'y')"),
    ).rejects.toThrowError(/permission denied/iu);

    // The new public API is callable — with no context it refuses, not errors.
    const rows = await runtime.unsafe<{ bundle: unknown }[]>(
      "SELECT public.novatrade_tenant_lifecycle_snapshot_read($1::uuid) AS bundle",
      [TENANT_A],
    );
    expect(rows[0]?.bundle ?? null).toBeNull();

    const profile = await runtime.unsafe<{ profile: { status: string } }[]>(
      "SELECT public.novatrade_app_user_session_profile($1::uuid, $2, $3) AS profile",
      [ORDINARY_USER, "t041-ordinary@example.test", ""],
    );
    expect(profile[0]?.profile.status).toBe("pending");
    expect(await appUserRow(ORDINARY_USER)).toBeNull();
  });
});
