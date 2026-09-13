import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const surfaceMocks = vi.hoisted(() => ({ loadSurface: vi.fn() }));
const membershipMocks = vi.hoisted(() => ({
  isLocalMembershipMutationAvailable: vi.fn(() => true),
  loadMembershipDirectory: vi.fn(),
}));
const operationsControlsMock = vi.hoisted(() => ({ controls: vi.fn() }));
const lifecycleControlsMock = vi.hoisted(() => ({ controls: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../(protected)/_lib/surface", () => ({
  loadSurface: surfaceMocks.loadSurface,
  SurfaceNotice: (props: { kind: "denied" | "unavailable" | "workspace-required" | "error" }) => {
    const titles = {
      denied: "Not authorized",
      unavailable: "Tenant scope unavailable",
      "workspace-required": "Workspace scope required",
      error: "Surface unavailable",
    } as const;
    return <section data-testid="surface-notice">{titles[props.kind]}</section>;
  },
  PendingSeamNotice: (props: { title: string }) => <div data-testid="pending-seam">{props.title}</div>,
}));
vi.mock("../(protected)/_lib/membership-directory", () => membershipMocks);
vi.mock("../(protected)/tenancy/workspace", () => ({
  TenantLifecycleControls: lifecycleControlsMock.controls.mockImplementation(() => (
    <div data-testid="tenant-lifecycle-controls" />
  )),
}));
vi.mock("@/components/admin/tenant-operations-controls", () => ({
  TenantOperationsControls: operationsControlsMock.controls.mockImplementation(() => (
    <div data-testid="tenant-operations-controls" />
  )),
}));
vi.mock("@/components/admin/local-membership-admin-controls", () => ({
  LocalMembershipAdminControls: () => <div data-testid="membership-admin-controls" />,
}));
vi.mock("@/components/admin/connector-governance-panel", () => ({
  ConnectorGovernancePanel: () => <div data-testid="connector-governance-panel" />,
}));
vi.mock("@/components/admin/tenant-audit-panel", () => ({
  TenantAuditPanel: () => <div data-testid="tenant-audit-panel" />,
}));

// Server-side loaders execute inside loadSurface, which is mocked; stub the
// module surfaces the page imports so module evaluation has no side effects.
vi.mock("@/app/api/_shared/l05-deps", () => ({ connectorDeps: vi.fn() }));
vi.mock("@/lib/connectors/repository", () => ({ createPostgresConnectorAuthorityRepository: vi.fn() }));
vi.mock("@/lib/connectors/service", () => ({ getConnectorGovernanceView: vi.fn() }));
vi.mock("@/lib/tenancy/authorize", () => ({ assertTenantPermission: vi.fn() }));
vi.mock("@/lib/tenancy/lifecycle-snapshot", () => ({
  loadLatestDataLifecycleJobs: vi.fn(),
  loadTenantLifecycleSnapshot: vi.fn(),
}));
vi.mock("@/lib/tenancy/local-lifecycle-operations", () => ({
  createLocalTenantLifecycleOperationsService: vi.fn(),
}));
vi.mock("@/lib/tenancy/local-membership-administration", () => ({
  isLocalMembershipAdministrationAvailable: vi.fn(() => true),
}));
vi.mock("@/lib/tenancy/lifecycle-operations", () => ({
  TenantLifecycleOpsError: class TenantLifecycleOpsError extends Error {},
}));
vi.mock("@/lib/tenancy/local-support-access", () => ({
  createLocalSupportAccessPolicyEvaluator: vi.fn(),
  createLocalSupportAccessRepository: vi.fn(),
  createLocalSupportPrincipalResolver: vi.fn(),
}));
vi.mock("@/lib/tenancy/local-tenant-limits", () => ({ createLocalTenantLimitService: vi.fn() }));
vi.mock("@/lib/tenancy/postgres-deletion-operations", () => ({
  createPostgresDeletionOperationsService: vi.fn(),
}));
vi.mock("@/lib/tenancy/postgres-export-operations", () => ({
  createPostgresExportOperationsService: vi.fn(),
  createPostgresExportRunner: vi.fn(),
}));
vi.mock("@/lib/tenancy/postgres-support-access", () => ({
  createPostgresSupportAccessPolicyEvaluator: vi.fn(),
  createPostgresSupportAccessRepository: vi.fn(),
  createPostgresSupportPrincipalResolver: vi.fn(),
}));
vi.mock("@/lib/tenancy/postgres-tenant-limits", () => ({ createPostgresTenantLimitService: vi.fn() }));
vi.mock("@/lib/tenancy/support-access", () => ({ createSupportAccessService: vi.fn() }));
vi.mock("@/lib/tenancy/queries", () => ({ createTenantQueryRepository: vi.fn() }));

