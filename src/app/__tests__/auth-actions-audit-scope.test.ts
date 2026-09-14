import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit-lane regression for the auth audit scope fix: the pre-tenant auth
 * entrypoints must classify every operational event as platform scope so the
 * persistence path uses createPlatformAuditLog (system actor, no uuid FK
 * value) instead of the legacy lane. The sanitize/classify/dispatch pipeline
 * runs for real; only the audit write boundary is mocked.
 */

const queryMocks = vi.hoisted(() => ({
  createAuditLog: vi.fn(),
  createPlatformAuditLog: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`NEXT_REDIRECT:${location}`);
  }),
}));

const headerMocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({
    get: (name: string) => (name === "origin" ? "https://app.nova.test" : null),
  })),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  isAuthConfigured: vi.fn(async () => true),
}));

const supabaseMocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  isSupabaseAuthConfigured: vi.fn(() => true),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(async () => ({})),
  resetPasswordForEmail: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  verifyOtp: vi.fn(),
}));

const timingMocks = vi.hoisted(() => ({
  startRouteTiming: vi.fn(() => () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => navigationMocks);
vi.mock("next/headers", () => headerMocks);
vi.mock("@/lib/auth", () => authMocks);
vi.mock("@/lib/supabase/server", () => supabaseMocks);
vi.mock("@/lib/route-timing", () => timingMocks);
vi.mock("@/lib/db/queries", () => queryMocks);

import { loginAction, logoutAction } from "@/app/login/actions";
import { requestPasswordResetAction } from "@/app/forgot-password/actions";
import { updatePasswordAction } from "@/app/reset-password/actions";
import { confirmRecoveryTokenAction } from "@/app/auth/callback/actions";

const AUTH_USER_ID = "9b1d4f6a-7c2e-4a1b-9d3f-2e5c8a7b6d90";
const AUTH_EMAIL = "researcher@nova.test";

function expectPlatformDispatch(action: string) {
  const call = queryMocks.createPlatformAuditLog.mock.calls.find((entry) => entry[0] === action);
  expect(call, `expected platform audit dispatch for ${action}`).toBeDefined();
  expect(call![4]).toEqual({ scope: "platform", actor: { layer: "system" } });
}

describe("auth actions classify operational events as platform scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMocks.createAuditLog.mockResolvedValue(undefined);
    queryMocks.createPlatformAuditLog.mockResolvedValue(undefined);
    authMocks.isAuthConfigured.mockResolvedValue(true);
    supabaseMocks.isSupabaseAuthConfigured.mockReturnValue(true);
    supabaseMocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithPassword: supabaseMocks.signInWithPassword,
        signOut: supabaseMocks.signOut,
        resetPasswordForEmail: supabaseMocks.resetPasswordForEmail,
        getUser: supabaseMocks.getUser,
        updateUser: supabaseMocks.updateUser,
        verifyOtp: supabaseMocks.verifyOtp,
      },
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("loginAction emits auth_login_succeeded as platform", async () => {
    supabaseMocks.signInWithPassword.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: AUTH_EMAIL } },
      error: null,
    });
    const formData = new FormData();
    formData.set("email", AUTH_EMAIL);
    formData.set("password", "correct-horse-battery-staple");

    await expect(loginAction(formData)).rejects.toThrow("NEXT_REDIRECT:/queue");

    expectPlatformDispatch("auth_login_succeeded");
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
    expect(JSON.stringify(queryMocks.createPlatformAuditLog.mock.calls)).not.toContain(AUTH_USER_ID);
  });

  it("loginAction emits auth_login_failed as platform", async () => {
    supabaseMocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid login credentials" },
    });
    const formData = new FormData();
    formData.set("email", AUTH_EMAIL);
    formData.set("password", "correct-horse-battery-staple");

    await expect(loginAction(formData)).rejects.toThrow("NEXT_REDIRECT:/login?error=invalid_credentials");

    expectPlatformDispatch("auth_login_failed");
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("logoutAction emits auth_logout as platform", async () => {
    authMocks.getSession.mockResolvedValue({
      userId: AUTH_USER_ID,
      email: AUTH_EMAIL,
      displayName: "Researcher",
      role: "researcher",
      status: "active",
    });

    await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT:/login");

    expectPlatformDispatch("auth_logout");
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("requestPasswordResetAction emits reset outcomes as platform", async () => {
    supabaseMocks.resetPasswordForEmail.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("email", AUTH_EMAIL);

    await expect(requestPasswordResetAction(formData)).rejects.toThrow("NEXT_REDIRECT:/forgot-password?sent=1");

    expectPlatformDispatch("auth_password_reset_requested");
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("updatePasswordAction emits auth_password_updated as platform", async () => {
    supabaseMocks.getUser.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: AUTH_EMAIL } },
      error: null,
    });
    supabaseMocks.updateUser.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("password", "new-password-value-1");
    formData.set("confirmPassword", "new-password-value-1");

    await expect(updatePasswordAction(formData)).rejects.toThrow("NEXT_REDIRECT:/login?reset=success");

    expectPlatformDispatch("auth_password_updated");
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("confirmRecoveryTokenAction emits auth_link_verified as platform", async () => {
    supabaseMocks.verifyOtp.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("tokenHash", "token-hash-value-1234567890");
    formData.set("type", "recovery");
    formData.set("next", "/queue");

    await expect(confirmRecoveryTokenAction(formData)).rejects.toThrow("NEXT_REDIRECT:/queue");

    expectPlatformDispatch("auth_link_verified");
    expect(queryMocks.createAuditLog).not.toHaveBeenCalled();
  });
});
