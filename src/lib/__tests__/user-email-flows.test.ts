import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/lib/users/actions.ts"), "utf8");

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const end = source.indexOf(`export async function ${nextName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("user email flows", () => {
  it("keeps tenant-facing user creation closed before platform invite side effects", () => {
    const body = functionBody("createUserAction", "updateUserRoleAction");

    expect(body).toContain("unavailableUserResult");
    expect(body).not.toContain("inviteUserByEmail");
    expect(body).not.toContain("buildWelcomeInviteUrl");
    expect(body).not.toContain("app_user_welcome_email_sent");
    expect(body).not.toContain("resetPasswordForEmail");
    expect(body).not.toContain("createAppUserForAuthUser");
  });

  it("keeps tenant-facing password reset closed before provider side effects", () => {
    const body = source.slice(source.indexOf("export async function resetUserPasswordAction"));

    expect(body).toContain("unavailableUserResult");
    expect(body).not.toContain("resetPasswordForEmail");
    expect(body).not.toContain("buildPasswordRecoveryUrl");
    expect(body).not.toContain("inviteUserByEmail");
    expect(body).not.toContain("createSupabaseAdminClient");
  });

  it("does not delete platform-global identities from a tenant-scoped removal action", () => {
    const body = functionBody("removeUserAction", "updateUserTeamAction");

    expect(body).toContain('authorizedTenantSession(actor.userId, selector, "membership:manage", "users.remove")');
    expect(body).toContain("resolveCanonicalMembershipTarget");
    expect(body).toContain("removeMember");
    expect(body).toContain("unavailableUserResult");
    expect(body).not.toContain("deleteUser(userId)");
    expect(body).not.toContain("removeAppUser(userId)");
    expect(body).not.toContain("updateAppUserStatus");
    expect(body).not.toContain("app_user_removed");

    // The delegated helpers still bind the actor session to membership:manage
    // and assert tenant resource ownership before any mutation runs.
    expect(source).toContain("requireTenantPermission(selector, permission,");
    expect(source).toContain("assertTenantResourceOwnership");
  });
});
