import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/delivery-browser",
  testMatch: /(?:delivery|uber)\.spec\.ts/,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5189",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "npm run dev:ui -- --port 5189 --strictPort",
    url: "http://127.0.0.1:5189",
    reuseExistingServer: false,
  },
});
