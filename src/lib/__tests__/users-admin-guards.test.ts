import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
}));

const appUserMocks = vi.hoisted(() => ({
  createAppUserForAuthUser: vi.fn(),
  getAppUserByUserId: vi.fn(),
  listAppUsers: vi.fn(),
  updateAppUserRole: vi.fn(),
  updateAppUserStatus: vi.fn(),
  updateAppUserTeam: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  ensureDbReady: vi.fn(),
  createAuditLog: vi.fn(),
  listLocationMarkets: vi.fn(),
  listUserMarketAccessForUsers: vi.fn(),
  replaceUserMarketAccess: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const supabaseMocks = vi.hoisted(() => ({ createSupabaseAdminClient: vi.fn() }));

const tenancyMocks = vi.hoisted(() => ({
  requireTenantPermission: vi.fn(),
  runWithTenantContext: vi.fn((_session: unknown, _correlationId: unknown, fn: () => unknown) => fn()),
  withTenantDbContext: vi.fn((fn: (db: object) => unknown) => fn({ kind: "scoped-db" })),
  createTenantQueryRepository: vi.fn(),
  listMemberships: vi.fn(),
  available: vi.fn(),
  createService: vi.fn(),
  assignMemberRole: vi.fn(),
  disableMember: vi.fn(),
  reactivateMember: vi.fn(),
  revokeMember: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => cacheMocks);
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePermission: authMocks.requirePermission }));
vi.mock("@/lib/db", () => ({ withTenantDbContext: tenancyMocks.withTenantDbContext }));
vi.mock("@/lib/tenancy/context", () => ({ runWithTenantContext: tenancyMocks.runWithTenantContext }));
vi.mock("@/lib/tenancy/queries", () => ({
  createTenantQueryRepository: tenancyMocks.createTenantQueryRepository,
}));
vi.mock("@/lib/tenancy/local-membership-administration", () => ({
  isLocalMembershipAdministrationAvailable: tenancyMocks.available,
  createLocalTenantMembershipAdministrationService: tenancyMocks.createService,
}));
vi.mock("@/lib/tenancy/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenancy/authorize")>();
  return { ...actual, requireTenantPermission: tenancyMocks.requireTenantPermission };
});
vi.mock("@/lib/app-users", () => ({
  createAppUserForAuthUser: appUserMocks.createAppUserForAuthUser,
  getAppUserByUserId: appUserMocks.getAppUserByUserId,
  listAppUsers: appUserMocks.listAppUsers,
  updateAppUserRole: appUserMocks.updateAppUserRole,
  updateAppUserStatus: appUserMocks.updateAppUserStatus,
  updateAppUserTeam: appUserMocks.updateAppUserTeam,
}));
vi.mock("@/lib/db/queries", () => queryMocks);
vi.mock("@/lib/supabase/admin", () => supabaseMocks);

import {
  createUserAction,
  listUserMarketAccessAction,
  listUsersAction,
  resetUserPasswordAction,
  updateUserMarketAccessAction,
  updateUserRoleAction,
  updateUserStatusAction,
  updateUserTeamAction,
} from "@/lib/users/actions";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_ID = "20000000-0000-4000-8000-000000000002";
const TARGET_MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000002";

const TENANT_SESSION = Object.freeze({
  userId: ACTOR_ID,
  email: "admin@example.com",
  displayName: "Admin",
  tenantId: TENANT_ID,
  workspaceId: null,
  membershipId: "30000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  roleBindingId: "40000000-0000-4000-8000-000000000001",
});

