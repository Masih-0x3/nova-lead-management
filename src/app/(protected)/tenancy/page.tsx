import { randomUUID } from "node:crypto";
import type { Metadata } from "next";

import { connectorDeps } from "@/app/api/_shared/l05-deps";
import { LocalMembershipAdminControls } from "@/components/admin/local-membership-admin-controls";
import { ConnectorGovernancePanel } from "@/components/admin/connector-governance-panel";
import { TenantAuditPanel, type TenantAuditEntry } from "@/components/admin/tenant-audit-panel";
import { TenantOperationsControls } from "@/components/admin/tenant-operations-controls";
import { AsyncState } from "@/components/async-state";
import { PageShell } from "@/components/page-shell";
import type { TenantSession } from "@/lib/auth";
import type { DbClient } from "@/lib/db/index";
import { createPostgresConnectorAuthorityRepository } from "@/lib/connectors/repository";
import { getConnectorGovernanceView, type ConnectorGovernanceView } from "@/lib/connectors/service";
import { isTenantRoleCapable } from "@/lib/permissions";
import { createTenantQueryRepository, type Tenant, type Workspace } from "@/lib/tenancy/queries";
import { assertTenantPermission } from "@/lib/tenancy/authorize";
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
import { createPostgresDeletionOperationsService } from "@/lib/tenancy/postgres-deletion-operations";
import {
  createPostgresExportOperationsService,
  createPostgresExportRunner,
} from "@/lib/tenancy/postgres-export-operations";
import {
  createPostgresSupportAccessPolicyEvaluator,
  createPostgresSupportAccessRepository,
  createPostgresSupportPrincipalResolver,
} from "@/lib/tenancy/postgres-support-access";
import { createPostgresTenantLimitService } from "@/lib/tenancy/postgres-tenant-limits";
import { createSupportAccessService } from "@/lib/tenancy/support-access";
import type { SupportAccessGrant, TenantPolicy } from "@/lib/tenancy/types";
import type { AuditActorLayer } from "@/lib/db/queries";
import type { TenantDeletionJobView } from "@/components/admin/data-lifecycle-panel";
import type { TenantLifecycleSnapshot } from "@/components/admin/tenant-lifecycle-panel";
import type { TenantExportJob } from "@/lib/tenancy/types";
import {
  isLocalMembershipMutationAvailable,
  loadMembershipDirectory,
  type MembershipDirectory,
} from "../_lib/membership-directory";
import { loadSurface, PendingSeamNotice, SurfaceNotice } from "../_lib/surface";
import { TenantLifecycleControls } from "./workspace";

export const metadata: Metadata = { title: "Tenant Admin | Nova Trade Lead Management" };

const AUDIT_ACTOR_LAYERS = new Set<AuditActorLayer>(["member", "support", "worker", "agent", "system"]);
const AUDIT_OUTCOMES = new Set<TenantAuditEntry["outcome"]>(["allowed", "denied", "failed"]);

type AuditLogRow = Readonly<{
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_email: string | null;
  actor_membership_id: string | null;
  actor_launch_role: string | null;
  actor_layer: string | null;
  workspace_id: string | null;
  correlation_id: string | null;
  metadata: string | null;
  created_at: string;
}>;

type TenantOperationsSurface = Readonly<{
  lifecycleSnapshot: TenantLifecycleSnapshot | null;
  supportGrant: SupportAccessGrant | null;
  exportJob: TenantExportJob | null;
  deletionJob: TenantDeletionJobView | null;
  policyAuthorizations: Readonly<{ "data:export"?: boolean; "data:delete"?: boolean }>;
}>;

type TenancyData = Readonly<{
  tenant: Tenant;
  workspaces: readonly Workspace[];
  policy: TenantPolicy | null;
  directory: MembershipDirectory | null;
  directoryFailed: boolean;
  auditEntries: readonly TenantAuditEntry[];
  governance: ConnectorGovernanceView | null;
  operations: TenantOperationsSurface | null;
}>;

