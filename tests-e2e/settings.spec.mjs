import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";
import { ID } from "./fixtures.mjs";

const hiddenOne = (page) => page.locator(`.tbl__row[data-id="${ID["user@hidden-one.com"]}"]`);
const coverageHint = (page) => page.locator(".prereq-banner", { hasText: "customer-user account" });

async function openSettings(page) {
  await page.locator("#btn-settings").click();
  await expect(page.locator(".modal-overlay")).toBeVisible();
}

test.describe("show-all-accounts setting", () => {
  test("toggle reveals then hides customer-user accounts", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await expect(page.locator(".tbl__row")).toHaveCount(7);

    await openSettings(page);
    const toggle = page.locator("#set-show-all-accounts");
    await expect(toggle).not.toHaveClass(/is-on/);

    // ON → all 9 accounts, hidden ones appear, coverage hint gone.
    await toggle.click();
    await expect(toggle).toHaveClass(/is-on/);
    await expect(hiddenOne(page)).toBeVisible();
    await expect(page.locator(".tbl__row")).toHaveCount(9);
    await expect(coverageHint(page)).toHaveCount(0);

    // OFF → back to 7, hidden ones gone, coverage hint returns.
    await toggle.click();
    await expect(toggle).not.toHaveClass(/is-on/);
    await expect(hiddenOne(page)).toHaveCount(0);
    await expect(page.locator(".tbl__row")).toHaveCount(7);
    await expect(coverageHint(page)).toContainText("2 customer-user accounts hidden");
  });

  test("persists across reload (round-trip)", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    await openSettings(page);
    await page.locator("#set-show-all-accounts").click();
    await expect(page.locator("#set-show-all-accounts")).toHaveClass(/is-on/);
    await expect(page.locator(".tbl__row")).toHaveCount(9);

    // Reload: the stubbed backend remembers the saved setting.
    await page.reload();
    await expect(page.locator(".tbl__row")).toHaveCount(9);
    await expect(hiddenOne(page)).toBeVisible();
    await expect(coverageHint(page)).toHaveCount(0);

    // And the toggle reflects the restored state.
    await openSettings(page);
    await expect(page.locator("#set-show-all-accounts")).toHaveClass(/is-on/);
  });
});

test.describe("settings modal", () => {
  test("theme switch applies and marks the swatch active", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await openSettings(page);

    await page.locator('[data-palette="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('[data-palette="dark"]')).toHaveClass(/is-active/);
  });

  test("sync now triggers a status refresh", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await openSettings(page);

    const [req] = await Promise.all([
      page.waitForRequest("**/api/sync/status"),
      page.locator("#settings-sync-btn").click(),
    ]);
    expect(req.method()).toBe("GET");
  });

  test("copy diagnostics fetches the support bundle", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await openSettings(page);

    const [req] = await Promise.all([
      page.waitForRequest("**/api/diagnostics"),
      page.locator("#settings-copy-diag").click(),
    ]);
    expect(req.method()).toBe("GET");
  });

  test("health re-check toasts; VD toggle is gated when unavailable", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await openSettings(page);

    // VD unavailable in the fixture → toggle disabled (gating logic).
    await expect(page.locator("#set-vd")).toBeDisabled();

    await page.locator("#settings-health-recheck").click();
    await expect(
      page.locator("#toasts .toast__body").filter({ hasText: "Health check complete" })
    ).toBeVisible();
  });

  test("install DR CLI from the health card streams status + toasts", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");
    await openSettings(page);

    // The dr-CLI health row carries an Install/Update button + status span.
    await page.locator("#settings-cli-install").click();
    await expect(page.locator("#cli-install-status")).toContainText("Starting");

    await page.evaluate(() => window.__emitES("/api/cli/install", { type: "done", data: "ok" }));
    await expect(page.locator("#cli-install-status")).toContainText("Installed");
    await expect(
      page.locator("#toasts .toast__body").filter({ hasText: "DR CLI installed/updated successfully" })
    ).toBeVisible();
  });
});
