import { expect, test } from "@playwright/test";
import type { runSharedOutlineCostProof } from "../apps/editor/src/testing/shared-outline-cost-proof";
import { renderingEvidence } from "./rendering-evidence";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// Local cost qualification uses the available adapter. Hosted CI uses software
// for lifetime invariants only; its timings never qualify desktop GPU cost.
const graphicsArguments = process.env.CI ? SOFTWARE_WEBGPU_ARGS : [];
// Preserve the selected local performance project's hardware launch options.
if (process.env.CI) test.use({ launchOptions: { args: graphicsArguments } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`shared outline fixed-output cost and repeated retirement on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?test=1&sharedOutlineCostProof=1");
    await page.waitForFunction(() => "__babylonslateSharedOutlineCostProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as {
      __babylonslateSharedOutlineCostProof: typeof runSharedOutlineCostProof;
    }).__babylonslateSharedOutlineCostProof(backend), backend).catch(async (error: unknown) => {
      await testInfo.attach("shared-outline-cost-failure", { body: JSON.stringify({
        progress: await page.getByTestId("shared-outline-cost-progress").textContent(), errors,
        evidence: renderingEvidence("apps/editor/src/testing/shared-outline-cost-proof.ts"),
      }), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("shared-outline-cost", { body: JSON.stringify({ ...report,
      evidence: { ...renderingEvidence("apps/editor/src/testing/shared-outline-cost-proof.ts"), graphicsArguments }, errors }), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(report.effectiveBackend).toBe(backend);
    for (const sample of report.measurements) {
      expect([sample.width, sample.height, sample.scalingLevel]).toEqual([640, 360, 1]);
      expect(sample.cpuMs.count).toBe(60);
      expect(sample.passes.drawingPassCount).toBeLessThanOrEqual(4);
      expect(sample.passes.renderRecordCount).toBeLessThanOrEqual(7);
      expect(sample.after, `${sample.count} ${sample.mode}: steady resources`).toEqual(sample.before);
      if (sample.mode.startsWith("off")) {
        expect(sample.passes.drawingPassCount).toBe(0);
        expect(sample.reservations.resourceBytes).toBe(0);
        expect(sample.reservations.pendingBytes).toBe(0);
      }
    }
    for (const sample of report.lifecycle) {
      expect(sample.passes.drawingPassCount).toBe(0);
      expect(sample.reservations.resourceBytes).toBe(0);
      expect(sample.reservations.pendingBytes).toBe(0);
      expect(sample.owner.instanceBufferBytes).toBe(0);
    }
  });
}
