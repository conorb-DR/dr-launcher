import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";

test.describe("boot", () => {
  test("authenticated boot reveals the app shell and renders the account list", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    await expect(page.locator("#login-screen")).toBeHidden();
    await expect(page.locator("#app-shell")).toBeVisible();
    await expect(page.locator("#app-shell")).toContainText("Customers");
    await expect(page.locator(".tbl__row").first()).toBeVisible();
  });
});
