import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { TenantAuthorizationError } from "@/lib/tenancy/authorize";
import { TENANT_POLICY_DEFAULTS } from "@/lib/tenancy/schemas";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const OTHER_WORKSPACE_ID = "20000000-0000-4000-8000-000000000099";

const authorizeMocks = vi.hoisted(() => ({
  requireTenantPermission: vi.fn(),
}));

const contextMocks = vi.hoisted(() => ({
  runWithTenantContext: vi.fn(
    (_session: unknown, _correlationId: unknown, callback: () => unknown) => callback(),
  ),
}));

const dbMocks = vi.hoisted(() => {
  const fakeDb = {
    prepare: () => {
      throw new Error("l05 route tests must not reach the database");
    },
    exec: async () => {},
  };
  return {
    withTenantDbContext: vi.fn(
      async (callback: (db: unknown) => Promise<unknown>) => callback(fakeDb),
    ),
  };
});

const policyMocks = vi.hoisted(() => ({
  getCurrentTenantPolicy: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  createTenantAuditLog: vi.fn(),
}));

const connectorAuthorityMocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listPolicies: vi.fn(),
}));

const contactServiceMocks = vi.hoisted(() => ({
  listContactViews: vi.fn(),
  registerContactRecord: vi.fn(),
  supersedeContactRecord: vi.fn(),
  transitionContactReview: vi.fn(),
  listBuyingCenterViews: vi.fn(),
  registerBuyingCenter: vi.fn(),
  transitionBuyingCenterReviewService: vi.fn(),
}));

const discoveryServiceMocks = vi.hoisted(() => ({
  listDiscoveryPlanViews: vi.fn(),
  createDiscoveryPlanService: vi.fn(),
  listDiscoveryRunViews: vi.fn(),
  createDiscoveryRunService: vi.fn(),
  getDiscoveryRunView: vi.fn(),
  appendDiscoveryBatchService: vi.fn(),
  transitionDiscoveryRunService: vi.fn(),
}));

const accountServiceMocks = vi.hoisted(() => ({
  listAccountPortfolio: vi.fn(),
  registerCanonicalAccount: vi.fn(),
  listAccountResolutionViews: vi.fn(),
  resolveAccountObservationsService: vi.fn(),
  listMergeHistory: vi.fn(),
  applyAccountMergeTransition: vi.fn(),
}));

const reviewServiceMocks = vi.hoisted(() => ({
  enqueueItem: vi.fn(),
  listReviewItemViews: vi.fn(),
  summarizeReviewQueue: vi.fn(),
  transitionItem: vi.fn(),
}));

const connectorServiceMocks = vi.hoisted(() => ({
  describeConnectorRegistryState: vi.fn(),
  createSourceRun: vi.fn(),
  registerFixtureConnectorAccount: vi.fn(),
  getConnectorGovernanceView: vi.fn(),
}));

const qualificationServiceMocks = vi.hoisted(() => ({
  evaluateQualification: vi.fn(),
  listQualificationViews: vi.fn(),
  reviewQualification: vi.fn(),
}));

vi.mock("@/lib/tenancy/authorize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy/authorize")>()),
  requireTenantPermission: authorizeMocks.requireTenantPermission,
}));

vi.mock("@/lib/tenancy/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy/context")>()),
  runWithTenantContext: contextMocks.runWithTenantContext,
}));

vi.mock("@/lib/db", () => dbMocks);

vi.mock("@/lib/db/queries", () => auditMocks);

vi.mock("@/lib/tenancy/queries", () => ({
  createTenantQueryRepository: () => ({
    getCurrentTenantPolicy: policyMocks.getCurrentTenantPolicy,
  }),
}));

vi.mock("@/lib/connectors/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/repository")>()),
  createPostgresConnectorAuthorityRepository: () => connectorAuthorityMocks,
}));

vi.mock("@/lib/contacts/service", () => contactServiceMocks);
vi.mock("@/lib/discovery/service", () => discoveryServiceMocks);
vi.mock("@/lib/discovery/account-service", () => accountServiceMocks);
vi.mock("@/lib/review/service", () => reviewServiceMocks);
vi.mock("@/lib/connectors/service", () => connectorServiceMocks);
vi.mock("@/lib/qualification/service", () => qualificationServiceMocks);

