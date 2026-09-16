import { test, expect, type Page } from "@playwright/test";

import { BASE_URL, login, requireE2EAuth } from "./auth-fixtures";

/**
 * L-07 authenticated product-UI smoke (admin identity).
 *
 * Every workflow nav link must resolve to a live surface: heading landmark,
 * no dead links, no send-path controls on outreach, and no horizontal
 * overflow at desktop and mobile widths. Denied/empty states are acceptable
 * renderings — what matters is that each route renders its typed shell.
 */
const WORKFLOW_ROUTES: ReadonlyArray<Readonly<{ path: string; heading: RegExp }>> = [
  { path: "/knowledge", heading: /^Knowledge$/ },
  { path: "/strategy", heading: /^Strategy$/ },
  { path: "/discovery", heading: /^Discovery$/ },
  { path: "/accounts", heading: /^Accounts$/ },
  { path: "/contacts", heading: /^Contacts$/ },
  { path: "/review", heading: /^Review$/ },
  { path: "/outreach", heading: /^Outreach$/ },
  { path: "/reporting", heading: /^Reporting$/ },
  { path: "/tenancy", heading: /^Tenant administration$/ },
];

async function expectNoHorizontalOverflow(page: Page, width: number, label: string) {
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth, `${label} must not overflow the ${width}px viewport`).toBeLessThanOrEqual(width);
}

test.describe("Workflow surfaces (admin)", () => {
  requireE2EAuth();
  test.setTimeout(90000);
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("1. Workspace menu exposes every workflow surface", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Setup", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Knowledge", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Workspace menu" }).click();
    const menu = page.locator("#workspace-nav-menu");
    await expect(menu).toBeVisible();
    for (const label of ["Strategy", "Discovery", "Accounts", "Contacts", "Review", "Outreach", "Reporting", "Tenant admin"]) {
      await expect(menu.getByRole("link", { name: new RegExp(`^${label}`) }), `Workspace menu must list ${label}`).toBeVisible();
    }
  });

  test("2. Every workflow route renders its typed shell", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

    for (const route of WORKFLOW_ROUTES) {
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { name: route.heading }).first(),
        `${route.path} must render its surface heading`,
      ).toBeVisible({ timeout: 15000 });
      const errorBoundary = page.getByRole("heading", { name: "Something went wrong" });
      await expect(errorBoundary, `${route.path} must not hit the generic error boundary`).toHaveCount(0);
    }
    expect(errors).toHaveLength(0);
  });

  test("3. Onboarding wizard steps render", async ({ page }) => {
    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Confirm the tenant scope", exact: true })).toBeVisible({ timeout: 15000 });
    for (const step of ["Policy", "Materials", "Progress"]) {
      await page.goto(`${BASE_URL}/onboarding?step=${step.toLowerCase()}`, { waitUntil: "networkidle" });
      await expect(page.locator("main").getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    }
  });

  test("4. Tenant administration sections render", async ({ page }) => {
    await page.goto(`${BASE_URL}/tenancy`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Tenant administration" })).toBeVisible({ timeout: 15000 });
    for (const section of ["Tenant overview", "Tenant lifecycle", "Members", "Tenant policy", "Connector governance", "Tenant audit", "Data lifecycle & support access"]) {
      await expect(
        page.getByRole("heading", { name: section, exact: true }),
        `/tenancy must render the ${section} section`,
      ).toBeVisible();
    }
  });

  test("5. Outreach surface exposes no send path", async ({ page }) => {
    await page.goto(`${BASE_URL}/outreach`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /^Outreach$/ }).first()).toBeVisible({ timeout: 15000 });
    for (const name of [/send now/i, /^send$/i, /deliver/i, /dispatch/i]) {
      await expect(
        page.getByRole("button", { name }),
        `outreach must not render a send control (${name})`,
      ).toHaveCount(0);
    }
  });

  test("6. No horizontal overflow on workflow surfaces", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const route of WORKFLOW_ROUTES) {
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "networkidle" });
      await expectNoHorizontalOverflow(page, 1440, route.path);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of WORKFLOW_ROUTES) {
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "networkidle" });
      await expectNoHorizontalOverflow(page, 390, route.path);
    }
  });

  test("7. Workflow surfaces keyboard-navigable", async ({ page }) => {
    await page.goto(`${BASE_URL}/strategy`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /^Strategy$/ }).first()).toBeVisible({ timeout: 15000 });
    // Tab through the surface: focus must always land on a visible, named control.
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement)) return null;
        const name = el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("title") ?? el.tagName;
        const rect = el.getBoundingClientRect();
        return { name: name.trim().slice(0, 80), tag: el.tagName, visible: rect.width > 0 && rect.height > 0 };
      });
      if (focused === null) break;
      if (focused.name === "" && focused.tag === "NEXTJS-PORTAL") continue;
      expect(focused.visible, `focused control "${focused.name}" must be visible`).toBe(true);
    }
  });
});
