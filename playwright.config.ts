import { defineConfig, devices } from "@playwright/test";

const IPAD_TOUCH = {
  hasTouch: true,
  deviceScaleFactor: 2,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "ipad-landscape",
      use: {
        ...devices["iPad Pro 11 landscape"],
        ...IPAD_TOUCH,
        browserName: "chromium",
      },
    },
    {
      name: "ipad-portrait",
      use: {
        ...devices["iPad Pro 11"],
        ...IPAD_TOUCH,
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command:
      "VITE_TEST_MODE=true pnpm --filter editor build && pnpm --filter editor preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
