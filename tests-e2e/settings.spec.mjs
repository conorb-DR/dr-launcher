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
