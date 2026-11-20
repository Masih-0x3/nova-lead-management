import { describe, expect, it } from "vitest";
import { buildAuthCallbackUrl, buildWelcomeInviteUrl, DEV_APP_URL, resolveCanonicalAppUrl } from "@/lib/app-url";

const APP_URL = "https://app.example.com";

describe("app URL helpers", () => {
  it("uses NEXT_PUBLIC_APP_URL before request origin", () => {
    expect(resolveCanonicalAppUrl("http://localhost:3000", {
      NEXT_PUBLIC_APP_URL: `${APP_URL}/`,
      NODE_ENV: "production",
    })).toBe(APP_URL);

    expect(resolveCanonicalAppUrl("https://preview.example", {
      NEXT_PUBLIC_APP_URL: " https://other.example.com ",
      NODE_ENV: "production",
    })).toBe("https://other.example.com");
  });

  it("fails loudly in production when NEXT_PUBLIC_APP_URL is missing", () => {
    expect(() => resolveCanonicalAppUrl("https://preview.example", {
      NEXT_PUBLIC_APP_URL: "",
      NODE_ENV: "production",
    })).toThrow(/NEXT_PUBLIC_APP_URL is required/);
  });

  it("uses request origin outside production, then the localhost default", () => {
    expect(resolveCanonicalAppUrl("http://localhost:3001/", {
      NEXT_PUBLIC_APP_URL: "",
      NODE_ENV: "development",
    })).toBe("http://localhost:3001");

    expect(resolveCanonicalAppUrl(null, {
      NEXT_PUBLIC_APP_URL: "",
      NODE_ENV: "test",
    })).toBe(DEV_APP_URL);
  });

  it("builds encoded Supabase auth callback URLs", () => {
    expect(buildAuthCallbackUrl("/reset-password", APP_URL))
      .toBe(`${APP_URL}/auth/callback?next=%2Freset-password`);
    expect(buildAuthCallbackUrl("/reset-password", "https://example.com"))
      .toBe("https://example.com/auth/callback?next=%2Freset-password");
    expect(buildWelcomeInviteUrl("reset-password", APP_URL))
      .toBe(`${APP_URL}/auth/callback?next=%2Freset-password`);
    expect(buildAuthCallbackUrl("/queue", APP_URL))
      .toBe(`${APP_URL}/auth/callback?next=%2Fqueue`);
  });
});