export default async function TenancyPage() {
  const outcome = await loadSurface<TenancyData>({
    route: "/tenancy",
    permission: "membership:read",
    action: "l07:tenancy:read",
    resourceType: "tenant",
    load: loadTenancyData,
  });
  if (outcome.state === "failed") {
    return (
      <SurfaceNotice
        route="/tenancy"
        title="Tenant administration"
        description="Members, tenant policy, budgets, retention, audit, and support access."
        kind={outcome.kind}
      />
    );
  }

  const { session, data } = outcome;
  const workspaceLabels = new Map(data.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const auditEntries = data.auditEntries.map((entry) => ({
    ...entry,
    workspaceLabel: entry.workspaceLabel === null ? null : workspaceLabels.get(entry.workspaceLabel) ?? entry.workspaceLabel,
  }));
  const canManageLifecycle = isTenantRoleCapable(session.role, "tenant:lifecycle");
  const mutationsEnabled = isLocalMembershipMutationAvailable()
    && (session.role === "owner" || session.role === "admin");
  const operations = data.operations;
  const operationsMutationsEnabled = mutationsEnabled && operations !== null;

  return (
    <PageShell
      title="Tenant administration"
      description="Members, lifecycle, policy, connectors, audit, and data controls for this tenant."
      stats={[
        { label: "Tenant status", value: data.tenant.status },
        { label: "Workspaces", value: String(data.workspaces.length) },
        { label: "Members", value: data.directory === null ? "—" : String(data.directory.memberships.length) },
        { label: "Policy version", value: data.policy === null ? "—" : `v${data.policy.version}` },
      ]}
    >
      <div className="grid gap-5">
        <TenantOverviewSection tenant={data.tenant} workspaces={data.workspaces} />

        <section aria-labelledby="tenancy-lifecycle-title" className="glass rounded-2xl p-5">
          <h2 id="tenancy-lifecycle-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Tenant lifecycle
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Canonical status transitions are audited and checked against the current tenant state.
          </p>
          {canManageLifecycle ? (
            <TenantLifecycleControls status={data.tenant.status} />
          ) : (
            <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>
              Lifecycle transitions require the tenant lifecycle permission for owner and admin roles.
            </p>
          )}
        </section>

        <section aria-labelledby="tenancy-members-title" className="glass rounded-2xl p-5">
          <h2 id="tenancy-members-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Members
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Canonical membership state and recorded role history for this tenant.
          </p>
          <div className="mt-4">
            {data.directory === null ? (
              <AsyncState
                variant={data.directoryFailed ? "error" : "access-denied"}
                title={data.directoryFailed ? "Members unavailable" : "Tenant scope required"}
                description={data.directoryFailed
                  ? "The canonical tenant membership snapshot could not be loaded."
                  : "Membership administration requires a tenant-wide membership scope."}
              />
            ) : (
              <LocalMembershipAdminControls
                actor={data.directory.actor}
                memberships={data.directory.memberships}
                history={data.directory.history}
                mutationsEnabled={mutationsEnabled}
              />
            )}
          </div>
        </section>

        <section aria-labelledby="tenancy-policy-title" className="glass rounded-2xl p-5">
          <h2 id="tenancy-policy-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Tenant policy
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Current governing policy version and feature flags.
          </p>
          {data.policy === null ? (
            <AsyncState
              variant="empty"
              title="No tenant policy"
              description="No canonical tenant policy version has been recorded for this tenant."
            />
          ) : (
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <PolicyField label="Policy version" value={`v${data.policy.version}`} />
              <PolicyField label="Locale" value={data.policy.locale} />
              <PolicyField label="Timezone" value={data.policy.timezone} />
              <PolicyField label="AI processing" value={data.policy.aiProcessingEnabled ? "Enabled" : "Disabled"} />
              <PolicyField label="Source research" value={data.policy.sourceResearchEnabled ? "Enabled" : "Disabled"} />
              <PolicyField label="Contact research" value={data.policy.contactResearchEnabled ? "Enabled" : "Disabled"} />
              <PolicyField label="Outreach drafting" value={data.policy.outreachDraftingEnabled ? "Enabled" : "Disabled"} />
              <PolicyField label="Copy/export" value={data.policy.copyExportEnabled ? "Enabled" : "Disabled"} />
              <PolicyField label="Export retention" value={`${data.policy.exportRetentionDays} days`} />
              <PolicyField label="Raw source retention" value={`${data.policy.rawSourceRetentionDays} days`} />
              <PolicyField label="Contact freshness" value={`${data.policy.contactFreshnessDays} days`} />
              <PolicyField label="Outreach review" value={data.policy.requireOutreachReview ? "Required" : "Not required"} />
            </dl>
          )}
          <div className="mt-4">
            <PendingSeamNotice
              title="Policy editing, limits, and usage pending"
              description="Editing tenant policy, limit runtime state, and per-action usage metering require the tenant-administration write/read seams still landing in the tenancy lane. This view is read-only until those seams are available."
            />
          </div>
        </section>

        <section aria-labelledby="tenancy-connectors-title" className="glass rounded-2xl p-5">
          <h2 id="tenancy-connectors-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Connector governance
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Source-run authority and policy decision for the latest connector run.
          </p>
          <div className="mt-4">
            {data.governance === null ? (
              <ConnectorGovernancePanel state="empty" />
            ) : (
              <ConnectorGovernancePanel
                state="ready"
                authority={data.governance.authority}
                decision={data.governance.decision}
                audit={{ state: "pending" }}
                asOf={data.governance.asOf}
              />
            )}
          </div>
          <div className="mt-4">
            <PendingSeamNotice
              title="Connector account controls pending"
              description="Enabling, disabling, and reviewing connector accounts requires the audited connector command seam. Authority state is shown read-only until it lands."
            />
          </div>
        </section>

        <section aria-labelledby="tenancy-audit-title" className="glass rounded-2xl p-5">
          <h2 id="tenancy-audit-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Tenant audit
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Recent tenant-scoped audit events recorded by the canonical audit log.
          </p>
          <div className="mt-4">
            {auditEntries.length === 0 ? (
              <TenantAuditPanel state="empty" />
            ) : (
              <TenantAuditPanel state="ready" entries={auditEntries} integrity="unverified" />
            )}
          </div>
        </section>

        <section aria-labelledby="tenancy-data-title" className="glass rounded-2xl p-5">
          <h2 id="tenancy-data-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Data lifecycle &amp; support access
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Canonical lifecycle snapshot, export and deletion jobs, and time-bound support access for this tenant.
          </p>
          <div className="mt-4">
            {operations === null ? (
              <AsyncState
                variant="empty"
                title="Operations unavailable"
                description="The tenant operations snapshot could not be loaded. No lifecycle or support records were read or changed."
              />
            ) : (
              <TenantOperationsControls
                lifecycleSnapshot={operations.lifecycleSnapshot}
                lifecycleMutations={operationsMutationsEnabled}
                supportGrant={operations.supportGrant}
                supportScope={{ tenantId: session.tenantId, workspaceId: session.workspaceId }}
                actorAuthIdentityId={session.userId}
                supportAsOf={new Date().toISOString()}
                supportMutations={operationsMutationsEnabled}
                dataLifecycle={{
                  policy: data.policy,
                  exportJob: operations.exportJob,
                  deletionJob: operations.deletionJob,
                  policyAuthorizations: operationsMutationsEnabled ? operations.policyAuthorizations : {},
                }}
                actorRole={session.role}
                dataMutations={operationsMutationsEnabled}
              />
            )}
          </div>
        </section>
      </div>
    </PageShell>
  );
}

async function loadTenancyData(db: DbClient, session: TenantSession): Promise<TenancyData> {
  const repository = createTenantQueryRepository(db);
  const [tenant, workspaces, policy, auditRows] = await Promise.all([
    repository.getTenant(session.tenantId),
    repository.listWorkspaces(session.tenantId),
    repository.getCurrentTenantPolicy(session.tenantId),
    db.prepare(
      `SELECT id, action, entity_type, entity_id, actor_email, actor_membership_id,
              actor_launch_role, actor_layer, workspace_id, correlation_id, metadata, created_at
       FROM audit_logs
       WHERE scope_kind = 'tenant' AND tenant_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    ).all<AuditLogRow>(session.tenantId),
  ]);
  if (!tenant) throw new Error("Tenant record missing for resolved session.");

  let directory: MembershipDirectory | null = null;
  let directoryFailed = false;
  try {
    directory = await loadMembershipDirectory(db, session);
  } catch {
    directoryFailed = session.workspaceId !== null ? false : true;
  }

  const governance = await loadConnectorGovernance(db, session);
  const operations = await loadTenantOperationsSurface(db, session, policy);

  return {
    tenant,
    workspaces,
    policy,
    directory,
    directoryFailed,
    auditEntries: projectAuditEntries(auditRows),
    governance,
    operations,
  };
}

async function loadTenantOperationsSurface(
  db: DbClient,
  session: TenantSession,
  policy: TenantPolicy | null,
): Promise<TenantOperationsSurface | null> {
  try {
    const lifecycleSnapshot = await loadTenantLifecycleSnapshot(db, session.tenantId);
    const supportGrant = await loadLatestSupportGrant(db, session.tenantId);
    const jobs = await loadLatestDataLifecycleJobs(db, session.tenantId, createJobReadService(db));
    const policyAuthorizations = policy !== null
      ? await decidePolicyAuthorizations(session, db)
      : {};
    return {
      lifecycleSnapshot,
      supportGrant,
      exportJob: jobs.exportJob,
      deletionJob: jobs.deletionJob,
      policyAuthorizations,
    };
  } catch {
    return null;
  }
}

/**
 * Final conditional-policy decisions for the panel's `data:export`/`data:delete`
 * gates. Denials are reported, not thrown — the controls stay inert.
 */
async function decidePolicyAuthorizations(
  session: TenantSession,
  db: DbClient,
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

async function loadLatestSupportGrant(db: DbClient, tenantId: string): Promise<SupportAccessGrant | null> {
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

async function loadConnectorGovernance(
  db: DbClient,
  session: TenantSession,
): Promise<ConnectorGovernanceView | null> {
  const authority = createPostgresConnectorAuthorityRepository(db);
  const runs = await authority.listRuns(session.tenantId, session.workspaceId);
  const run = runs[0];
  if (!run) return null;
  const units = await authority.listUnits(session.tenantId, session.workspaceId, run.id);
  const unit = units[0];
  if (!unit) return null;
  try {
    return await getConnectorGovernanceView(connectorDeps(db), {
      authorizedTenantId: session.tenantId,
      authorizedWorkspaceId: session.workspaceId,
      runId: run.id,
      unitId: unit.id,
    });
  } catch {
    return null;
  }
}

function projectAuditEntries(rows: readonly AuditLogRow[]): TenantAuditEntry[] {
  const entries: TenantAuditEntry[] = [];
  for (const row of rows) {
    const occurredAt = new Date(row.created_at);
    if (!Number.isFinite(occurredAt.getTime())) continue;
    const metadata = parseAuditMetadata(row.metadata);
    const rawOutcome = metadata?.["outcome"] ?? metadata?.["decision"] ?? metadata?.["result"];
    entries.push({
      id: row.id,
      occurredAt: occurredAt.toISOString(),
      actorLabel: row.actor_email ?? row.actor_launch_role ?? row.actor_membership_id ?? "system",
      actorLayer: AUDIT_ACTOR_LAYERS.has(row.actor_layer as AuditActorLayer)
        ? row.actor_layer as AuditActorLayer
        : "member",
      action: row.action,
      resource: row.entity_type === null
        ? "tenant"
        : row.entity_id === null ? row.entity_type : `${row.entity_type}:${row.entity_id}`,
      workspaceLabel: row.workspace_id,
      outcome: AUDIT_OUTCOMES.has(rawOutcome as TenantAuditEntry["outcome"])
        ? rawOutcome as TenantAuditEntry["outcome"]
        : "allowed",
      correlationId: row.correlation_id ?? row.id,
    });
  }
  return entries;
}

function parseAuditMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function TenantOverviewSection(props: Readonly<{
  tenant: Tenant;
  workspaces: readonly Workspace[];
}>) {
  return (
    <section aria-labelledby="tenancy-overview-title" className="glass rounded-2xl p-5">
      <h2 id="tenancy-overview-title" className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Tenant overview
      </h2>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PolicyField label="Name" value={props.tenant.name} />
        <PolicyField label="Slug" value={props.tenant.slug} />
        <PolicyField label="Status" value={props.tenant.status} />
        <PolicyField label="Locale / timezone" value={`${props.tenant.locale} · ${props.tenant.timezone}`} />
      </dl>
      <h3 className="mt-5 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Workspaces</h3>
      {props.workspaces.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          No workspaces are provisioned for this tenant yet.
        </p>
      ) : (
        <ul className="mt-2 grid gap-2" role="list">
          {props.workspaces.map((workspace) => (
            <li
              key={workspace.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                {workspace.name}
                <span className="ml-2 font-normal" style={{ color: "var(--text-muted)" }}>{workspace.slug}</span>
              </span>
              <span className="text-xs uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                {workspace.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PolicyField(props: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-xl border px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
      <dt className="text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{props.label}</dt>
      <dd className="mt-1 text-sm font-medium" style={{ color: "var(--text-primary)" }}>{props.value}</dd>
    </div>
  );
}
