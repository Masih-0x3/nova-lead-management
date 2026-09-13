import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenancy/membership-admin-actions", () => ({
  inviteLocalTenantMembershipAction: vi.fn(),
  assignLocalTenantMembershipRoleAction: vi.fn(),
  disableLocalTenantMembershipAction: vi.fn(),
  reactivateLocalTenantMembershipAction: vi.fn(),
  revokeLocalTenantMembershipAction: vi.fn(),
  removeLocalTenantMembershipAction: vi.fn(),
}));
vi.mock("@/lib/tenancy/invitation-actions", () => ({
  acceptLocalTenantInvitationAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { LocalMembershipAdminControls } from "@/components/admin/local-membership-admin-controls";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const OWNER = {
  tenantId: TENANT_ID,
  membershipId: "30000000-0000-4000-8000-000000000001",
  status: "active",
  role: "owner",
  workspaceId: null,
} as const;
const MEMBER = {
  tenantId: TENANT_ID,
  membershipId: "30000000-0000-4000-8000-000000000002",
  status: "active",
  role: "researcher",
  workspaceId: null,
} as const;
const HISTORY = [
  { ...OWNER, roleBindings: [{ id: "owner-role", role: "owner", revokedAt: null, reasonCode: "initial_provisioning" }] },
  { ...MEMBER, roleBindings: [{ id: "member-role", role: "researcher", revokedAt: null, reasonCode: "initial_provisioning" }] },
] as const;

describe("LocalMembershipAdminControls", () => {
  it("exposes invite, role, and member-state controls when local canonical mutations are enabled", () => {
    const html = renderToStaticMarkup(
      <LocalMembershipAdminControls actor={OWNER} memberships={[OWNER, MEMBER]} history={HISTORY} mutationsEnabled />,
    );

    expect(html).toContain('data-local-membership-mutations="enabled"');
    expect(html).toMatch(/>Invite member<\/button>/u);
    expect(html).toMatch(/>Change role<\/button>/u);
    expect(html).toMatch(/>Suspend member<\/button>/u);
    expect(html).toMatch(/>Remove member<\/button>/u);
    expect(html).not.toMatch(/<(?:input|select|form)\b/u);
  });

  it("keeps a non-admin actor visibly read-only and renders no mutation buttons", () => {
    const html = renderToStaticMarkup(
      <LocalMembershipAdminControls actor={OWNER} memberships={[OWNER, MEMBER]} history={HISTORY} mutationsEnabled={false} />,
    );

    expect(html).toContain('data-local-membership-mutations="read-only"');
    expect(html).toContain("Membership administration is read-only for this role");
    expect(html).not.toMatch(/>(?:Invite member|Change role|Suspend member|Reactivate member|Revoke invitation|Remove member)<\/button>/u);
    expect(html).not.toMatch(/<(?:input|select|form)\b/u);
  });
});
