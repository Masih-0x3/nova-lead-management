import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantSession } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { createPostgresDeletionOperationsService } from "@/lib/tenancy/postgres-deletion-operations";

/**
 * T-039 gated rehearsal lane for the deletion-operations Postgres port.
 * Requires the disposable PG16 instance seeded with the full migration
 * history through 202609120012 plus a `t039_runtime` NOSUPERUSER role.
 *
 *   T039_RUN_DISPOSABLE_PG_TESTS=1 \
 *   T039_RUNTIME_ROLE=t039_runtime \
 *   T039_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t039_deletion_ops_rehearsal \
 *   DATABASE_URL=postgresql://t039_runtime:t039_runtime@127.0.0.1:55440/t039_deletion_ops_rehearsal \
 *   DATABASE_SSL=disable \
 *   npx vitest run src/lib/__tests__/tenant-deletion-ops-postgres.test.ts
 */

const RUN = process.env.T039_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t039_deletion_ops_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b1";
const MEMBER_A_OWNER = "20000000-0000-4000-8000-0000000000a1";
const MEMBER_A_OWNER2 = "20000000-0000-4000-8000-0000000000a4";
const MEMBER_A_ADMIN = "20000000-0000-4000-8000-0000000000a2";
const MEMBER_B_OWNER = "20000000-0000-4000-8000-0000000000b1";
const BINDING_A_OWNER = "30000000-0000-4000-8000-0000000000a1";
const BINDING_A_OWNER2 = "30000000-0000-4000-8000-0000000000a4";
const BINDING_A_ADMIN = "30000000-0000-4000-8000-0000000000a2";
const BINDING_B_OWNER = "30000000-0000-4000-8000-0000000000b1";
const ACTOR_A_OWNER = "50000000-0000-4000-8000-0000000000a1";
const ACTOR_A_OWNER2 = "50000000-0000-4000-8000-0000000000a4";
const ACTOR_A_ADMIN = "50000000-0000-4000-8000-0000000000a2";
const ACTOR_B_OWNER = "50000000-0000-4000-8000-0000000000b1";

const FUTURE_CLOCK = () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_OWNER,
    email: "t039-owner-a@example.test",
    displayName: "T039 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_OWNER,
    role: "owner",
    roleBindingId: BINDING_A_OWNER,
    ...overrides,
  };
}

function owner2SessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_OWNER2,
    email: "t039-owner2-a@example.test",
    displayName: "T039 Owner2 A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_OWNER2,
    role: "owner",
    roleBindingId: BINDING_A_OWNER2,
    ...overrides,
  };
}

function adminSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_ADMIN,
    email: "t039-admin-a@example.test",
    displayName: "T039 Admin A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_ADMIN,
    role: "admin",
    roleBindingId: BINDING_A_ADMIN,
    ...overrides,
  };
}

function ownerSessionB(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_B_OWNER,
    email: "t039-owner-b@example.test",
    displayName: "T039 Owner B",
    tenantId: TENANT_B,
    workspaceId: null,
    membershipId: MEMBER_B_OWNER,
    role: "owner",
    roleBindingId: BINDING_B_OWNER,
    ...overrides,
  };
}

interface StoreReceipt {
  receiptHash: string;
  observedCount: number;
  expectedCount: number;
}

function service(options: {
  clock?: () => Date;
  store?: { execute?: (input: { checkpoint: { storeClass: string } }) => Promise<StoreReceipt> };
} = {}) {
  const receipt = (): StoreReceipt => ({
    receiptHash: "b".repeat(64),
    observedCount: 0,
    expectedCount: 0,
  });
  return createPostgresDeletionOperationsService({
    deletionStore: {
      execute: options.store?.execute
        ? async (input) => options.store!.execute!(input)
        : async () => receipt(),
    },
    clock: options.clock,
  });
}

