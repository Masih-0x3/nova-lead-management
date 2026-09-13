import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ getTenantSession: vi.fn() }));
const dbIndexMocks = vi.hoisted(() => ({
  withDbStatementTimeout: vi.fn((_timeoutMs: number, fn: () => Promise<unknown>) => fn()),
  withTenantDbContext: vi.fn((fn: (db: unknown) => Promise<unknown>) => fn({ kind: "scoped-db" })),
}));
const authorizationMocks = vi.hoisted(() => ({ assertTenantPermission: vi.fn() }));
const tenantContextMocks = vi.hoisted(() => ({
  getTenantContext: vi.fn(() => null),
  runWithTenantContext: vi.fn((_session: unknown, _correlationId: unknown, fn: () => unknown) => fn()),
}));
const snapshotMocks = vi.hoisted(() => ({
  loadTenantLifecycleSnapshot: vi.fn(),
  loadLatestDataLifecycleJobs: vi.fn(),
}));
const supportMocks = vi.hoisted(() => ({
  repository: vi.fn(),
  resolver: vi.fn(),
  policy: vi.fn(),
  createService: vi.fn(),
  listHistory: vi.fn(),
}));
const queryMocks = vi.hoisted(() => ({
  createRepository: vi.fn(),
  getCurrentTenantPolicy: vi.fn(),
}));
const lifecycleLocalMocks = vi.hoisted(() => ({ createService: vi.fn(() => ({ kind: "lifecycle-service" })) }));
const limitMocks = vi.hoisted(() => ({ createService: vi.fn(() => ({ kind: "limit-service" })) }));

vi.mock("@/lib/auth", () => authMocks);
vi.mock("@/lib/db/index", () => dbIndexMocks);
vi.mock("@/lib/tenancy/authorize", () => authorizationMocks);
vi.mock("@/lib/tenancy/context", () => tenantContextMocks);
vi.mock("@/lib/tenancy/lifecycle-snapshot", () => snapshotMocks);
vi.mock("@/lib/tenancy/local-support-access", () => ({
  createLocalSupportAccessRepository: supportMocks.repository,
  createLocalSupportPrincipalResolver: supportMocks.resolver,
  createLocalSupportAccessPolicyEvaluator: supportMocks.policy,
}));
vi.mock("@/lib/tenancy/support-access", () => ({
  createSupportAccessService: supportMocks.createService,
}));
vi.mock("@/lib/tenancy/queries", () => ({
  createTenantQueryRepository: queryMocks.createRepository,
}));
vi.mock("@/lib/tenancy/local-lifecycle-operations", () => ({
  createLocalTenantLifecycleOperationsService: lifecycleLocalMocks.createService,
}));
vi.mock("@/lib/tenancy/local-tenant-limits", () => ({
  createLocalTenantLimitService: limitMocks.createService,
}));
vi.mock("@/lib/tenancy/tenant-operations-actions", () => ({
  requestTenantLifecycleTransitionAction: vi.fn(),
  requestTenantSupportAccessAction: vi.fn(),
  decideTenantSupportAccessAction: vi.fn(),
  requestTenantExportAction: vi.fn(),
  cancelTenantExportAction: vi.fn(),
  retryTenantExportAction: vi.fn(),
  requestTenantDeletionAction: vi.fn(),
  verifyTenantDeletionAction: vi.fn(),
  approveTenantDeletionAction: vi.fn(),
  cancelTenantDeletionAction: vi.fn(),
  retryTenantDeletionAction: vi.fn(),
}));

import TenancyPage from "@/app/(protected)/tenancy/page";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const GRANT_ID = "60000000-0000-4000-8000-000000000001";
const SUPPORT_ACTOR_ID = "70000000-0000-4000-8000-000000000001";

const TENANT_SESSION = {
  userId: USER_ID,
  email: "owner@example.com",
  displayName: null,
  tenantId: TENANT_ID,
  workspaceId: null,
  membershipId: MEMBERSHIP_ID,
  roleBindingId: ROLE_BINDING_ID,
  role: "owner",
} as const;

