import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ requireTenantSession: vi.fn() }));
const dbMocks = vi.hoisted(() => ({
  withTenantDbContext: vi.fn((fn: (db: unknown) => Promise<unknown>) => fn({
    prepare: () => ({ get: async () => ({ present: 1 }) }),
  })),
}));
const authorizeMocks = vi.hoisted(() => ({ assertTenantPermission: vi.fn() }));
const contextMocks = vi.hoisted(() => ({
  runWithTenantContext: vi.fn((_session: unknown, _correlationId: unknown, fn: () => unknown) => fn()),
}));
const lifecycleMocks = vi.hoisted(() => ({
  createService: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  archive: vi.fn(),
  requestExport: vi.fn(),
  runExport: vi.fn(),
  cancelExport: vi.fn(),
  requeueExport: vi.fn(),
  requestDeletion: vi.fn(),
  verifyDeletion: vi.fn(),
  approveDeletion: vi.fn(),
  cancelDeletion: vi.fn(),
  requeueDeletion: vi.fn(),
}));
const supportServiceMocks = vi.hoisted(() => ({
  createService: vi.fn(),
  request: vi.fn(),
  approve: vi.fn(),
  revoke: vi.fn(),
}));
const supportLocalMocks = vi.hoisted(() => ({
  repository: vi.fn(),
  resolver: vi.fn(),
  policy: vi.fn(),
}));
const limitMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgLifecycleMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgExportMocks = vi.hoisted(() => ({ createService: vi.fn(), createRunner: vi.fn() }));
const pgDeletionMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgLimitMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgSupportMocks = vi.hoisted(() => ({ repository: vi.fn(), resolver: vi.fn(), policy: vi.fn() }));
const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  ...authMocks,
  TenantSessionUnauthenticatedError: class extends Error {},
  TenantSessionUnavailableError: class extends Error {},
}));
vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/tenancy/authorize", () => ({
  ...authorizeMocks,
  TenantAuthorizationError: class extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
      super(code);
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock("@/lib/tenancy/context", () => ({
  ...contextMocks,
  TenantContextError: class extends Error {},
}));
vi.mock("@/lib/tenancy/local-lifecycle-operations", () => ({
  createLocalTenantLifecycleOperationsService: lifecycleMocks.createService,
}));
vi.mock("@/lib/tenancy/local-tenant-limits", () => ({
  createLocalTenantLimitService: limitMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-lifecycle", () => ({
  createPostgresTenantLifecycleService: pgLifecycleMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-export-operations", () => ({
  createPostgresExportOperationsService: pgExportMocks.createService,
  createPostgresExportRunner: pgExportMocks.createRunner,
}));
vi.mock("@/lib/tenancy/postgres-deletion-operations", () => ({
  createPostgresDeletionOperationsService: pgDeletionMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-tenant-limits", () => ({
  createPostgresTenantLimitService: pgLimitMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-support-access", () => ({
  createPostgresSupportAccessRepository: pgSupportMocks.repository,
  createPostgresSupportPrincipalResolver: pgSupportMocks.resolver,
  createPostgresSupportAccessPolicyEvaluator: pgSupportMocks.policy,
}));
vi.mock("@/lib/tenancy/local-support-access", () => ({
  createLocalSupportAccessRepository: supportLocalMocks.repository,
  createLocalSupportPrincipalResolver: supportLocalMocks.resolver,
  createLocalSupportAccessPolicyEvaluator: supportLocalMocks.policy,
}));
vi.mock("@/lib/tenancy/support-access", () => ({
  createSupportAccessService: supportServiceMocks.createService,
}));
vi.mock("next/cache", () => cacheMocks);

import {
  approveTenantDeletionAction,
  cancelTenantDeletionAction,
  cancelTenantExportAction,
  decideTenantSupportAccessAction,
  requestTenantDeletionAction,
  requestTenantExportAction,
  requestTenantLifecycleTransitionAction,
  requestTenantSupportAccessAction,
  retryTenantDeletionAction,
  retryTenantExportAction,
  verifyTenantDeletionAction,
} from "@/lib/tenancy/tenant-operations-actions";
import { TenantLifecycleOpsError } from "@/lib/tenancy/lifecycle-operations";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const REQUEST_ID = "50000000-0000-4000-8000-000000000001";
const GRANT_ID = "60000000-0000-4000-8000-000000000001";
const JOB_ID = "70000000-0000-4000-8000-000000000001";

const SESSION = {
  userId: USER_ID,
  email: "owner@example.com",
  displayName: null,
  tenantId: TENANT_ID,
  workspaceId: null,
  membershipId: MEMBERSHIP_ID,
  roleBindingId: ROLE_BINDING_ID,
  role: "owner",
} as const;