function membership(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TARGET_MEMBERSHIP_ID,
    tenantId: TENANT_ID,
    authIdentityId: TARGET_ID,
    pendingIdentityRefHash: null,
    workspaceId: null,
    status: "active" as const,
    invitedByMembershipId: TENANT_SESSION.membershipId,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.requirePermission.mockResolvedValue({
    userId: ACTOR_ID,
    email: "admin@example.com",
    role: "admin",
  });
  tenancyMocks.requireTenantPermission.mockResolvedValue(TENANT_SESSION);
  tenancyMocks.createTenantQueryRepository.mockReturnValue({
    listMemberships: tenancyMocks.listMemberships,
  });
  tenancyMocks.listMemberships.mockResolvedValue([membership()]);
  tenancyMocks.available.mockReturnValue(true);
  tenancyMocks.createService.mockReturnValue({
    assignMemberRole: tenancyMocks.assignMemberRole,
    disableMember: tenancyMocks.disableMember,
    reactivateMember: tenancyMocks.reactivateMember,
    revokeMember: tenancyMocks.revokeMember,
    removeMember: tenancyMocks.removeMember,
  });
  for (const mock of [
    tenancyMocks.assignMemberRole,
    tenancyMocks.disableMember,
    tenancyMocks.reactivateMember,
    tenancyMocks.revokeMember,
    tenancyMocks.removeMember,
  ]) {
    mock.mockResolvedValue({
      code: "OK",
      tenantId: TENANT_ID,
      operation: "op",
      membership: { membershipId: TARGET_MEMBERSHIP_ID },
      replacementMembership: null,
    });
  }
});

function expectNoGlobalUserSideEffects(): void {
  expectNoGlobalUserWrites();
  expect(queryMocks.ensureDbReady).not.toHaveBeenCalled();
}

function expectNoGlobalUserWrites(): void {
  expectNoGlobalUserWritesExceptRevalidate();
  expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
}

function expectNoGlobalUserWritesExceptRevalidate(): void {
  expect(appUserMocks.createAppUserForAuthUser).not.toHaveBeenCalled();
  expect(appUserMocks.getAppUserByUserId).not.toHaveBeenCalled();
  expect(appUserMocks.listAppUsers).not.toHaveBeenCalled();
  expect(appUserMocks.updateAppUserRole).not.toHaveBeenCalled();
  expect(appUserMocks.updateAppUserStatus).not.toHaveBeenCalled();
  expect(appUserMocks.updateAppUserTeam).not.toHaveBeenCalled();
  expect(queryMocks.replaceUserMarketAccess).not.toHaveBeenCalled();
  expect(queryMocks.listUserMarketAccessForUsers).not.toHaveBeenCalled();
  expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  expect(supabaseMocks.createSupabaseAdminClient).not.toHaveBeenCalled();
}

