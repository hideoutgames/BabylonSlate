import { expect, test } from "@playwright/test";
import type { runGpuPickProof } from "../apps/editor/src/testing/gpu-pick-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`GPU object-ID pick follows shader-displaced geometry on ${backend}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?test=1&gpuPickProof=1");
    await page.waitForFunction(() => "__gpuPickProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as {
      __gpuPickProof: typeof runGpuPickProof;
    }).__gpuPickProof(backend), backend);
    expect(errors).toEqual([]);
    expect(report.effectiveBackend).toBe(backend);
    expect(report.plain).toEqual({ gpu: "Plain", cpu: "Plain" });
    // The CPU ray tests bind-pose positions; the GPU pass sees the drawn box.
    expect(report.displacedDrawn).toEqual({ gpu: "Displaced", cpu: null });
    expect(report.displacedBindPose).toEqual({ gpu: null, cpu: "Displaced" });
    expect(report.background).toEqual({ gpu: null, cpu: null });
  });
}
