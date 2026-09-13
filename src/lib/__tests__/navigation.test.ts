import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  WORKFLOW_NAV_ITEMS,
  workflowNavItemsForRole,
} from "@/lib/navigation";
import { TENANT_ROLES, isTenantPermission } from "@/lib/permissions";

describe("primary navigation", () => {
  it("puts explore before workbench", () => {
    expect(PRIMARY_NAV_ITEMS.slice(0, 2).map((item) => item.label)).toEqual(["Explore", "Workbench"]);
  });

  it("keeps admin navigation focused on core operator routes", () => {
    expect(ADMIN_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Admin Home",
      "Discovery",
      "Monitor",
      "Fulfillment",
      "All Leads",
      "Quality",
      "Scheduler",
      "Statistics",
      "Settings",
      "Users",
      "Tenancy",
    ]);
    expect(ADMIN_NAV_ITEMS.find((item) => item.label === "Discovery")?.href).toBe("/dashboard#discovery");
  });
});

describe("workflow navigation", () => {
  it("covers the expanded product surfaces in a stable order", () => {
    expect(WORKFLOW_NAV_ITEMS.map((item) => item.id)).toEqual([
      "onboarding",
      "knowledge",
      "strategy",
      "discovery",
      "accounts",
      "contacts",
      "review",
      "outreach",
      "reporting",
      "tenancy",
    ]);
  });

  it("gates every workflow item on a real tenant permission", () => {
    for (const item of WORKFLOW_NAV_ITEMS) {
      expect(isTenantPermission(item.tenantPermission), item.id).toBe(true);
      expect(item.href.startsWith("/"), item.id).toBe(true);
      expect(item.href.includes("#"), item.id).toBe(false);
    }
  });

  it("returns no workflow items without a resolved tenant role", () => {
    expect(workflowNavItemsForRole(null)).toEqual([]);
    expect(workflowNavItemsForRole(undefined)).toEqual([]);
  });

  it("hides tenant administration from roles that cannot read memberships", () => {
    for (const role of TENANT_ROLES) {
      const items = workflowNavItemsForRole(role);
      const tenancy = items.find((item) => item.id === "tenancy");
      if (role === "owner" || role === "admin") {
        expect(tenancy, role).toBeDefined();
      } else {
        expect(tenancy, role).toBeUndefined();
      }
    }
  });

  it("shows the knowledge surfaces to read-capable roles and hides setup from denied roles", () => {
    const reviewer = workflowNavItemsForRole("reviewer");
    expect(reviewer.some((item) => item.id === "knowledge")).toBe(true);
    expect(reviewer.some((item) => item.id === "onboarding")).toBe(false);

    const analyst = workflowNavItemsForRole("analyst_read_only");
    expect(analyst.some((item) => item.id === "knowledge")).toBe(true);
    expect(analyst.some((item) => item.id === "outreach")).toBe(true);
  });
});
