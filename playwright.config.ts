import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";

// The WebKit/iPad project runs the @cross tests wherever WebKit is installed
// (CI installs it: `npx playwright install --with-deps chromium webkit`).
const webkitInstalled = (() => {
  try {
    return existsSync(webkit.executablePath());
  } catch {
    return false;
  }
})();

export default defineConfig({
  testDir: "tests/browser",
  // The restaurant-day gate has its own config and production-mode servers
  // (playwright.restaurant-day.config.ts, npm run test:acceptance:day).
  testIgnore: ["**/restaurant-day.spec.ts"],
  // Keeps the demo restaurants' business day from rolling over mid-run.
  globalSetup: "./tests/browser/global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:5173",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    ...(webkitInstalled || process.env.CI
      ? [
          {
            name: "webkit-ipad",
            use: { ...devices["iPad (gen 7)"] },
            grep: /@cross/,
          },
        ]
      : []),
  ],
  reporter: [["list"], ["html", { open: "never" }]],
});
