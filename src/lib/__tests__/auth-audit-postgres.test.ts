import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real-Postgres regression for the auth audit boundary (2026-09-14 release
 * defect): pre-tenant auth events must persist as platform-scoped audit rows
 * and must never push a pseudonymous hash into the `actor_user_id` uuid FK.
 *
 * Opt-in: requires NOVA_AUDIT_PG_REHEARSAL=1 and DATABASE_URL pointing at a
 * disposable rehearsal database with the production migration shape applied
 * (auth.users stub + full portable replay). Skipped entirely otherwise, so the
 * default unit lane stays hermetic.
 */

const RUN_PG_REHEARSAL =
  process.env.NOVA_AUDIT_PG_REHEARSAL === "1" && Boolean(process.env.DATABASE_URL?.trim());

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

import { loginAction, logoutAction } from "@/app/login/actions";
import { requestPasswordResetAction } from "@/app/forgot-password/actions";
import { updatePasswordAction } from "@/app/reset-password/actions";
import { confirmRecoveryTokenAction } from "@/app/auth/callback/actions";
import { recordOperationalEvent } from "@/lib/operational-logging";
import { getDb, closeDb } from "@/lib/db/index";
import { runWithTenantContext } from "@/lib/tenancy/context";
import type { TenantSession } from "@/lib/auth";

const AUTH_USER_ID = "9b1d4f6a-7c2e-4a1b-9d3f-2e5c8a7b6d90";
const AUTH_EMAIL = "researcher@nova.test";
const AUTH_PASSWORD = "correct-horse-battery-staple";

interface AuditRow {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  scope_kind: string;
  tenant_id: string | null;
  workspace_id: string | null;
  actor_auth_identity_id: string | null;
  actor_membership_id: string | null;
  actor_role_binding_id: string | null;
  actor_layer: string | null;
  metadata_text: string;
}

async function auditRowsFor(action: string): Promise<AuditRow[]> {
  const db = await getDb();
  return db.prepare(
    `SELECT action, entity_type, entity_id, actor_user_id, actor_email, actor_role,
            scope_kind, tenant_id, workspace_id, actor_auth_identity_id,
            actor_membership_id, actor_role_binding_id, actor_layer, metadata::text AS metadata_text
       FROM audit_logs WHERE action = ? ORDER BY created_at`,
  ).all<AuditRow>(action);
}

function expectPlatformRow(row: AuditRow, action: string) {
  expect(row.action).toBe(action);
  expect(row.scope_kind).toBe("platform");
  expect(row.actor_layer).toBe("system");
  expect(row.actor_user_id).toBeNull();
  expect(row.actor_email).toBeNull();
  expect(row.actor_auth_identity_id).toBeNull();
  expect(row.actor_membership_id).toBeNull();
  expect(row.actor_role_binding_id).toBeNull();
  expect(row.tenant_id).toBeNull();
  expect(row.workspace_id).toBeNull();
}

function expectNoRawSecrets(serialized: string) {
  expect(serialized).not.toContain(AUTH_USER_ID);
  expect(serialized).not.toContain(AUTH_EMAIL);
  expect(serialized).not.toContain(AUTH_PASSWORD);
}

