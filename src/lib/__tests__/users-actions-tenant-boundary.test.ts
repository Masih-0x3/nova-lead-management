import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_ID = "20000000-0000-4000-8000-000000000002";
const TARGET_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000002";

const authorizationMocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  requireTenantPermission: vi.fn(),
}));

const contextMocks = vi.hoisted(() => ({
  runWithTenantContext: vi.fn((_session: unknown, _correlationId: unknown, callback: () => unknown) => callback()),
  withTenantDbContext: vi.fn((callback: (db: object) => unknown) => callback({ kind: "scoped-db" })),
}));

const appUserMocks = vi.hoisted(() => ({
  getAppUserByUserId: vi.fn(),
  listAppUsers: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  createAuditLog: vi.fn(),
  ensureDbReady: vi.fn(),
  listLocationMarkets: vi.fn(),
  listUserMarketAccessForUsers: vi.fn(),
  replaceUserMarketAccess: vi.fn(),
}));

const repositoryMocks = vi.hoisted(() => ({
  createTenantQueryRepository: vi.fn(),
  listMemberships: vi.fn(),
}));

const membershipServiceMocks = vi.hoisted(() => ({
  available: vi.fn(),
  createService: vi.fn(),
  removeMember: vi.fn(),
  disableMember: vi.fn(),
  reactivateMember: vi.fn(),
  revokeMember: vi.fn(),
  assignMemberRole: vi.fn(),
}));

const pgMembershipMocks = vi.hoisted(() => ({
  createService: vi.fn(),
  removeMember: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => cacheMocks);
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePermission: authorizationMocks.requirePermission }));
vi.mock("@/lib/db", () => ({ withTenantDbContext: contextMocks.withTenantDbContext }));
vi.mock("@/lib/db/queries", () => queryMocks);
vi.mock("@/lib/tenancy/context", () => ({ runWithTenantContext: contextMocks.runWithTenantContext }));
vi.mock("@/lib/tenancy/queries", () => ({
  createTenantQueryRepository: repositoryMocks.createTenantQueryRepository,
}));
vi.mock("@/lib/tenancy/local-membership-administration", () => ({
  isLocalMembershipAdministrationAvailable: membershipServiceMocks.available,
  createLocalTenantMembershipAdministrationService: membershipServiceMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-membership-administration", () => ({
  createPostgresTenantMembershipAdministrationService: pgMembershipMocks.createService,
}));
vi.mock("@/lib/tenancy/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenancy/authorize")>();
  return { ...actual, requireTenantPermission: authorizationMocks.requireTenantPermission };
});
vi.mock("@/lib/app-users", () => ({
  createAppUserForAuthUser: vi.fn(),
  getAppUserByUserId: appUserMocks.getAppUserByUserId,
  listAppUsers: appUserMocks.listAppUsers,
  updateAppUserRole: vi.fn(),
  updateAppUserStatus: vi.fn(),
  updateAppUserTeam: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: supabaseMocks.createSupabaseAdminClient,
}));

import { removeUserAction } from "@/lib/users/actions";

const TENANT_SESSION = Object.freeze({
  userId: ACTOR_ID,
  email: "owner@example.test",
  displayName: "Owner",
  tenantId: TENANT_A,
  workspaceId: WORKSPACE_A,
  membershipId: "30000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  roleBindingId: "40000000-0000-4000-8000-000000000001",
});

function membership(tenantId = TENANT_A) {
  return {
    id: TARGET_MEMBERSHIP_ID,
    tenantId,
    authIdentityId: TARGET_ID,
    pendingIdentityRefHash: null,
    workspaceId: WORKSPACE_A,
    status: "active" as const,
    invitedByMembershipId: TENANT_SESSION.membershipId,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizationMocks.requirePermission.mockResolvedValue({
    userId: ACTOR_ID,
    email: TENANT_SESSION.email,
    displayName: TENANT_SESSION.displayName,
    role: "admin",
  });
  authorizationMocks.requireTenantPermission.mockResolvedValue(TENANT_SESSION);
  repositoryMocks.createTenantQueryRepository.mockReturnValue({
    listMemberships: repositoryMocks.listMemberships,
  });
  repositoryMocks.listMemberships.mockReset();
  repositoryMocks.listMemberships.mockResolvedValue([membership()]);
  membershipServiceMocks.available.mockReturnValue(true);
  membershipServiceMocks.createService.mockReturnValue({
    removeMember: membershipServiceMocks.removeMember,
    disableMember: membershipServiceMocks.disableMember,
    reactivateMember: membershipServiceMocks.reactivateMember,
    revokeMember: membershipServiceMocks.revokeMember,
    assignMemberRole: membershipServiceMocks.assignMemberRole,
  });
  membershipServiceMocks.removeMember.mockResolvedValue({
    code: "OK",
    tenantId: TENANT_A,
    operation: "remove",
    membership: { membershipId: TARGET_MEMBERSHIP_ID, status: "removed" },
    replacementMembership: null,
  });
});

