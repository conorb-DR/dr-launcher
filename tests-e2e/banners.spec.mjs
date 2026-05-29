import { test, expect } from "@playwright/test";
import { setupHarness } from "./mocks.mjs";

const vdBanner = (page) => page.locator(".prereq-banner", { hasText: "Virtual Desktops" });
const coverageBanner = (page) => page.locator(".prereq-banner", { hasText: "customer-user account" });

test.describe("banners", () => {
  test("VD warning + coverage hint stack and dismiss independently", async ({ page }) => {
    await setupHarness(page);
    await page.goto("/");

    // Both banners present (same .prereq-banner component).
    await expect(page.locator(".prereq-banner")).toHaveCount(2);
    await expect(vdBanner(page)).toBeVisible();
    await expect(coverageBanner(page)).toBeVisible();

    // Dismiss the VD banner → coverage hint remains (flows into its place).
    await page.locator("#prereq-banner-dismiss").click();
    await expect(vdBanner(page)).toHaveCount(0);
    await expect(coverageBanner(page)).toBeVisible();
    await expect(page.locator(".prereq-banner")).toHaveCount(1);

    // Dismiss the coverage hint → no banners left.
    await page.locator("#coverage-banner-dismiss").click();
    await expect(page.locator(".prereq-banner")).toHaveCount(0);
  });
});
