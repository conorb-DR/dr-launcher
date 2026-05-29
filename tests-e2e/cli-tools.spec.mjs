import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";

test.describe("CLI tools view", () => {
  test("sidebar nav opens the view and shows the installed version", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    await page.locator('[data-nav="cli-tools"]').click();

    await expect(page.locator(".page-header__title")).toHaveText("DR CLI");
    await expect(page.locator(".cli-tools-card")).toHaveCount(3);
    // Version hint resolves from the /api/cli/version stub.
    await expect(page.locator("#cli-version-info")).toContainText("Installed: 1.2.3");
  });

  test("install flow streams output and toasts on completion", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await page.locator('[data-nav="cli-tools"]').click();
    await expect(page.locator("#cli-version-info")).toContainText("Installed: 1.2.3");

    // Start the install: button locks, output panel opens, SSE connects.
    await page.locator("#cli-install-btn").click();
    await expect(page.locator("#cli-install-btn")).toBeDisabled();
    await expect(page.locator("#cli-install-output")).toBeVisible();

    // Script the install stream (stdout → done).
    await page.evaluate(() => window.__emitES("/api/cli/install", { type: "stdout", data: "downloading package...\n" }));
    await expect(page.locator("#cli-install-output")).toContainText("downloading package");

    await page.evaluate(() => window.__emitES("/api/cli/install", { type: "done", data: "installed v1.2.4" }));
    await expect(
      page.locator("#toasts .toast__body").filter({ hasText: "DR CLI installed/updated successfully" })
    ).toBeVisible();
    await expect(page.locator("#cli-install-btn")).toBeEnabled();
  });
});
