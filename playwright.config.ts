import { defineConfig, devices } from "@playwright/test";
import { IPAD_TEST_GREP } from "./e2e/ipad-tag";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "4173");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PLAYWRIGHT_PORT must be an integer from 1 to 65535.");
}
const baseURL = `http://127.0.0.1:${port}`;

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
  reporter: "list",
  use: {
    baseURL,
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
      `pnpm --filter editor build && pnpm --filter editor preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_TEST_MODE: "true" },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
