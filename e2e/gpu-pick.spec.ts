import { expect, test } from "@playwright/test";
import type { runGpuPickProof } from "../apps/editor/src/testing/gpu-pick-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`1×1 GPU object-ID pick follows drawn geometry at any pixel on ${backend}`, async ({ page }) => {
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
    for (const projection of ["orthographic", "perspective"] as const) {
      const picks = report[projection];
      expect(picks.plain, projection).toEqual({ gpu: "Plain", cpu: "Plain" });
      // The CPU ray tests bind-pose positions; the GPU pass sees the drawn box.
      expect(picks.displacedDrawn, projection).toEqual({ gpu: "Displaced", cpu: null });
      expect(picks.displacedBindPose, projection).toEqual({ gpu: null, cpu: "Displaced" });
      expect(picks.background, projection).toEqual({ gpu: null, cpu: null });
      // Corner pixels: a wrong pick projection or read-back row hits another corner.
      expect(picks.topLeft, projection).toEqual({ gpu: "Top Left", cpu: "Top Left" });
      expect(picks.topRight, projection).toEqual({ gpu: "Top Right", cpu: "Top Right" });
      expect(picks.bottomLeft, projection).toEqual({ gpu: "Bottom Left", cpu: "Bottom Left" });
      expect(picks.bottomRightDisplaced, projection).toEqual({ gpu: "Displaced Corner", cpu: null });
      expect(picks.displacedCornerBindPose, projection).toEqual({ gpu: null, cpu: "Displaced Corner" });
      // Far draws after Near on the same edge pixel; depth keeps Near.
      expect(picks.leftEdgeOccluded, projection).toEqual({ gpu: "Near", cpu: "Near" });
    }
    // The pick renders only the tapped pixel: no full-view (240×160) targets.
    expect(report.pickTargetSizes).toEqual(["1x1"]);
  });
}
