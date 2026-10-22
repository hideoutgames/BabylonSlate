import { defineConfig, devices } from "@playwright/test";

/**
 * Local performance-route configuration. Not used by CI. Run through the
 * owned test server (scripts/browser-session.mjs) so HAPTIC_TEST_BASE_URL and the
 * build identity are set, e.g.
 *   HAPTIC_PERF_ROUTE=1 node scripts/browser-session.mjs <test-build-dir> \
 *     --config playwright.perf.config.ts --project perf-gpu e2e/play-performance-route.spec.ts
 * The FeatureTest route (agents' default workload) is opt-in the same way:
 *   HAPTIC_PERF_FEATURE_TEST=1 pnpm run test:e2e e2e/feature-test-perf-route.spec.ts \
 *     --config playwright.perf.config.ts --project perf-software
 * The FeatureTest fly-through route counts camera-motion events per frame:
 *   HAPTIC_PERF_FLYTHROUGH=1 pnpm run test:e2e e2e/feature-test-flythrough-route.spec.ts \
 *     --config playwright.perf.config.ts --project perf-software
 * The FeatureTest cold-load route counts shader programs, modules and pipelines per scene load:
 *   HAPTIC_PERF_LOAD=1 pnpm run test:e2e e2e/feature-test-load-route.spec.ts \
 *     --config playwright.perf.config.ts --project perf-gpu
 * The editor-edit profiling route also needs a React profiling build:
 *   VITE_REACT_PROFILING=true pnpm run test:e2e e2e/editor-edit-profile.spec.ts \
 *     --config playwright.perf.config.ts --project perf-software
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /(?:play-(performance|sustained)-route|feature-test-(?:perf|flythrough|load)-route|editor-edit-profile|rendering-baseline|shared-outline|scalability-play|lattice-deformer|fixed-shape-lighting)\.spec\.ts$/,
  timeout: 600_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/timings.json" }]],
  metadata: { testRunNonce: process.env.HAPTIC_TEST_SERVER_NONCE },
  outputDir: "test-results/perf-route",
  globalSetup: "./e2e/verify-test-server.ts",
  use: {
    baseURL: process.env.HAPTIC_TEST_BASE_URL,
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
