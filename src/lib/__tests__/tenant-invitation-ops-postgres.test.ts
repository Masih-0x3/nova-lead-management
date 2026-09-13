import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";

vi.mock("server-only", () => ({}));

import { closeDb } from "@/lib/db";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  createPostgresTenantInvitationService,
} from "@/lib/tenancy/postgres-tenant-invitation";
import { TenantInvitationError } from "@/lib/tenancy/provisioning";
import type { TenantInvitationDeliveryPort } from "@/lib/tenancy/provisioning";
import type { TenantSession } from "@/lib/auth";

/**
 * L-02 disposable-Postgres rehearsal for the tenant invitation service — the
 * seventh Postgres-backed service-port binding after T-031..T-039.
 *
 * The canonical createTenantInvitationService orchestration is unit-verified
 * against the SQLite backend; this lane proves the Postgres twin end to end
 * across its three caller lanes:
 *   * member lane   — issue runs under the ambient member context installed
 *                     by withTenantDbContext;
 *   * identity lane — accept runs context-free; the CAS-bound recipient hash
 *                     plus the same-transaction finalize is the authority;
 *   * system lane   — operator reissue/revoke/status run context-free.
 *
 * Every write goes through the SECURITY DEFINER functions of migration
 * 202609120013 (invitations and the invitation journal are zero-policy). The
 * functions re-validate the transaction-local lane server-side and bind
 * post-finalize writes to an invitation accepted in the same transaction.
 *
 * Requires a disposable database named `t040_invitation_ops_rehearsal`
 * holding the migrated schema plus migration 202609120013, and a
 * `t040_runtime` role granted EXECUTE on the API functions only.
 * `DATABASE_URL` is staged to the runtime role with `DATABASE_SSL=disable`.
 * See docs/TESTING.md for provisioning.
 */

const RUN = process.env.T040_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t040_invitation_ops_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000a2";
const TENANT_P = "00000000-0000-4000-8000-0000000000a3";
const WORKSPACE_A1 = "10000000-0000-4000-8000-0000000000a1";
const WORKSPACE_P1 = "10000000-0000-4000-8000-0000000000a3";
const MEMBER_A_OWNER = "20000000-0000-4000-8000-0000000000a1";
const MEMBER_A_RESEARCHER = "20000000-0000-4000-8000-0000000000a2";
const MEMBER_A_PENDING = "20000000-0000-4000-8000-0000000000a3";
const MEMBER_A_PREBOUND = "20000000-0000-4000-8000-0000000000a4";
const MEMBER_A_ISSUE_TARGET = "20000000-0000-4000-8000-0000000000a5";
const MEMBER_A_EXPIRED = "20000000-0000-4000-8000-0000000000a7";
const MEMBER_A_REVOKED = "20000000-0000-4000-8000-0000000000a8";
const MEMBER_B_OWNER = "20000000-0000-4000-8000-0000000000b1";
const MEMBER_B_PENDING = "20000000-0000-4000-8000-0000000000b2";
const MEMBER_P_OWNER = "20000000-0000-4000-8000-0000000000a6";
const BINDING_A_OWNER = "30000000-0000-4000-8000-0000000000a1";
const BINDING_A_RESEARCHER = "30000000-0000-4000-8000-0000000000a2";
const BINDING_A_PENDING = "30000000-0000-4000-8000-0000000000a3";
const BINDING_A_PREBOUND = "30000000-0000-4000-8000-0000000000a4";
const BINDING_A_ISSUE_TARGET = "30000000-0000-4000-8000-0000000000a5";
const BINDING_A_EXPIRED = "30000000-0000-4000-8000-0000000000a7";
const BINDING_A_REVOKED = "30000000-0000-4000-8000-0000000000a8";
const BINDING_B_OWNER = "30000000-0000-4000-8000-0000000000b1";
const BINDING_B_PENDING = "30000000-0000-4000-8000-0000000000b2";
const BINDING_P_OWNER = "30000000-0000-4000-8000-0000000000a6";
const ACTOR_A_OWNER = "50000000-0000-4000-8000-0000000000a1";
const ACTOR_A_RESEARCHER = "50000000-0000-4000-8000-0000000000a2";
const ACTOR_B_OWNER = "50000000-0000-4000-8000-0000000000b1";
const INVITEE_A = "50000000-0000-4000-8000-0000000000a3";
const INVITEE_B = "50000000-0000-4000-8000-0000000000a4";
const INVITEE_ISSUE = "50000000-0000-4000-8000-0000000000aa";
const INVITEE_EXPIRED = "50000000-0000-4000-8000-0000000000ab";
const INVITEE_REVOKED = "50000000-0000-4000-8000-0000000000ac";
const INVITEE_B2 = "50000000-0000-4000-8000-0000000000b2";
const OWNER_ID = "50000000-0000-4000-8000-0000000000a5";
const OPERATOR_ID = "50000000-0000-4000-8000-0000000000a9";
const INV_A_MEMBER = "40000000-0000-4000-8000-0000000000a1";
const INV_A_PREBOUND = "40000000-0000-4000-8000-0000000000a2";
const INV_A_EXPIRED = "40000000-0000-4000-8000-0000000000a3";
const INV_A_REVOKED = "40000000-0000-4000-8000-0000000000a4";
const INV_B_MEMBER = "40000000-0000-4000-8000-0000000000b1";
const INV_P_OWNER = "40000000-0000-4000-8000-0000000000a5";

