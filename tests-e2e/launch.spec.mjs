import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";
import { LAUNCH_TARGET_ID } from "./fixtures.mjs";

const row = (page) => page.locator(`.tbl__row[data-id="${LAUNCH_TARGET_ID}"]`);
const launchBtn = (page) => row(page).locator('[data-row-action="launch"]');
const toastBody = (page) => page.locator("#toasts .toast__body");

test.describe("launch flow", () => {
  test("success: launching state → active session row + toast", async ({ page }) => {
    await setupHarness(page, { launchDelayMs: 600 });
    await page.goto("/");

    await launchBtn(page).click();

    // Transient launching state (during the delayed /api/launch). The row
    // carries two launching badges (status + action), so assert the row state.
    await expect(row(page)).toHaveAttribute("data-state", "launching");

    // Success toast, then the row flips to an active session (End button).
    await expect(toastBody(page).filter({ hasText: "Launched proshop.inc" })).toBeVisible();
    await expect(row(page).locator('[data-row-action="close-session"]')).toBeVisible();
  });

  test("support_only (403) surfaces a warning toast", async ({ page }) => {
    await setupHarness(page, { launch: "support_only" });
    await page.goto("/");

    await launchBtn(page).click();
    await expect(toastBody(page).filter({ hasText: "Launching a customer user account is disabled" })).toBeVisible();
  });

  test("account_type_unknown (428) surfaces a warning toast", async ({ page }) => {
    await setupHarness(page, { launch: "account_type_unknown" });
    await page.goto("/");

    await launchBtn(page).click();
    await expect(toastBody(page).filter({ hasText: "Couldn't verify this is a support account" })).toBeVisible();
  });
});
