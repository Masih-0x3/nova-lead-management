import { randomUUID } from "node:crypto";
import type { Metadata } from "next";

import { LocalMembershipAdminControls } from "@/components/admin/local-membership-admin-controls";
import { PageShell } from "@/components/page-shell";
import { getTenantSession, type TenantSession } from "@/lib/auth";
import { withDbStatementTimeout, withTenantDbContext } from "@/lib/db/index";
import { startRouteTiming } from "@/lib/route-timing";
import { assertTenantPermission } from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  createLocalTenantMembershipAdministrationService,
  isLocalMembershipAdministrationAvailable,
} from "@/lib/tenancy/local-membership-administration";
import { createPostgresTenantMembershipAdministrationService } from "@/lib/tenancy/postgres-membership-administration";
import type { MembershipHistoryView, MembershipView } from "@/lib/tenancy/memberships";
import type { MembershipStatus } from "@/lib/tenancy/types";

export const metadata: Metadata = { title: "Users | Nova Lead Management" };

type Directory = Readonly<{
  memberships: readonly MembershipView[];
  history: readonly MembershipHistoryView[];
  actor: MembershipView;
}>;

const CURRENT_MEMBERSHIP_STATUSES = new Set<MembershipStatus>([
  "pending",
  "active",
  "suspended",
  "disabled",
]);
const TERMINAL_MEMBERSHIP_STATUSES = new Set<MembershipStatus>([
  "revoked",
  "removed",
  "expired",
]);

export default async function UsersPage() {
  const logRouteTiming = startRouteTiming("/users");
  let tenantSession: Awaited<ReturnType<typeof getTenantSession>>;
  try {
    tenantSession = await getTenantSession({});
  } catch {
    logRouteTiming(403, { reason: "tenant_scope_unavailable" });
    return <UsersUnavailable reason="tenant_scope_unavailable" />;
  }

  if (!tenantSession || tenantSession.workspaceId !== null) {
    logRouteTiming(403, { reason: "tenant_scope_unavailable" });
    return <UsersUnavailable reason="tenant_scope_unavailable" />;
  }

  try {
    await assertTenantPermission(tenantSession, "membership:read", { action: "users.page" });
  } catch {
    logRouteTiming(403, { reason: "tenant_scope_unavailable" });
    return <UsersUnavailable reason="tenant_scope_unavailable" />;
  }

  let directory: Directory;
  try {
    directory = await runWithTenantContext(
      tenantSession,
      `users-page:${randomUUID()}`,
      () => withTenantDbContext((db) => withDbStatementTimeout(10_000, async () => {
        const service = isLocalMembershipAdministrationAvailable()
          ? createLocalTenantMembershipAdministrationService(db)
          : createPostgresTenantMembershipAdministrationService();
        const memberships = await service.listCurrent(tenantSession);
        const history = await service.listHistory(tenantSession);
        return validateDirectory(tenantSession, memberships, history);
      })),
    );
    logRouteTiming(200);
  } catch {
    logRouteTiming(503, { reason: "members_load_error" });
    return <UsersUnavailable reason="members_load_error" />;
  }

  const active = directory.memberships.filter((membership) => membership.status === "active").length;
  const pending = directory.memberships.filter((membership) => membership.status === "pending").length;
  const suspended = directory.memberships.filter((membership) => membership.status === "suspended").length;
  const withoutRole = directory.memberships.filter((membership) => membership.role === null).length;
  const mutationsEnabled = tenantSession.role === "owner" || tenantSession.role === "admin";

  return (
    <PageShell
      title="Tenant Members"
      description="Review canonical membership state and recorded role history for this tenant."
      stats={[
        { label: "Members", value: String(directory.memberships.length) },
        { label: "Active", value: String(active) },
        { label: "Pending", value: String(pending) },
        { label: "Suspended", value: String(suspended) },
        { label: "No Current Role", value: String(withoutRole) },
      ]}
    >
      <LocalMembershipAdminControls
        actor={directory.actor}
        memberships={directory.memberships}
        history={directory.history}
        mutationsEnabled={mutationsEnabled}
      />
    </PageShell>
  );
}

function validateDirectory(
  session: TenantSession,
  memberships: readonly MembershipView[],
  history: readonly MembershipHistoryView[],
): Directory {
  const currentById = new Map(memberships.map((membership) => [membership.membershipId, membership]));
  const historyById = new Map(history.map((membership) => [membership.membershipId, membership]));
  if (currentById.size !== memberships.length
    || historyById.size !== history.length
    || memberships.some((membership) => membership.tenantId !== session.tenantId)
    || history.some((membership) => membership.tenantId !== session.tenantId)
    || memberships.some((membership) => !CURRENT_MEMBERSHIP_STATUSES.has(membership.status))) {
    throw new Error("Invalid tenant member snapshot.");
  }

  for (const membership of memberships) {
    const historical = historyById.get(membership.membershipId);
    if (!historical || !sameMembershipFacts(membership, historical)) {
      throw new Error("Invalid tenant member snapshot.");
    }
  }
  for (const historical of history) {
    const current = currentById.get(historical.membershipId);
    const terminal = TERMINAL_MEMBERSHIP_STATUSES.has(historical.status);
    if ((terminal && current !== undefined)
      || (!terminal && (current === undefined || !sameMembershipFacts(current, historical)))) {
      throw new Error("Invalid tenant member snapshot.");
    }
  }

  const actors = memberships.filter((membership) => membership.membershipId === session.membershipId);
  if (actors.length !== 1 || actors[0].status !== "active" || actors[0].role !== session.role
    || actors[0].workspaceId !== null) {
    throw new Error("Invalid tenant member snapshot.");
  }
  return { memberships, history, actor: actors[0] };
}

function sameMembershipFacts(
  current: MembershipView,
  historical: MembershipHistoryView,
): boolean {
  return historical.tenantId === current.tenantId
    && historical.membershipId === current.membershipId
    && historical.status === current.status
    && historical.role === current.role
    && historical.workspaceId === current.workspaceId;
}

function UsersUnavailable({ reason }: Readonly<{ reason: "tenant_scope_unavailable" | "members_load_error" }>) {
  const scopeUnavailable = reason === "tenant_scope_unavailable";
  return (
    <PageShell title="Tenant Members" description="Membership administration is unavailable until a canonical tenant scope can be verified.">
      <section className="glass rounded-2xl p-5" role="alert" aria-labelledby="users-unavailable-title" data-users-state={reason}>
        <p className="section-label">Read-only recovery</p>
        <h2 id="users-unavailable-title" className="mt-2 text-base font-semibold" style={{ color: "var(--text-primary)" }}>Tenant members unavailable</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {scopeUnavailable
            ? "Your tenant-wide membership scope could not be verified. No user, membership, territory, or market-access records were read."
            : "The canonical tenant membership snapshot could not be loaded. No platform-global user or market-access fallback was attempted."}
        </p>
        <a href="/users" className="btn-primary mt-4 inline-flex text-center">Reload members</a>
      </section>
    </PageShell>
  );
}
