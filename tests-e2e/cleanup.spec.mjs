import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";

test.describe("cleanup (settings)", () => {
  test("scan lists orphaned data; purge profiles toasts", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    await page.locator("#btn-settings").click();
    await expect(page.locator(".modal-overlay")).toBeVisible();

    // Scan surfaces orphaned profiles + workspaces with their action buttons.
    await page.locator("#settings-cleanup-scan").click();
    const results = page.locator("#cleanup-results");
    await expect(results).toBeVisible();
    await expect(results).toContainText("orphaned Chrome profile");
    await expect(results).toContainText("orphaned workspace");
    await expect(page.locator("#cleanup-purge-profiles")).toBeVisible();
    await expect(page.locator("#cleanup-quarantine-ws")).toBeVisible();

    // Purge the (default-checked) profile → POST /api/cleanup/purge → toast.
    await page.locator("#cleanup-purge-profiles").click();
    await expect(
      page.locator("#toasts .toast__body").filter({ hasText: "Deleted 1 profile" })
    ).toBeVisible();
  });

  test("empty scan re-enables the Scan button (regression)", async ({ page }) => {
    await setupHarness(page);
    // Scan finds nothing → the handler's early return must still re-enable the
    // button (a finally), otherwise it stays stuck on "Scanning…".
    await page.route("**/api/cleanup/scan", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profiles: [], workspaces: [] }) })
    );
    await page.goto("/");
    await page.locator("#btn-settings").click();

    const scanBtn = page.locator("#settings-cleanup-scan");
    await scanBtn.click();
    await expect(page.locator("#cleanup-results")).toContainText("No orphaned data found");
    await expect(scanBtn).toBeEnabled();
    await expect(scanBtn).toHaveText("Scan");
  });
});