const SUSPEND_INPUT = {
  toStatus: "suspended",
  expectedCurrentState: "active",
  reasonCode: "operations.freeze",
  reason: "Freeze during incident review.",
  requestId: REQUEST_ID,
} as const;

const SUPPORT_REQUEST_INPUT = {
  supportPrincipalRef: "support-agent",
  reasonCode: "incident.review",
  reason: "Investigate a stuck pipeline.",
  startsAt: "2026-09-12T12:00:00.000Z",
  expiresAt: "2026-09-12T16:00:00.000Z",
  permissions: ["tenant:read"],
  dataClasses: ["tenant_metadata"],
  requestId: REQUEST_ID,
} as const;

describe("tenant operations actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    authMocks.requireTenantSession.mockResolvedValue(SESSION);
    authorizeMocks.assertTenantPermission.mockResolvedValue(SESSION);
    lifecycleMocks.createService.mockReturnValue({
      suspend: lifecycleMocks.suspend,
      resume: lifecycleMocks.resume,
      archive: lifecycleMocks.archive,
      requestExport: lifecycleMocks.requestExport,
      runExport: lifecycleMocks.runExport,
      cancelExport: lifecycleMocks.cancelExport,
      requeueExport: lifecycleMocks.requeueExport,
      requestDeletion: lifecycleMocks.requestDeletion,
      verifyDeletion: lifecycleMocks.verifyDeletion,
      approveDeletion: lifecycleMocks.approveDeletion,
      cancelDeletion: lifecycleMocks.cancelDeletion,
      requeueDeletion: lifecycleMocks.requeueDeletion,
    });
    lifecycleMocks.suspend.mockResolvedValue({ code: "OK_SUSPENDED", tenant: { id: TENANT_ID, status: "suspended" } });
    lifecycleMocks.resume.mockResolvedValue({ code: "OK_RESUMED", tenant: { id: TENANT_ID, status: "active" } });
    lifecycleMocks.archive.mockResolvedValue({ code: "OK_ARCHIVED", tenant: { id: TENANT_ID, status: "archived" } });
    lifecycleMocks.requestExport.mockResolvedValue({ code: "OK_EXPORT_REQUESTED", job: { id: JOB_ID, status: "requested" } });
    lifecycleMocks.runExport.mockResolvedValue({ code: "OK_EXPORT_COMPLETED", job: { id: JOB_ID, status: "completed" } });
    lifecycleMocks.cancelExport.mockResolvedValue({ code: "OK_EXPORT_CANCELED", job: { id: JOB_ID, status: "canceled" } });
    lifecycleMocks.requeueExport.mockResolvedValue({ code: "OK_EXPORT_RUNNING", job: { id: JOB_ID, status: "retry_wait" } });
    lifecycleMocks.requestDeletion.mockResolvedValue({ code: "OK_DELETION_REQUESTED", job: { id: JOB_ID, status: "requested" } });
    lifecycleMocks.verifyDeletion.mockResolvedValue({ code: "OK_DELETION_VERIFIED", job: { id: JOB_ID, status: "verified" } });
    lifecycleMocks.approveDeletion.mockResolvedValue({ code: "OK_DELETION_SCHEDULED", job: { id: JOB_ID, status: "scheduled" } });
    lifecycleMocks.cancelDeletion.mockResolvedValue({ code: "OK_DELETION_CANCELED", job: { id: JOB_ID, status: "canceled" } });
    lifecycleMocks.requeueDeletion.mockResolvedValue({ code: "OK_DELETION_RUNNING", job: { id: JOB_ID, status: "retry_wait" } });
    supportServiceMocks.createService.mockReturnValue({
      request: supportServiceMocks.request,
      approve: supportServiceMocks.approve,
      revoke: supportServiceMocks.revoke,
    });
    supportServiceMocks.request.mockResolvedValue({ ok: true, code: "OK_SUPPORT_GRANT_REQUESTED" });
    supportServiceMocks.approve.mockResolvedValue({ ok: true, code: "OK_SUPPORT_GRANT_APPROVED" });
    supportServiceMocks.revoke.mockResolvedValue({ ok: true, code: "OK_SUPPORT_GRANT_REVOKED" });
  });

  describe("requestTenantLifecycleTransitionAction", () => {
    it("suspends through the canonical service with session-derived scope", async () => {
      const result = await requestTenantLifecycleTransitionAction(SUSPEND_INPUT);
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.suspend).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        expectedCurrentState: "active",
        reasonCode: "operations.freeze",
        reason: "Freeze during incident review.",
        actor: { authIdentityId: USER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
        correlationId: `tenant-lifecycle:suspended:${REQUEST_ID}`,
      }));
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/tenancy");
    });

    it("resumes through the canonical service", async () => {
      const result = await requestTenantLifecycleTransitionAction({
        ...SUSPEND_INPUT,
        toStatus: "active",
        expectedCurrentState: "suspended",
      });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.resume).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        expectedCurrentState: "suspended",
      }));
    });

    it("rejects malformed input before any service call", async () => {
      for (const input of [
        { ...SUSPEND_INPUT, toStatus: "deleted" },
        { ...SUSPEND_INPUT, reasonCode: "INVALID CODE" },
        { ...SUSPEND_INPUT, reason: "" },
        { ...SUSPEND_INPUT, requestId: "not-a-uuid" },
        { ...SUSPEND_INPUT, tenantId: "00000000-0000-4000-8000-000000000099" },
      ]) {
        const result = await requestTenantLifecycleTransitionAction(input);
        expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      }
      expect(lifecycleMocks.suspend).not.toHaveBeenCalled();
      expect(lifecycleMocks.resume).not.toHaveBeenCalled();
    });

    it("rejects non-admin roles and workspace-scoped sessions", async () => {
      authMocks.requireTenantSession.mockResolvedValueOnce({ ...SESSION, role: "researcher" });
      expect(await requestTenantLifecycleTransitionAction(SUSPEND_INPUT))
        .toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
      authMocks.requireTenantSession.mockResolvedValueOnce({ ...SESSION, workspaceId: GRANT_ID });
      expect(await requestTenantLifecycleTransitionAction(SUSPEND_INPUT))
        .toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
      expect(lifecycleMocks.suspend).not.toHaveBeenCalled();
    });

    it("dispatches to the Postgres lifecycle composite when PostgreSQL is configured", async () => {
      vi.stubEnv("DATABASE_URL", "postgres://example.test/db");
      const pgSuspend = vi.fn().mockResolvedValue({ code: "OK_SUSPENDED" });
      pgLifecycleMocks.createService.mockReturnValue({ suspend: pgSuspend });
      pgExportMocks.createService.mockReturnValue({});
      pgDeletionMocks.createService.mockReturnValue({});
      pgLimitMocks.createService.mockReturnValue({ consume: vi.fn() });
      pgExportMocks.createRunner.mockReturnValue({ execute: vi.fn(), purge: vi.fn() });

      const result = await requestTenantLifecycleTransitionAction(SUSPEND_INPUT);

      expect(result).toMatchObject({ ok: true });
      expect(pgLifecycleMocks.createService).toHaveBeenCalled();
      expect(pgExportMocks.createService).toHaveBeenCalledWith(
        expect.objectContaining({ exportRunner: expect.anything(), limits: expect.anything() }),
      );
      expect(pgDeletionMocks.createService).toHaveBeenCalledWith(
        expect.objectContaining({ limits: expect.anything() }),
      );
      expect(lifecycleMocks.createService).not.toHaveBeenCalled();
      expect(pgSuspend).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, expectedCurrentState: "active" }),
      );
      expect(lifecycleMocks.suspend).not.toHaveBeenCalled();
    });

    it("collapses lifecycle service failures non-enumeratingly", async () => {
      lifecycleMocks.suspend.mockRejectedValueOnce(new TenantLifecycleOpsError("NOT_FOUND_NON_ENUMERATING"));
      expect(await requestTenantLifecycleTransitionAction(SUSPEND_INPUT))
        .toMatchObject({ ok: false, code: "OPERATION_UNAVAILABLE" });
      lifecycleMocks.suspend.mockRejectedValueOnce(new TenantLifecycleOpsError("BLOCKED_STATE_CONFLICT"));
      expect(await requestTenantLifecycleTransitionAction(SUSPEND_INPUT))
        .toMatchObject({ ok: false, code: "CONFLICT" });
      lifecycleMocks.suspend.mockRejectedValueOnce(new TenantLifecycleOpsError("BLOCKED_ACTOR_SCOPE"));
      expect(await requestTenantLifecycleTransitionAction(SUSPEND_INPUT))
        .toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
      lifecycleMocks.suspend.mockRejectedValueOnce(new Error("boom"));
      expect(await requestTenantLifecycleTransitionAction(SUSPEND_INPUT))
        .toMatchObject({ ok: false, code: "UNAVAILABLE" });
    });
  });

  describe("requestTenantSupportAccessAction", () => {
    it("requests a grant through the canonical service", async () => {
      const result = await requestTenantSupportAccessAction(SUPPORT_REQUEST_INPUT);
      expect(result.ok).toBe(true);
      expect(supportServiceMocks.request).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        supportPrincipalRef: "support-agent",
        reasonCode: "incident.review",
        startsAt: "2026-09-12T12:00:00.000Z",
        expiresAt: "2026-09-12T16:00:00.000Z",
        permissions: ["tenant:read"],
        dataClasses: ["tenant_metadata"],
        idempotencyKey: `support-grant-request.${REQUEST_ID}`,
      }));
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/tenancy");
    });

    it("rejects malformed input", async () => {
      for (const input of [
        { ...SUPPORT_REQUEST_INPUT, permissions: [] },
        { ...SUPPORT_REQUEST_INPUT, permissions: ["not:a:permission"] },
        { ...SUPPORT_REQUEST_INPUT, dataClasses: [] },
        { ...SUPPORT_REQUEST_INPUT, startsAt: "2026-09-12 12:00:00" },
        { ...SUPPORT_REQUEST_INPUT, reasonCode: "Nope" },
      ]) {
        expect(await requestTenantSupportAccessAction(input))
          .toMatchObject({ ok: false, code: "INVALID_INPUT" });
      }
      expect(supportServiceMocks.request).not.toHaveBeenCalled();
    });

    it("maps support denial codes non-enumeratingly", async () => {
      supportServiceMocks.request.mockResolvedValueOnce({ ok: false, code: "SUPPORT_SELF_ACTION" });
      expect(await requestTenantSupportAccessAction(SUPPORT_REQUEST_INPUT))
        .toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
      supportServiceMocks.request.mockResolvedValueOnce({ ok: false, code: "SUPPORT_NOT_FOUND_OR_FORBIDDEN" });
      expect(await requestTenantSupportAccessAction(SUPPORT_REQUEST_INPUT))
        .toMatchObject({ ok: false, code: "OPERATION_UNAVAILABLE" });
      supportServiceMocks.request.mockResolvedValueOnce({ ok: false, code: "SUPPORT_STATE_CONFLICT" });
      expect(await requestTenantSupportAccessAction(SUPPORT_REQUEST_INPUT))
        .toMatchObject({ ok: false, code: "CONFLICT" });
    });
  });

  describe("decideTenantSupportAccessAction", () => {
    it("approves through the canonical service", async () => {
      const result = await decideTenantSupportAccessAction({ grantId: GRANT_ID, decision: "approve", requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(supportServiceMocks.approve).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        grantId: GRANT_ID,
        idempotencyKey: `support-grant-approve.${REQUEST_ID}`,
      }));
    });

    it("revokes through the canonical service", async () => {
      const result = await decideTenantSupportAccessAction({ grantId: GRANT_ID, decision: "revoke", requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(supportServiceMocks.revoke).toHaveBeenCalledWith(expect.objectContaining({
        grantId: GRANT_ID,
        idempotencyKey: `support-grant-revoke.${REQUEST_ID}`,
      }));
    });

    it("rejects malformed decisions", async () => {
      expect(await decideTenantSupportAccessAction({ grantId: "bad", decision: "approve", requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await decideTenantSupportAccessAction({ grantId: GRANT_ID, decision: "request", requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(supportServiceMocks.approve).not.toHaveBeenCalled();
    });
  });

  describe("archive transition", () => {
    it("archives through the canonical service", async () => {
      const result = await requestTenantLifecycleTransitionAction({
        ...SUSPEND_INPUT,
        toStatus: "archived",
        expectedCurrentState: "suspended",
      });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.archive).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        expectedCurrentState: "suspended",
        actor: { authIdentityId: USER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
        correlationId: `tenant-lifecycle:archived:${REQUEST_ID}`,
      }));
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/tenancy");
    });
  });

  describe("requestTenantExportAction", () => {
    it("requests then executes the export inline with a system executor", async () => {
      const result = await requestTenantExportAction({ requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.requestExport).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        workspaceId: null,
        requester: { authIdentityId: USER_ID, membershipId: MEMBERSHIP_ID },
        idempotencyKey: `tenant-export-request.${REQUEST_ID}`,
        correlationId: `tenant-export:request:${REQUEST_ID}`,
      }));
      expect(lifecycleMocks.runExport).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        executor: { authIdentityId: USER_ID, layer: "system" },
      }));
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/tenancy");
    });

    it("keeps the durable request when inline execution fails non-internally", async () => {
      lifecycleMocks.runExport.mockRejectedValueOnce(new TenantLifecycleOpsError("BLOCKED_STATE_CONFLICT"));
      const result = await requestTenantExportAction({ requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({ message: expect.stringContaining("retry") });
    });

    it("propagates internal execution failures through the error map", async () => {
      lifecycleMocks.runExport.mockRejectedValueOnce(new TenantLifecycleOpsError("FAILED_INTERNAL"));
      expect(await requestTenantExportAction({ requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "OPERATION_UNAVAILABLE" });
    });

    it("rejects malformed input and non-admin sessions before any service call", async () => {
      expect(await requestTenantExportAction({ requestId: "nope" }))
        .toMatchObject({ ok: false, code: "INVALID_INPUT" });
      authMocks.requireTenantSession.mockResolvedValueOnce({ ...SESSION, role: "researcher" });
      expect(await requestTenantExportAction({ requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
      expect(lifecycleMocks.requestExport).not.toHaveBeenCalled();
    });
  });

  describe("cancelTenantExportAction", () => {
    it("cancels as the member actor", async () => {
      const result = await cancelTenantExportAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.cancelExport).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        actor: { authIdentityId: USER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
        correlationId: `tenant-export:cancel:${REQUEST_ID}`,
      }));
    });
  });

  describe("retryTenantExportAction", () => {
    it("requeues then re-executes inline", async () => {
      const result = await retryTenantExportAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.requeueExport).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        actor: { authIdentityId: USER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
        correlationId: `tenant-export:requeue:${REQUEST_ID}`,
      }));
      expect(lifecycleMocks.runExport).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID }));
    });

    it("reports requeue when the retried execution fails again", async () => {
      lifecycleMocks.runExport.mockRejectedValueOnce(new TenantLifecycleOpsError("BLOCKED_STATE_CONFLICT"));
      const result = await retryTenantExportAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({ message: expect.stringContaining("requeued") });
    });
  });

  describe("requestTenantDeletionAction", () => {
    it("records a durable request requiring independent verification", async () => {
      const result = await requestTenantDeletionAction({ requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({ message: expect.stringContaining("Verification") });
      expect(lifecycleMocks.requestDeletion).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        workspaceId: null,
        requester: { authIdentityId: USER_ID, membershipId: MEMBERSHIP_ID },
        idempotencyKey: `tenant-deletion-request.${REQUEST_ID}`,
      }));
    });

    it("maps a lifecycle gate refusal to CONFLICT", async () => {
      lifecycleMocks.requestDeletion.mockRejectedValueOnce(new TenantLifecycleOpsError("BLOCKED_STATE_CONFLICT"));
      expect(await requestTenantDeletionAction({ requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "CONFLICT" });
    });
  });

  describe("verifyTenantDeletionAction", () => {
    it("verifies as an independent member", async () => {
      const result = await verifyTenantDeletionAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.verifyDeletion).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        verifier: { authIdentityId: USER_ID, membershipId: MEMBERSHIP_ID },
        correlationId: `tenant-deletion:verify:${REQUEST_ID}`,
      }));
    });

    it("maps approval-independence refusal to CONFLICT", async () => {
      lifecycleMocks.verifyDeletion.mockRejectedValueOnce(new TenantLifecycleOpsError("BLOCKED_APPROVAL_INDEPENDENCE"));
      expect(await verifyTenantDeletionAction({ jobId: JOB_ID, requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "CONFLICT" });
    });
  });

  describe("approveTenantDeletionAction", () => {
    it("approves through the canonical service", async () => {
      const result = await approveTenantDeletionAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.approveDeletion).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        approver: { authIdentityId: USER_ID, membershipId: MEMBERSHIP_ID },
      }));
    });
  });

  describe("cancelTenantDeletionAction", () => {
    it("cancels as the member actor", async () => {
      const result = await cancelTenantDeletionAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.cancelDeletion).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        actor: { authIdentityId: USER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
      }));
    });
  });

  describe("retryTenantDeletionAction", () => {
    it("requeues as the member executor", async () => {
      const result = await retryTenantDeletionAction({ jobId: JOB_ID, requestId: REQUEST_ID });
      expect(result.ok).toBe(true);
      expect(lifecycleMocks.requeueDeletion).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        executor: { authIdentityId: USER_ID, layer: "member", membershipId: MEMBERSHIP_ID },
        correlationId: `tenant-deletion:requeue:${REQUEST_ID}`,
      }));
    });

    it("rejects malformed job input before any service call", async () => {
      expect(await retryTenantDeletionAction({ jobId: "bad", requestId: REQUEST_ID }))
        .toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(lifecycleMocks.requeueDeletion).not.toHaveBeenCalled();
    });
  });
});