function hashRef(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityRefHash(identity: string): string {
  return hashRef(`novatrade:tenant-membership-invite:v1:auth-identity:${identity.toLowerCase()}`);
}

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_OWNER,
    email: "t040-owner-a@example.test",
    displayName: "T040 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_OWNER,
    role: "owner",
    roleBindingId: BINDING_A_OWNER,
    ...overrides,
  };
}

function researcherSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_RESEARCHER,
    email: "t040-researcher-a@example.test",
    displayName: "T040 Researcher A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_RESEARCHER,
    role: "researcher",
    roleBindingId: BINDING_A_RESEARCHER,
    ...overrides,
  };
}

function service(delivery?: TenantInvitationDeliveryPort) {
  return createPostgresTenantInvitationService({
    operatorIdentityId: OPERATOR_ID,
    authUserProvisioner: {
      ensureAuthUser: async (input) => ({ provisioned: "created" as const, authIdentityId: input.authIdentityId }),
    },
    invitationDelivery: delivery,
  });
}

function serviceWithoutOperator() {
  return createPostgresTenantInvitationService({
    authUserProvisioner: {
      ensureAuthUser: async (input) => ({ provisioned: "created" as const, authIdentityId: input.authIdentityId }),
    },
  });
}

describe.skipIf(!RUN)("T-040 tenant invitation operations on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-040 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T040_ADMIN_DATABASE_URL) {
      throw new Error("T-040 disposable test requires DATABASE_URL and T040_ADMIN_DATABASE_URL");
    }
    if (!process.env.T040_RUNTIME_ROLE) {
      throw new Error("T-040 disposable test requires T040_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T040_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-040 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-040 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-040 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T040_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-040 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_invitation_context_free',
        'novatrade_invitation_lane',
        'novatrade_invitation_json',
        'novatrade_invitation_accept_ctx',
        'novatrade_invitation_read',
        'novatrade_invitation_live_read',
        'novatrade_invitation_tenant_read',
        'novatrade_invitation_workspace_read',
        'novatrade_invitation_membership_read',
        'novatrade_invitation_binding_read',
        'novatrade_invitation_policy_read',
        'novatrade_invitation_journal_find',
        'novatrade_invitation_journal_reserve',
        'novatrade_invitation_journal_complete',
        'novatrade_invitation_create',
        'novatrade_invitation_finalize',
        'novatrade_invitation_supersede',
        'novatrade_invitation_revoke',
        'novatrade_invitation_membership_status',
        'novatrade_invitation_binding_revoke',
        'novatrade_invitation_membership_create',
        'novatrade_invitation_binding_create',
        'novatrade_invitation_tenant_activate',
        'novatrade_invitation_workspace_activate',
        'novatrade_invitation_audit_append',
        'novatrade_invitation_delivery_mark'
      )
    `);
    const helpers = new Set([
      "novatrade_invitation_context_free",
      "novatrade_invitation_lane",
      "novatrade_invitation_json",
      "novatrade_invitation_accept_ctx",
    ]);
    if (
      posture.length !== 26
      || posture.some((fn) =>
        helpers.has(fn.proname)
          ? fn.prosecdef // helpers are internal STABLE predicates, not definer
          : !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)
    ) {
      throw new Error("T-040 preflight refused: API functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }

    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-040 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-040 fixture reached without disposable-target validation");
    await cleanRows();
    const now = Date.now();
    const issuedAt = new Date(now - 60_000).toISOString();
    const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    const expiredIssuedAt = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const expiredExpiresAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't040-tenant-a', 'Invitation Tenant A', 'active'), ($2, 't040-tenant-b', 'Invitation Tenant B', 'active'), ($3, 't040-tenant-p', 'Invitation Tenant P', 'provisioning')",
        [TENANT_A, TENANT_B, TENANT_P],
      );
      await tx.unsafe(
        `INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
          ($1, $3, 't040-ws-a1', 'Invitation Workspace A1', 'active'),
          ($2, $4, 't040-ws-p1', 'Invitation Workspace P1', 'provisioning')`,
        [WORKSPACE_A1, WORKSPACE_P1, TENANT_A, TENANT_P],
      );
      await tx.unsafe("INSERT INTO public.tenant_policies (tenant_id) VALUES ($1), ($2), ($3)", [TENANT_A, TENANT_B, TENANT_P]);
      await tx.unsafe(
        `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id, status) VALUES
          ($1, $10, $11, NULL, NULL, 'active'),
          ($2, $10, $12, NULL, NULL, 'active'),
          ($3, $10, NULL, $13, $14, 'pending'),
          ($4, $10, $15, NULL, $14, 'pending'),
          ($5, $10, NULL, $16, $14, 'pending'),
          ($6, $17, $18, NULL, NULL, 'active'),
          ($7, $17, NULL, $19, NULL, 'pending'),
          ($8, $20, NULL, $21, $22, 'pending'),
          ($9, $10, NULL, $24, $14, 'pending'),
          ($23, $10, NULL, $25, $14, 'pending')`,
        [
          MEMBER_A_OWNER,
          MEMBER_A_RESEARCHER,
          MEMBER_A_PENDING,
          MEMBER_A_PREBOUND,
          MEMBER_A_ISSUE_TARGET,
          MEMBER_B_OWNER,
          MEMBER_B_PENDING,
          MEMBER_P_OWNER,
          MEMBER_A_EXPIRED,
          TENANT_A,
          ACTOR_A_OWNER,
          ACTOR_A_RESEARCHER,
          identityRefHash(INVITEE_A),
          WORKSPACE_A1,
          INVITEE_B,
          identityRefHash(INVITEE_ISSUE),
          TENANT_B,
          ACTOR_B_OWNER,
          identityRefHash(INVITEE_B2),
          TENANT_P,
          identityRefHash(OWNER_ID),
          WORKSPACE_P1,
          MEMBER_A_REVOKED,
          identityRefHash(INVITEE_EXPIRED),
          identityRefHash(INVITEE_REVOKED),
        ],
      );
      await tx.unsafe(
        `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, created_at, valid_from, revoked_at) VALUES
          ($1, $9, $10, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($2, $9, $11, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($3, $9, $12, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($4, $9, $13, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($5, $9, $14, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($6, $15, $16, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($7, $15, $17, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($8, $18, $19, 'owner', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($20, $9, $21, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null),
          ($22, $9, $23, 'researcher', now() - interval '2 minutes', now() - interval '1 minute', null)`,
        [
          BINDING_A_OWNER,
          BINDING_A_RESEARCHER,
          BINDING_A_PENDING,
          BINDING_A_PREBOUND,
          BINDING_A_ISSUE_TARGET,
          BINDING_B_OWNER,
          BINDING_B_PENDING,
          BINDING_P_OWNER,
          TENANT_A,
          MEMBER_A_OWNER,
          MEMBER_A_RESEARCHER,
          MEMBER_A_PENDING,
          MEMBER_A_PREBOUND,
          MEMBER_A_ISSUE_TARGET,
          TENANT_B,
          MEMBER_B_OWNER,
          MEMBER_B_PENDING,
          TENANT_P,
          MEMBER_P_OWNER,
          BINDING_A_EXPIRED,
          MEMBER_A_EXPIRED,
          BINDING_A_REVOKED,
          MEMBER_A_REVOKED,
        ],
      );
      const invitation = (
        id: string,
        tenantId: string,
        membershipId: string,
        kind: "owner" | "member",
        role: string,
        workspaceId: string | null,
        identityHash: string,
        issued: string,
        expires: string,
        label: string,
      ) => tx.unsafe(
        `INSERT INTO public.tenant_invitations (
           id, tenant_id, membership_id, kind, role, workspace_id,
           expected_identity_ref_hash, policy_version, generation, content_hash,
           status, delivery_state, issued_at, expires_at, correlation_id, audit_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'tenant-policy-v1',1,$8,'issued','queued',$9,$10,$11,$12)`,
        [
          id, tenantId, membershipId, kind, role, workspaceId,
          identityHash, hashRef(`t040:${label}`), issued, expires,
          `t040-fixture-${label}`, randomUUID(),
        ],
      );
      await Promise.all([
        invitation(INV_A_MEMBER, TENANT_A, MEMBER_A_PENDING, "member", "researcher", WORKSPACE_A1, identityRefHash(INVITEE_A), issuedAt, expiresAt, "member"),
        invitation(INV_A_PREBOUND, TENANT_A, MEMBER_A_PREBOUND, "member", "researcher", WORKSPACE_A1, identityRefHash(INVITEE_B), issuedAt, expiresAt, "prebound"),
        invitation(INV_A_EXPIRED, TENANT_A, MEMBER_A_EXPIRED, "member", "researcher", WORKSPACE_A1, identityRefHash(INVITEE_EXPIRED), expiredIssuedAt, expiredExpiresAt, "expired"),
        invitation(INV_B_MEMBER, TENANT_B, MEMBER_B_PENDING, "member", "researcher", null, identityRefHash(INVITEE_B2), issuedAt, expiresAt, "tenant-b"),
        invitation(INV_P_OWNER, TENANT_P, MEMBER_P_OWNER, "owner", "owner", WORKSPACE_P1, identityRefHash(OWNER_ID), issuedAt, expiresAt, "owner"),
      ]);
      await tx.unsafe(
        `INSERT INTO public.tenant_invitations (
           id, tenant_id, membership_id, kind, role, workspace_id,
           expected_identity_ref_hash, policy_version, generation, content_hash,
           status, delivery_state, issued_at, expires_at, correlation_id, audit_event_id
         ) VALUES ($1,$2,$3,'member','researcher',$4,$5,'tenant-policy-v1',1,$6,'issued','queued',$7,$8,$9,$10)`,
        [
          INV_A_REVOKED, TENANT_A, MEMBER_A_REVOKED, WORKSPACE_A1,
          identityRefHash(INVITEE_REVOKED), hashRef("t040:revoked"), issuedAt, expiresAt,
          "t040-fixture-revoked", randomUUID(),
        ],
      );
      await tx.unsafe(
        `UPDATE public.tenant_invitations
         SET status = 'revoked', revoked_at = $1, revoked_reason_code = 't040.revoked-fixture'
         WHERE tenant_id = $2 AND id = $3`,
        [issuedAt, TENANT_A, INV_A_REVOKED],
      );
    });
  }

  async function cleanRows(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_invitation_journal DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_invitations DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships DISABLE TRIGGER ALL");
      await tx.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE 't040-%' OR tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't040-%')");
      await tx.unsafe("DELETE FROM public.tenant_invitation_journal");
      await tx.unsafe("DELETE FROM public.tenant_invitations WHERE correlation_id LIKE 't040-%'");
      await tx.unsafe(
        "DELETE FROM public.tenant_role_bindings WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't040-%')",
      );
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't040-%')");
      await tx.unsafe("DELETE FROM public.tenant_policies WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't040-%')");
      await tx.unsafe("DELETE FROM public.workspaces WHERE slug LIKE 't040-%'");
      await tx.unsafe("DELETE FROM public.tenants WHERE slug LIKE 't040-%'");
      await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_invitation_journal ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_invitations ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships ENABLE TRIGGER ALL");
    });
  }

  async function readTenantStatus(tenantId: string): Promise<string> {
    const row = await admin.unsafe<{ status: string }[]>(
      "SELECT status FROM public.tenants WHERE id = $1", [tenantId],
    );
    return row[0].status;
  }

  async function auditActions(invitationId: string): Promise<{ scope_kind: string; actor_layer: string; action: string }[]> {
    return admin.unsafe<{ scope_kind: string; actor_layer: string; action: string }[]>(
      "SELECT scope_kind, actor_layer, action FROM public.audit_logs WHERE entity_id = $1 ORDER BY created_at",
      [invitationId],
    );
  }

  async function expectInvitationError(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(TenantInvitationError);
      expect((error as TenantInvitationError).code).toBe(code);
      return;
    }
    throw new Error(`expected TenantInvitationError(${code})`);
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

  it("issues a member invitation under the member lane and the recipient accepts through the identity lane", async () => {
    const delivered: string[] = [];
    const delivery: TenantInvitationDeliveryPort = {
      adapterId: "t040-delivery",
      deliver: async (input) => {
        delivered.push(input.invitationId);
        return { adapterId: "t040-delivery", state: "delivered", deliveryRefHash: hashRef("t040:ref"), deliveryDetail: null };
      },
    };
    const svc = service(delivery);

    const issued = await runWithTenantContext(ownerSessionA(), "t040-issue-1", () =>
      svc.issueMembershipInvitation({
        tenantId: TENANT_A,
        membershipId: MEMBER_A_ISSUE_TARGET,
        role: "researcher",
        workspaceId: WORKSPACE_A1,
        expectedIdentityRefHash: identityRefHash(INVITEE_ISSUE),
        actorMembershipId: MEMBER_A_OWNER,
        actorIdentityId: ACTOR_A_OWNER,
        idempotencyKey: "t040-issue-1",
        correlationId: "t040-issue-1",
      }));
    expect(issued.resultCode).toBe("INVITATION_ISSUED");
    expect(issued.generation).toBe(1);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 5000 });

    const accepted = await svc.acceptInvitation(INVITEE_ISSUE, {
      invitationId: issued.invitationId,
      idempotencyKey: "t040-accept-1",
      correlationId: "t040-accept-1",
    });
    expect(accepted.resultCode).toBe("INVITATION_ACCEPTED");
    expect(accepted.membershipStatus).toBe("active");
    expect(accepted.tenantStatus).toBe("active");
    expect(accepted.membershipId).not.toBe(MEMBER_A_ISSUE_TARGET);
    expect(accepted.role).toBe("researcher");

    const invited = await admin.unsafe<{ status: string }[]>(
      "SELECT status FROM public.tenant_memberships WHERE id = $1", [MEMBER_A_ISSUE_TARGET],
    );
    expect(invited[0].status).toBe("expired");

    const replacement = await admin.unsafe<{ auth_identity_id: string; status: string }[]>(
      "SELECT auth_identity_id, status FROM public.tenant_memberships WHERE id = $1",
      [accepted.membershipId],
    );
    expect(replacement[0].auth_identity_id).toBe(INVITEE_ISSUE);
    expect(replacement[0].status).toBe("active");

    const binding = await admin.unsafe<{ role: string; revoked_at: string | null }[]>(
      "SELECT role, revoked_at FROM public.tenant_role_bindings WHERE membership_id = $1 AND revoked_at IS NULL",
      [accepted.membershipId],
    );
    expect(binding).toHaveLength(1);
    expect(binding[0].role).toBe("researcher");

    const row = await admin.unsafe<{ status: string; delivery_state: string }[]>(
      "SELECT status, delivery_state FROM public.tenant_invitations WHERE id = $1",
      [issued.invitationId],
    );
    expect(row[0].status).toBe("accepted");
    expect(row[0].delivery_state).toBe("delivered");

    const actions = await auditActions(issued.invitationId);
    expect(actions.map((a) => a.action)).toEqual([
      "tenant.invitation_issued",
      "tenant.invitation_delivery_recorded",
      "tenant.invitation_accepted",
    ]);
    expect(actions[0].scope_kind).toBe("tenant");
    expect(actions[1].scope_kind).toBe("platform");
    expect(actions[2].scope_kind).toBe("tenant");
  });

  it("activates a provisioning tenant and workspace on owner acceptance", async () => {
    const accepted = await service().acceptInvitation(OWNER_ID, {
      invitationId: INV_P_OWNER,
      idempotencyKey: "t040-accept-owner-1",
      correlationId: "t040-accept-owner-1",
    });
    expect(accepted.resultCode).toBe("INVITATION_ACCEPTED");
    expect(accepted.role).toBe("owner");
    expect(accepted.tenantStatus).toBe("active");
    expect(accepted.workspaceStatus).toBe("active");
    expect(accepted.membershipStatus).toBe("active");

    expect(await readTenantStatus(TENANT_P)).toBe("active");
    const ws = await admin.unsafe<{ status: string }[]>(
      "SELECT status FROM public.workspaces WHERE id = $1", [WORKSPACE_P1],
    );
    expect(ws[0].status).toBe("active");

    const invited = await admin.unsafe<{ status: string }[]>(
      "SELECT status FROM public.tenant_memberships WHERE id = $1", [MEMBER_P_OWNER],
    );
    expect(invited[0].status).toBe("expired");

    const binding = await admin.unsafe<{ role: string }[]>(
      "SELECT role FROM public.tenant_role_bindings WHERE membership_id = $1 AND revoked_at IS NULL",
      [accepted.membershipId],
    );
    expect(binding).toHaveLength(1);
    expect(binding[0].role).toBe("owner");

    const actions = await auditActions(INV_P_OWNER);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("tenant.provisioned");
    expect(actions[0].actor_layer).toBe("member");
  });

  it("activates a pre-bound membership in place on member acceptance", async () => {
    const accepted = await service().acceptInvitation(INVITEE_B, {
      invitationId: INV_A_PREBOUND,
      idempotencyKey: "t040-accept-prebound-1",
      correlationId: "t040-accept-prebound-1",
    });
    expect(accepted.resultCode).toBe("INVITATION_ACCEPTED");
    expect(accepted.membershipId).toBe(MEMBER_A_PREBOUND);
    expect(accepted.membershipStatus).toBe("active");

    const membership = await admin.unsafe<{ status: string; auth_identity_id: string }[]>(
      "SELECT status, auth_identity_id FROM public.tenant_memberships WHERE id = $1",
      [MEMBER_A_PREBOUND],
    );
    expect(membership[0].status).toBe("active");
    expect(membership[0].auth_identity_id).toBe(INVITEE_B);
  });

  it("replays completed idempotency and refuses conflicting keys", async () => {
    const svc = service();
    const accepted = await svc.acceptInvitation(INVITEE_A, {
      invitationId: INV_A_MEMBER,
      idempotencyKey: "t040-accept-replay",
      correlationId: "t040-accept-replay",
    });
    expect(accepted.resultCode).toBe("INVITATION_ACCEPTED");

    const replay = await svc.acceptInvitation(INVITEE_A, {
      invitationId: INV_A_MEMBER,
      idempotencyKey: "t040-accept-replay",
      correlationId: "t040-accept-replay",
    });
    expect(replay).toEqual(accepted);

    const membershipRows = await admin.unsafe<unknown[]>(
      "SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 AND auth_identity_id = $2",
      [TENANT_A, INVITEE_A],
    );
    expect(membershipRows).toHaveLength(1);

    await expectInvitationError(
      svc.acceptInvitation(INVITEE_A, {
        invitationId: INV_A_PREBOUND,
        idempotencyKey: "t040-accept-replay",
        correlationId: "t040-accept-replay",
      }),
      "PROVISIONING_IDEMPOTENCY_CONFLICT",
    );

    const issued = await runWithTenantContext(ownerSessionA(), "t040-issue-2", () =>
      svc.issueMembershipInvitation({
        tenantId: TENANT_A,
        membershipId: MEMBER_A_ISSUE_TARGET,
        role: "researcher",
        workspaceId: WORKSPACE_A1,
        expectedIdentityRefHash: identityRefHash(INVITEE_ISSUE),
        actorMembershipId: MEMBER_A_OWNER,
        actorIdentityId: ACTOR_A_OWNER,
        idempotencyKey: "t040-issue-replay",
        correlationId: "t040-issue-replay",
      }));
    const issueReplay = await runWithTenantContext(ownerSessionA(), "t040-issue-2", () =>
      svc.issueMembershipInvitation({
        tenantId: TENANT_A,
        membershipId: MEMBER_A_ISSUE_TARGET,
        role: "researcher",
        workspaceId: WORKSPACE_A1,
        expectedIdentityRefHash: identityRefHash(INVITEE_ISSUE),
        actorMembershipId: MEMBER_A_OWNER,
        actorIdentityId: ACTOR_A_OWNER,
        idempotencyKey: "t040-issue-replay",
        correlationId: "t040-issue-replay",
      }));
    expect(issueReplay).toEqual(issued);
  });

  it("refuses closed, mismatched, and unauthorized operations with canonical codes", async () => {
    const svc = service();

    await expectInvitationError(
      svc.acceptInvitation(ACTOR_A_OWNER, {
        invitationId: INV_A_MEMBER,
        idempotencyKey: "t040-wrong-recipient",
        correlationId: "t040-wrong-recipient",
      }),
      "INVITE_RECIPIENT_MISMATCH",
    );
    const unchanged = await admin.unsafe<{ status: string }[]>(
      "SELECT status FROM public.tenant_invitations WHERE id = $1", [INV_A_MEMBER],
    );
    expect(unchanged[0].status).toBe("issued");

    await expectInvitationError(
      svc.acceptInvitation(INVITEE_REVOKED, {
        invitationId: INV_A_REVOKED,
        idempotencyKey: "t040-revoked",
        correlationId: "t040-revoked",
      }),
      "INVITE_REVOKED",
    );
    await expectInvitationError(
      svc.acceptInvitation(INVITEE_EXPIRED, {
        invitationId: INV_A_EXPIRED,
        idempotencyKey: "t040-expired",
        correlationId: "t040-expired",
      }),
      "INVITE_EXPIRED",
    );
    await expectInvitationError(
      svc.acceptInvitation(INVITEE_A, {
        invitationId: randomUUID(),
        idempotencyKey: "t040-unknown",
        correlationId: "t040-unknown",
      }),
      "INVITE_NOT_FOUND",
    );

    // A researcher reaches the actor-role gate only when every fact matches —
    // a mismatched recipient hash is refused earlier as provisioning state.
    await expectInvitationError(
      runWithTenantContext(researcherSessionA(), "t040-issue-denied", () =>
        svc.issueMembershipInvitation({
          tenantId: TENANT_A,
          membershipId: MEMBER_A_ISSUE_TARGET,
          role: "researcher",
          workspaceId: WORKSPACE_A1,
          expectedIdentityRefHash: identityRefHash(INVITEE_ISSUE),
          actorMembershipId: MEMBER_A_RESEARCHER,
          actorIdentityId: ACTOR_A_RESEARCHER,
          idempotencyKey: "t040-issue-denied",
          correlationId: "t040-issue-denied",
        })),
      "INVITATION_NOT_AUTHORIZED",
    );

    // Cross-tenant: a tenant-A member context cannot read or act inside B —
    // the lane binding collapses it to the same closed refusal.
    await expectInvitationError(
      runWithTenantContext(ownerSessionA(), "t040-issue-xtenant", () =>
        svc.issueMembershipInvitation({
          tenantId: TENANT_B,
          membershipId: MEMBER_B_PENDING,
          role: "researcher",
          workspaceId: null,
          expectedIdentityRefHash: identityRefHash(INVITEE_B2),
          actorMembershipId: MEMBER_A_OWNER,
          actorIdentityId: ACTOR_A_OWNER,
          idempotencyKey: "t040-issue-xtenant",
          correlationId: "t040-issue-xtenant",
        })),
      "TENANT_STATE_BLOCKED",
    );
  });

  it("runs the operator lane: reissue, revoke, and status under the system lane", async () => {
    const svc = service();

    const reissued = await svc.reissueInvitation({
      invitationId: INV_A_MEMBER,
      reasonCode: "t040.reissue-ok",
      reason: "reissue rehearsal",
      idempotencyKey: "t040-reissue-1",
      correlationId: "t040-reissue-1",
    });
    expect(reissued.resultCode).toBe("INVITATION_REISSUED");
    expect(reissued.priorInvitationId).toBe(INV_A_MEMBER);
    expect(reissued.generation).toBe(2);
    expect(reissued.invitationId).not.toBe(INV_A_MEMBER);

    const prior = await admin.unsafe<{ status: string; superseded_by_invitation_id: string }[]>(
      "SELECT status, superseded_by_invitation_id FROM public.tenant_invitations WHERE id = $1",
      [INV_A_MEMBER],
    );
    expect(prior[0].status).toBe("superseded");
    expect(prior[0].superseded_by_invitation_id).toBe(reissued.invitationId);

    const reissueReplay = await svc.reissueInvitation({
      invitationId: INV_A_MEMBER,
      reasonCode: "t040.reissue-ok",
      reason: "reissue rehearsal",
      idempotencyKey: "t040-reissue-1",
      correlationId: "t040-reissue-1",
    });
    expect(reissueReplay).toEqual(reissued);

    const status = await svc.getInvitationStatus({ invitationId: reissued.invitationId });
    expect(status.status).toBe("issued");
    expect(status.generation).toBe(2);

    const revoked = await svc.revokeInvitation({
      invitationId: reissued.invitationId,
      reasonCode: "t040.revoke-ok",
      reason: "revoke rehearsal",
      idempotencyKey: "t040-revoke-1",
      correlationId: "t040-revoke-1",
    });
    expect(revoked.resultCode).toBe("INVITATION_REVOKED");
    expect(revoked.status).toBe("revoked");

    const closed = await svc.getInvitationStatus({ invitationId: reissued.invitationId });
    expect(closed.status).toBe("revoked");
    expect(closed.effectiveStatus).toBe("revoked");

    const actions = await auditActions(reissued.invitationId);
    expect(actions.map((a) => a.action)).toEqual([
      "tenant.invitation_reissued",
      "tenant.invitation_revoked",
    ]);
    expect(actions.every((a) => a.scope_kind === "platform" && a.actor_layer === "system")).toBe(true);

    const noOperator = serviceWithoutOperator();
    await expectInvitationError(
      noOperator.getInvitationStatus({ invitationId: INV_A_MEMBER }),
      "INVITATION_NOT_AUTHORIZED",
    );
    await expectInvitationError(
      noOperator.reissueInvitation({
        invitationId: INV_A_MEMBER,
        reasonCode: "t040.reissue-denied",
        reason: "denied",
        idempotencyKey: "t040-reissue-denied",
        correlationId: "t040-reissue-denied",
      }),
      "INVITATION_NOT_AUTHORIZED",
    );
    await expectInvitationError(
      svc.getInvitationStatus({ invitationId: randomUUID() }),
      "INVITE_NOT_FOUND",
    );
  });

  it("enforces the direct-EXECUTE boundary and lane isolation on raw calls", async () => {
    // Context-free: the runtime role may read it — the invitation id is the capability.
    const crossLane = await runtime.unsafe<{ record: unknown }[]>(`
      SELECT public.novatrade_invitation_read($1) AS record
    `, [JSON.stringify({ invitationId: INV_B_MEMBER })]);
    expect(crossLane[0].record).not.toBeNull();

    // A member context bound to tenant A cannot read a tenant-B invitation —
    // the lane check collapses it to NULL, indistinguishable from absent.
    await runtime.begin(async (tx) => {
      await tx.unsafe(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.actor_id', $2, true),
                set_config('app.membership_id', $3, true),
                set_config('app.role', 'owner', true),
                set_config('app.role_binding_id', $4, true),
                set_config('app.correlation_id', 't040-direct-read', true)`,
        [TENANT_A, ACTOR_A_OWNER, MEMBER_A_OWNER, BINDING_A_OWNER],
      );
      const denied = await tx.unsafe<{ record: unknown }[]>(`
        SELECT public.novatrade_invitation_read($1) AS record
      `, [JSON.stringify({ invitationId: INV_B_MEMBER })]);
      expect(denied[0].record).toBeNull();
      const own = await tx.unsafe<{ record: { tenantId: string } | null }[]>(`
        SELECT public.novatrade_invitation_read($1) AS record
      `, [JSON.stringify({ invitationId: INV_A_MEMBER })]);
      expect(own[0].record?.tenantId).toBe(TENANT_A);
    });

    // Internal helpers carry no EXECUTE grant for the runtime role.
    await expect(
      runtime.unsafe(`SELECT public.novatrade_invitation_accept_ctx($1, $2)`, [TENANT_A, MEMBER_A_PENDING]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runtime.unsafe(`SELECT public.novatrade_invitation_json(NULL::public.tenant_invitations)`),
    ).rejects.toThrow(/permission denied/i);

    // Post-finalize writes refuse without a same-transaction acceptance.
    const unbound = await runtime.unsafe<unknown[]>(`
      SELECT * FROM public.novatrade_invitation_membership_status($1)
    `, [JSON.stringify({ tenantId: TENANT_A, membershipId: MEMBER_A_PENDING, status: "active" })]);
    expect(unbound).toHaveLength(0);

    const unboundCreate = await runtime.unsafe<unknown[]>(`
      SELECT * FROM public.novatrade_invitation_membership_create($1)
    `, [JSON.stringify({
      tenantId: TENANT_A,
      id: randomUUID(),
      authIdentityId: INVITEE_A,
      workspaceId: WORKSPACE_A1,
      invitedByMembershipId: MEMBER_A_OWNER,
      createdAt: new Date().toISOString(),
    })]);
    expect(unboundCreate).toHaveLength(0);

    // Member-layer audit events refuse under a context-free session.
    const auditDenied = await runtime.unsafe<{ applied: boolean }[]>(`
      SELECT applied FROM public.novatrade_invitation_audit_append($1)
    `, [JSON.stringify({
      eventId: randomUUID(),
      eventType: "tenant.invitation_accepted",
      requestId: null,
      invitationId: INV_A_MEMBER,
      correlationId: "t040-direct-audit",
      idempotencyKeyHashRef: null,
      inputHashRef: null,
      actorLayer: "member",
      actorIdentityId: INVITEE_A,
      actorMembershipId: MEMBER_A_PENDING,
      actorRole: "researcher",
      actorRoleBindingId: BINDING_A_PENDING,
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A1,
      resultCode: "INVITATION_ACCEPTED",
    })]);
    expect(auditDenied[0].applied).toBe(false);
  });
});