describe("remove user tenant boundary", () => {
  it("binds canonical membership removal to the exact tenant and never touches global identity records", async () => {
    const selector = { tenantId: TENANT_A, workspaceId: WORKSPACE_A };

    const result = await removeUserAction(TARGET_ID, selector);

    expect(authorizationMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expect(authorizationMocks.requireTenantPermission).toHaveBeenCalledWith(
      selector,
      "membership:manage",
      expect.objectContaining({ action: "users.remove", policyEvaluator: expect.any(Function) }),
    );
    const authorizationOptions = authorizationMocks.requireTenantPermission.mock.calls[0][2];
    const policyContext = {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      membershipId: TENANT_SESSION.membershipId,
      role: TENANT_SESSION.role,
      permission: "membership:manage",
      action: "users.remove",
      resource: null,
    };
    expect(authorizationOptions.policyEvaluator(policyContext)).toEqual({ allowed: true, context: policyContext });
    for (const role of ["researcher", "reviewer", "strategist_manager", "outreach_operator", "analyst_read_only"] as const) {
      const denied = { ...policyContext, role };
      expect(authorizationOptions.policyEvaluator(denied)).toEqual({ allowed: false, context: denied });
    }
    expect(contextMocks.runWithTenantContext).toHaveBeenCalledWith(
      TENANT_SESSION,
      expect.stringMatching(/^user-remove:[0-9a-f-]+$/),
      expect.any(Function),
    );
    expect(contextMocks.withTenantDbContext).toHaveBeenCalledOnce();
    expect(repositoryMocks.createTenantQueryRepository).toHaveBeenCalledWith({ kind: "scoped-db" });
    expect(repositoryMocks.listMemberships).toHaveBeenCalledWith(TENANT_A);
    expect(membershipServiceMocks.removeMember).toHaveBeenCalledWith(TENANT_SESSION, {
      membershipId: TARGET_MEMBERSHIP_ID,
      reasonCode: "membership_remove",
      correlationId: expect.stringMatching(/^user-remove:[0-9a-f-]+$/),
      idempotencyKey: expect.stringMatching(/^user-remove\.[0-9a-f-]+$/),
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/users");
    expect(supabaseMocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(appUserMocks.getAppUserByUserId).not.toHaveBeenCalled();
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("dispatches the canonical mutation to the Postgres membership service when PostgreSQL is configured", async () => {
    membershipServiceMocks.available.mockReturnValue(false);
    pgMembershipMocks.createService.mockReturnValue({ removeMember: pgMembershipMocks.removeMember });
    pgMembershipMocks.removeMember.mockResolvedValue({
      code: "OK",
      tenantId: TENANT_A,
      operation: "remove",
      membership: { membershipId: TARGET_MEMBERSHIP_ID, status: "removed" },
      replacementMembership: null,
    });

    const result = await removeUserAction(TARGET_ID, { tenantId: TENANT_A });

    expect(result).toEqual({ success: true });
    expect(pgMembershipMocks.createService).toHaveBeenCalled();
    expect(membershipServiceMocks.createService).not.toHaveBeenCalled();
    expect(pgMembershipMocks.removeMember).toHaveBeenCalledWith(TENANT_SESSION, {
      membershipId: TARGET_MEMBERSHIP_ID,
      reasonCode: "membership_remove",
      correlationId: expect.stringMatching(/^user-remove:[0-9a-f-]+$/),
      idempotencyKey: expect.stringMatching(/^user-remove\.[0-9a-f-]+$/),
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/users");
  });

  it("collapses canonical service failures to the non-enumerating result", async () => {
    membershipServiceMocks.removeMember.mockRejectedValue(new Error("backend unavailable"));

    const result = await removeUserAction(TARGET_ID, { tenantId: TENANT_A });

    expect(result).toEqual({ error: "User not found or unavailable." });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
    expect(appUserMocks.getAppUserByUserId).not.toHaveBeenCalled();
  });

  it("fails before tenant database access when legacy and tenant identities diverge", async () => {
    authorizationMocks.requireTenantPermission.mockResolvedValueOnce({
      ...TENANT_SESSION,
      userId: "20000000-0000-4000-8000-000000000099",
    });

    await expect(removeUserAction(TARGET_ID, { tenantId: TENANT_A })).rejects.toMatchObject({
      code: "TENANT_SCOPE_MISMATCH",
      status: 403,
    });

    expect(contextMocks.runWithTenantContext).not.toHaveBeenCalled();
    expect(contextMocks.withTenantDbContext).not.toHaveBeenCalled();
    expect(supabaseMocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign membership", [membership(TENANT_B)]],
    ["missing membership", []],
    ["duplicate identity binding", [membership(), membership()]],
    ["foreign workspace", [{ ...membership(), workspaceId: WORKSPACE_B }]],
  ])("uses one non-enumerating result for a %s target", async (_label, memberships) => {
    repositoryMocks.listMemberships.mockResolvedValueOnce(memberships);

    await expect(removeUserAction(TARGET_ID, { tenantId: TENANT_A })).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(supabaseMocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(appUserMocks.getAppUserByUserId).not.toHaveBeenCalled();
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  });
});
