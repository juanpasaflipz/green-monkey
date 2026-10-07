import { defineConfig, devices } from "@playwright/test";

/**
 * The restaurant-day go-live gate (specs/acceptance.md §2): one serial chain,
 * no retries, Chromium only, its own global setup (an isolated, demo-free,
 * production-mode web + worker) and its own report folders. Run it with
 * `npm run test:acceptance:day` (scripts/restaurant-day.sh).
 */
export default defineConfig({
  testDir: "tests/browser",
  testMatch: /restaurant-day\.spec\.ts/,
  globalSetup: "./tests/restaurant-day/global-setup.ts",
  globalTeardown: "./tests/restaurant-day/global-teardown.ts",
  outputDir: "test-results/restaurant-day/artifacts",
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  globalTimeout: 40 * 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:3390",
    headless: true,
    // A missing or disabled control fails within seconds, not at the test budget.
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: "playwright-report/restaurant-day", open: "never" },
    ],
    ["json", { outputFile: "test-results/restaurant-day/report.json" }],
  ],
});
