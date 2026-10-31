import { expect, test } from "@playwright/test";
import type { runWaterCoverageProof } from "../apps/editor/src/testing/water-coverage-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Water Mesh Density: Low's, Medium and High's, and Ultra's. */
const DENSITIES = [0.75, 1, 1.5] as const;
const background = (pixels: number[], index: number) => pixels[index]! > 200 && pixels[index + 1]! < 60 && pixels[index + 2]! > 200;

for (const backend of ["webgl2", "webgpu"] as const) {
  for (const density of DENSITIES) {
    test(`blended water covers the whole frame with far neighbours at Water Mesh Density ${density} on ${backend}`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()) &&
          /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
      });
      await page.goto("/?test=1&waterCoverageProof=1");
      await page.waitForFunction(() => typeof (window as unknown as { __waterCoverageProof?: unknown }).__waterCoverageProof === "function");
      const result = await page.evaluate(([backend, density]) =>
        (window as unknown as { __waterCoverageProof: typeof runWaterCoverageProof }).__waterCoverageProof(backend, density), [backend, density] as const);
      expect(errors).toEqual([]);
      const holes = result.views.map((view) => {
        const where: string[] = [];
        let count = 0;
        for (let index = 0; index < view.pixels.length; index += 4) {
          if (!background(view.pixels, index)) continue;
          count++;
          const x = (index / 4) % result.width, row = Math.floor(index / 4 / result.width);
          if (where.length < 12) where.push(`${x},${result.flipped ? result.height - 1 - row : row}`);
        }
        return { camera: view.camera.join(", "), count, where: where.join(" ") };
      });
      await testInfo.attach(`water-coverage-${backend}-${density}`, { body: JSON.stringify({ holes, result }), contentType: "application/json" });
      // Water fills every view to the top of the frame: any background is a hole no body keeps.
      for (const view of holes) expect(view.count, `${view.camera}: ${view.where}`).toBe(0);
    });
  }
}