import { GET as contactsGET, POST as contactsPOST } from "@/app/api/contacts/route";
import {
  GET as discoveryPlansGET,
  POST as discoveryPlansPOST,
} from "@/app/api/discovery/plans/route";
import { GET as accountMergesGET, POST as accountMergesPOST } from "@/app/api/accounts/merges/route";
import {
  GET as reviewQueueGET,
  POST as reviewQueuePOST,
} from "@/app/api/qualification/review-queue/route";
import { GET as connectorsGET } from "@/app/api/connectors/route";
import { POST as connectorRunsPOST } from "@/app/api/connectors/runs/route";
import { POST as qualificationReviewPOST } from "@/app/api/qualification/review/route";

type TestRole =
  | "owner"
  | "admin"
  | "strategist_manager"
  | "researcher"
  | "reviewer"
  | "outreach_operator"
  | "analyst_read_only";

function sessionFor(role: TestRole, workspaceId: string | null = WORKSPACE_ID) {
  return {
    userId: "30000000-0000-4000-8000-000000000003",
    email: "user@example.test",
    displayName: "Test User",
    tenantId: TENANT_ID,
    workspaceId,
    membershipId: "40000000-0000-4000-8000-000000000004",
    role,
    roleBindingId: "50000000-0000-4000-8000-000000000005",
  } as const;
}

function tenantPolicy(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...TENANT_POLICY_DEFAULTS,
    id: "60000000-0000-4000-8000-000000000006",
    tenantId: TENANT_ID,
    version: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

function getRequest(path: string): NextRequest {
  return new NextRequest(`https://example.test${path}`);
}

function postRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")).toBe("Cookie");
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("owner"));
  policyMocks.getCurrentTenantPolicy.mockResolvedValue(
    tenantPolicy({
      aiProcessingEnabled: true,
      sourceResearchEnabled: true,
      contactResearchEnabled: true,
      outreachDraftingEnabled: true,
      copyExportEnabled: true,
    }),
  );
  connectorAuthorityMocks.listAccounts.mockResolvedValue([]);
  connectorAuthorityMocks.listPolicies.mockResolvedValue([]);
});

