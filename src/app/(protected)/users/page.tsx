import type { Metadata } from "next";

import { LocalMembershipAdminControls } from "@/components/admin/local-membership-admin-controls";
import { PageShell } from "@/components/page-shell";
import { getTenantSession } from "@/lib/auth";
import { withDbStatementTimeout, withTenantDbContext } from "@/lib/db/index";
import { startRouteTiming } from "@/lib/route-timing";
import { assertTenantPermission } from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";
import {
  isLocalMembershipMutationAvailable,
  loadMembershipDirectory,
  type MembershipDirectory,
} from "../_lib/membership-directory";

export const metadata: Metadata = { title: "Users | Nova Trade Lead Management" };

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

  const localMutationsAvailable = isLocalMembershipMutationAvailable();
  let directory: MembershipDirectory;
  try {
    directory = await runWithTenantContext(
      tenantSession,
      `users-page:${crypto.randomUUID()}`,
      () => withTenantDbContext((db) => withDbStatementTimeout(10_000, async () =>
        loadMembershipDirectory(db, tenantSession))),
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
  const mutationsEnabled = localMutationsAvailable && (tenantSession.role === "owner" || tenantSession.role === "admin");

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
