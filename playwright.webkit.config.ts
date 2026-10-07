import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";
import { WEBKIT_SMOKE_GREP } from "./e2e/ipad-tag";

/**
 * Optional WebKit (Safari engine) smoke lane. Not part of PR Verify: it runs
 * through .github/workflows/webkit-smoke.yml on pushes to main and on demand.
 * Run locally through the owned test server and resource admission:
 *   pnpm test:e2e:webkit
 * Only tests tagged WEBKIT_SMOKE_TAG run; each is also an ordinary desktop test.
 */
export default defineConfig({
  ...base,
  // Software WebGL in headless WebKit is slower than Chromium's SwiftShader.
  timeout: 120_000,
  outputDir: "test-results/webkit",
  use: { ...base.use, trace: "retain-on-failure" },
  projects: [
    {
      name: "ipad-webkit",
      grep: WEBKIT_SMOKE_GREP,
      use: { ...devices["iPad Pro 11 landscape"], browserName: "webkit" },
    },
  ],
});
