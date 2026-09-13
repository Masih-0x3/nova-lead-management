import { randomUUID } from "node:crypto";
import type { Metadata } from "next";

import { TenantOperationsControls } from "@/components/admin/tenant-operations-controls";
import { PageShell } from "@/components/page-shell";
import { getTenantSession } from "@/lib/auth";
import { withDbStatementTimeout, withTenantDbContext, type DbClient } from "@/lib/db/index";
import { startRouteTiming } from "@/lib/route-timing";
import { assertTenantPermission } from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { loadLatestDataLifecycleJobs, loadTenantLifecycleSnapshot } from "@/lib/tenancy/lifecycle-snapshot";
import { createLocalTenantLifecycleOperationsService } from "@/lib/tenancy/local-lifecycle-operations";
import { isLocalMembershipAdministrationAvailable } from "@/lib/tenancy/local-membership-administration";
import { TenantLifecycleOpsError, type TenantDeletionStorePort } from "@/lib/tenancy/lifecycle-operations";
import {
  createLocalSupportAccessPolicyEvaluator,
  createLocalSupportAccessRepository,
  createLocalSupportPrincipalResolver,
} from "@/lib/tenancy/local-support-access";
import { createLocalTenantLimitService } from "@/lib/tenancy/local-tenant-limits";
import {
  createPostgresExportOperationsService,
  createPostgresExportRunner,
} from "@/lib/tenancy/postgres-export-operations";
import { createPostgresDeletionOperationsService } from "@/lib/tenancy/postgres-deletion-operations";
import { createPostgresTenantLimitService } from "@/lib/tenancy/postgres-tenant-limits";
import {
  createPostgresSupportAccessPolicyEvaluator,
  createPostgresSupportAccessRepository,
  createPostgresSupportPrincipalResolver,
} from "@/lib/tenancy/postgres-support-access";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { createSupportAccessService } from "@/lib/tenancy/support-access";
import type { SupportAccessGrant, TenantPolicy } from "@/lib/tenancy/types";
import type { TenantDeletionJobView } from "@/components/admin/data-lifecycle-panel";
import type { TenantLifecycleSnapshot } from "@/components/admin/tenant-lifecycle-panel";
import type { TenantExportJob } from "@/lib/tenancy/types";

export const metadata: Metadata = { title: "Tenant Operations | Nova Trade Lead Management" };

type OperationsSurface = Readonly<{
  lifecycleSnapshot: TenantLifecycleSnapshot | null;
  supportGrant: SupportAccessGrant | null;
  policy: TenantPolicy | null;
  exportJob: TenantExportJob | null;
  deletionJob: TenantDeletionJobView | null;
  policyAuthorizations: Readonly<{ "data:export"?: boolean; "data:delete"?: boolean }>;
}>;

export default async function TenancyPage() {
  const logRouteTiming = startRouteTiming("/tenancy");
  let tenantSession: Awaited<ReturnType<typeof getTenantSession>>;
  try {
    tenantSession = await getTenantSession({});
  } catch {
    logRouteTiming(403, { reason: "tenant_scope_unavailable" });
    return <TenancyUnavailable reason="tenant_scope_unavailable" />;
  }

  if (!tenantSession || tenantSession.workspaceId !== null) {
    logRouteTiming(403, { reason: "tenant_scope_unavailable" });
    return <TenancyUnavailable reason="tenant_scope_unavailable" />;
  }

  try {
    await assertTenantPermission(tenantSession, "tenant:read", { action: "tenancy.page" });
  } catch {
    logRouteTiming(403, { reason: "tenant_scope_unavailable" });
    return <TenancyUnavailable reason="tenant_scope_unavailable" />;
  }

  const adminSurface = tenantSession.role === "owner" || tenantSession.role === "admin";

  let surface: OperationsSurface;
  try {
    surface = await runWithTenantContext(
      tenantSession,
      `tenancy-page:${randomUUID()}`,
      () => withTenantDbContext((db) => withDbStatementTimeout(10_000, async () => {
        const lifecycleSnapshot = await loadTenantLifecycleSnapshot(db, tenantSession.tenantId);
        const supportGrant = adminSurface
          ? await loadLatestSupportGrant(db, tenantSession.tenantId)
          : null;
        const policy = adminSurface
          ? await createTenantQueryRepository(db).getCurrentTenantPolicy(tenantSession.tenantId)
          : null;
        const jobs = adminSurface
          ? await loadLatestDataLifecycleJobs(db, tenantSession.tenantId, createJobReadService(db))
          : { exportJob: null, deletionJob: null };
        const policyAuthorizations = adminSurface && policy !== null
          ? await decidePolicyAuthorizations(tenantSession, db)
          : {};
        return {
          lifecycleSnapshot, supportGrant, policy,
          exportJob: jobs.exportJob, deletionJob: jobs.deletionJob,
          policyAuthorizations,
        };
      })),
    );
    logRouteTiming(200);
  } catch {
    logRouteTiming(503, { reason: "operations_load_error" });
    return <TenancyUnavailable reason="operations_load_error" />;
  }

  const mutationsEnabled = adminSurface;
  return (
    <PageShell
      title="Tenant Operations"
      description="Tenant lifecycle state, recorded rationale, and time-bound support access for this tenant."
      stats={[
        { label: "Tenant status", value: surface.lifecycleSnapshot?.tenant.status.replaceAll("_", " ") ?? "Unavailable" },
        { label: "Lifecycle version", value: String(surface.lifecycleSnapshot?.lifecycleVersion ?? "—") },
        { label: "Support grant", value: surface.supportGrant?.state ?? "None recorded" },
      ]}
    >
      <TenantOperationsControls
        lifecycleSnapshot={surface.lifecycleSnapshot}
        lifecycleMutations={mutationsEnabled}
        supportGrant={surface.supportGrant}
        supportScope={{ tenantId: tenantSession.tenantId, workspaceId: null }}
        actorAuthIdentityId={tenantSession.userId}
        supportAsOf={new Date().toISOString()}
        supportMutations={mutationsEnabled}
        dataLifecycle={{
          policy: surface.policy,
          exportJob: surface.exportJob,
          deletionJob: surface.deletionJob,
          policyAuthorizations: surface.policyAuthorizations,
        }}
        actorRole={tenantSession.role}
        dataMutations={mutationsEnabled}
      />
    </PageShell>
  );
}

