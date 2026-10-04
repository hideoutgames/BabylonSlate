import { expect, test } from "@playwright/test";
import type { runTextMaterialProof } from "../apps/editor/src/testing/text-material-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Text Materials preserve bitmap and MSDF letter coverage on ${backend}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&textMaterialProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __textMaterialProof?: unknown }).__textMaterialProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __textMaterialProof: typeof runTextMaterialProof }).__textMaterialProof(backend), backend);
    expect(errors).toEqual([]);
    expect(result.releasedMaterials).toBeGreaterThan(0);
    for (const capture of result.captures) {
      let visible = 0, preserved = 0, holes = 0, leaked = 0;
      for (let i = 0; i < capture.before.length; i += 4) {
        if (capture.before[i + 1]! > 100) {
          visible++;
          if (capture.after[i]! < 10 && capture.after[i + 1]! > 100 && capture.after[i + 2]! < 10) preserved++;
        } else if (capture.before[i + 1]! < 5) {
          if (capture.after[i + 1]! < 5) holes++;
          if (capture.after[i + 1]! > 10) leaked++;
        }
      }
      expect(visible, capture.renderer).toBeGreaterThan(50);
      expect(preserved / visible, capture.renderer).toBeGreaterThan(0.95);
      expect(holes, capture.renderer).toBeGreaterThan(5000);
      expect(leaked, capture.renderer).toBeLessThan(visible * 0.3 + 8);
    }
  });
}
