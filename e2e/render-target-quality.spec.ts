import { expect, test } from "@playwright/test";
import type { runRenderTargetQualityCost, runRenderTargetQualityProof } from "../apps/editor/src/testing/render-target-quality-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type ProofWindow = {
  __renderTargetQualityProof: typeof runRenderTargetQualityProof;
  __renderTargetQualityCost: typeof runRenderTargetQualityCost;
};

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`a Full Quality capture of water matches the scene view and a Fast one does not on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || (message.type() === "warning" &&
        /shader|GPUValidation|validation error|INVALID_|feedback loop|conflicting usages/i.test(message.text()))) errors.push(message.text());
    });
    await page.goto("/?test=1&renderTargetQualityProof=1");
    await page.waitForFunction(() => "__renderTargetQualityProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as ProofWindow).__renderTargetQualityProof(backend), backend);
    await testInfo.attach("render-target-quality", { body: JSON.stringify(report), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(report.effectiveBackend).toBe(backend);
    expect(report.mainCameraPreserved).toBe(true);
    expect(report.retainedBytes).toBe(0);
    for (const [label, result] of Object.entries(report.cases)) {
      // Full Quality draws the water through its own scene copy, like the view.
      expect(result.waterCopy, label).toBe(true);
      expect(result.fullQuality, label).toBeLessThan(1.5);
      // Fast draws blended water without refraction: visibly different.
      expect(result.fast, label).toBeGreaterThan(Math.max(4, result.fullQuality * 4));
    }
  });
}

// Opt-in measurement (BL_RENDER_TARGET_COST=1): capture cost per frame on this device.
test("capture cost per frame for Fast and Full Quality", async ({ page }, testInfo) => {
  test.skip(process.env.BL_RENDER_TARGET_COST !== "1", "Opt-in measurement.");
  test.setTimeout(600_000);
  await page.goto("/?test=1&renderTargetQualityProof=1");
  await page.waitForFunction(() => "__renderTargetQualityCost" in window);
  const reports: Array<Awaited<ReturnType<typeof runRenderTargetQualityCost>> | { backend: string; unavailable: string }> = [];
  for (const backend of ["webgl2", "webgpu"] as const) {
    try {
      reports.push(await page.evaluate((backend) => (window as unknown as ProofWindow).__renderTargetQualityCost(backend), backend));
    } catch (error) {
      // A native run may have no WebGPU adapter; record it rather than lose the other backend.
      reports.push({ backend, unavailable: String(error).slice(0, 200) });
    }
  }
  await testInfo.attach("render-target-quality-cost", { body: JSON.stringify(reports, null, 2), contentType: "application/json" });
  for (const report of reports) if ("retainedBytes" in report) expect(report.retainedBytes).toBe(0);
  expect(reports.some((report) => "retainedBytes" in report)).toBe(true);
});
