import { expect, test } from "@playwright/test";
import type { runFsrUpscalingProof } from "../apps/editor/src/testing/fsr-upscaling-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`FSR upscaling reconstructs a half-resolution frame on ${backend}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || (message.type() === "warning" && /shader|GPUValidation|validation error|INVALID_/i.test(message.text()))) errors.push(message.text());
    });
    await page.goto("/?test=1&fsrUpscalingProof=1");
    await page.waitForFunction(() => "__fsrUpscalingProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as {
      __fsrUpscalingProof: typeof runFsrUpscalingProof;
    }).__fsrUpscalingProof(backend), backend);
    expect(errors).toEqual([]);
    expect(report.effectiveBackend).toBe(backend);
    // Same shape, rebuilt from a quarter of the pixels: only edges differ.
    expect(report.coverageRatio).toBeGreaterThan(0.95);
    expect(report.coverageRatio).toBeLessThan(1.05);
    expect(report.differingFraction).toBeGreaterThan(0);
    expect(report.differingFraction).toBeLessThan(0.1);
    expect(report.meanError).toBeLessThan(8);
  });
}
