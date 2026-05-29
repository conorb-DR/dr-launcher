import { defineConfig, devices } from "@playwright/test";

// Frontend smoke harness. Drives the REAL public/index.html + app.js against a
// lightweight static server (tests-e2e/server.mjs); all /api/* is stubbed
// in-browser via page.route (see tests-e2e/mocks.mjs). Port 3457 avoids the
// real launcher's 3456.
const PORT = 3457;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests-e2e",
  testMatch: "**/*.spec.mjs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node tests-e2e/server.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { E2E_PORT: String(PORT) },
  },
});
