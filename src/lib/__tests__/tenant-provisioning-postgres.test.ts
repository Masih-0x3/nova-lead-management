/**
 * T-036: tenant provisioning on Postgres 16 — the system-lane write path.
 *
 * provisionTenant runs with no member context: the tenant does not exist
 * yet, so the SECURITY DEFINER family in migration 202609120009 binds the
 * session to a tenant created inside the same transaction (xmin = current
 * xact) and refuses to run while any member/worker/support GUC is set.
 *
 * Rehearsal setup (disposable PG16):
 *   - database t036_provisioning_rehearsal seeded with the tracked schema
 *     plus migration 202609120009
 *   - role t036_runtime (NOSUPERUSER NOBYPASSRLS) holding EXECUTE on the
 *     eleven provisioning API functions only
 *
 * The lane proves the full foundation commit (tenant, workspace, policy,
 * pending membership, owner binding, issued owner invitation), journal
 * reservation → completion, platform-scope system audit append, idempotent
 * replay and same-key conflict, delivery marking, direct-EXECUTE boundary
 * refusals, and append-only journal/invitation guards.
 */
import { createHash } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresTenantProvisioningService } from "@/lib/tenancy/postgres-tenant-provisioning";
import type { TenantProvisioningResult } from "@/lib/tenancy/provisioning";
import type { TenantInvitationDeliveryPort } from "@/lib/tenancy/provisioning";

vi.mock("server-only", () => ({}));

const adminUrl = process.env.T036_ADMIN_DATABASE_URL;
const runtimeRole = process.env.T036_RUNTIME_ROLE ?? "t036_runtime";
const enabled = process.env.T036_RUN_DISPOSABLE_PG_TESTS === "1" && Boolean(adminUrl);

const OPERATOR_IDENTITY = "00000000-0000-4000-8000-0000000000ff";
const OWNER_IDENTITY = "50000000-0000-4000-8000-0000000000a1";

