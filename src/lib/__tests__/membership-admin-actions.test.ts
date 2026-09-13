import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ requireTenantSession: vi.fn() }));
const dbMocks = vi.hoisted(() => ({
  withTenantDbContext: vi.fn((fn: (db: unknown) => Promise<unknown>) => fn({ kind: "tenant-db" })),
}));
const contextMocks = vi.hoisted(() => ({
  runWithTenantContext: vi.fn((_session: unknown, _correlationId: unknown, fn: () => unknown) => fn()),
}));
const localMocks = vi.hoisted(() => ({
  available: vi.fn(),
  createService: vi.fn(),
  hashIdentity: vi.fn(),
  invite: vi.fn(),
  assignRole: vi.fn(),
  disable: vi.fn(),
  reactivate: vi.fn(),
  revoke: vi.fn(),
  remove: vi.fn(),
}));
const invitationMocks = vi.hoisted(() => ({
  createService: vi.fn(),
  deliveryAdapter: vi.fn(),
  issue: vi.fn(),
}));
const limitMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgMembershipMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgInvitationMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const pgLimitMocks = vi.hoisted(() => ({ createService: vi.fn() }));
const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  ...authMocks,
  TenantSessionUnauthenticatedError: class extends Error {},
  TenantSessionUnavailableError: class extends Error {},
}));
vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/tenancy/context", () => ({
  ...contextMocks,
  TenantContextError: class extends Error {},
}));
vi.mock("@/lib/tenancy/local-membership-administration", () => ({
  isLocalMembershipAdministrationAvailable: localMocks.available,
  createLocalTenantMembershipAdministrationService: localMocks.createService,
  hashLocalAuthIdentitySelector: localMocks.hashIdentity,
}));
vi.mock("@/lib/tenancy/local-tenant-provisioning", () => ({
  createLocalTenantInvitationService: invitationMocks.createService,
  createLocalInvitationDeliveryAdapter: invitationMocks.deliveryAdapter,
}));
vi.mock("@/lib/tenancy/local-tenant-limits", () => ({
  createLocalTenantLimitService: limitMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-membership-administration", () => ({
  createPostgresTenantMembershipAdministrationService: pgMembershipMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-tenant-invitation", () => ({
  createPostgresTenantInvitationService: pgInvitationMocks.createService,
}));
vi.mock("@/lib/tenancy/postgres-tenant-limits", () => ({
  createPostgresTenantLimitService: pgLimitMocks.createService,
}));
vi.mock("next/cache", () => cacheMocks);

import {
  assignLocalTenantMembershipRoleAction,
  disableLocalTenantMembershipAction,
  inviteLocalTenantMembershipAction,
  reactivateLocalTenantMembershipAction,
  removeLocalTenantMembershipAction,
  revokeLocalTenantMembershipAction,
} from "@/lib/tenancy/membership-admin-actions";
import { MembershipAdministrationError } from "@/lib/tenancy/memberships";
import { TenantInvitationError } from "@/lib/tenancy/provisioning";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const ACTOR_ID = "30000000-0000-4000-8000-000000000001";
const TARGET_ID = "30000000-0000-4000-8000-000000000002";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const REQUEST_ID = "50000000-0000-4000-8000-000000000001";
const SUBJECT_ID = "60000000-0000-4000-8000-000000000001";
const SESSION = {
  userId: USER_ID,
  email: "owner@example.com",
  displayName: null,
  tenantId: TENANT_ID,
  workspaceId: null,
  membershipId: ACTOR_ID,
  roleBindingId: ROLE_BINDING_ID,
  role: "owner",
} as const;
const INVITED = { tenantId: TENANT_ID, membershipId: TARGET_ID, status: "pending", role: "researcher", workspaceId: null } as const;
const UPDATED = { ...INVITED, status: "active", role: "reviewer" } as const;
const INVITATION_ID = "80000000-0000-4000-8000-000000000001";
const ISSUED = {
  resultCode: "INVITATION_ISSUED",
  invitationId: INVITATION_ID,
  tenantId: TENANT_ID,
  membershipId: TARGET_ID,
  generation: 1,
  expiresAt: "2026-10-01T00:00:00.000Z",
  deliveryState: "delivered",
} as const;
const INVITE_SUCCESS = {
  ok: true,
  membership: INVITED,
  invitationId: INVITATION_ID,
  invitationExpiresAt: ISSUED.expiresAt,
  deliveryState: "delivered",
  message: "Pending membership created and the invitation was issued. Relay the invitation id to the invitee so they can accept.",
} as const;

