import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authMocks = vi.hoisted(() => ({ getTenantSession: vi.fn() }));
const dbMocks = vi.hoisted(() => ({
  withTenantDbContext: vi.fn((fn: (db: unknown) => Promise<unknown>) => fn({ kind: "scoped-db" })),
  withDbStatementTimeout: vi.fn((_timeoutMs: number, fn: () => Promise<unknown>) => fn()),
}));
const contextMocks = vi.hoisted(() => ({
  runWithTenantContext: vi.fn((_session: unknown, _correlationId: unknown, fn: () => unknown) => fn()),
}));
const policyMocks = vi.hoisted(() => ({ gateL05Policy: vi.fn() }));
const queryMocks = vi.hoisted(() => ({
  createTenantQueryRepository: vi.fn(() => ({ getCurrentTenantPolicy: vi.fn(async () => null) })),
}));
const understandingMocks = vi.hoisted(() => ({
  listAuthenticatedUnderstandingVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
  getAuthenticatedQuestionSession: vi.fn(async () => ({ ok: false as const })),
}));
const strategyMocks = vi.hoisted(() => ({
  listAuthenticatedIcpVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
  listAuthenticatedLeadPlayVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
  getAuthenticatedLeadPlayActivation: vi.fn(async () => ({ ok: true as const, value: null })),
}));

vi.mock("@/lib/auth", () => authMocks);
vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/tenancy/context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithTenantContext: contextMocks.runWithTenantContext,
}));
vi.mock("@/app/api/_shared/l05-deps", () => policyMocks);
vi.mock("@/lib/tenancy/queries", () => queryMocks);
vi.mock("@/lib/understanding/authenticated-service", () => understandingMocks);
vi.mock("@/lib/strategy/authenticated-service", () => strategyMocks);

import OnboardingPage from "@/app/(protected)/onboarding/page";

const TENANT_SESSION = {
  userId: "20000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
  displayName: "Owner",
  tenantId: "10000000-0000-4000-8000-000000000001",
  workspaceId: null,
  membershipId: "30000000-0000-4000-8000-000000000001",
  roleBindingId: "40000000-0000-4000-8000-000000000001",
  role: "owner",
} as const;

async function render(step?: string) {
  const searchParams = Promise.resolve<Record<string, string | string[] | undefined>>(
    step === undefined ? {} : { step },
  );
  return renderToStaticMarkup(await OnboardingPage({ searchParams }) as React.ReactElement);
}

describe("service-backed onboarding page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getTenantSession.mockResolvedValue(TENANT_SESSION);
    contextMocks.runWithTenantContext.mockImplementation(
      (_session: unknown, _correlationId: unknown, fn: () => unknown) => fn(),
    );
    dbMocks.withTenantDbContext.mockImplementation(
      (fn: (db: unknown) => Promise<unknown>) => fn({ kind: "scoped-db" }),
    );
    dbMocks.withDbStatementTimeout.mockImplementation(
      (_timeoutMs: number, fn: () => Promise<unknown>) => fn(),
    );
  });

  it("renders the typed unavailable state when no tenant session resolves", async () => {
    authMocks.getTenantSession.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Tenant scope unavailable");
  });

  it("renders the resolved tenant scope on the scope step", async () => {
    const html = await render();
    expect(html).toContain("Resolved tenant scope");
    expect(html).toContain(TENANT_SESSION.tenantId);
    expect(html).toContain(TENANT_SESSION.membershipId);
    expect(html).toContain("owner");
    expect(html).toContain("Tenant-wide");
    expect(html).toContain('href="/onboarding?step=policy"');
  });

  it("renders the pending material-registry seam on the materials step", async () => {
    const html = await render("materials");
    expect(html).toContain("Material registry read seam pending");
    expect(html).not.toContain("Choose files");
    expect(html).not.toContain("<input");
  });

  it("derives progress steps from the authenticated service state", async () => {
    const html = await render("progress");
    expect(html).toContain("Source intake");
    expect(html).toContain("Understanding");
    expect(html).toContain("Lead play");
    expect(understandingMocks.listAuthenticatedUnderstandingVersions).toHaveBeenCalled();
    expect(strategyMocks.listAuthenticatedIcpVersions).toHaveBeenCalled();
    expect(strategyMocks.listAuthenticatedLeadPlayVersions).toHaveBeenCalled();
  });

  it("renders a typed failure state on the progress step when service reads fail", async () => {
    understandingMocks.listAuthenticatedUnderstandingVersions.mockResolvedValueOnce(
      { ok: false } as never,
    );
    const html = await render("progress");
    expect(html).toContain("Progress unavailable");
  });

  it("does not claim completion without an active lead play", async () => {
    const html = await render("complete");
    expect(html).toContain("Setup still in progress");
    expect(html).toContain('href="/strategy"');
    expect(html).toContain('href="/review"');
  });
});