let admin: Sql | undefined;

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe.runIf(enabled)("T-036 tenant provisioning on Postgres", () => {
  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    const version = await admin`SHOW server_version_num`;
    expect(Number(version[0].server_version_num)).toBeGreaterThanOrEqual(160000);

    await cleanRows();
    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean }[]>(
      `SELECT proname, prosecdef FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN (
           'novatrade_provisioning_journal_find',
           'novatrade_provisioning_journal_reserve',
           'novatrade_provisioning_journal_complete',
           'novatrade_provisioning_create_tenant',
           'novatrade_provisioning_create_workspace',
           'novatrade_provisioning_create_policy',
           'novatrade_provisioning_create_membership',
           'novatrade_provisioning_create_binding',
           'novatrade_provisioning_create_invitation',
           'novatrade_provisioning_audit_append',
           'novatrade_invitation_delivery_mark'
         )`,
    );
    expect(posture).toHaveLength(11);
    for (const fn of posture) expect(fn.prosecdef).toBe(true);

    const grants = await admin.unsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.routine_privileges
       WHERE grantee = $1 AND routine_name LIKE 'novatrade_provisioning%'`, [runtimeRole],
    );
    expect(grants.length).toBeGreaterThanOrEqual(10);
  });

  function service(delivery?: TenantInvitationDeliveryPort) {
    return createPostgresTenantProvisioningService({
      operatorIdentityId: OPERATOR_IDENTITY,
      invitationDelivery: delivery,
    });
  }

  function command(overrides: Record<string, unknown> = {}) {
    return {
      organizationName: "T036 Rehearsal Org",
      organizationSlug: `t036-org-${Math.random().toString(36).slice(2, 10)}`,
      requestedPolicyVersion: "policy-v1",
      ownerIdentityId: OWNER_IDENTITY,
      locale: "en-US",
      timezone: "UTC",
      idempotencyKey: `t036.provision.${Math.random().toString(36).slice(2, 12)}`,
      correlationId: `t036:provision:${Math.random().toString(36).slice(2, 12)}`,
      ...overrides,
    };
  }

  async function cleanRows(): Promise<void> {
    await admin!.begin(async (tx: TransactionSql) => {
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_provisioning_journal DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_invitations DISABLE TRIGGER ALL");
      try {
        await tx.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE 't036%'");
        await tx.unsafe("DELETE FROM public.tenant_provisioning_journal");
        await tx.unsafe("DELETE FROM public.tenant_invitations WHERE correlation_id LIKE 't036%'");
      } finally {
        await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.tenant_provisioning_journal ENABLE TRIGGER ALL");
        await tx.unsafe("ALTER TABLE public.tenant_invitations ENABLE TRIGGER ALL");
      }
      await tx.unsafe("DELETE FROM public.tenant_role_bindings WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't036-%')");
      await tx.unsafe("DELETE FROM public.tenant_memberships WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't036-%')");
      await tx.unsafe("DELETE FROM public.tenant_policies WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't036-%')");
      await tx.unsafe("DELETE FROM public.workspaces WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 't036-%')");
      await tx.unsafe("DELETE FROM public.tenants WHERE slug LIKE 't036-%'");
    });
  }

  it("commits the full tenant foundation with journal, audit, and invitation records", async () => {
    const result = await service().provisionTenant(command());
    expect(result.resultCode).toBe("PROVISIONING_FOUNDATION_CREATED");
    expect(result.tenantStatus).toBe("provisioning");
    expect(result.membershipStatus).toBe("pending");
    expect(result.role).toBe("owner");
    expect(result.workspaceId).toBeNull();
    expect(result.activationState).toBe("blocked");

    const tenant = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenants WHERE id = $1", [result.tenantId],
    );
    expect(tenant).toHaveLength(1);
    expect(tenant[0].status).toBe("provisioning");

    const policy = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_policies WHERE tenant_id = $1", [result.tenantId],
    );
    expect(policy).toHaveLength(1);
    expect(policy[0].version).toBe(1);

    const membership = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_memberships WHERE id = $1", [result.membershipId],
    );
    expect(membership).toHaveLength(1);
    expect(membership[0].status).toBe("pending");
    expect(membership[0].auth_identity_id).toBe(OWNER_IDENTITY);
    expect(membership[0].workspace_id).toBeNull();

    const binding = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_role_bindings WHERE id = $1", [result.roleBindingId],
    );
    expect(binding).toHaveLength(1);
    expect(binding[0].role).toBe("owner");
    expect(binding[0].reason_code).toBe("initial_provisioning");

    const invitation = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_invitations WHERE id = $1", [result.invitationId],
    );
    expect(invitation).toHaveLength(1);
    expect(invitation[0].kind).toBe("owner");
    expect(invitation[0].status).toBe("issued");
    expect(invitation[0].delivery_state).toBe("queued");
    expect(invitation[0].expected_identity_ref_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(invitation[0].membership_id).toBe(result.membershipId);

    const journal = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_provisioning_journal ORDER BY created_at",
    );
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe("completed");
    expect(journal[0].result_json).toBeTruthy();

    const audit = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.audit_logs WHERE correlation_id LIKE 't036%' AND action = 'tenant.provisioning_started'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].scope_kind).toBe("platform");
    expect(audit[0].actor_layer).toBe("system");
    expect(audit[0].tenant_id).toBeNull();
    expect(audit[0].actor_auth_identity_id).toBe(OPERATOR_IDENTITY);
  });

  it("commits a workspace-scoped foundation when the command carries a workspace", async () => {
    const result = await service().provisionTenant(command({
      workspace: { workspaceSlug: "t036-ws-alpha", workspaceName: "T036 Workspace Alpha" },
    }));
    expect(result.workspaceId).not.toBeNull();
    expect(result.workspaceStatus).toBe("provisioning");

    const workspace = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.workspaces WHERE id = $1", [result.workspaceId],
    );
    expect(workspace).toHaveLength(1);
    expect(workspace[0].status).toBe("provisioning");

    const membership = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_memberships WHERE id = $1", [result.membershipId],
    );
    expect(membership[0].workspace_id).toBe(result.workspaceId);

    const invitation = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_invitations WHERE id = $1", [result.invitationId],
    );
    expect(invitation[0].workspace_id).toBe(result.workspaceId);
  });

  it("replays an identical command and conflicts on the same key with different input", async () => {
    const cmd = command();
    const first = await service().provisionTenant(cmd);
    const replay = await service().provisionTenant(cmd);
    expect(replay).toEqual(first as TenantProvisioningResult);

    const tenants = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT id FROM public.tenants WHERE slug = $1", [cmd.organizationSlug],
    );
    expect(tenants).toHaveLength(1);
    const keyedJournal = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.tenant_provisioning_journal WHERE idempotency_key_hash = $1",
      [sha(cmd.idempotencyKey)],
    );
    expect(keyedJournal).toHaveLength(1);

    await expect(
      service().provisionTenant(command({ idempotencyKey: cmd.idempotencyKey })),
    ).rejects.toMatchObject({ code: "PROVISIONING_IDEMPOTENCY_CONFLICT" });
  });

  it("marks delivery and appends the delivery audit when the adapter reports delivered", async () => {
    const delivery: TenantInvitationDeliveryPort = {
      adapterId: "t036-stub",
      deliver: async () => ({
        adapterId: "t036-stub",
        state: "delivered",
        deliveryRefHash: sha("t036-delivery-ref"),
        deliveryDetail: "stub delivery",
      }),
    };
    const result = await service(delivery).provisionTenant(command());
    const invitation = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT delivery_state, delivery_adapter, delivery_ref_hash FROM public.tenant_invitations WHERE id = $1",
      [result.invitationId],
    );
    expect(invitation[0].delivery_state).toBe("delivered");
    expect(invitation[0].delivery_adapter).toBe("t036-stub");
    expect(invitation[0].delivery_ref_hash).toBe(sha("t036-delivery-ref"));

    const audit = await admin!.unsafe<Record<string, unknown>[]>(
      "SELECT * FROM public.audit_logs WHERE action = 'tenant.invitation_delivery_recorded' AND entity_id = $1",
      [result.invitationId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].scope_kind).toBe("platform");
    expect(audit[0].actor_layer).toBe("system");
  });

  it("refuses direct calls that escape the system-lane binding", async () => {
    // Child-row creators bind to a tenant created in the same transaction:
    // targeting an existing tenant (or none) yields no record.
    const runtime = postgres(
      adminUrl!.replace("postgres:postgres@", `${runtimeRole}:${runtimeRole}@`),
      { max: 1, prepare: false, onnotice: () => undefined },
    );
    try {
      const committed = await service().provisionTenant(command());
      // Refusals produce zero result rows, not a NULL record.
      const stray = await runtime.unsafe(
        `SELECT record FROM public.novatrade_provisioning_create_membership($1::text)`,
        [JSON.stringify({
          id: crypto.randomUUID(),
          tenantId: committed.tenantId,
          authIdentityId: OWNER_IDENTITY,
          workspaceId: null,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })],
      );
      expect(stray).toHaveLength(0);

      // A member-context install must refuse the system lane outright.
      await runtime.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [committed.tenantId]);
        await tx.unsafe("SELECT set_config('app.actor_id', $1, true)", [OWNER_IDENTITY]);
        const blocked = await tx.unsafe(
          `SELECT record FROM public.novatrade_provisioning_create_tenant($1::text)`,
          [JSON.stringify({
            id: crypto.randomUUID(),
            slug: "t036-blocked",
            name: "T036 Blocked",
            status: "provisioning",
            locale: "en-US",
            timezone: "UTC",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })],
        );
        expect(blocked).toHaveLength(0);
      });

      // Malformed payloads fail closed.
      const malformed = await runtime.unsafe(
        `SELECT record FROM public.novatrade_provisioning_create_tenant($1::text)`,
        [JSON.stringify({ id: "not-a-uuid", status: "active" })],
      );
      expect(malformed).toHaveLength(0);
    } finally {
      await runtime.end();
    }
  });

  it("keeps journal, invitation, and audit rows append-only", async () => {
    const result = await service().provisionTenant(command());
    await expect(
      admin!.unsafe("DELETE FROM public.tenant_provisioning_journal"),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin!.unsafe("UPDATE public.tenant_provisioning_journal SET input_hash = 'x'"),
    ).rejects.toThrow();
    await expect(
      admin!.unsafe("DELETE FROM public.tenant_invitations WHERE id = $1", [result.invitationId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin!.unsafe("UPDATE public.tenant_invitations SET role = 'admin' WHERE id = $1", [result.invitationId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      admin!.unsafe("DELETE FROM public.audit_logs WHERE correlation_id LIKE 't036%'"),
    ).rejects.toThrow();
  });
});

afterAll(async () => {
  if (admin) await admin.end();
});
