import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  isAuthConfigured: vi.fn(),
}));

const headerMocks = vi.hoisted(() => ({
  headers: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`NEXT_REDIRECT:${location}`);
  }),
}));

const operationalLoggingMocks = vi.hoisted(() => ({
  recordOperationalEvent: vi.fn(),
}));

const routeTimingMocks = vi.hoisted(() => ({
  logRouteTiming: vi.fn(),
  startRouteTiming: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

const appUrlMocks = vi.hoisted(() => ({
  resolveCanonicalAppUrl: vi.fn(),
}));

vi.mock("@/lib/app-url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-url")>();
  appUrlMocks.resolveCanonicalAppUrl.mockImplementation(actual.resolveCanonicalAppUrl);
  return { ...actual, resolveCanonicalAppUrl: appUrlMocks.resolveCanonicalAppUrl };
});
vi.mock("@/lib/auth", () => authMocks);
vi.mock("next/headers", () => headerMocks);
vi.mock("next/navigation", () => navigationMocks);
vi.mock("@/lib/operational-logging", () => operationalLoggingMocks);
vi.mock("@/lib/route-timing", () => routeTimingMocks);
vi.mock("@/lib/supabase/server", () => supabaseMocks);
vi.mock("@/app/forgot-password/forgot-password-form", () => ({
  ForgotPasswordForm: ({
    initialErrorMessage,
    initialSent,
  }: {
    initialErrorMessage?: string | null;
    initialSent?: boolean;
  }) => initialErrorMessage ?? (initialSent ? "reset-request-sent" : null),
}));

import { requestPasswordResetAction } from "@/app/forgot-password/actions";
import ForgotPasswordPage from "@/app/forgot-password/page";

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.isAuthConfigured.mockResolvedValue(true);
  headerMocks.headers.mockResolvedValue({ get: () => "https://app.example.test" });
  operationalLoggingMocks.recordOperationalEvent.mockResolvedValue(undefined);
  routeTimingMocks.startRouteTiming.mockReturnValue(routeTimingMocks.logRouteTiming);
  supabaseMocks.createSupabaseServerClient.mockResolvedValue({
    auth: { resetPasswordForEmail: supabaseMocks.resetPasswordForEmail },
  });
});

describe("forgot-password error handling", () => {
  it("keeps a credential-bearing Supabase reset error out of the redirect", async () => {
    const diagnostic = "provider failed with service_role=secret-sentinel";
    supabaseMocks.resetPasswordForEmail.mockResolvedValue({ error: { message: diagnostic } });
    const formData = new FormData();
    formData.set("email", "user@example.com");

    await expect(requestPasswordResetAction(formData)).rejects.toThrow("NEXT_REDIRECT");

    expect(navigationMocks.redirect).toHaveBeenCalledWith("/forgot-password?error=reset_failed");
    expect(JSON.stringify(navigationMocks.redirect.mock.calls)).not.toContain("secret-sentinel");
    expect(operationalLoggingMocks.recordOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ error: diagnostic }),
      }),
    );
  });

  it("redirects to the configuration error when the app URL cannot be resolved", async () => {
    appUrlMocks.resolveCanonicalAppUrl.mockImplementationOnce(() => {
      throw new Error("NEXT_PUBLIC_APP_URL is required in production to build auth links.");
    });
    const formData = new FormData();
    formData.set("email", "user@example.com");

    await expect(requestPasswordResetAction(formData)).rejects.toThrow("NEXT_REDIRECT");

    expect(navigationMocks.redirect).toHaveBeenCalledWith("/forgot-password?error=missing_origin");
    expect(supabaseMocks.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(operationalLoggingMocks.recordOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth_password_reset_request_failed",
        metadata: expect.objectContaining({ reason: "missing_app_url" }),
      }),
    );
  });

  it("does not render arbitrary forgot-password error query content", async () => {
    const diagnostic = "provider failed with service_role=secret-sentinel";

    const node = await ForgotPasswordPage({
      searchParams: Promise.resolve({ error: diagnostic }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);

    expect(html).not.toContain(diagnostic);
    expect(html).not.toContain("secret-sentinel");
  });

  it("renders a generic retry message for the stable reset failure code", async () => {
    const node = await ForgotPasswordPage({
      searchParams: Promise.resolve({ error: "reset_failed" }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);

    expect(html).toContain("Password reset could not be requested. Please try again.");
  });

  it.each([
    ["missing_config", "Supabase Auth is not configured."],
    ["invalid_email", "Enter a valid email address."],
    ["missing_origin", "Password reset links need a configured app URL. Ask an admin to check NEXT_PUBLIC_APP_URL in Vercel."],
    ["expired_link", "That account link is expired or was already used. Request a fresh reset link and open only the newest email."],
  ])("preserves the %s public error message", async (error, expectedMessage) => {
    const node = await ForgotPasswordPage({
      searchParams: Promise.resolve({ error }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);

    expect(html).toContain(expectedMessage);
  });

  it("preserves the successful reset-request state", async () => {
    const node = await ForgotPasswordPage({
      searchParams: Promise.resolve({ sent: "1" }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);

    expect(html).toContain("reset-request-sent");
  });
});
