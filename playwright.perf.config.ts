import { defineConfig, devices } from "@playwright/test";

/**
 * Local performance-route configuration. Not used by CI. Run through the
 * owned test server (scripts/browser-session.mjs) so BL_TEST_BASE_URL and the
 * build identity are set, e.g.
 *   BL_PERF_ROUTE=1 node scripts/browser-session.mjs <test-build-dir> \
 *     --config playwright.perf.config.ts --project perf-gpu e2e/play-performance-route.spec.ts
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /play-(performance|sustained)-route\.spec\.ts$/,
  timeout: 600_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/perf-route.json" }]],
  outputDir: "test-results/perf-route",
  globalSetup: "./e2e/verify-test-server.ts",
  use: {
    baseURL: process.env.BL_TEST_BASE_URL,
    trace: "off",
    video: "off",
  },
  projects: [
    {
      // Full Chromium in new headless mode with the machine GPU through ANGLE D3D11.
      name: "perf-gpu",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        launchOptions: {
          args: [
            "--use-angle=d3d11",
            "--ignore-gpu-blocklist",
            "--enable-gpu-rasterization",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
          ],
        },
      },
    },
    {
      // Headless shell defaults (software ANGLE/SwiftShader), matching the ordinary e2e project.
      name: "perf-software",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