describe("platform-global user mutation guards", () => {
  it("fails the platform-global user directory read closed", async () => {
    await expect(listUsersAction()).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expectNoGlobalUserSideEffects();
  });

  it.each([
    ["existing-looking targets", ["researcher-1", "researcher-2"]],
    ["empty targets", []],
    ["malformed targets", ["", "  "]],
  ])("fails market-access reads closed for %s", async (_label, userIds) => {
    await expect(listUserMarketAccessAction(userIds)).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expectNoGlobalUserSideEffects();
  });

  it.each([
    ["valid input", { email: "new-user@example.com", displayName: "New User", role: "admin" as const }],
    ["invalid input", { email: "not-an-email", role: "researcher" as const }],
  ])("fails user creation closed for %s before invite or persistence", async (_label, input) => {
    await expect(createUserAction(input)).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expectNoGlobalUserSideEffects();
  });

  it.each([
    ["existing-looking target", "researcher-1"],
    ["unknown target", "missing-user"],
    ["malformed target", ""],
  ])("fails password resets closed for an %s before provider access", async (_label, userId) => {
    await expect(resetUserPasswordAction(userId)).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expectNoGlobalUserSideEffects();
  });

  it.each([
    ["existing target", "researcher-1"],
    ["unknown target", "missing-user"],
  ])("returns one non-enumerating result when an %s has no canonical membership", async (_label, userId) => {
    await expect(updateUserRoleAction(userId, "admin")).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expect(tenancyMocks.requireTenantPermission).toHaveBeenCalledWith(
      {},
      "role:assign",
      expect.objectContaining({ action: "users.role" }),
    );
    expect(tenancyMocks.assignMemberRole).not.toHaveBeenCalled();
    expectNoGlobalUserWrites();
  });

  it("delegates role changes to the canonical membership-role adapter", async () => {
    await expect(updateUserRoleAction(TARGET_ID, "admin")).resolves.toEqual({ success: true });

    expect(tenancyMocks.assignMemberRole).toHaveBeenCalledWith(TENANT_SESSION, {
      membershipId: TARGET_MEMBERSHIP_ID,
      role: "admin",
      reasonCode: "role_change",
      correlationId: expect.stringMatching(/^user-role:[0-9a-f-]+$/),
      idempotencyKey: expect.stringMatching(/^user-role\.[0-9a-f-]+$/),
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/users");
    expectNoGlobalUserWritesExceptRevalidate();
  });

  it("returns one non-enumerating result when a user has no canonical membership for a status change", async () => {
    await expect(updateUserStatusAction("researcher-1", "disabled")).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expect(tenancyMocks.requireTenantPermission).toHaveBeenCalledWith(
      {},
      "membership:manage",
      expect.objectContaining({ action: "users.status" }),
    );
    expect(tenancyMocks.disableMember).not.toHaveBeenCalled();
    expect(tenancyMocks.revokeMember).not.toHaveBeenCalled();
    expectNoGlobalUserWrites();
  });

  it.each([
    ["active", "disabled", "disableMember", "membership_disable"],
    ["pending", "disabled", "revokeMember", "membership_revoke"],
    ["disabled", "active", "reactivateMember", "membership_reactivate"],
  ] as const)("maps a %s membership + %s request to %s", async (membershipStatus, requested, method, reasonCode) => {
    tenancyMocks.listMemberships.mockResolvedValueOnce([membership({ status: membershipStatus })]);

    await expect(updateUserStatusAction(TARGET_ID, requested)).resolves.toEqual({ success: true });

    const serviceMock = tenancyMocks[method];
    expect(serviceMock).toHaveBeenCalledWith(TENANT_SESSION, {
      membershipId: TARGET_MEMBERSHIP_ID,
      reasonCode,
      correlationId: expect.stringMatching(/^user-status:[0-9a-f-]+$/),
      idempotencyKey: expect.stringMatching(/^user-status\.[0-9a-f-]+$/),
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/users");
  });

  it.each([
    ["active", "active"],
    ["disabled", "disabled"],
    ["pending", "active"],
    ["suspended", "active"],
  ] as const)("returns one non-enumerating result for a no-op %s membership + %s request", async (membershipStatus, requested) => {
    tenancyMocks.listMemberships.mockResolvedValueOnce([membership({ status: membershipStatus })]);

    await expect(updateUserStatusAction(TARGET_ID, requested)).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(tenancyMocks.disableMember).not.toHaveBeenCalled();
    expect(tenancyMocks.reactivateMember).not.toHaveBeenCalled();
    expect(tenancyMocks.revokeMember).not.toHaveBeenCalled();
    expectNoGlobalUserWrites();
  });

  it("fails team changes closed before database or provider side effects", async () => {
    await expect(updateUserTeamAction("researcher-1", {
      isTeamLead: true,
      teamLeadUserId: "researcher-2",
      teamLabel: "West",
    })).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expectNoGlobalUserSideEffects();
  });

  it("does not reveal validation differences before a tenant-safe adapter exists", async () => {
    await expect(updateUserRoleAction("missing-user", "not-a-role" as never)).resolves.toEqual({
      error: "User not found or unavailable.",
    });
    await expect(updateUserStatusAction("missing-user", "not-a-status" as never)).resolves.toEqual({
      error: "User not found or unavailable.",
    });
    await expect(updateUserTeamAction("missing-user", { teamLabel: "x".repeat(121) })).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expectNoGlobalUserSideEffects();
  });

  it.each([
    ["existing target", "researcher-1", { marketIds: ["market-1"] }],
    ["unknown target", "missing-user", { marketIds: ["missing-market"] }],
    ["invalid input", "researcher-1", { marketIds: [""] }],
  ])("fails territory changes closed for an %s before global side effects", async (_label, userId, input) => {
    await expect(updateUserMarketAccessAction(userId, input)).resolves.toEqual({
      error: "User not found or unavailable.",
    });

    expect(authMocks.requirePermission).toHaveBeenCalledWith("users:manage");
    expectNoGlobalUserSideEffects();
  });
});
