import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the Planning Poker SPA.
 *
 * The app is real-time: the FE (Vite) talks to the BE over a WebSocket at `/ws`,
 * which Vite's dev proxy upgrades to `ws://localhost:3000`. So e2e needs BOTH
 * servers running. Playwright's `webServer` boots them and waits on a readiness
 * URL before the suite starts. Reuse the FE port (5173) as the test baseURL.
 */

const FE_PORT = 5173;
const BE_PORT = 3000;
const BASE_URL = `http://localhost:${FE_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Boot BE first (FE proxies /ws to it), then FE. Playwright starts all entries
  // in parallel but each waits on its own readiness URL, so order is by readiness.
  webServer: [
    {
      command: "npm run dev:be",
      url: `http://localhost:${BE_PORT}/health`,
      // Never reuse the BE. /health only returns a 200 (no app/version identity), so a
      // stale BE left on :3000 would be silently adopted and the suite would run against
      // code that doesn't match the working tree — a meaningless pass/fail. Always boot a
      // BE from this tree; a port clash then fails loudly instead of running stale code.
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev:fe",
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