/**
 * Final conditional-policy decisions for the panel's `data:export`/`data:delete`
 * gates. Denials are reported, not thrown — the controls stay inert.
 */
async function decidePolicyAuthorizations(
  session: NonNullable<Awaited<ReturnType<typeof getTenantSession>>>,
  db: Parameters<typeof createLocalSupportAccessRepository>[0],
): Promise<Readonly<{ "data:export"?: boolean; "data:delete"?: boolean }>> {
  const decide = async (permission: "data:export" | "data:delete"): Promise<boolean> => {
    try {
      await assertTenantPermission(session, permission, {
        action: "tenancy.page",
        policyEvaluator: async (context) => ({
          allowed: context.tenantId === session.tenantId
            && context.workspaceId === session.workspaceId
            && context.membershipId === session.membershipId
            && Boolean(await db
              .prepare("SELECT 1 AS present FROM tenant_policies WHERE tenant_id = ?")
              .get(session.tenantId)),
          context,
        }),
      });
      return true;
    } catch {
      return false;
    }
  };
  return { "data:export": await decide("data:export"), "data:delete": await decide("data:delete") };
}

/** Read-side job service: only the getters the panel consumes, dispatched per backend. */
function createJobReadService(db: DbClient) {
  if (isLocalMembershipAdministrationAvailable()) {
    return createLocalTenantLifecycleOperationsService(db, {
      limits: createLocalTenantLimitService(db),
    });
  }
  const limits = createPostgresTenantLimitService();
  return {
    ...createPostgresExportOperationsService({
      exportRunner: createPostgresExportRunner(),
      limits,
    }),
    ...createPostgresDeletionOperationsService({
      deletionStore: PAGE_UNREACHABLE_DELETION_STORE,
      limits,
    }),
  };
}

const PAGE_UNREACHABLE_DELETION_STORE: TenantDeletionStorePort = {
  execute: () => Promise.reject(new TenantLifecycleOpsError("FAILED_INTERNAL")),
};

async function loadLatestSupportGrant(
  db: Parameters<typeof createLocalSupportAccessRepository>[0],
  tenantId: string,
): Promise<SupportAccessGrant | null> {
  const service = isLocalMembershipAdministrationAvailable()
    ? createSupportAccessService({
        repository: createLocalSupportAccessRepository(db),
        principalResolver: createLocalSupportPrincipalResolver(db),
        policyEvaluator: createLocalSupportAccessPolicyEvaluator(db),
      })
    : createSupportAccessService({
        repository: createPostgresSupportAccessRepository(),
        principalResolver: createPostgresSupportPrincipalResolver(),
        policyEvaluator: createPostgresSupportAccessPolicyEvaluator(),
      });
  const result = await service.listHistory({
    tenantId,
    idempotencyKey: `support-grant-list.${randomUUID()}`,
  });
  if (!result.ok || !result.grants || result.grants.length === 0) return null;
  // Most recently updated grant is the operative record the panel displays.
  return result.grants.reduce((latest, grant) =>
    grant.updatedAt > latest.updatedAt ? grant : latest);
}

function TenancyUnavailable({ reason }: Readonly<{ reason: "tenant_scope_unavailable" | "operations_load_error" }>) {
  const scopeUnavailable = reason === "tenant_scope_unavailable";
  return (
    <PageShell title="Tenant Operations" description="Tenant lifecycle and support access are unavailable until a canonical tenant scope can be verified.">
      <section className="glass rounded-2xl p-5" role="alert" aria-labelledby="tenancy-unavailable-title" data-tenancy-state={reason}>
        <p className="section-label">Fail-closed</p>
        <h2 id="tenancy-unavailable-title" className="mt-2 text-base font-semibold" style={{ color: "var(--text-primary)" }}>Tenant operations unavailable</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {scopeUnavailable
            ? "Your tenant-wide membership scope could not be verified. No lifecycle, support, or audit records were read."
            : "The tenant operations snapshot could not be loaded. No lifecycle or support records were read or changed."}
        </p>
        <a href="/tenancy" className="btn-primary mt-4 inline-flex text-center">Reload tenant operations</a>
      </section>
    </PageShell>
  );
}