function tenantSession(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: "50000000-0000-4000-8000-000000000001",
    email: "actor@example.com",
    displayName: "Actor",
    tenantId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    membershipId: "20000000-0000-4000-8000-000000000001",
    role: "owner",
    roleBindingId: "30000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

describe.runIf(RUN_PG_REHEARSAL)("auth operational audit on real Postgres", () => {
  beforeAll(async () => {
    const db = await getDb();
    for (const id of [AUTH_USER_ID, "50000000-0000-4000-8000-000000000001"]) {
      await db.prepare("INSERT INTO auth.users (id) VALUES (?) ON CONFLICT (id) DO NOTHING").run(id);
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  afterAll(async () => {
    await closeDb();
  });

  it("persists auth_login_succeeded as a privacy-safe platform audit row", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabaseMocks.signInWithPassword.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: AUTH_EMAIL } },
      error: null,
    });
    const formData = new FormData();
    formData.set("email", AUTH_EMAIL);
    formData.set("password", AUTH_PASSWORD);

    await expect(loginAction(formData)).rejects.toThrow("NEXT_REDIRECT:/queue");

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_login_succeeded");
    expect(rows).toHaveLength(1);
    expectPlatformRow(rows[0]!, "auth_login_succeeded");
    expect(rows[0]!.entity_id).toMatch(/^[0-9a-f]{16}$/);
    const emitted = JSON.stringify(infoSpy.mock.calls);
    expectNoRawSecrets(emitted);
    expectNoRawSecrets(rows[0]!.metadata_text);
    expect(rows[0]!.metadata_text).toContain("platform");
  });

  it("persists auth_login_failed as platform without leaking the credential pair", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabaseMocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid login credentials" },
    });
    const formData = new FormData();
    formData.set("email", AUTH_EMAIL);
    formData.set("password", AUTH_PASSWORD);

    await expect(loginAction(formData)).rejects.toThrow("NEXT_REDIRECT:/login?error=invalid_credentials");

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_login_failed");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((entry) => entry.metadata_text.includes("invalid_credentials"));
    expect(row).toBeDefined();
    expectPlatformRow(row!, "auth_login_failed");
    expectNoRawSecrets(row!.metadata_text);
  });

  it("persists auth_logout as platform with no session identifiers in the row", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    authMocks.getSession.mockResolvedValue({
      userId: AUTH_USER_ID,
      email: AUTH_EMAIL,
      displayName: "Researcher",
      role: "researcher",
      status: "active",
    });

    await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_logout");
    expect(rows).toHaveLength(1);
    expectPlatformRow(rows[0]!, "auth_logout");
    expectNoRawSecrets(rows[0]!.metadata_text);
  });

  it("persists auth_password_reset_requested as platform", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabaseMocks.resetPasswordForEmail.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("email", AUTH_EMAIL);

    await expect(requestPasswordResetAction(formData)).rejects.toThrow("NEXT_REDIRECT:/forgot-password?sent=1");

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_password_reset_requested");
    expect(rows).toHaveLength(1);
    expectPlatformRow(rows[0]!, "auth_password_reset_requested");
    expectNoRawSecrets(rows[0]!.metadata_text);
    expect(rows[0]!.metadata_text).not.toContain("token");
  });

  it("persists auth_password_updated as platform", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabaseMocks.getUser.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: AUTH_EMAIL } },
      error: null,
    });
    supabaseMocks.updateUser.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("password", "new-password-value-1");
    formData.set("confirmPassword", "new-password-value-1");

    await expect(updatePasswordAction(formData)).rejects.toThrow("NEXT_REDIRECT:/login?reset=success");

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_password_updated");
    expect(rows).toHaveLength(1);
    expectPlatformRow(rows[0]!, "auth_password_updated");
    expectNoRawSecrets(rows[0]!.metadata_text);
    expect(rows[0]!.metadata_text).not.toContain("new-password-value-1");
  });

  it("persists auth_link_verified as platform", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabaseMocks.verifyOtp.mockResolvedValue({ error: null });
    const formData = new FormData();
    formData.set("tokenHash", "token-hash-value-1234567890");
    formData.set("type", "recovery");
    formData.set("next", "/queue");

    await expect(confirmRecoveryTokenAction(formData)).rejects.toThrow("NEXT_REDIRECT:/queue");

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_link_verified");
    expect(rows).toHaveLength(1);
    expectPlatformRow(rows[0]!, "auth_link_verified");
    expect(rows[0]!.metadata_text).not.toContain("token-hash-value-1234567890");
  });

  it("still rejects explicit platform scope inside an accepted tenant context", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runWithTenantContext(tenantSession(), "corr-auth-pg-boundary", async () => {
      await expect(
        recordOperationalEvent({
          action: "auth_login_succeeded",
          category: "auth",
          scope: "platform",
          actor: { userId: AUTH_USER_ID, email: AUTH_EMAIL },
        }),
      ).rejects.toMatchObject({ code: "REJECTED_LOG_REDACTION" });
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "operational_event",
      expect.objectContaining({ action: "REJECTED_LOG_REDACTION" }),
    );
    const rows = await auditRowsFor("auth_login_succeeded");
    expect(rows.every((row) => row.tenant_id === null)).toBe(true);
  });

  it("keeps an unscoped actor-bearing event on the legacy lane without pushing a non-uuid actor", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await recordOperationalEvent({
      action: "auth_rehearsal_legacy_actor",
      category: "auth",
      entityType: "auth",
      actor: { userId: AUTH_USER_ID, email: AUTH_EMAIL, role: "researcher" },
      metadata: { reason: "rehearsal" },
    });

    expect(warnSpy).not.toHaveBeenCalledWith(
      "operational_event_persist_failed",
      expect.anything(),
    );
    const rows = await auditRowsFor("auth_rehearsal_legacy_actor");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope_kind).toBe("legacy_unscoped");
    expect(rows[0]!.actor_user_id).toBeNull();
    expect(rows[0]!.actor_email).toBeNull();
    expect(rows[0]!.actor_role).toBe("researcher");
    const emitted = JSON.stringify(infoSpy.mock.calls);
    expectNoRawSecrets(emitted);
    expectNoRawSecrets(rows[0]!.metadata_text);
  });
});
