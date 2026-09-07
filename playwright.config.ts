import { defineConfig, devices } from "@playwright/test";
import { IPAD_TEST_GREP } from "./e2e/ipad-tag";

const IPAD_TOUCH = {
  hasTouch: true,
  deviceScaleFactor: 2,
};

export default defineConfig({
  testDir: "./e2e",
  // Dirty Play saves/compiles and collects materials before the overlay mounts.
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Shared origin OPFS (`TestProject`) cannot run two browser workers at once.
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/timings.json" }]],
  globalSetup: "./e2e/verify-test-server.ts",
  use: {
    baseURL: process.env.BL_TEST_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "ipad-landscape",
      // Touch / coarse-pointer / landscape viewport. Tag those tests with IPAD_TEST_TAG.
      // iPad portrait is unsupported — do not add an ipad-portrait project.
      grep: IPAD_TEST_GREP,
      use: {
        ...devices["iPad Pro 11 landscape"],
        ...IPAD_TOUCH,
        browserName: "chromium",
      },
    },
  ],
});