describe("L-05 route authorization boundary", () => {
  it("returns 401 when the session boundary rejects authentication", async () => {
    authorizeMocks.requireTenantPermission.mockRejectedValue(
      new TenantAuthorizationError(401, "AUTH_REQUIRED"),
    );

    const response = await contactsGET(
      getRequest(`/api/contacts?tenantId=${TENANT_ID}&workspaceId=${WORKSPACE_ID}`),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    expectPrivateNoStore(response);
    expect(contactServiceMocks.listContactViews).not.toHaveBeenCalled();
  });

  it("returns 403 when the selector does not resolve to a tenant scope", async () => {
    authorizeMocks.requireTenantPermission.mockRejectedValue(
      new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH"),
    );

    const response = await contactsGET(
      getRequest(`/api/contacts?tenantId=${TENANT_ID}&workspaceId=${WORKSPACE_ID}`),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Tenant scope does not match" });
    expectPrivateNoStore(response);
    expect(contactServiceMocks.listContactViews).not.toHaveBeenCalled();
  });

  it("denies a role whose matrix decision is D before any service call", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("analyst_read_only"));

    const response = await contactsPOST(
      postRequest("/api/contacts", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        identity: { fullName: "Case" },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Permission denied" });
    expectPrivateNoStore(response);
    expect(contactServiceMocks.registerContactRecord).not.toHaveBeenCalled();
  });

  it("denies a C permission when the tenant policy flag is off", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("researcher"));
    policyMocks.getCurrentTenantPolicy.mockResolvedValue(
      tenantPolicy({ contactResearchEnabled: false }),
    );

    const response = await contactsPOST(
      postRequest("/api/contacts", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        identity: { fullName: "Case" },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Policy blocked" });
    expectPrivateNoStore(response);
    expect(contactServiceMocks.registerContactRecord).not.toHaveBeenCalled();
  });

  it("denies a C permission when the tenant policy row is missing", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("researcher"));
    policyMocks.getCurrentTenantPolicy.mockResolvedValue(null);

    const response = await contactsPOST(
      postRequest("/api/contacts", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Policy blocked" });
    expect(contactServiceMocks.registerContactRecord).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before resolving the session", async () => {
    const response = await contactsPOST(postRequest("/api/contacts", "{not-json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "The request body is invalid." });
    expectPrivateNoStore(response);
    expect(authorizeMocks.requireTenantPermission).not.toHaveBeenCalled();
  });
});

describe("L-05 route dispatch", () => {
  it("lists contacts for an A-permission role inside the tenant context", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("analyst_read_only"));
    contactServiceMocks.listContactViews.mockResolvedValue([{ versionId: "v1" }]);

    const response = await contactsGET(
      getRequest(`/api/contacts?tenantId=${TENANT_ID}&workspaceId=${WORKSPACE_ID}`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ contacts: [{ versionId: "v1" }] });
    expectPrivateNoStore(response);
    expect(contactServiceMocks.listContactViews).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("registers a contact for a C-permission role when the policy allows it", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("researcher"));
    contactServiceMocks.registerContactRecord.mockResolvedValue({ versionId: "v1" });

    const response = await contactsPOST(
      postRequest("/api/contacts", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        identity: { fullName: "Case" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ versionId: "v1" });
    expect(contactServiceMocks.registerContactRecord).toHaveBeenCalled();
  });

  it("lists tenant-wide discovery plans without a workspace selector", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("reviewer", null));
    discoveryServiceMocks.listDiscoveryPlanViews.mockResolvedValue([]);

    const response = await discoveryPlansGET(
      getRequest(`/api/discovery/plans?tenantId=${TENANT_ID}`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ plans: [] });
    expect(discoveryServiceMocks.listDiscoveryPlanViews).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT_ID,
      workspaceId: null,
    });
  });

  it("creates a discovery plan for a C-permission role under the default policy gate", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("strategist_manager"));
    discoveryServiceMocks.createDiscoveryPlanService.mockResolvedValue({ planId: "p1" });

    const response = await discoveryPlansPOST(
      postRequest("/api/discovery/plans", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        playId: "play-1",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ planId: "p1" });
    expect(discoveryServiceMocks.createDiscoveryPlanService).toHaveBeenCalled();
  });

  it("blocks discovery plan creation when source research is disabled", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("researcher"));
    policyMocks.getCurrentTenantPolicy.mockResolvedValue(
      tenantPolicy({ sourceResearchEnabled: false }),
    );

    const response = await discoveryPlansPOST(
      postRequest("/api/discovery/plans", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Policy blocked" });
    expect(discoveryServiceMocks.createDiscoveryPlanService).not.toHaveBeenCalled();
  });

  it("returns connector registry state with tenant-scoped account and policy lists", async () => {
    connectorServiceMocks.describeConnectorRegistryState.mockResolvedValue({ connectors: [] });

    const response = await connectorsGET(
      getRequest(`/api/connectors?tenantId=${TENANT_ID}&workspaceId=${WORKSPACE_ID}`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      registry: { connectors: [] },
      accounts: [],
      policies: [],
    });
    expect(connectorAuthorityMocks.listAccounts).toHaveBeenCalledWith(TENANT_ID, WORKSPACE_ID);
    expect(connectorAuthorityMocks.listPolicies).toHaveBeenCalledWith(TENANT_ID, WORKSPACE_ID);
  });

  it("creates a connector run under connector:use when the policy allows it", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("researcher"));
    connectorServiceMocks.createSourceRun.mockResolvedValue({ runId: "r1" });

    const response = await connectorRunsPOST(
      postRequest("/api/connectors/runs", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        connectorKey: "fixture.directory",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runId: "r1" });
    expect(connectorServiceMocks.createSourceRun).toHaveBeenCalled();
  });

  it("lists review queue items for a queue:read role", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("reviewer"));
    reviewServiceMocks.summarizeReviewQueue.mockResolvedValue({ open: 2 });
    reviewServiceMocks.listReviewItemViews.mockResolvedValue([{ itemId: "i1" }]);

    const response = await reviewQueueGET(
      getRequest(
        `/api/qualification/review-queue?tenantId=${TENANT_ID}&workspaceId=${WORKSPACE_ID}&kind=qualification_review&status=open`,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: { open: 2 },
      items: [{ itemId: "i1" }],
    });
    expect(reviewServiceMocks.listReviewItemViews).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID },
      { kind: "qualification_review", status: "open" },
    );
  });

  it("enqueues review items for a queue:operate role", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("strategist_manager"));
    reviewServiceMocks.enqueueItem.mockResolvedValue({ itemId: "i1" });

    const response = await reviewQueuePOST(
      postRequest("/api/qualification/review-queue", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        kind: "qualification_review",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ itemId: "i1" });
    expect(reviewServiceMocks.enqueueItem).toHaveBeenCalled();
    expect(reviewServiceMocks.transitionItem).not.toHaveBeenCalled();
  });

  it("routes itemId payloads to the transition path", async () => {
    authorizeMocks.requireTenantPermission.mockResolvedValue(sessionFor("strategist_manager"));
    reviewServiceMocks.transitionItem.mockResolvedValue({ itemId: "i1" });

    const response = await reviewQueuePOST(
      postRequest("/api/qualification/review-queue", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        itemId: "i1",
        transition: "claim",
      }),
    );

    expect(response.status).toBe(200);
    expect(reviewServiceMocks.transitionItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        itemId: "i1",
        actorId: "30000000-0000-4000-8000-000000000003",
      }),
    );
    expect(reviewServiceMocks.enqueueItem).not.toHaveBeenCalled();
  });
});

