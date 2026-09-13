import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// getDb() materializes the local SQLite runtime under process.cwd() — point it
// at a temp directory before the module state initializes so this file proves
// the real init path (SCHEMA_SQL + tenancy DDL) and the real transaction
// passthrough used by the action layer.
const tempDir = mkdtempSync(path.join(tmpdir(), "nova-invite-actions-"));
vi.spyOn(process, "cwd").mockReturnValue(tempDir);
vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

const { getDb, withTenantDbContext } = await import("@/lib/db");
const { runWithTenantContext } = await import("@/lib/tenancy/context");
const { createTenantQueryRepository } = await import("@/lib/tenancy/queries");
const { createLocalTenantMembershipAdministrationService, hashLocalAuthIdentitySelector } = await import(
  "@/lib/tenancy/local-membership-administration"
);
const {
  createLocalInvitationDeliveryAdapter,
  createLocalAuthUserProvisioner,
  createLocalTenantInvitationService,
} = await import("@/lib/tenancy/local-tenant-provisioning");
const { createLocalTenantLimitService } = await import("@/lib/tenancy/local-tenant-limits");

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const POLICY_ID = "90000000-0000-4000-8000-000000000001";
const OWNER_ID = "30000000-0000-4000-8000-000000000001";
const OWNER_MEMBERSHIP_ID = "40000000-0000-4000-8000-000000000001";
const OWNER_BINDING_ID = "50000000-0000-4000-8000-000000000001";
const INVITEE_ID = "60000000-0000-4000-8000-000000000001";

const OWNER_SESSION = {
  userId: OWNER_ID,
  email: "owner@example.com",
  displayName: null,
  tenantId: TENANT_ID,
  workspaceId: null,
  membershipId: OWNER_MEMBERSHIP_ID,
  roleBindingId: OWNER_BINDING_ID,
  role: "owner",
} as const;

beforeAll(async () => {
  const db = await getDb();
  const repository = createTenantQueryRepository(db);
  await repository.createTenant({ id: TENANT_ID, slug: "it-tenant", name: "Integration Tenant", status: "active" });
  await repository.createWorkspace(TENANT_ID, { id: WORKSPACE_ID, slug: "ops", name: "Ops", status: "active" });
  await repository.createTenantPolicy(TENANT_ID, { id: POLICY_ID });
  await repository.createMembership(TENANT_ID, {
    id: OWNER_MEMBERSHIP_ID,
    authIdentityId: OWNER_ID,
    workspaceId: null,
    status: "active",
  });
  await repository.createRoleBinding(TENANT_ID, {
    id: OWNER_BINDING_ID,
    membershipId: OWNER_MEMBERSHIP_ID,
    role: "owner",
    reasonCode: "initial_provisioning",
  });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("local invitation action composition on the real db", () => {
  it("invites, issues, delivers, and accepts through the real transaction seam", async () => {
    const identitySelectorHash = hashLocalAuthIdentitySelector(INVITEE_ID);
    const requestId = "70000000-0000-4000-8000-000000000001";

    // The exact composition inviteLocalTenantMembershipAction performs:
    // member context + withTenantDbContext, pending membership, then the
    // durable invitation with delivery + quota consume inside the same
    // transaction boundary (nested withTransaction passes through).
    const composed = await runWithTenantContext(OWNER_SESSION, `it-invite:${requestId}`, () =>
      withTenantDbContext(async (db) => {
        const membershipService = createLocalTenantMembershipAdministrationService(db);
        const membershipResult = await membershipService.invitePendingMember(OWNER_SESSION, {
          identitySelectorHash,
          role: "researcher",
          workspaceId: null,
          reasonCode: "invitation",
          correlationId: `membership-invite:${requestId}`,
          idempotencyKey: `membership-invite.${requestId}`,
        });
        const invitationService = createLocalTenantInvitationService(db, {
          invitationDelivery: createLocalInvitationDeliveryAdapter(),
          limits: createLocalTenantLimitService(db),
        });
        const invitation = await invitationService.issueMembershipInvitation({
          tenantId: TENANT_ID,
          membershipId: membershipResult.membership.membershipId,
          role: "researcher",
          workspaceId: null,
          expectedIdentityRefHash: identitySelectorHash,
          actorMembershipId: OWNER_MEMBERSHIP_ID,
          actorIdentityId: OWNER_ID,
          idempotencyKey: `membership-invitation-issue.${requestId}`,
          correlationId: `membership-invitation-issue:${requestId}`,
        });
        return { membershipResult, invitation };
      }),
    );

    expect(composed.invitation.resultCode).toBe("INVITATION_ISSUED");
    // The journaled result records the committed queued state; post-commit
    // delivery then updates the durable row through the local adapter.
    expect(composed.invitation.deliveryState).toBe("queued");
    const deliveredRow = await (await getDb())
      .prepare("SELECT delivery_state, status FROM tenant_invitations WHERE id = ?")
      .get<{ delivery_state: string; status: string }>(composed.invitation.invitationId);
    expect(deliveredRow).toMatchObject({ delivery_state: "delivered", status: "issued" });
    expect(composed.membershipResult.membership.status).toBe("pending");

    // Acceptance runs outside any tenant context on the raw client — the same
    // construction the accept action uses.
    const db = await getDb();
    const inviteeService = createLocalTenantInvitationService(db, {
      authUserProvisioner: createLocalAuthUserProvisioner(),
    });
    const accepted = await inviteeService.acceptInvitation(INVITEE_ID, {
      invitationId: composed.invitation.invitationId,
      idempotencyKey: `invitation-accept.${requestId}`,
      correlationId: `invitation-accept:${requestId}`,
    });

    expect(accepted.resultCode).toBe("INVITATION_ACCEPTED");
    expect(accepted.membershipStatus).toBe("active");
    expect(accepted.activationState).toBe("active");
    expect(accepted.activationBlockers).toEqual([]);
    expect(accepted.role).toBe("researcher");

    // A wrong-identity acceptance fails closed — the recipient hash is checked
    // before any lifecycle state is disclosed.
    const wrongIdentity = "60000000-0000-4000-8000-0000000000ff";
    await expect(
      inviteeService.acceptInvitation(wrongIdentity, {
        invitationId: composed.invitation.invitationId,
        idempotencyKey: `invitation-accept-wrong.${requestId}`,
        correlationId: `invitation-accept-wrong:${requestId}`,
      }),
    ).rejects.toMatchObject({ code: "INVITE_RECIPIENT_MISMATCH" });
  });
});