describe.skipIf(!RUN)("T-039 deletion operations on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-039 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T039_ADMIN_DATABASE_URL) {
      throw new Error("T-039 disposable test requires DATABASE_URL and T039_ADMIN_DATABASE_URL");
    }
    if (!process.env.T039_RUNTIME_ROLE) {
      throw new Error("T-039 disposable test requires T039_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T039_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-039 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-039 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-039 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T039_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-039 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_deletion_actor_ctx',
        'novatrade_deletion_read',
        'novatrade_deletion_checkpoint_json',
        'novatrade_deletion_request',
        'novatrade_deletion_transition',
        'novatrade_deletion_tenant_cas',
        'novatrade_deletion_checkpoint_insert',
        'novatrade_deletion_checkpoint_transition',
        'novatrade_deletion_checkpoint_event',
        'novatrade_deletion_tombstone_insert',
        'novatrade_deletion_audit_append'
      )
    `);
    if (posture.length !== 11 || posture.some((fn) => !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)) {
      throw new Error("T-039 preflight refused: deletion functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }

    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-039 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  interface MembershipSeed {
    id: string;
    tenantId: string;
    authIdentityId: string;
    bindingId: string;
    role: string;
  }

  const MEMBERSHIPS: MembershipSeed[] = [
    { id: MEMBER_A_OWNER, tenantId: TENANT_A, authIdentityId: ACTOR_A_OWNER, bindingId: BINDING_A_OWNER, role: "owner" },
    { id: MEMBER_A_OWNER2, tenantId: TENANT_A, authIdentityId: ACTOR_A_OWNER2, bindingId: BINDING_A_OWNER2, role: "owner" },
    { id: MEMBER_A_ADMIN, tenantId: TENANT_A, authIdentityId: ACTOR_A_ADMIN, bindingId: BINDING_A_ADMIN, role: "admin" },
    { id: MEMBER_B_OWNER, tenantId: TENANT_B, authIdentityId: ACTOR_B_OWNER, bindingId: BINDING_B_OWNER, role: "owner" },
  ];

  async function cleanRows(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.tenant_deletion_jobs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_checkpoints DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_checkpoint_events DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_tombstones DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships DISABLE TRIGGER ALL");
      await tx.unsafe(
        "DELETE FROM public.tenant_deletion_checkpoint_events WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_deletion_checkpoints WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_deletion_tombstones WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_deletion_jobs WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.audit_logs WHERE correlation_id LIKE $1 OR tenant_id = ANY($2::uuid[])",
        ["t039-%", [TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_role_bindings WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.tenant_policies WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe("DELETE FROM public.workspaces WHERE tenant_id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
      await tx.unsafe("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[TENANT_A, TENANT_B]]);
      await tx.unsafe("ALTER TABLE public.tenant_deletion_jobs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_checkpoints ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_checkpoint_events ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_deletion_tombstones ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships ENABLE TRIGGER ALL");
    });
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-039 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't039-tenant-a', 'Deletion Tenant A', 'archived'), ($2, 't039-tenant-b', 'Deletion Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.tenant_policies (tenant_id, primary_delete_within_days, backup_expire_within_days) VALUES ($1, 30, 30), ($2, 30, 30)",
        [TENANT_A, TENANT_B],
      );
      for (const membership of MEMBERSHIPS) {
        await tx.unsafe(
          `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status)
           VALUES ($1, $2, $3, NULL, 'active')`,
          [membership.id, membership.tenantId, membership.authIdentityId],
        );
        await tx.unsafe(
          `INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, created_at, valid_from, revoked_at)
           VALUES ($1, $2, $3, $4, pg_catalog.now() - pg_catalog.interval '2 minutes', pg_catalog.now() - pg_catalog.interval '1 minute', NULL)`,
          [membership.bindingId, membership.tenantId, membership.id, membership.role],
        );
      }
    });
  }

  async function jobRows(tenantId = TENANT_A) {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, status, scope_kind,
              verified_by_membership_id::text AS verified_by_membership_id,
              approved_by_membership_id::text AS approved_by_membership_id,
              retry_count, error_code, scheduled_at::text AS scheduled_at,
              started_at::text AS started_at, completed_at::text AS completed_at,
              canceled_at::text AS canceled_at
       FROM public.tenant_deletion_jobs WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
  }

  async function checkpointRows(jobId: string) {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT store_class, status, attempt, receipt_hash, error_code
       FROM public.tenant_deletion_checkpoints WHERE job_id = $1::uuid ORDER BY store_class`,
      [jobId],
    );
  }

  async function checkpointEventRows(jobId: string) {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT status, attempt FROM public.tenant_deletion_checkpoint_events
       WHERE job_id = $1::uuid ORDER BY id`,
      [jobId],
    );
  }

  async function tombstoneRows(jobId: string) {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT id::text AS id, job_id::text AS job_id FROM public.tenant_deletion_tombstones WHERE job_id = $1::uuid`,
      [jobId],
    );
  }

  async function auditRows() {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT action, entity_id, scope_kind, tenant_id::text AS tenant_id,
              correlation_id, actor_auth_identity_id::text AS actor_auth_identity_id,
              actor_membership_id::text AS actor_membership_id,
              actor_launch_role, actor_layer, metadata
       FROM public.audit_logs WHERE correlation_id LIKE 't039-%' ORDER BY created_at`,
    );
  }

  async function tenantStatus(tenantId = TENANT_A) {
    const rows = await admin.unsafe<{ status: string }[]>(
      `SELECT status FROM public.tenants WHERE id = $1`, [tenantId]);
    return rows[0]?.status;
  }

  function requestInput(overrides: Record<string, unknown> = {}) {
    return {
      tenantId: TENANT_A,
      workspaceId: null,
      requester: { authIdentityId: ACTOR_A_OWNER, membershipId: MEMBER_A_OWNER },
      idempotencyKey: `t039-request-${randomUUID()}`,
      correlationId: "t039-correlation",
      ...overrides,
    };
  }

  /** Drive a job to the scheduled state under real time, returning ids. */
  async function driveToScheduled(key: string) {
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestDeletion(requestInput({ idempotencyKey: key, correlationId: `${key}-request` })));
    await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().verifyDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        verifier: { authIdentityId: ACTOR_A_ADMIN, membershipId: MEMBER_A_ADMIN },
        correlationId: `${key}-verify`,
      }));
    await runWithTenantContext(owner2SessionA(), "ambient", () =>
      service().approveDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        approver: { authIdentityId: ACTOR_A_OWNER2, membershipId: MEMBER_A_OWNER2 },
        correlationId: `${key}-approve`,
      }));
    return requested.job.id;
  }

  beforeAll(async () => {
    await assertDisposableTarget();
  }, 30_000);

  // Each test needs a fresh 'archived' tenant A: the first request lands the
  // archived → deletion_pending CAS, after which the canonical status gate
  // refuses every further requestDeletion for that tenant.
  beforeEach(async () => {
    await fixture();
  }, 15_000);

  afterAll(async () => {
    await cleanRows().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await runtime?.end().catch(() => undefined);
  });

  it("runs request→verify→approve→run end to end: job, checkpoints, tombstone, audits", async () => {
    const input = requestInput({ idempotencyKey: "t039-req-main", correlationId: "t039-request-main" });
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestDeletion(input));

    expect(requested.code).toBe("OK_DELETION_REQUESTED");
    expect(requested.replayed).toBe(false);
    expect(requested.job.status).toBe("requested");
    expect(await tenantStatus()).toBe("deletion_pending");

    const job = (await jobRows()).find((row) => row.id === requested.job.id);
    expect(job).toMatchObject({ status: "requested", scope_kind: "tenant" });

    const requestAudit = (await auditRows()).filter((row) => row.action === "tenant.deletion.requested");
    expect(requestAudit).toHaveLength(1);
    expect(requestAudit[0]).toMatchObject({
      scope_kind: "tenant",
      tenant_id: TENANT_A,
      actor_auth_identity_id: ACTOR_A_OWNER,
      actor_membership_id: MEMBER_A_OWNER,
      actor_launch_role: "owner",
      actor_layer: "member",
      correlation_id: "t039-request-main",
      entity_id: requested.job.id,
    });

    // Canonical semantics: the archived → deletion_pending CAS commits with
    // the request, so every subsequent requestDeletion — same key, conflicting
    // key, or different requester — fails the archived-only status gate before
    // the idempotency lookup is reached. The replay row is unreachable for
    // deletion; the observable contract is a closed non-enumerating refusal.
    for (const replayInput of [
      { ...input, correlationId: "t039-request-replay" },
      {
        ...input,
        requester: { authIdentityId: ACTOR_A_OWNER2, membershipId: MEMBER_A_OWNER2 },
        correlationId: "t039-request-conflict",
      },
      { ...input, idempotencyKey: "t039-request-second", correlationId: "t039-request-second" },
    ]) {
      await expect(
        runWithTenantContext(owner2SessionA(), "ambient", () =>
          service().requestDeletion(replayInput)),
      ).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
    }

    const verified = await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().verifyDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        verifier: { authIdentityId: ACTOR_A_ADMIN, membershipId: MEMBER_A_ADMIN },
        correlationId: "t039-verify-main",
      }));
    expect(verified.code).toBe("OK_DELETION_VERIFIED");
    expect(verified.job.status).toBe("verified");
    expect(verified.job.verifiedByMembershipId).toBe(MEMBER_A_ADMIN);

    const approved = await runWithTenantContext(owner2SessionA(), "ambient", () =>
      service().approveDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        approver: { authIdentityId: ACTOR_A_OWNER2, membershipId: MEMBER_A_OWNER2 },
        correlationId: "t039-approve-main",
      }));
    expect(approved.code).toBe("OK_DELETION_SCHEDULED");
    expect(approved.job.status).toBe("scheduled");
    expect(approved.job.scheduledAt).not.toBeNull();

    // The approval schedules the run; executing early violates clock ordering.
    await expect(
      runWithTenantContext(ownerSessionA(), "ambient", () =>
        service().runDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
          correlationId: "t039-run-early",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_STATE_CONFLICT" });

    const ran = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service({ clock: FUTURE_CLOCK }).runDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t039-run-main",
      }));
    expect(ran.code).toBe("OK_DELETION_COMPLETED");
    expect(ran.job.status).toBe("completed");
    expect(ran.job.primaryDeletedAt).not.toBeNull();
    expect(ran.job.backupAgingAt).not.toBeNull();
    expect(ran.job.completedAt).not.toBeNull();
    expect(await tenantStatus()).toBe("deleted");

    const checkpoints = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().listDeletionCheckpoints(TENANT_A, requested.job.id));
    expect(checkpoints).toHaveLength(10);
    expect(checkpoints.every((checkpoint) => checkpoint.status === "complete" && checkpoint.receiptHash !== null)).toBe(true);

    const tombstones = await tombstoneRows(requested.job.id);
    expect(tombstones).toHaveLength(1);

    const events = await checkpointEventRows(requested.job.id);
    // 10 pending + 10 running + 9 primary complete + 1 backup_aging complete
    expect(events.filter((row) => row.status === "pending")).toHaveLength(10);
    expect(events.filter((row) => row.status === "running")).toHaveLength(10);
    expect(events.filter((row) => row.status === "complete")).toHaveLength(10);

    const runAudits = (await auditRows()).filter((row) =>
      row.action === "tenant.deletion.running"
      || row.action === "tenant.deletion.primary_deleted"
      || row.action === "tenant.deletion.completed");
    expect(runAudits).toHaveLength(3);
    expect(runAudits.every((row) =>
      row.scope_kind === "platform" && row.tenant_id === null
      && row.actor_layer === "system" && row.actor_membership_id === null)).toBe(true);
    expect(runAudits.every((row) =>
      (row.metadata as Record<string, unknown>).tenantId === TENANT_A)).toBe(true);
  });

  it("enforces the three-person independence rule and legal edges", async () => {
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestDeletion(requestInput({ idempotencyKey: "t039-req-ind", correlationId: "t039-request-ind" })));

    // The requester cannot verify their own job.
    await expect(
      runWithTenantContext(ownerSessionA(), "ambient", () =>
        service().verifyDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          verifier: { authIdentityId: ACTOR_A_OWNER, membershipId: MEMBER_A_OWNER },
          correlationId: "t039-verify-self",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_APPROVAL_INDEPENDENCE" });

    // Approval requires the verified state first.
    await expect(
      runWithTenantContext(owner2SessionA(), "ambient", () =>
        service().approveDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          approver: { authIdentityId: ACTOR_A_OWNER2, membershipId: MEMBER_A_OWNER2 },
          correlationId: "t039-approve-early",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_STATE_CONFLICT" });

    // An owner may verify — the verifier role gate is owner/admin.
    await runWithTenantContext(owner2SessionA(), "ambient", () =>
      service().verifyDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        verifier: { authIdentityId: ACTOR_A_OWNER2, membershipId: MEMBER_A_OWNER2 },
        correlationId: "t039-verify-ind",
      }));

    // The verifier cannot approve — independence is checked after the
    // owner-only approver role gate, so an owner verifier reaches it.
    await expect(
      runWithTenantContext(owner2SessionA(), "ambient", () =>
        service().approveDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          approver: { authIdentityId: ACTOR_A_OWNER2, membershipId: MEMBER_A_OWNER2 },
          correlationId: "t039-approve-verifier",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_APPROVAL_INDEPENDENCE" });

    // The requester cannot approve either.
    await expect(
      runWithTenantContext(ownerSessionA(), "ambient", () =>
        service().approveDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          approver: { authIdentityId: ACTOR_A_OWNER, membershipId: MEMBER_A_OWNER },
          correlationId: "t039-approve-requester",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_APPROVAL_INDEPENDENCE" });

    // Admins cannot approve — the owner-only role gate refuses first, before
    // the independence check, so the failure is a scope denial.
    await expect(
      runWithTenantContext(adminSessionA(), "ambient", () =>
        service().approveDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          approver: { authIdentityId: ACTOR_A_ADMIN, membershipId: MEMBER_A_ADMIN },
          correlationId: "t039-approve-admin",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_ACTOR_SCOPE" });
  });

  it("cancels a requested job and rolls the tenant back to archived", async () => {
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestDeletion(requestInput({ idempotencyKey: "t039-req-cancel", correlationId: "t039-request-cancel" })));
    expect(await tenantStatus()).toBe("deletion_pending");

    const canceled = await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().cancelDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        actor: { authIdentityId: ACTOR_A_ADMIN, layer: "member", membershipId: MEMBER_A_ADMIN },
        correlationId: "t039-cancel",
      }));
    expect(canceled.code).toBe("OK_DELETION_CANCELED");
    expect(canceled.job.status).toBe("canceled");
    expect(await tenantStatus()).toBe("archived");

    const job = (await jobRows()).find((row) => row.id === requested.job.id);
    expect(job).toMatchObject({ status: "canceled" });
    const cancelAudit = (await auditRows()).filter((row) => row.action === "tenant.deletion.canceled");
    expect(cancelAudit).toHaveLength(1);
    expect(cancelAudit[0]).toMatchObject({
      scope_kind: "tenant",
      actor_membership_id: MEMBER_A_ADMIN,
      actor_launch_role: "admin",
      actor_layer: "member",
      correlation_id: "t039-cancel",
    });
    const metadata = cancelAudit[0].metadata as Record<string, unknown>;
    expect(metadata.tenantFromStatus).toBe("deletion_pending");
    expect(metadata.tenantToStatus).toBe("archived");

    // canceled→canceled is a legal self-loop edge in the canonical transition
    // map: the local backend re-answers OK_DELETION_CANCELED and appends a
    // second audit row. The Postgres twin preserves that surface while the
    // immutable canceled_at guard turns the row write into a no-op.
    const recanceled = await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().cancelDeletion({
        tenantId: TENANT_A, jobId: requested.job.id,
        actor: { authIdentityId: ACTOR_A_ADMIN, layer: "member", membershipId: MEMBER_A_ADMIN },
        correlationId: "t039-cancel-again",
      }));
    expect(recanceled.code).toBe("OK_DELETION_CANCELED");
    expect(recanceled.job.status).toBe("canceled");
    expect(recanceled.job.canceledAt).toBe(canceled.job.canceledAt);
    const recancelAudit = (await auditRows()).filter((row) => row.action === "tenant.deletion.canceled");
    expect(recancelAudit).toHaveLength(2);
    expect(recancelAudit[1]).toMatchObject({ correlation_id: "t039-cancel-again" });

    // A canceled job cannot re-enter the lifecycle — verify requires the
    // 'requested' state and fails closed.
    await expect(
      runWithTenantContext(adminSessionA(), "ambient", () =>
        service().verifyDeletion({
          tenantId: TENANT_A, jobId: requested.job.id,
          verifier: { authIdentityId: ACTOR_A_ADMIN, membershipId: MEMBER_A_ADMIN },
          correlationId: "t039-verify-after-cancel",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_STATE_CONFLICT" });
  });

  it("records the failure ledger, requeues, and completes on retry", async () => {
    const jobId = await driveToScheduled("t039-req-fail");

    const calls: string[] = [];
    const flaky = (input: { checkpoint: { storeClass: string } }) => {
      calls.push(input.checkpoint.storeClass);
      if (calls.length === 3) return Promise.reject(new Error("store blew up"));
      return Promise.resolve({ receiptHash: "c".repeat(64), observedCount: 0, expectedCount: 0 });
    };

    await expect(
      runWithTenantContext(ownerSessionA(), "ambient", () =>
        service({ clock: FUTURE_CLOCK, store: { execute: flaky } }).runDeletion({
          tenantId: TENANT_A, jobId,
          executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
          correlationId: "t039-run-fail",
        })),
    ).rejects.toMatchObject({ code: "FAILED_INTERNAL" });

    const failedJob = (await jobRows()).find((row) => row.id === jobId);
    expect(failedJob).toMatchObject({ status: "failed", error_code: "DELETE_INTERNAL" });
    const checkpoints = await checkpointRows(jobId);
    expect(checkpoints.filter((row) => row.status === "complete")).toHaveLength(2);
    expect(checkpoints.filter((row) => row.status === "failed")).toHaveLength(1);
    expect(checkpoints.filter((row) => row.status === "pending")).toHaveLength(7);
    expect((await auditRows()).some((row) =>
      row.action === "tenant.deletion.failed" && row.actor_layer === "system"
      && row.entity_id === jobId)).toBe(true);

    const requeued = await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().requeueDeletion({
        tenantId: TENANT_A, jobId,
        executor: { authIdentityId: ACTOR_A_ADMIN, layer: "member", membershipId: MEMBER_A_ADMIN },
        correlationId: "t039-requeue",
      }));
    expect(requeued.code).toBe("OK_DELETION_RUNNING");
    expect(requeued.job.status).toBe("retry_wait");
    expect(requeued.job.retryCount).toBe(1);
    expect((await auditRows()).some((row) =>
      row.action === "tenant.deletion.requeued" && row.actor_membership_id === MEMBER_A_ADMIN
      && row.entity_id === jobId)).toBe(true);

    const completed = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service({ clock: FUTURE_CLOCK }).runDeletion({
        tenantId: TENANT_A, jobId,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t039-run-retry",
      }));
    expect(completed.code).toBe("OK_DELETION_COMPLETED");
    expect(completed.job.status).toBe("completed");
    expect(await tenantStatus()).toBe("deleted");

    const finalCheckpoints = await checkpointRows(jobId);
    expect(finalCheckpoints.every((row) => row.status === "complete")).toBe(true);
    expect(finalCheckpoints.some((row) => row.attempt === 1)).toBe(true);
    const events = await checkpointEventRows(jobId);
    expect(events.some((row) => row.status === "retryable" && row.attempt === 1)).toBe(true);
  });

  it("scopes every lane to the accepted tenant and fails closed", async () => {
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestDeletion(requestInput({ idempotencyKey: "t039-req-scope", correlationId: "t039-request-scope" })));

    // Tenant B's owner cannot reach tenant A's job — the definer read binds
    // tenant_id to the installed context, so the lookup is non-enumerating.
    await expect(
      runWithTenantContext(ownerSessionB(), "ambient", () =>
        service().verifyDeletion({
          tenantId: TENANT_B, jobId: requested.job.id,
          verifier: { authIdentityId: ACTOR_B_OWNER, membershipId: MEMBER_B_OWNER },
          correlationId: "t039-verify-cross",
        })),
    ).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });
    await expect(
      runWithTenantContext(ownerSessionB(), "ambient", () =>
        service().getDeletionJob(TENANT_B, requested.job.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });

    // Tenant B is 'active' — deletion_request is not a legal operation there.
    await expect(
      runWithTenantContext(ownerSessionB(), "ambient", () =>
        service().requestDeletion({
          tenantId: TENANT_B,
          workspaceId: null,
          requester: { authIdentityId: ACTOR_B_OWNER, membershipId: MEMBER_B_OWNER },
          idempotencyKey: "t039-req-b",
          correlationId: "t039-request-b",
        })),
    ).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });

    // No ambient context: the adapter refuses before any SQL.
    await expect(service().requestDeletion(requestInput({ idempotencyKey: "t039-req-noctx" })))
      .rejects.toThrow();
  });

  it("keeps the direct-EXECUTE boundary honest", async () => {
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestDeletion(requestInput({ idempotencyKey: "t039-req-direct", correlationId: "t039-request-direct" })));

    async function withMemberGucs(
      session: TenantSession,
      callback: (tx: Sql) => Promise<unknown>,
    ): Promise<unknown> {
      return runtime.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [session.tenantId]);
        await tx.unsafe("SELECT set_config('app.actor_id', $1, true)", [session.userId]);
        await tx.unsafe("SELECT set_config('app.membership_id', $1, true)", [session.membershipId]);
        await tx.unsafe("SELECT set_config('app.role', $1, true)", [session.role]);
        await tx.unsafe("SELECT set_config('app.role_binding_id', $1, true)", [session.roleBindingId]);
        await tx.unsafe("SELECT set_config('app.workspace_id', $1, true)", [session.workspaceId ?? ""]);
        await tx.unsafe("SELECT set_config('app.correlation_id', 't039-direct', true)");
        return callback(tx as unknown as Sql);
      });
    }

    // A tenant-B context cannot transition tenant A's job.
    const foreign = await withMemberGucs(ownerSessionB(), async (tx) =>
      tx.unsafe<{ outcome: string }[]>(
        `SELECT outcome FROM public.novatrade_deletion_transition($1)`,
        [JSON.stringify({ jobId: requested.job.id, tenantId: TENANT_B, edge: "cancel", at: new Date().toISOString(), expectedStatus: "requested" })],
      )) as { outcome: string }[];
    expect(foreign[0].outcome).toBe("not_found");

    // A bogus edge refuses lexically under a valid context.
    const invalid = await withMemberGucs(ownerSessionA(), async (tx) =>
      tx.unsafe<{ outcome: string }[]>(
        `SELECT outcome FROM public.novatrade_deletion_transition($1)`,
        [JSON.stringify({ jobId: requested.job.id, tenantId: TENANT_A, edge: "teleport" })],
      )) as { outcome: string }[];
    expect(invalid[0].outcome).toBe("invalid_request");

    // A self-verification refuses at the function boundary too.
    const selfVerify = await withMemberGucs(ownerSessionA(), async (tx) =>
      tx.unsafe<{ outcome: string }[]>(
        `SELECT outcome FROM public.novatrade_deletion_transition($1)`,
        [JSON.stringify({
          jobId: requested.job.id, tenantId: TENANT_A, edge: "verify",
          verifierAuthIdentityId: ACTOR_A_OWNER, verifierMembershipId: MEMBER_A_OWNER,
          at: new Date().toISOString(),
        })],
      )) as { outcome: string }[];
    expect(selfVerify[0].outcome).toBe("invalid_request");

    // No context: request, transition, audit, and read lanes refuse.
    const noCtx = await runtime.unsafe<{ applied: boolean }[]>(
      `SELECT applied FROM public.novatrade_deletion_request($1)`,
      [JSON.stringify({ jobId: randomUUID(), tenantId: TENANT_A })],
    );
    expect(noCtx[0].applied).toBe(false);
    const noCtxTransition = await runtime.unsafe<{ outcome: string }[]>(
      `SELECT outcome FROM public.novatrade_deletion_transition($1)`,
      [JSON.stringify({ jobId: requested.job.id, tenantId: TENANT_A, edge: "cancel", at: new Date().toISOString(), expectedStatus: "requested" })],
    );
    expect(noCtxTransition[0].outcome).toBe("denied");
    const noCtxRead = await runtime.unsafe<{ record: unknown }[]>(
      `SELECT record FROM public.novatrade_deletion_read($1) AS record`,
      [JSON.stringify({ kind: "job", tenantId: TENANT_A, jobId: requested.job.id })],
    );
    expect(noCtxRead[0].record).toBeNull();

    // A request naming a different requester membership refuses.
    const forged = await withMemberGucs(ownerSessionA(), async (tx) =>
      tx.unsafe<{ applied: boolean }[]>(
        `SELECT applied FROM public.novatrade_deletion_request($1)`,
        [JSON.stringify({
          jobId: randomUUID(), tenantId: TENANT_A, workspaceId: null,
          scopeKind: "tenant", scopeSelectorHash: "a".repeat(64),
          inputHash: "b".repeat(64), idempotencyKeyHash: "c".repeat(64),
          policySnapshotHash: "d".repeat(64), policyVersion: "tenant-policy-v1",
          requesterAuthIdentityId: ACTOR_A_OWNER,
          requesterMembershipId: MEMBER_A_ADMIN,
          correlationId: "t039-forged", auditEventId: randomUUID(),
        })],
      )) as { applied: boolean }[];
    expect(forged[0].applied).toBe(false);
  });
});
