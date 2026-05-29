import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";
import { ID } from "./fixtures.mjs";

test.describe("account visibility (support-only default)", () => {
  test("shows support + kept session, hides other customer users, with coverage hint", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    // 6 support + 1 customer-user kept (active session) = 7 rows.
    await expect(page.locator(".tbl__row")).toHaveCount(7);

    // Coverage hint reflects the 2 hidden customer-user accounts.
    const hint = page.locator(".prereq-banner", { hasText: "customer-user account" });
    await expect(hint).toContainText("2 customer-user accounts hidden");

    // The kept customer-user (active session) is visible AND badged USER.
    const shacharUser = page.locator(`.tbl__row[data-id="${ID["user@ai.exercise.shachar.com"]}"]`);
    await expect(shacharUser).toBeVisible();
    await expect(shacharUser.locator(".st-badge", { hasText: "USER" })).toBeVisible();

    // The session-less customer-user accounts are hidden.
    await expect(page.locator(`.tbl__row[data-id="${ID["user@hidden-one.com"]}"]`)).toHaveCount(0);
    await expect(page.locator(`.tbl__row[data-id="${ID["user@hidden-two.com"]}"]`)).toHaveCount(0);
  });
});