const SNAPSHOT = {
  tenant: {
    id: TENANT_ID,
    slug: "ops-tenant",
    name: "Ops Tenant",
    status: "active",
    locale: "en-US",
    timezone: "UTC",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
  workspace: null,
  lifecycleVersion: 2,
  reasonCode: "owner_acceptance",
  reason: "Tenant activated when the owner accepted the provisioning invitation.",
  freezeHandoffStatus: "not_started",
  accessRevocationHandoffStatus: "not_started",
  changedAt: "2026-08-02T00:00:00.000Z",
  audit: {
    state: "recorded",
    tenantId: TENANT_ID,
    workspaceId: null,
    lifecycleVersion: 2,
    eventId: "90000000-0000-4000-8000-000000000001",
    actorId: USER_ID,
    fromStatus: "suspended",
    toStatus: "active",
    recordedAt: "2026-08-02T00:00:00.000Z",
  },
} as const;

const GRANT = {
  id: GRANT_ID,
  tenantId: TENANT_ID,
  workspaceId: null,
  supportActorAuthIdentityId: SUPPORT_ACTOR_ID,
  platformRole: "platform_support",
  requestedByAuthIdentityId: USER_ID,
  approvedByAuthIdentityId: null,
  approvedAt: null,
  revokedByAuthIdentityId: null,
  revokedAt: null,
  state: "pending",
  reasonCode: "incident.review",
  reason: "Investigate a stuck pipeline.",
  startsAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2999-01-01T00:00:00.000Z",
  correlationId: "corr-page-test-1",
  auditEventId: "90000000-0000-4000-8000-000000000009",
  permissions: ["tenant:read"],
  dataClasses: ["tenant_metadata"],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as const;

const POLICY = {
  id: "80000000-0000-4000-8000-000000000001",
  tenantId: TENANT_ID,
  version: 1,
  locale: "en-US",
  timezone: "UTC",
  exportRetentionDays: 7,
  operationalLogRetentionDays: 30,
  rawSourceRetentionDays: 180,
  contactFreshnessDays: 180,
  primaryDeleteWithinDays: 30,
  backupExpireWithinDays: 35,
  tombstoneRetentionYears: 7,
  activeMaterialsMode: "while_authorized_until_superseded_policy_or_deletion",
  aiProcessingEnabled: false,
  sourceResearchEnabled: false,
  contactResearchEnabled: false,
  outreachDraftingEnabled: false,
  copyExportEnabled: false,
  autonomousSendEnabled: false,
  requireSourcePlanApproval: true,
  requireKnowledgeReview: true,
  requireIcpReview: true,
  requireLeadPlayReview: true,
  requireContactReview: true,
  requireOutreachReview: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as const;

describe("TenancyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    authMocks.getTenantSession.mockResolvedValue(TENANT_SESSION);
    authorizationMocks.assertTenantPermission.mockResolvedValue(TENANT_SESSION);
    snapshotMocks.loadTenantLifecycleSnapshot.mockResolvedValue(SNAPSHOT);
    snapshotMocks.loadLatestDataLifecycleJobs.mockResolvedValue({ exportJob: null, deletionJob: null });
    queryMocks.createRepository.mockReturnValue({ getCurrentTenantPolicy: queryMocks.getCurrentTenantPolicy });
    queryMocks.getCurrentTenantPolicy.mockResolvedValue(POLICY);
    supportMocks.createService.mockReturnValue({ listHistory: supportMocks.listHistory });
    supportMocks.listHistory.mockResolvedValue({ ok: true, code: "OK_SUPPORT_AUTHORIZED", grants: [GRANT] });
  });

  it("renders the lifecycle panel and latest support grant for an owner", async () => {
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-tenant-lifecycle-state="ready"');
    expect(html).toContain('data-surface="tenant-lifecycle-panel"');
    expect(html).toContain('data-support-access-state="ready"');
    expect(html).toContain('data-lifecycle-state="ready"');
    expect(html).toContain("Request tenant suspension");
    expect(html).toContain("Request tenant archive");
    expect(html).toContain("Request export");
    expect(html).toContain("Approve grant");
    expect(snapshotMocks.loadTenantLifecycleSnapshot).toHaveBeenCalledWith({ kind: "scoped-db" }, TENANT_ID);
    expect(snapshotMocks.loadLatestDataLifecycleJobs).toHaveBeenCalledWith(
      { kind: "scoped-db" }, TENANT_ID, { kind: "lifecycle-service" },
    );
  });

  it("fails closed when no tenant session resolves", async () => {
    authMocks.getTenantSession.mockResolvedValue(null);
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-tenancy-state="tenant_scope_unavailable"');
    expect(html).not.toContain('data-surface="tenant-lifecycle-panel"');
  });

  it("fails closed for workspace-scoped sessions", async () => {
    authMocks.getTenantSession.mockResolvedValue({ ...TENANT_SESSION, workspaceId: GRANT_ID });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-tenancy-state="tenant_scope_unavailable"');
  });

  it("fails closed when the read permission is denied", async () => {
    authorizationMocks.assertTenantPermission.mockRejectedValue(new Error("denied"));
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-tenancy-state="tenant_scope_unavailable"');
  });

  it("renders read-only for non-admin roles without loading support grants", async () => {
    authMocks.getTenantSession.mockResolvedValue({ ...TENANT_SESSION, role: "researcher" });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-tenant-lifecycle-state="ready"');
    expect(html).not.toContain("Request tenant suspension");
    expect(html).not.toContain('data-support-access-state="ready"');
    expect(html).not.toContain('data-lifecycle-state="ready"');
    expect(supportMocks.listHistory).not.toHaveBeenCalled();
    expect(snapshotMocks.loadLatestDataLifecycleJobs).not.toHaveBeenCalled();
    expect(queryMocks.getCurrentTenantPolicy).not.toHaveBeenCalled();
  });

  it("hides data-lifecycle mutations when the policy cannot be verified", async () => {
    queryMocks.getCurrentTenantPolicy.mockResolvedValue(null);
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain("Data lifecycle unavailable");
    expect(html).not.toContain("Request export");
  });

  it("exposes deletion request only once the tenant is archived", async () => {
    snapshotMocks.loadTenantLifecycleSnapshot.mockResolvedValue({
      ...SNAPSHOT,
      tenant: { ...SNAPSHOT.tenant, status: "archived" },
      audit: { ...SNAPSHOT.audit, fromStatus: "suspended", toStatus: "archived" },
    });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain("Request deletion");
    expect(html).not.toContain("Request tenant suspension");
  });

  it("renders the empty grant state when none is recorded", async () => {
    supportMocks.listHistory.mockResolvedValue({ ok: true, code: "OK_SUPPORT_AUTHORIZED", grants: [] });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-support-access-state="empty"');
    expect(html).toContain("Request support access");
  });

  it("fails closed when the snapshot load throws", async () => {
    snapshotMocks.loadTenantLifecycleSnapshot.mockRejectedValue(new Error("db"));
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain('data-tenancy-state="operations_load_error"');
  });
});
