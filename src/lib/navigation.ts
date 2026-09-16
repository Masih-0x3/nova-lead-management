import { isTenantRoleCapable, type TenantPermission, type TenantRole } from "@/lib/permissions";

export type NavItem = {
  href: string;
  label: string;
  description?: string;
  badge?: "fulfillment";
};

/**
 * Tenant workflow surfaces added by the L-07 product UI. `tenantPermission` is
 * the read permission that gates visibility — the item renders only when the
 * resolved tenant role is capable (D-002 decision A or C). Every href must
 * resolve to a real route; unavailable items are hidden, never disabled.
 */
export type WorkflowNavItem = NavItem & Readonly<{
  id: string;
  tenantPermission: TenantPermission;
}>;

export const WORKFLOW_NAV_ITEMS: readonly WorkflowNavItem[] = [
  {
    id: "onboarding",
    href: "/onboarding",
    label: "Setup",
    description: "Guided tenant onboarding: scope, policy, materials, and launch progress.",
    tenantPermission: "knowledge:upload",
  },
  {
    id: "knowledge",
    href: "/knowledge",
    label: "Knowledge",
    description: "Source materials, extraction review, evidence, and business understanding.",
    tenantPermission: "knowledge:read",
  },
  {
    id: "strategy",
    href: "/strategy",
    label: "Strategy",
    description: "Understanding review, adaptive questions, ICP and lead-play authoring.",
    tenantPermission: "icp:read",
  },
  {
    id: "discovery",
    href: "/discovery",
    label: "Discovery",
    description: "Bounded discovery plans, run control, and cost caps.",
    tenantPermission: "source:review",
  },
  {
    id: "accounts",
    href: "/accounts",
    label: "Accounts",
    description: "Canonical account portfolio, resolution, and merge history.",
    tenantPermission: "account:read",
  },
  {
    id: "contacts",
    href: "/contacts",
    label: "Contacts",
    description: "Contact registry and buying-center mapping workbench.",
    tenantPermission: "contact:read",
  },
  {
    id: "review",
    href: "/review",
    label: "Review",
    description: "Human review queues for resolutions, qualification, and outreach.",
    tenantPermission: "review:read",
  },
  {
    id: "outreach",
    href: "/outreach",
    label: "Outreach",
    description: "Draft review and approval, copy/export handoffs, and suppressions.",
    tenantPermission: "outreach:read",
  },
  {
    id: "reporting",
    href: "/reporting",
    label: "Reporting",
    description: "Outcome capture, attribution reports, and learning proposals.",
    tenantPermission: "report:read",
  },
  {
    id: "tenancy",
    href: "/tenancy",
    label: "Tenant admin",
    description: "Members, tenant policy, budgets, retention, audit, and support access.",
    tenantPermission: "membership:read",
  },
];

/**
 * Workflow items the resolved tenant role may see. A null/unknown role yields
 * no workflow navigation — the shell never renders a link the actor cannot use.
 */
export function workflowNavItemsForRole(role: TenantRole | null | undefined): readonly WorkflowNavItem[] {
  if (!role) return [];
  return WORKFLOW_NAV_ITEMS.filter((item) => isTenantRoleCapable(role, item.tenantPermission));
}

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/explore", label: "Explore", description: "Search, map, filter, and claim available businesses." },
  { href: "/queue", label: "Workbench", description: "Daily call, text, email, and follow-up queue." },
  { href: "/leads?assigned=me", label: "My Leads", description: "Only leads owned by the current user." },
  { href: "/team", label: "Team", description: "Team workload and recent outreach activity." },
];

export const ADMIN_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Admin Home", description: "Lead inventory, discovery, and fulfillment command center." },
  { href: "/dashboard#discovery", label: "Discovery", description: "Configure and start a new discovery run." },
  { href: "/coverage", label: "Monitor", description: "Inspect discovery items, run status, and coverage." },
  { href: "/fulfillment", label: "Fulfillment", description: "Website and quote requests from researchers.", badge: "fulfillment" },
  { href: "/leads", label: "All Leads", description: "Full lead database, filters, Kanban, and export." },
  { href: "/quality", label: "Quality", description: "AI verification and manual lead quality review." },
  { href: "/scheduler", label: "Scheduler", description: "Worker health, usage, backlog, and run history." },
  { href: "/statistics", label: "Statistics", description: "Pipeline conversion, quality, and cost reporting." },
  { href: "/settings", label: "Settings", description: "API keys, scoring, and model settings." },
  { href: "/users", label: "Users", description: "Team roles, status, and team lead assignment." },
  { href: "/tenancy", label: "Tenancy", description: "Tenant lifecycle state and time-bound support access." },
];
