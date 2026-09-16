import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantSession } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { createPostgresExportOperationsService } from "@/lib/tenancy/postgres-export-operations";
import type { TenantExportArtifactFacts, TenantExportRunnerPort } from "@/lib/tenancy/lifecycle-operations";

/**
 * T-038 gated rehearsal lane for the export-operations Postgres port.
 * Requires the disposable PG16 instance seeded with the full migration
 * history through 202609120011 plus a `t038_runtime` NOSUPERUSER role.
 *
 *   T038_RUN_DISPOSABLE_PG_TESTS=1 \
 *   T038_RUNTIME_ROLE=t038_runtime \
 *   T038_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/t038_export_ops_rehearsal \
 *   DATABASE_URL=postgresql://t038_runtime:t038_runtime@127.0.0.1:55440/t038_export_ops_rehearsal \
 *   DATABASE_SSL=disable \
 *   npx vitest run src/lib/__tests__/tenant-export-ops-postgres.test.ts
 */

const RUN = process.env.T038_RUN_DISPOSABLE_PG_TESTS === "1";
const EXPECTED_DATABASE = "t038_export_ops_rehearsal";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE_A1 = "10000000-0000-4000-8000-0000000000a1";
const MEMBER_A_OWNER = "20000000-0000-4000-8000-0000000000a1";
const MEMBER_A_ADMIN = "20000000-0000-4000-8000-0000000000a2";
const MEMBER_A_RESEARCHER = "20000000-0000-4000-8000-0000000000a3";
const MEMBER_B_OWNER = "20000000-0000-4000-8000-0000000000b1";
const BINDING_A_OWNER = "30000000-0000-4000-8000-0000000000a1";
const BINDING_A_ADMIN = "30000000-0000-4000-8000-0000000000a2";
const BINDING_A_RESEARCHER = "30000000-0000-4000-8000-0000000000a3";
const BINDING_B_OWNER = "30000000-0000-4000-8000-0000000000b1";
const ACTOR_A_OWNER = "50000000-0000-4000-8000-0000000000a1";
const ACTOR_A_ADMIN = "50000000-0000-4000-8000-0000000000a2";
const ACTOR_A_RESEARCHER = "50000000-0000-4000-8000-0000000000a3";
const ACTOR_B_OWNER = "50000000-0000-4000-8000-0000000000b1";

function ownerSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_OWNER,
    email: "t038-owner-a@example.test",
    displayName: "T038 Owner A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_OWNER,
    role: "owner",
    roleBindingId: BINDING_A_OWNER,
    ...overrides,
  };
}

function adminSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_ADMIN,
    email: "t038-admin-a@example.test",
    displayName: "T038 Admin A",
    tenantId: TENANT_A,
    workspaceId: null,
    membershipId: MEMBER_A_ADMIN,
    role: "admin",
    roleBindingId: BINDING_A_ADMIN,
    ...overrides,
  };
}

function researcherSessionA(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: ACTOR_A_RESEARCHER,
    email: "t038-researcher-a@example.test",
    displayName: "T038 Researcher A",
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
    userId: ACTOR_B_OWNER,
    email: "t038-owner-b@example.test",
    displayName: "T038 Owner B",
    tenantId: TENANT_B,
    workspaceId: null,
    membershipId: MEMBER_B_OWNER,
    role: "owner",
    roleBindingId: BINDING_B_OWNER,
    ...overrides,
  };
}