describe("L-05 route error mapping", () => {
  it.each([
    ["CONTACT_INPUT_INVALID", 400],
    ["CONTACT_NOT_FOUND", 404],
    ["CONTACT_STALE_VERSION", 409],
    ["CONTACT_SCOPE_MISMATCH", 403],
    ["CONTACT_MALFORMED_INPUT", 400],
  ])("maps service error %s to %i", async (code, status) => {
    contactServiceMocks.registerContactRecord.mockRejectedValue(
      Object.assign(new Error("service failure"), { code }),
    );

    const response = await contactsPOST(
      postRequest("/api/contacts", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: "The request could not be completed.",
    });
    expectPrivateNoStore(response);
  });

  it("maps merge stale-state errors to 409 without leaking record existence", async () => {
    accountServiceMocks.applyAccountMergeTransition.mockRejectedValue(
      Object.assign(new Error("stale"), { code: "ACCOUNT_STALE_STATE" }),
    );

    const response = await accountMergesPOST(
      postRequest("/api/accounts/merges", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        survivorRef: "a",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The request could not be completed.",
    });
  });

  it("maps unexpected failures to 500 with the generic error body", async () => {
    accountServiceMocks.listMergeHistory.mockRejectedValue(new Error("db offline"));

    const response = await accountMergesGET(
      getRequest(`/api/accounts/merges?tenantId=${TENANT_ID}&workspaceId=${WORKSPACE_ID}`),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "The request could not be completed.",
    });
    expectPrivateNoStore(response);
  });

  it("maps review-required service errors to 403", async () => {
    qualificationServiceMocks.reviewQualification.mockRejectedValue(
      Object.assign(new Error("needs human"), { code: "QUALIFICATION_HUMAN_REVIEW_REQUIRED" }),
    );

    const response = await qualificationReviewPOST(
      postRequest("/api/qualification/review", {
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        decision: "confirm",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("denies a workspace selector that disagrees with the resolved session", async () => {
    // The session boundary resolves authority; a mismatched selector means the
    // boundary itself must fail before the handler runs.
    authorizeMocks.requireTenantPermission.mockRejectedValue(
      new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH"),
    );

    const response = await contactsGET(
      getRequest(`/api/contacts?tenantId=${TENANT_ID}&workspaceId=${OTHER_WORKSPACE_ID}`),
    );

    expect(response.status).toBe(403);
    expect(contactServiceMocks.listContactViews).not.toHaveBeenCalled();
  });
});
