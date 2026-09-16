import { test, expect } from "@playwright/test";

import { login, openAdminPage, requireE2EAuth } from "./auth-fixtures";

test("Settings controls verification", async ({ page }) => {
  requireE2EAuth();
  const results: { step: string; pass: boolean; note?: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`PageError: ${e.message}`));

  try {
    await login(page);
    await openAdminPage(page, "Settings");
    await page.waitForURL(/\/settings/, { timeout: 5000 });
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible({ timeout: 5000 });

    results.push({ step: "1. Login and open Settings", pass: true });

    const searchSection = page.locator('section:has-text("Search & Enrichment")').first();
    await searchSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const cacheTtl = page.getByText("Cache TTL (days)").locator("..").locator("input");
    const stageB = page.getByText("Stage-B Min Score").locator("..").locator("input");
    const aiBatchLimit = page.getByText("AI Batch Limit").locator("..").locator("input");
    const aiEnabledCheckbox = page.getByRole("checkbox", { name: /Enable AI lead verification/i });
    const backfillBtn = page.getByRole("button", { name: "Backfill Canonical Places" });

    const hasCacheTtl = (await cacheTtl.count()) > 0;
    const hasStageB = (await stageB.count()) > 0;
    const hasAiBatchLimit = (await aiBatchLimit.count()) > 0;
    const hasAiEnabled = (await aiEnabledCheckbox.count()) > 0;
    const hasBackfill = (await backfillBtn.count()) > 0;

    results.push({ step: "Cache TTL (days)", pass: hasCacheTtl });
    results.push({ step: "Stage-B Min Score", pass: hasStageB });
    results.push({ step: "AI Batch Limit", pass: hasAiBatchLimit });
    results.push({ step: "Enable AI lead verification", pass: hasAiEnabled });
    results.push({ step: "Backfill Canonical Places", pass: hasBackfill });

    const origCache = await cacheTtl.inputValue();
    const origStageB = await stageB.inputValue();
    const origBatchLimit = await aiBatchLimit.inputValue();
    const origChecked = await aiEnabledCheckbox.isChecked();

    await cacheTtl.fill("99");
    await expect(cacheTtl).toHaveValue("99");
    await cacheTtl.fill(origCache);
    await expect(cacheTtl).toHaveValue(origCache);
    results.push({ step: "Cache TTL: change and revert", pass: true });

    await stageB.fill("4.5");
    await expect(stageB).toHaveValue("4.5");
    await stageB.fill(origStageB);
    await expect(stageB).toHaveValue(origStageB);
    results.push({ step: "Stage-B Min Score: change and revert", pass: true });

    await aiBatchLimit.fill("50");
    await expect(aiBatchLimit).toHaveValue("50");
    await aiBatchLimit.fill(origBatchLimit);
    await expect(aiBatchLimit).toHaveValue(origBatchLimit);
    results.push({ step: "AI Batch Limit: change and revert", pass: true });

    await aiEnabledCheckbox.click();
    await expect(aiEnabledCheckbox).toBeChecked({ checked: !origChecked });
    await aiEnabledCheckbox.click();
    await expect(aiEnabledCheckbox).toBeChecked({ checked: origChecked });
    results.push({ step: "AI enabled checkbox: toggle and revert", pass: true });

    const saveBtn = page.getByRole("button", { name: "Save Settings" });
    await expect(saveBtn).toBeVisible();
    results.push({ step: "Did NOT click Save Settings", pass: true });

    results.push({ step: "No runtime errors", pass: errors.length === 0, note: errors.length ? errors.join("; ") : undefined });
  } catch (e) {
    results.push({ step: "Execution", pass: false, note: String(e) });
  }

  console.log("\n=== PASS/FAIL CHECKLIST ===");
  results.forEach((r) => console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.step}${r.note ? ` (${r.note})` : ""}`));
  if (errors.length) console.log("\nRuntime errors:", errors);

  const allPass = results.every((r) => r.pass);
  expect(allPass, `Failed: ${results.filter((r) => !r.pass).map((r) => r.step).join(", ")}`).toBeTruthy();
});