function artifactFacts(tenantId: string, jobId: string, expiresInMs = 60_000): TenantExportArtifactFacts {
  const at = new Date().toISOString();
  return {
    snapshotAt: at,
    artifactStorageRef: `tenants/${tenantId}/exports/${jobId}/export.json`,
    checksumSha256: "a".repeat(64),
    includedCount: 3,
    excludedCount: 1,
    redactedCount: 2,
    artifactCreatedAt: at,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

function service(runner?: {
  execute?: TenantExportArtifactFacts | Error | TenantExportRunnerPort["execute"];
  purge?: TenantExportRunnerPort["purge"];
}) {
  return createPostgresExportOperationsService({
    exportRunner: {
      execute: async (input) => {
        if (runner?.execute instanceof Error) throw runner.execute;
        if (typeof runner?.execute === "function") return runner.execute(input);
        return runner?.execute ?? artifactFacts(input.tenantId, input.job.id);
      },
      purge: runner?.purge ?? (async () => {}),
    },
  });
}

describe.skipIf(!RUN)("T-038 export operations on Postgres", () => {
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
    if (rows.length !== 1) throw new Error("T-038 preflight could not resolve current_user role attributes");
    return rows[0];
  }

  async function assertDisposableTarget(): Promise<void> {
    if (!process.env.DATABASE_URL || !process.env.T038_ADMIN_DATABASE_URL) {
      throw new Error("T-038 disposable test requires DATABASE_URL and T038_ADMIN_DATABASE_URL");
    }
    if (!process.env.T038_RUNTIME_ROLE) {
      throw new Error("T-038 disposable test requires T038_RUNTIME_ROLE");
    }
    admin = postgres(process.env.T038_ADMIN_DATABASE_URL, { ssl: false, max: 2 });
    runtime = postgres(process.env.DATABASE_URL, { ssl: false, max: 2 });
    const [adminReceipt, runtimeReceipt] = await Promise.all([connectionReceipt(admin), connectionReceipt(runtime)]);
    const sameDatabase = ["database_name", "server_addr", "server_port", "postmaster_started_at"].every(
      (key) => adminReceipt[key as keyof ConnectionReceipt] === runtimeReceipt[key as keyof ConnectionReceipt],
    );
    if (!sameDatabase) throw new Error("T-038 preflight refused: admin and runtime are not the same resolved PostgreSQL instance");
    if (adminReceipt.database_name !== EXPECTED_DATABASE) throw new Error(`T-038 preflight refused: database must be ${EXPECTED_DATABASE}`);
    if (Math.floor(adminReceipt.server_version_num / 10_000) !== 16) throw new Error("T-038 preflight refused: server major must be PostgreSQL 16");
    if (runtimeReceipt.current_user !== process.env.T038_RUNTIME_ROLE || runtimeReceipt.rolsuper || runtimeReceipt.rolbypassrls) {
      throw new Error("T-038 preflight refused: runtime must be the named NOSUPERUSER, NOBYPASSRLS role");
    }

    const posture = await admin.unsafe<{ proname: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }[]>(`
      SELECT p.proname, p.prosecdef,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'novatrade_export_job_json',
        'novatrade_export_member_ctx',
        'novatrade_export_request',
        'novatrade_export_transition',
        'novatrade_export_audit_append'
      )
    `);
    if (posture.length !== 5 || posture.some((fn) => !fn.prosecdef || fn.anon_execute || fn.authenticated_execute)) {
      throw new Error("T-038 preflight refused: export functions must be SECURITY DEFINER with no anon/authenticated EXECUTE");
    }

    const { getDb } = await import("@/lib/db");
    const probe = await (await getDb()).prepare("SELECT 1 AS one").get<{ one: number }>();
    if (probe?.one !== 1) throw new Error("T-038 preflight refused: production PostgresClient could not complete a probe query");
    targetValidated = true;
  }

  interface MembershipSeed {
    id: string;
    tenantId: string;
    authIdentityId: string;
    workspaceId: string | null;
    bindingId: string;
    role: string;
  }

  const MEMBERSHIPS: MembershipSeed[] = [
    { id: MEMBER_A_OWNER, tenantId: TENANT_A, authIdentityId: ACTOR_A_OWNER, workspaceId: null, bindingId: BINDING_A_OWNER, role: "owner" },
    { id: MEMBER_A_ADMIN, tenantId: TENANT_A, authIdentityId: ACTOR_A_ADMIN, workspaceId: null, bindingId: BINDING_A_ADMIN, role: "admin" },
    { id: MEMBER_A_RESEARCHER, tenantId: TENANT_A, authIdentityId: ACTOR_A_RESEARCHER, workspaceId: null, bindingId: BINDING_A_RESEARCHER, role: "researcher" },
    { id: MEMBER_B_OWNER, tenantId: TENANT_B, authIdentityId: ACTOR_B_OWNER, workspaceId: null, bindingId: BINDING_B_OWNER, role: "owner" },
  ];

  async function cleanRows(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE public.tenant_export_jobs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.audit_logs DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings DISABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships DISABLE TRIGGER ALL");
      await tx.unsafe(
        "DELETE FROM public.tenant_export_jobs WHERE tenant_id = ANY($1::uuid[])",
        [[TENANT_A, TENANT_B]],
      );
      await tx.unsafe(
        "DELETE FROM public.audit_logs WHERE correlation_id LIKE $1 OR tenant_id = ANY($2::uuid[])",
        ["t038-%", [TENANT_A, TENANT_B]],
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
      await tx.unsafe("ALTER TABLE public.tenant_export_jobs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.audit_logs ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_role_bindings ENABLE TRIGGER ALL");
      await tx.unsafe("ALTER TABLE public.tenant_memberships ENABLE TRIGGER ALL");
    });
  }

  async function fixture(): Promise<void> {
    if (!targetValidated) throw new Error("T-038 fixture reached without disposable-target validation");
    await cleanRows();
    await admin.begin(async (tx) => {
      await tx.unsafe(
        "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't038-tenant-a', 'Export Tenant A', 'active'), ($2, 't038-tenant-b', 'Export Tenant B', 'active')",
        [TENANT_A, TENANT_B],
      );
      await tx.unsafe(
        "INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES ($1, $2, 't038-ws-a1', 'Workspace A1', 'active')",
        [WORKSPACE_A1, TENANT_A],
      );
      await tx.unsafe(
        "INSERT INTO public.tenant_policies (tenant_id, export_retention_days) VALUES ($1, 7), ($2, 7)",
        [TENANT_A, TENANT_B],
      );
      for (const membership of MEMBERSHIPS) {
        await tx.unsafe(
          `INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status)
           VALUES ($1, $2, $3, $4, 'active')`,
          [membership.id, membership.tenantId, membership.authIdentityId, membership.workspaceId],
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
      `SELECT id::text AS id, tenant_id::text AS tenant_id, workspace_id::text AS workspace_id,
              status, requester_auth_identity_id::text AS requester_auth_identity_id,
              requester_membership_id::text AS requester_membership_id,
              support_access_grant_id::text AS support_access_grant_id,
              requested_format, error_code, retry_count, next_retry_at::text AS next_retry_at,
              artifact_storage_ref, expires_at::text AS expires_at, correlation_id
       FROM public.tenant_export_jobs WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
  }

  async function auditRows() {
    return admin.unsafe<Record<string, unknown>[]>(
      `SELECT id::text AS id, action, entity_type, entity_id, scope_kind,
              tenant_id::text AS tenant_id, workspace_id::text AS workspace_id,
              correlation_id, actor_auth_identity_id::text AS actor_auth_identity_id,
              actor_membership_id::text AS actor_membership_id,
              actor_launch_role, actor_role_binding_id::text AS actor_role_binding_id,
              actor_layer, metadata
       FROM public.audit_logs WHERE correlation_id LIKE 't038-%' ORDER BY created_at`,
    );
  }

  function requestInput(overrides: Record<string, unknown> = {}) {
    return {
      tenantId: TENANT_A,
      workspaceId: null,
      requester: { authIdentityId: ACTOR_A_OWNER, membershipId: MEMBER_A_OWNER },
      format: "json" as const,
      idempotencyKey: `t038-request-${randomUUID()}`,
      correlationId: "t038-correlation",
      ...overrides,
    };
  }

  beforeAll(async () => {
    await assertDisposableTarget();
    await fixture();
  }, 30_000);

  afterAll(async () => {
    await cleanRows().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await runtime?.end().catch(() => undefined);
  });

  it("commits request + run end to end: job, audits, replay, conflict", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-main", correlationId: "t038-request-main" });
    const requested = await runWithTenantContext(ownerSessionA(), "tenant-operations:tenant-export.request:1", () =>
      service().requestExport(input));

    expect(requested.code).toBe("OK_EXPORT_REQUESTED");
    expect(requested.replayed).toBe(false);
    expect(requested.job.status).toBe("requested");
    expect(requested.job.tenantId).toBe(TENANT_A);
    expect(requested.job.requesterMembershipId).toBe(MEMBER_A_OWNER);

    const job = (await jobRows()).find((row) => row.id === requested.job.id);
    expect(job).toMatchObject({
      status: "requested",
      requester_auth_identity_id: ACTOR_A_OWNER,
      requester_membership_id: MEMBER_A_OWNER,
      support_access_grant_id: null,
      requested_format: "json",
      correlation_id: "t038-request-main",
    });

    const requestAudit = (await auditRows()).filter((row) => row.action === "tenant.export.requested");
    expect(requestAudit).toHaveLength(1);
    expect(requestAudit[0]).toMatchObject({
      scope_kind: "tenant",
      tenant_id: TENANT_A,
      entity_type: "tenant_lifecycle_job",
      entity_id: requested.job.id,
      actor_auth_identity_id: ACTOR_A_OWNER,
      actor_membership_id: MEMBER_A_OWNER,
      actor_launch_role: "owner",
      actor_role_binding_id: BINDING_A_OWNER,
      actor_layer: "member",
      correlation_id: "t038-request-main",
    });

    const ran = await runWithTenantContext(ownerSessionA(), "tenant-operations:tenant-export.request:1", () =>
      service().runExport({
        tenantId: TENANT_A,
        jobId: requested.job.id,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t038-run-main",
      }));
    expect(ran.code).toBe("OK_EXPORT_COMPLETED");
    expect(ran.job.status).toBe("released");
    expect(ran.job.artifactStorageRef).toBe(`tenants/${TENANT_A}/exports/${requested.job.id}/export.json`);

    const releasedAudit = (await auditRows()).filter((row) => row.action === "tenant.export.released");
    expect(releasedAudit).toHaveLength(1);
    expect(releasedAudit[0]).toMatchObject({
      scope_kind: "platform",
      tenant_id: null,
      workspace_id: null,
      actor_membership_id: null,
      actor_launch_role: null,
      actor_role_binding_id: null,
      actor_layer: "system",
      actor_auth_identity_id: ACTOR_A_OWNER,
      correlation_id: "t038-run-main",
      entity_id: requested.job.id,
    });
    expect((releasedAudit[0].metadata as Record<string, unknown>).tenantId).toBe(TENANT_A);

    const replayed = await runWithTenantContext(ownerSessionA(), "tenant-operations:tenant-export.request:2", () =>
      service().requestExport({ ...input, correlationId: "t038-request-replay" }));
    expect(replayed.code).toBe("OK_EXPORT_REQUESTED");
    expect(replayed.replayed).toBe(true);
    expect(replayed.job.id).toBe(requested.job.id);

    await expect(
      runWithTenantContext(ownerSessionA(), "tenant-operations:tenant-export.request:3", () =>
        service().requestExport({ ...input, format: "csv", correlationId: "t038-request-conflict" })),
    ).rejects.toMatchObject({ code: "BLOCKED_REPLAY_CONFLICT" });
  });

  it("marks runner failures, requeues with retry facts, and reruns to released", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-fail", correlationId: "t038-request-fail" });
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestExport(input));

    const boom = new Error("pipeline blew up");
    await expect(
      runWithTenantContext(ownerSessionA(), "ambient", () =>
        service({ execute: boom }).runExport({
          tenantId: TENANT_A,
          jobId: requested.job.id,
          executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
          correlationId: "t038-run-fail",
        })),
    ).rejects.toMatchObject({ code: "FAILED_INTERNAL" });

    const failedJob = (await jobRows()).find((row) => row.id === requested.job.id);
    expect(failedJob).toMatchObject({ status: "failed", error_code: "EXPORT_UNKNOWN_FAILURE" });
    expect((await auditRows()).some((row) => row.action === "tenant.export.failed"
      && row.entity_id === requested.job.id && row.actor_layer === "system")).toBe(true);

    const requeued = await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().requeueExport({
        tenantId: TENANT_A,
        jobId: requested.job.id,
        actor: { authIdentityId: ACTOR_A_ADMIN, layer: "member", membershipId: MEMBER_A_ADMIN },
        correlationId: "t038-requeue",
      }));
    expect(requeued.code).toBe("OK_EXPORT_RUNNING");
    expect(requeued.job.status).toBe("retry_wait");
    expect(requeued.job.retryCount).toBe(1);
    expect(requeued.job.nextRetryAt).not.toBeNull();

    const requeueAudit = (await auditRows()).filter((row) => row.action === "tenant.export.requeued");
    expect(requeueAudit).toHaveLength(1);
    expect(requeueAudit[0]).toMatchObject({
      scope_kind: "tenant",
      actor_membership_id: MEMBER_A_ADMIN,
      actor_launch_role: "admin",
      actor_layer: "member",
      correlation_id: "t038-requeue",
    });

    const reran = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().runExport({
        tenantId: TENANT_A,
        jobId: requested.job.id,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t038-rerun",
      }));
    expect(reran.code).toBe("OK_EXPORT_COMPLETED");
    expect(reran.job.status).toBe("released");
    expect(reran.job.retryCount).toBe(1);
  });

  it("cancels a requested job and refuses a second transition", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-cancel", correlationId: "t038-request-cancel" });
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestExport(input));

    const canceled = await runWithTenantContext(adminSessionA(), "ambient", () =>
      service().cancelExport({
        tenantId: TENANT_A,
        jobId: requested.job.id,
        actor: { authIdentityId: ACTOR_A_ADMIN, layer: "member", membershipId: MEMBER_A_ADMIN },
        correlationId: "t038-cancel",
      }));
    expect(canceled.code).toBe("OK_EXPORT_CANCELED");
    expect(canceled.job.status).toBe("canceled");

    const job = (await jobRows()).find((row) => row.id === requested.job.id);
    expect(job).toMatchObject({ status: "canceled", error_code: "EXPORT_CANCELED" });
    expect((await auditRows()).some((row) => row.action === "tenant.export.canceled"
      && row.entity_id === requested.job.id && row.actor_membership_id === MEMBER_A_ADMIN)).toBe(true);

    await expect(
      runWithTenantContext(adminSessionA(), "ambient", () =>
        service().cancelExport({
          tenantId: TENANT_A,
          jobId: requested.job.id,
          actor: { authIdentityId: ACTOR_A_ADMIN, layer: "member", membershipId: MEMBER_A_ADMIN },
          correlationId: "t038-cancel-again",
        })),
    ).rejects.toMatchObject({ code: "BLOCKED_STATE_CONFLICT" });
  });

  it("sweeps released→expired then expired→deleted across passes", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-sweep", correlationId: "t038-request-sweep" });
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestExport(input));

    const purge = vi.fn(async () => {});
    await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service({ execute: artifactFacts(TENANT_A, requested.job.id, 60), purge }).runExport({
        tenantId: TENANT_A,
        jobId: requested.job.id,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t038-run-sweep",
      }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const first = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service({ purge }).sweepExportRetention({
        tenantId: TENANT_A,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t038-sweep-1",
      }));
    expect(first.code).toBe("OK_EXPORT_SWEPT");
    expect(first.expiredJobIds).toEqual([requested.job.id]);
    expect(first.deletedJobIds).toEqual([]);
    expect(purge).not.toHaveBeenCalled();

    const second = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service({ purge }).sweepExportRetention({
        tenantId: TENANT_A,
        executor: { authIdentityId: ACTOR_A_OWNER, layer: "system" },
        correlationId: "t038-sweep-2",
      }));
    expect(second.expiredJobIds).toEqual([]);
    expect(second.deletedJobIds).toEqual([requested.job.id]);
    expect(purge).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));

    const job = (await jobRows()).find((row) => row.id === requested.job.id);
    expect(job).toMatchObject({ status: "deleted" });
    const sweepAudits = (await auditRows()).filter((row) =>
      (row.action === "tenant.export.expired" || row.action === "tenant.export.deleted")
      && row.entity_id === requested.job.id);
    expect(sweepAudits).toHaveLength(2);
    expect(sweepAudits.every((row) => row.scope_kind === "platform" && row.actor_layer === "system")).toBe(true);
  });

  it("scopes reads and mutations to the accepted tenant slice", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-scope", correlationId: "t038-request-scope" });
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestExport(input));

    // A researcher member cannot request — the member-select policy hides
    // their own row from an owner/admin-gated read, so the service fails
    // closed before reaching the write path (non-enumerating).
    await expect(
      runWithTenantContext(researcherSessionA(), "ambient", () =>
        service().requestExport(requestInput({
          idempotencyKey: "t038-req-researcher",
          correlationId: "t038-request-researcher",
          requester: { authIdentityId: ACTOR_A_RESEARCHER, membershipId: MEMBER_A_RESEARCHER },
        }))),
    ).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });

    // Tenant B's owner cannot reach tenant A's job — the member-RLS read
    // hides it and the canonical failure is non-enumerating.
    await expect(
      runWithTenantContext(ownerSessionB(), "ambient", () =>
        service().cancelExport({
          tenantId: TENANT_B,
          jobId: requested.job.id,
          actor: { authIdentityId: ACTOR_B_OWNER, layer: "member", membershipId: MEMBER_B_OWNER },
          correlationId: "t038-cancel-cross",
        })),
    ).rejects.toMatchObject({ code: "NOT_FOUND_NON_ENUMERATING" });

    // Tenant A cannot read tenant B's jobs through the scoped RLS lane.
    expect(await jobRows(TENANT_B)).toHaveLength(0);
  });

  it("keeps the direct-EXECUTE boundary honest", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-direct", correlationId: "t038-request-direct" });
    const requested = await runWithTenantContext(ownerSessionA(), "ambient", () =>
      service().requestExport(input));

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
        await tx.unsafe("SELECT set_config('app.correlation_id', 't038-direct', true)");
        return callback(tx as unknown as Sql);
      });
    }

    // A tenant-B context cannot transition tenant A's job.
    const foreign = await withMemberGucs(ownerSessionB(), async (tx) =>
      tx.unsafe<{ outcome: string }[]>(
        `SELECT outcome FROM public.novatrade_export_transition($1)`,
        [JSON.stringify({ jobId: requested.job.id, tenantId: TENANT_B, edge: "cancel", expectedStatus: "requested", errorMessage: "nope" })],
      )) as { outcome: string }[];
    expect(foreign[0].outcome).toBe("not_found");

    // A bogus edge refuses lexically under a valid context.
    const invalid = await withMemberGucs(ownerSessionA(), async (tx) =>
      tx.unsafe<{ outcome: string }[]>(
        `SELECT outcome FROM public.novatrade_export_transition($1)`,
        [JSON.stringify({ jobId: requested.job.id, tenantId: TENANT_A, edge: "teleport" })],
      )) as { outcome: string }[];
    expect(invalid[0].outcome).toBe("invalid_request");

    // No member context: the request and audit lanes refuse.
    const noCtx = await runtime.unsafe<{ applied: boolean }[]>(
      `SELECT applied FROM public.novatrade_export_request($1)`,
      [JSON.stringify({ jobId: randomUUID(), tenantId: TENANT_A })],
    );
    expect(noCtx[0].applied).toBe(false);
    const noCtxAudit = await runtime.unsafe<{ applied: boolean }[]>(
      `SELECT applied FROM public.novatrade_export_audit_append($1)`,
      [JSON.stringify({ eventType: "tenant.export.canceled", tenantId: TENANT_A, jobId: requested.job.id })],
    );
    expect(noCtxAudit[0].applied).toBe(false);

    // A request naming a different requester membership refuses.
    const forged = await withMemberGucs(ownerSessionA(), async (tx) =>
      tx.unsafe<{ applied: boolean }[]>(
        `SELECT applied FROM public.novatrade_export_request($1)`,
        [JSON.stringify({
          jobId: randomUUID(), tenantId: TENANT_A, workspaceId: null,
          requesterAuthIdentityId: ACTOR_A_OWNER,
          requesterMembershipId: MEMBER_A_ADMIN,
          supportAccessGrantId: null,
          scopeHash: "a".repeat(64), inputHash: "b".repeat(64),
          idempotencyKeyHash: "c".repeat(64), policyVersion: "tenant-policy-v1",
          manifestVersion: "d014-v1", schemaVersion: "tenant-export-job-v1",
          requestedFormat: "json", correlationId: "t038-forged",
          auditEventId: randomUUID(),
        })],
      )) as { applied: boolean }[];
    expect(forged[0].applied).toBe(false);
  });

  it("fails closed without a member context and on a suspended tenant", async () => {
    const input = requestInput({ idempotencyKey: "t038-req-closed", correlationId: "t038-request-closed" });

    // No ambient context: the adapter refuses before any SQL.
    await expect(service().requestExport(input)).rejects.toThrow();

    // Suspended tenant: member context cannot be established, so every
    // lane fails closed — reads return nothing and writes refuse.
    await admin.unsafe("UPDATE public.tenants SET status = 'suspended' WHERE id = $1", [TENANT_A]);
    try {
      await expect(
        runWithTenantContext(ownerSessionA(), "ambient", () => service().requestExport(input)),
      ).rejects.toThrow();
    } finally {
      await admin.unsafe("UPDATE public.tenants SET status = 'active' WHERE id = $1", [TENANT_A]);
    }
  });
});
