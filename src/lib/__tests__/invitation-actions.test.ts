import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const localMocks = vi.hoisted(() => ({ available: vi.fn() }));
const provisioningMocks = vi.hoisted(() => ({
  createService: vi.fn(),
  localProvisioner: vi.fn(),
  accept: vi.fn(),
}));
const postgresMocks = vi.hoisted(() => ({
  createService: vi.fn(),
  accept: vi.fn(),
}));
const supabaseProvisionerMocks = vi.hoisted(() => ({ create: vi.fn() }));
const appUserMocks = vi.hoisted(() => ({
  getAppUserByUserId: vi.fn(),
  createAppUserForAuthUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => authMocks);
vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/tenancy/local-membership-administration", () => ({
  isLocalMembershipAdministrationAvailable: localMocks.available,
}));
vi.mock("@/lib/tenancy/local-tenant-provisioning", () => ({
  createLocalTenantInvitationService: provisioningMocks.createService,
  createLocalAuthUserProvisioner: provisioningMocks.localProvisioner,
}));
vi.mock("@/lib/tenancy/postgres-tenant-invitation", () => ({
  createPostgresTenantInvitationService: postgresMocks.createService,
}));
vi.mock("@/lib/tenancy/supabase-auth-provisioning", () => ({
  createSupabaseAuthUserProvisioner: supabaseProvisionerMocks.create,
}));
vi.mock("@/lib/app-users", () => appUserMocks);

import { acceptLocalTenantInvitationAction } from "@/lib/tenancy/invitation-actions";
import { TenantInvitationError } from "@/lib/tenancy/provisioning";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const INVITATION_ID = "80000000-0000-4000-8000-000000000001";
const REQUEST_ID = "50000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000002";
const SESSION = { userId: USER_ID, email: "invitee@example.com", displayName: null, role: "researcher" } as const;
const ACCEPTED = {
  resultCode: "INVITATION_ACCEPTED",
  invitationId: INVITATION_ID,
  tenantId: TENANT_ID,
  membershipId: MEMBERSHIP_ID,
  role: "researcher",
  tenantStatus: "active",
  workspaceStatus: null,
  membershipStatus: "active",
  acceptedAt: "2026-10-01T00:00:00.000Z",
  activationState: "active",
  activationBlockers: [],
} as const;

describe("acceptLocalTenantInvitationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    authMocks.getSession.mockResolvedValue(SESSION);
    localMocks.available.mockReturnValue(true);
    dbMocks.getDb.mockResolvedValue({ kind: "local-db" });
    provisioningMocks.localProvisioner.mockReturnValue({ kind: "local-provisioner" });
    provisioningMocks.createService.mockReturnValue({ acceptInvitation: provisioningMocks.accept });
    provisioningMocks.accept.mockResolvedValue(ACCEPTED);
    appUserMocks.getAppUserByUserId.mockResolvedValue(null);
    appUserMocks.createAppUserForAuthUser.mockResolvedValue({ id: "app-user-1" });
  });

  it("accepts with the verified session identity and activates the app profile", async () => {
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result).toEqual({
      ok: true,
      tenantId: TENANT_ID,
      role: "researcher",
      message: "The invitation was accepted and the membership is active.",
    });
    expect(provisioningMocks.accept).toHaveBeenCalledWith(USER_ID, {
      invitationId: INVITATION_ID,
      idempotencyKey: `invitation-accept.${REQUEST_ID}`,
      correlationId: `invitation-accept:${REQUEST_ID}`,
    });
    // The invitee had no persisted app_users row — the acceptance creates an
    // active profile with the compat role for the accepted launch role.
    expect(appUserMocks.createAppUserForAuthUser).toHaveBeenCalledWith({
      userId: USER_ID,
      email: "invitee@example.com",
      displayName: null,
      role: "researcher",
      status: "active",
      createdBy: null,
    });
    expect(provisioningMocks.localProvisioner).toHaveBeenCalled();
    expect(supabaseProvisionerMocks.create).not.toHaveBeenCalled();
  });

  it("maps owner/admin launch roles to the admin compat app role", async () => {
    provisioningMocks.accept.mockResolvedValue({ ...ACCEPTED, role: "admin" });
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result.ok).toBe(true);
    expect(appUserMocks.createAppUserForAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin" }),
    );
  });

  it("never rewrites an existing persisted app_users row", async () => {
    appUserMocks.getAppUserByUserId.mockResolvedValue({ id: "existing", status: "active", role: "admin" });
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result.ok).toBe(true);
    expect(appUserMocks.createAppUserForAuthUser).not.toHaveBeenCalled();
  });

  it("uses the Supabase provisioner when the service role is configured", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    supabaseProvisionerMocks.create.mockReturnValue({ kind: "supabase-provisioner" });
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result.ok).toBe(true);
    expect(supabaseProvisionerMocks.create).toHaveBeenCalled();
    expect(provisioningMocks.localProvisioner).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before any service work", async () => {
    authMocks.getSession.mockResolvedValue(null);
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result).toEqual({
      ok: false,
      code: "NOT_AUTHORIZED",
      message: "An authenticated session is required to accept an invitation.",
    });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
    expect(provisioningMocks.createService).not.toHaveBeenCalled();
  });

  it("rejects invalid input before touching the store", async () => {
    const result = await acceptLocalTenantInvitationAction({ invitationId: "not-a-uuid", requestId: REQUEST_ID });

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: "The invitation request is invalid." });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });

  it("dispatches to the Postgres invitation service and the ensure-active definer when PostgreSQL is configured", async () => {
    localMocks.available.mockReturnValue(false);
    postgresMocks.createService.mockReturnValue({ acceptInvitation: postgresMocks.accept });
    postgresMocks.accept.mockResolvedValue(ACCEPTED);
    const run = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockReturnValue({ run });
    dbMocks.getDb.mockResolvedValue({ prepare });

    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result).toEqual({
      ok: true,
      tenantId: TENANT_ID,
      role: "researcher",
      message: "The invitation was accepted and the membership is active.",
    });
    expect(postgresMocks.createService).toHaveBeenCalledWith(
      expect.objectContaining({ authUserProvisioner: { kind: "local-provisioner" } }),
    );
    expect(provisioningMocks.createService).not.toHaveBeenCalled();
    expect(postgresMocks.accept).toHaveBeenCalledWith(USER_ID, {
      invitationId: INVITATION_ID,
      idempotencyKey: `invitation-accept.${REQUEST_ID}`,
      correlationId: `invitation-accept:${REQUEST_ID}`,
    });
    // The app profile is ensured inside the definer — no direct app_users access.
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining("novatrade_app_user_ensure_active"),
    );
    expect(run).toHaveBeenCalledWith(USER_ID, "invitee@example.com", null, "researcher");
    expect(appUserMocks.getAppUserByUserId).not.toHaveBeenCalled();
    expect(appUserMocks.createAppUserForAuthUser).not.toHaveBeenCalled();
  });

  it.each([
    ["INVITE_NOT_FOUND"],
    ["INVITE_RECIPIENT_MISMATCH"],
    ["INVITE_REVOKED"],
    ["INVITE_EXPIRED"],
    ["INVITE_ALREADY_ACCEPTED"],
    ["TENANT_STATE_BLOCKED"],
    ["PROVISIONING_STATE_BLOCKED"],
  ] as const)("collapses %s to the non-enumerating INVITATION_UNAVAILABLE", async (code) => {
    provisioningMocks.accept.mockRejectedValue(new TenantInvitationError(code, "nope"));
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result).toEqual({
      ok: false,
      code: "INVITATION_UNAVAILABLE",
      message: "The invitation is not available.",
    });
    expect(appUserMocks.createAppUserForAuthUser).not.toHaveBeenCalled();
  });

  it.each([
    ["PROVISIONING_IDEMPOTENCY_CONFLICT", "CONFLICT"],
    ["PROVISIONING_IN_PROGRESS", "CONFLICT"],
    ["PROVISIONING_RETRYABLE", "UNAVAILABLE"],
    ["SERVICE_MISCONFIGURED", "UNAVAILABLE"],
    ["INVALID_INPUT", "INVALID_INPUT"],
  ] as const)("maps %s to %s", async (code, expected) => {
    provisioningMocks.accept.mockRejectedValue(new TenantInvitationError(code, "nope"));
    const result = await acceptLocalTenantInvitationAction({ invitationId: INVITATION_ID, requestId: REQUEST_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(expected);
  });
});
