import { defineConfig, devices } from "@playwright/test";

// E2E_BASE_URL points to a Compose-managed frontend. Playwright deliberately
// does not start a Vite server: the suite exercises the deployed proxy shape
// and should fail clearly when that stack has not been started.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "/tmp/ip-intel-playwright-results",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
