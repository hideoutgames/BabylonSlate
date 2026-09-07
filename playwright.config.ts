import { defineConfig, devices } from "@playwright/test";
import { IPAD_TEST_GREP } from "./e2e/ipad-tag";

const IPAD_TOUCH = {
  hasTouch: true,
  deviceScaleFactor: 2,
};

const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const testBaseURL = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "./e2e",
  // Dirty Play saves/compiles and collects materials before the overlay mounts.
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Shared origin OPFS (`TestProject`) cannot run two browser workers at once.
  workers: 1,
  reporter: "list",
  use: {
    baseURL: testBaseURL,
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
  webServer: {
    command:
      `pnpm --filter editor build && pnpm --filter editor preview -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    env: { VITE_TEST_MODE: "true" },
    url: testBaseURL,
    reuseExistingServer: !process.env.CI && !process.env.PLAYWRIGHT_PORT,
    timeout: 180_000,
  },
});
