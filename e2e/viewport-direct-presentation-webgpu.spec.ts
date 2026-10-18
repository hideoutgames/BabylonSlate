import { test } from "@playwright/test";
import { directViewportStaysNonBlank } from "./direct-presentation-probe";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// Software adapter for a functional proof, as in webgpu-backend.spec.ts.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

test("a directly presented WebGPU viewport stays non-blank across held frames and a resize", async ({ page }) => {
  test.setTimeout(180_000);
  await directViewportStaysNonBlank(page, "webgpu");
});
