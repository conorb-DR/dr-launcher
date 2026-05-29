import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";

test.describe("diagnostics view", () => {
  test("sidebar nav opens the view; re-check + copy support bundle work", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    // Navigate via the Tools sidebar nav item.
    await page.locator('[data-nav="diagnostics"]').click();

    // View renders with its header and the system-health card (rows populated
    // from the /api/health fixture).
    await expect(page.locator(".page-header__title")).toHaveText("Diagnostics");
    await expect(page.locator(".diag-card")).toBeVisible();
    await expect(page.locator(".diag-card__body")).not.toBeEmpty();

    // Re-check re-runs the health check and toasts (no clipboard involved).
    await page.locator("#diag-recheck").click();
    await expect(
      page.locator("#toasts .toast__body").filter({ hasText: "Health check complete" })
    ).toBeVisible();

    // Copy support bundle fetches the diagnostics payload. Assert the request
    // (the clipboard write itself is environment-dependent in headless).
    const [req] = await Promise.all([
      page.waitForRequest("**/api/diagnostics"),
      page.locator("#diag-copy").click(),
    ]);
    expect(req.method()).toBe("GET");
  });

  test("env-card link also opens the diagnostics view", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    await page.locator("#open-diagnostics").click();
    await expect(page.locator(".page-header__title")).toHaveText("Diagnostics");
  });
});