describe("local canonical membership admin actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.requireTenantSession.mockResolvedValue(SESSION);
    localMocks.available.mockReturnValue(true);
    localMocks.hashIdentity.mockReturnValue("a".repeat(64));
    localMocks.createService.mockReturnValue({
      invitePendingMember: localMocks.invite,
      assignMemberRole: localMocks.assignRole,
      disableMember: localMocks.disable,
      reactivateMember: localMocks.reactivate,
      revokeMember: localMocks.revoke,
      removeMember: localMocks.remove,
    });
    localMocks.invite.mockResolvedValue({ code: "OK", tenantId: TENANT_ID, operation: "invite", membership: INVITED, replacementMembership: null });
    localMocks.assignRole.mockResolvedValue({ code: "OK", tenantId: TENANT_ID, operation: "assign_role", membership: UPDATED, replacementMembership: null });
    localMocks.disable.mockResolvedValue({ code: "OK", tenantId: TENANT_ID, operation: "disable", membership: { ...UPDATED, status: "disabled" }, replacementMembership: null });
    localMocks.reactivate.mockResolvedValue({ code: "OK", tenantId: TENANT_ID, operation: "reactivate", membership: UPDATED, replacementMembership: null });
    localMocks.revoke.mockResolvedValue({ code: "OK", tenantId: TENANT_ID, operation: "revoke", membership: { ...INVITED, status: "revoked" }, replacementMembership: null });
    localMocks.remove.mockResolvedValue({ code: "OK", tenantId: TENANT_ID, operation: "remove", membership: { ...UPDATED, status: "removed" }, replacementMembership: null });
    invitationMocks.deliveryAdapter.mockReturnValue({ adapterId: "local-noop" });
    limitMocks.createService.mockReturnValue({ consume: vi.fn() });
    invitationMocks.createService.mockReturnValue({
      issueMembershipInvitation: invitationMocks.issue,
    });
    invitationMocks.issue.mockResolvedValue(ISSUED);
  });

  it("hashes a verified subject, preserves the client request UUID, and returns explicit pending-only copy", async () => {
    const input = { authSubjectId: SUBJECT_ID, role: "researcher", requestId: REQUEST_ID };
    const first = await inviteLocalTenantMembershipAction(input);
    const replay = await inviteLocalTenantMembershipAction(input);

    expect(first).toEqual(INVITE_SUCCESS);
    expect(replay).toEqual(first);
    expect(localMocks.hashIdentity).toHaveBeenNthCalledWith(1, SUBJECT_ID);
    expect(localMocks.invite).toHaveBeenNthCalledWith(1, SESSION, {
      identitySelectorHash: "a".repeat(64),
      role: "researcher",
      workspaceId: null,
      reasonCode: "invitation",
      correlationId: `membership-invite:${REQUEST_ID}`,
      idempotencyKey: `membership-invite.${REQUEST_ID}`,
    });
    expect(localMocks.invite.mock.calls[1][1]).toEqual(localMocks.invite.mock.calls[0][1]);
    expect(invitationMocks.issue).toHaveBeenNthCalledWith(1, {
      tenantId: TENANT_ID,
      membershipId: TARGET_ID,
      role: "researcher",
      workspaceId: null,
      expectedIdentityRefHash: "a".repeat(64),
      actorMembershipId: ACTOR_ID,
      actorIdentityId: USER_ID,
      idempotencyKey: `membership-invitation-issue.${REQUEST_ID}`,
      correlationId: `membership-invitation-issue:${REQUEST_ID}`,
    });
    expect(invitationMocks.issue.mock.calls[1][0]).toEqual(invitationMocks.issue.mock.calls[0][0]);
    expect(cacheMocks.revalidatePath).toHaveBeenCalledTimes(2);
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/users");
  });

  it("preserves a committed invite success when cache invalidation fails", async () => {
    cacheMocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("cache unavailable after commit");
    });

    const input = { authSubjectId: SUBJECT_ID, role: "researcher", requestId: REQUEST_ID };
    const committed = await inviteLocalTenantMembershipAction(input);
    const replay = await inviteLocalTenantMembershipAction(input);

    expect(committed).toEqual(INVITE_SUCCESS);
    expect(replay).toEqual(INVITE_SUCCESS);
    expect(localMocks.invite).toHaveBeenCalledTimes(2);
    expect(localMocks.invite.mock.calls[1][1]).toEqual(localMocks.invite.mock.calls[0][1]);
  });

  it("assigns only a fixed canonical role through the local adapter", async () => {
    const result = await assignLocalTenantMembershipRoleAction({ membershipId: TARGET_ID, role: "reviewer", requestId: REQUEST_ID });

    expect(result).toEqual({ ok: true, membership: UPDATED, message: "The canonical tenant role was updated locally." });
    expect(localMocks.assignRole).toHaveBeenCalledWith(SESSION, {
      membershipId: TARGET_ID,
      role: "reviewer",
      reasonCode: "role_change",
      correlationId: `membership-role:${REQUEST_ID}`,
      idempotencyKey: `membership-role.${REQUEST_ID}`,
    });

    const invalid = await assignLocalTenantMembershipRoleAction({ membershipId: TARGET_ID, role: "platform_admin", requestId: REQUEST_ID });
    expect(invalid).toEqual({ ok: false, code: "INVALID_INPUT", message: "The membership request is invalid." });
    expect(localMocks.assignRole).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["workspace session", { ...SESSION, workspaceId: "70000000-0000-4000-8000-000000000001" }],
    ["non-admin role", { ...SESSION, role: "researcher" }],
  ])("rejects %s before tenant database context", async (_label, session) => {
    authMocks.requireTenantSession.mockResolvedValue(session);
    const result = await inviteLocalTenantMembershipAction({ authSubjectId: SUBJECT_ID, role: "researcher", requestId: REQUEST_ID });

    expect(result).toEqual({ ok: false, code: "NOT_AUTHORIZED", message: "Membership administration is unavailable for this session." });
    expect(dbMocks.withTenantDbContext).not.toHaveBeenCalled();
    expect(localMocks.createService).not.toHaveBeenCalled();
  });

  it("dispatches the invite to the Postgres membership and invitation services when PostgreSQL is configured", async () => {
    localMocks.available.mockReturnValue(false);
    const pgMembership = {
      invitePendingMember: vi.fn().mockResolvedValue({
        code: "OK", tenantId: TENANT_ID, operation: "invite", membership: INVITED, replacementMembership: null,
      }),
    };
    const pgIssue = vi.fn().mockResolvedValue(ISSUED);
    const pgLimits = { consume: vi.fn() };
    pgMembershipMocks.createService.mockReturnValue(pgMembership);
    pgInvitationMocks.createService.mockReturnValue({ issueMembershipInvitation: pgIssue });
    pgLimitMocks.createService.mockReturnValue(pgLimits);

    const result = await inviteLocalTenantMembershipAction({ authSubjectId: SUBJECT_ID, role: "researcher", requestId: REQUEST_ID });

    expect(result).toEqual(INVITE_SUCCESS);
    expect(pgMembershipMocks.createService).toHaveBeenCalled();
    expect(localMocks.createService).not.toHaveBeenCalled();
    expect(pgMembership.invitePendingMember).toHaveBeenCalledWith(SESSION, {
      identitySelectorHash: "a".repeat(64),
      role: "researcher",
      workspaceId: null,
      reasonCode: "invitation",
      correlationId: `membership-invite:${REQUEST_ID}`,
      idempotencyKey: `membership-invite.${REQUEST_ID}`,
    });
    expect(pgInvitationMocks.createService).toHaveBeenCalledWith(
      expect.objectContaining({ limits: pgLimits }),
    );
    expect(invitationMocks.createService).not.toHaveBeenCalled();
    expect(pgIssue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, membershipId: TARGET_ID }),
    );
  });

  it("normalizes missing and foreign target failures to the same non-enumerating result", async () => {
    localMocks.assignRole.mockRejectedValue(new MembershipAdministrationError("TARGET_NOT_FOUND_OR_FORBIDDEN"));
    const missing = await assignLocalTenantMembershipRoleAction({ membershipId: TARGET_ID, role: "reviewer", requestId: REQUEST_ID });
    const foreign = await assignLocalTenantMembershipRoleAction({ membershipId: TARGET_ID, role: "reviewer", requestId: REQUEST_ID });

    const safe = { ok: false, code: "MEMBERSHIP_UNAVAILABLE", message: "The membership is unavailable." };
    expect(missing).toEqual(safe);
    expect(foreign).toEqual(safe);
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("issues the durable invitation only after the pending membership commits", async () => {
    const input = { authSubjectId: SUBJECT_ID, role: "researcher", requestId: REQUEST_ID };
    await inviteLocalTenantMembershipAction(input);

    expect(localMocks.invite).toHaveBeenCalledTimes(1);
    expect(invitationMocks.createService).toHaveBeenCalledTimes(1);
    expect(limitMocks.createService).toHaveBeenCalledTimes(1);
    expect(invitationMocks.issue).toHaveBeenCalledTimes(1);
    expect(
      localMocks.invite.mock.invocationCallOrder[0],
    ).toBeLessThan(invitationMocks.issue.mock.invocationCallOrder[0]);
  });

  it.each([
    ["INVITE_NOT_FOUND", "MEMBERSHIP_UNAVAILABLE"],
    ["TENANT_STATE_BLOCKED", "MEMBERSHIP_UNAVAILABLE"],
    ["PROVISIONING_STATE_BLOCKED", "MEMBERSHIP_UNAVAILABLE"],
    ["INVITATION_NOT_AUTHORIZED", "NOT_AUTHORIZED"],
    ["PROVISIONING_IDEMPOTENCY_CONFLICT", "CONFLICT"],
    ["PROVISIONING_RETRYABLE", "UNAVAILABLE"],
    ["SERVICE_MISCONFIGURED", "UNAVAILABLE"],
  ] as const)("maps invitation issue failure %s to %s", async (code, expected) => {
    invitationMocks.issue.mockRejectedValue(new TenantInvitationError(code, "failed"));
    const result = await inviteLocalTenantMembershipAction({ authSubjectId: SUBJECT_ID, role: "researcher", requestId: REQUEST_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(expected);
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["disable", disableLocalTenantMembershipAction, localMocks.disable, "membership_disable", "The member was suspended.", "disabled"],
    ["reactivate", reactivateLocalTenantMembershipAction, localMocks.reactivate, "membership_reactivate", "The member was reactivated.", "active"],
    ["revoke", revokeLocalTenantMembershipAction, localMocks.revoke, "membership_revoke", "The pending membership was revoked.", "revoked"],
    ["remove", removeLocalTenantMembershipAction, localMocks.remove, "membership_remove", "The member was removed.", "removed"],
  ] as const)("runs the %s state transition with a caller-bound idempotency key", async (operation, action, serviceMock, reasonCode, message, status) => {
    const input = { membershipId: TARGET_ID, requestId: REQUEST_ID };
    const first = await action(input);
    const replay = await action(input);

    expect(first).toEqual({ ok: true, membership: expect.objectContaining({ membershipId: TARGET_ID, status }), message });
    expect(replay).toEqual(first);
    expect(serviceMock).toHaveBeenCalledTimes(2);
    expect(serviceMock).toHaveBeenNthCalledWith(1, SESSION, {
      membershipId: TARGET_ID,
      reasonCode,
      correlationId: `membership-${operation}:${REQUEST_ID}`,
      idempotencyKey: `membership-${operation}.${REQUEST_ID}`,
    });
    expect(serviceMock.mock.calls[1][1]).toEqual(serviceMock.mock.calls[0][1]);
    expect(contextMocks.runWithTenantContext).toHaveBeenCalledWith(
      SESSION,
      `membership-admin:${operation}:${REQUEST_ID}`,
      expect.any(Function),
    );
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/users");
  });

  it("forwards an owner replacement membership id on owner transitions", async () => {
    const replacementId = "30000000-0000-4000-8000-0000000000ff";
    const result = await removeLocalTenantMembershipAction({
      membershipId: TARGET_ID,
      replacementOwnerMembershipId: replacementId,
      requestId: REQUEST_ID,
    });

    expect(result.ok).toBe(true);
    expect(localMocks.remove).toHaveBeenCalledWith(SESSION, expect.objectContaining({
      membershipId: TARGET_ID,
      replacementOwnerMembershipId: replacementId,
    }));
  });

  it.each([
    ["malformed membership id", { membershipId: "not-a-uuid", requestId: REQUEST_ID }],
    ["malformed request id", { membershipId: TARGET_ID, requestId: "nope" }],
    ["unknown field", { membershipId: TARGET_ID, requestId: REQUEST_ID, extra: true }],
    ["malformed replacement", { membershipId: TARGET_ID, replacementOwnerMembershipId: "x", requestId: REQUEST_ID }],
  ])("rejects %s before tenant database context", async (_label, input) => {
    const result = await disableLocalTenantMembershipAction(input);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: "The membership request is invalid." });
    expect(dbMocks.withTenantDbContext).not.toHaveBeenCalled();
    expect(localMocks.disable).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace session", { ...SESSION, workspaceId: "70000000-0000-4000-8000-000000000001" }],
    ["non-admin role", { ...SESSION, role: "researcher" }],
  ])("rejects %s on state transitions before tenant database context", async (_label, session) => {
    authMocks.requireTenantSession.mockResolvedValue(session);
    const result = await removeLocalTenantMembershipAction({ membershipId: TARGET_ID, requestId: REQUEST_ID });

    expect(result).toEqual({ ok: false, code: "NOT_AUTHORIZED", message: "Membership administration is unavailable for this session." });
    expect(dbMocks.withTenantDbContext).not.toHaveBeenCalled();
    expect(localMocks.remove).not.toHaveBeenCalled();
  });

  it("dispatches state transitions to the Postgres membership service when PostgreSQL is configured", async () => {
    localMocks.available.mockReturnValue(false);
    const pgDisable = vi.fn().mockResolvedValue({
      code: "OK", tenantId: TENANT_ID, operation: "disable", membership: { ...UPDATED, status: "disabled" }, replacementMembership: null,
    });
    pgMembershipMocks.createService.mockReturnValue({ disableMember: pgDisable });

    const result = await disableLocalTenantMembershipAction({ membershipId: TARGET_ID, requestId: REQUEST_ID });

    expect(result.ok).toBe(true);
    expect(pgMembershipMocks.createService).toHaveBeenCalled();
    expect(localMocks.createService).not.toHaveBeenCalled();
    expect(pgDisable).toHaveBeenCalledWith(SESSION, {
      membershipId: TARGET_ID,
      reasonCode: "membership_disable",
      correlationId: `membership-disable:${REQUEST_ID}`,
      idempotencyKey: `membership-disable.${REQUEST_ID}`,
    });
  });

  it.each([
    ["TARGET_NOT_FOUND_OR_FORBIDDEN", "MEMBERSHIP_UNAVAILABLE"],
    ["PERMISSION_DENIED", "NOT_AUTHORIZED"],
    ["STATE_CONFLICT", "CONFLICT"],
    ["OWNER_GUARD", "CONFLICT"],
    ["IDEMPOTENCY_CONFLICT", "CONFLICT"],
    ["MUTATION_IN_PROGRESS", "CONFLICT"],
    ["TRANSACTION_FAILED", "UNAVAILABLE"],
  ] as const)("maps state-transition failure %s to %s", async (code, expected) => {
    localMocks.disable.mockRejectedValue(new MembershipAdministrationError(code));
    const result = await disableLocalTenantMembershipAction({ membershipId: TARGET_ID, requestId: REQUEST_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(expected);
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });
});
