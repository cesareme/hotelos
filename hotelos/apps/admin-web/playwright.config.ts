import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for admin-web E2E smoke tests.
 *
 * Notes:
 *  - These tests are tolerant: if the app requires authentication and the
 *    current environment doesn't auto-bypass (e.g. dev seed user), the spec
 *    will skip the body with a TODO marker rather than fail. The goal here is
 *    to validate that the critical demo flows render without runtime errors.
 *  - Sequential (1 worker) so that drawer / quick-checkin flows do not race
 *    each other on shared mock state.
 *  - Assumes the dev server is already running on http://localhost:5173.
 *    Start it manually before invoking `npm run e2e -w @hotelos/admin-web`:
 *      npm --workspace @hotelos/admin-web run dev
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