import TenancyPage from "@/app/(protected)/tenancy/page";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000001";
const ROLE_BINDING_ID = "40000000-0000-4000-8000-000000000001";

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

const TENANT = {
  id: TENANT_ID,
  slug: "demo-tenant",
  name: "Local Demo Tenant",
  status: "active",
  locale: "en-US",
  timezone: "UTC",
} as const;

const WORKSPACE = {
  id: "50000000-0000-4000-8000-000000000001",
  tenantId: TENANT_ID,
  slug: "primary",
  name: "Primary",
  status: "active",
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

const SNAPSHOT = {
  tenant: TENANT,
  workspace: null,
  lifecycleVersion: 2,
  reasonCode: "owner_acceptance",
  reason: "Tenant activated when the owner accepted the provisioning invitation.",
  freezeHandoffStatus: "not_started",
  accessRevocationHandoffStatus: "not_started",
  changedAt: "2026-08-02T00:00:00.000Z",
  audit: null,
} as const;

const DIRECTORY = {
  actor: { id: MEMBERSHIP_ID },
  memberships: [{ id: MEMBERSHIP_ID }],
  history: [],
} as const;

const OPERATIONS = {
  lifecycleSnapshot: SNAPSHOT,
  supportGrant: null,
  exportJob: null,
  deletionJob: null,
  policyAuthorizations: { "data:export": true, "data:delete": false },
} as const;

function readyOutcome(overrides: Readonly<{
  role?: string;
  workspaceId?: string | null;
  operations?: typeof OPERATIONS | null;
}> = {}) {
  return {
    state: "ready" as const,
    session: {
      ...TENANT_SESSION,
      role: (overrides.role ?? "owner") as typeof TENANT_SESSION.role,
      workspaceId: overrides.workspaceId === undefined ? null : overrides.workspaceId,
    },
    data: {
      tenant: TENANT,
      workspaces: [WORKSPACE],
      policy: POLICY,
      directory: DIRECTORY,
      directoryFailed: false,
      auditEntries: [],
      governance: null,
      operations: overrides.operations === undefined ? OPERATIONS : overrides.operations,
    },
  };
}

describe("TenancyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    operationsControlsMock.controls.mockClear();
    surfaceMocks.loadSurface.mockResolvedValue(readyOutcome());
  });

  it("renders every tenant-administration section for an owner", async () => {
    const html = renderToStaticMarkup(await TenancyPage());
    for (const section of [
      "Tenant overview",
      "Tenant lifecycle",
      "Members",
      "Tenant policy",
      "Connector governance",
      "Tenant audit",
      "Data lifecycle &amp; support access",
    ]) {
      expect(html).toContain(section);
    }
    expect(html).toContain('data-testid="tenant-operations-controls"');
  });

  it("passes the operations surface and admin mutation flags to the controls", async () => {
    renderToStaticMarkup(await TenancyPage());
    expect(operationsControlsMock.controls).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycleSnapshot: SNAPSHOT,
        lifecycleMutations: true,
        supportMutations: true,
        dataMutations: true,
        supportScope: { tenantId: TENANT_ID, workspaceId: null },
        actorAuthIdentityId: USER_ID,
      }),
      undefined,
    );
  });

  it("renders an empty operations notice when the surface cannot be loaded", async () => {
    surfaceMocks.loadSurface.mockResolvedValue(readyOutcome({ operations: null }));
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain("Operations unavailable");
    expect(html).not.toContain('data-testid="tenant-operations-controls"');
  });

  it("fails closed with Not authorized when the membership permission is denied", async () => {
    surfaceMocks.loadSurface.mockResolvedValue({ state: "failed", kind: "denied" });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain("Not authorized");
    expect(html).not.toContain("Tenant overview");
    expect(operationsControlsMock.controls).not.toHaveBeenCalled();
  });

  it("fails closed when the tenant scope cannot be resolved", async () => {
    surfaceMocks.loadSurface.mockResolvedValue({ state: "failed", kind: "unavailable" });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain("Tenant scope unavailable");
    expect(operationsControlsMock.controls).not.toHaveBeenCalled();
  });

  it("renders the error surface when the load fails", async () => {
    surfaceMocks.loadSurface.mockResolvedValue({ state: "failed", kind: "error" });
    const html = renderToStaticMarkup(await TenancyPage());
    expect(html).toContain("Surface unavailable");
    expect(operationsControlsMock.controls).not.toHaveBeenCalled();
  });
});
