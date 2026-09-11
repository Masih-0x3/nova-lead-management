import { test, expect } from "@playwright/test";

import { BASE_URL, EMAIL, login, requireE2EAuth } from "./auth-fixtures";

/**
 * Researcher-path authenticated smoke. Run with the seeded researcher identity:
 *   E2E_SUPABASE_EMAIL=researcher@nova.local E2E_SUPABASE_PASSWORD=... \
 *   npx playwright test e2e/smoke-researcher.spec.ts --project=authenticated-read-only
 *
 * Verifies that a tenant-wide researcher membership renders the working
 * surfaces and that admin/membership surfaces fail closed without data.
 */
test.describe("Researcher Smoke Test", () => {
  requireE2EAuth();
  test.setTimeout(60000);
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("1. Login lands on the workbench", async ({ page }) => {
    expect(page.url()).toContain("/queue");
    await expect(page.getByRole("heading", { name: "Workbench", exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: `Log out ${EMAIL}` })).toBeVisible();
  });

  test("2. Primary nav renders without admin affordances", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Workbench", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "My Leads", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Team", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Admin menu" })).toHaveCount(0);
  });

  test("3. Lead Explorer renders", async ({ page }) => {
    await page.goto(`${BASE_URL}/explore`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Lead Explorer", exact: true })).toBeVisible({ timeout: 10000 });
  });

  test("4. Leads list renders", async ({ page }) => {
    await page.goto(`${BASE_URL}/leads`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Leads", exact: true })).toBeVisible({ timeout: 10000 });
  });

  test("5. Team board renders scoped view", async ({ page }) => {
    await page.goto(`${BASE_URL}/team`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "My Team Board", exact: true })).toBeVisible({ timeout: 10000 });
  });

  test("6. Membership directory denies researcher", async ({ page }) => {
    await page.goto(`${BASE_URL}/users`, { waitUntil: "networkidle" });
    const alert = page.getByRole("alert", { name: "Tenant members unavailable" });
    await expect(alert).toBeVisible({ timeout: 10000 });
    await expect(alert).toHaveAttribute("data-users-state", "tenant_scope_unavailable");
    await expect(page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
  });

  test("7. Admin surfaces fail closed", async ({ page }) => {
    for (const path of ["/dashboard", "/settings"]) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { name: "Something went wrong" }),
        `${path} must deny researcher without leaking admin content`,
      ).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole("button", { name: "Admin menu" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Admin Command Center" })).toHaveCount(0);
    }
  });

  test("8. No horizontal overflow on researcher surfaces", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const path of ["/queue", "/explore", "/leads", "/team"]) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth, `${path} must not overflow the 1440px viewport`).toBeLessThanOrEqual(1440);
    }
  });
});
