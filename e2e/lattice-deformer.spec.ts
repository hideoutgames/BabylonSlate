import { expect, test } from "@playwright/test";
import type { runLatticeDeformerProof } from "../apps/editor/src/testing/lattice-deformer-proof";
import type { runLatticeDeformerCost } from "../apps/editor/src/testing/lattice-deformer-cost";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { renderingEvidence } from "./rendering-evidence";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`lattice follows WPO and animation without shared-material bleed on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || (message.type() === "warning" && /shader|GPUValidation|validation error|INVALID_/i.test(message.text()))) errors.push(message.text());
    });
    await page.goto("/?test=1&latticeDeformerProof=1");
    await page.waitForFunction(() => "__latticeDeformerProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as {
      __latticeDeformerProof: typeof runLatticeDeformerProof;
    }).__latticeDeformerProof(backend), backend);
    await testInfo.attach("lattice-rendering-proof", { body: JSON.stringify({ ...report,
      evidence: renderingEvidence("apps/editor/src/testing/lattice-deformer-proof.ts") }), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(report.effectiveBackend).toBe(backend);
    expect(report.geometryUnchanged).toBe(true);
    for (const result of report.cases) {
      expect(result.referencePixels, result.name).toBeGreaterThan(300);
      expect(result.mismatchFraction, result.name).toBeLessThan(0.02);
      if (result.compareLighting) expect(result.meanColorError, result.name).toBeLessThan(3);
      expect(result.detachedOutline, result.name).toBe(0);
      if (result.boundary) expect(result.coveredBoundary / result.boundary, result.name).toBeGreaterThanOrEqual(0.95);
    }
  });
}

test("measure stock and post-WPO lattice vertex costs", async ({ page }, testInfo) => {
  test.skip(process.env.BL_PERF_LATTICE !== "1", "Explicit sustained lattice measurement only");
  test.setTimeout(3_600_000);
  await page.goto("/?test=1&latticeDeformerCost=1");
  await page.waitForFunction(() => "__latticeDeformerCost" in window);
  const report = await page.evaluate(() => (window as unknown as {
    __latticeDeformerCost: typeof runLatticeDeformerCost;
  }).__latticeDeformerCost("webgl2"));
  await testInfo.attach("lattice-cost-measurements", { body: JSON.stringify({ ...report,
    evidence: renderingEvidence("apps/editor/src/testing/lattice-deformer-cost.ts") }), contentType: "application/json" });
  expect(report.effectiveBackend).toBe("webgl2");
  for (const measurement of report.measurements) {
    expect(measurement.vertices).toBe(measurement.requestedVertices);
    expect(measurement.cpuSubmissionMs.count).toBeGreaterThan(0);
    expect(measurement.frameIntervalMs.count).toBeGreaterThan(0);
  }
});
