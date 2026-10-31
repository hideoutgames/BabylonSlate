import { expect, test } from "@playwright/test";
import type { runWaterSeamProof } from "../apps/editor/src/testing/water-seam-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const background = (pixels: number[], index: number) => pixels[index]! > 200 && pixels[index + 1]! < 60 && pixels[index + 2]! > 200;
const ocean = (pixels: number[], index: number) => pixels[index + 2]! > pixels[index]! + 60 && pixels[index + 2]! > pixels[index + 1]! + 60;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Global Water and an Ocean meet without a gap from near and far, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterSeamProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __waterSeamProof?: unknown }).__waterSeamProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __waterSeamProof: typeof runWaterSeamProof }).__waterSeamProof(backend), backend);
    await testInfo.attach(`water-seam-proof-${backend}`, { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    for (const view of result.views) {
      // The seam lies on the Ocean's outline: look within a few pixels of it, not at the far horizon.
      const xs = view.corners.map((c) => c[0]!), ys = view.corners.map((c) => c[1]!);
      const left = Math.min(...xs) - 6, right = Math.max(...xs) + 6, bottom = Math.min(...ys) - 6, top = Math.max(...ys) + 6;
      let gaps = 0, changed = 0, blue = 0;
      const where: string[] = [];
      for (let index = 0; index < view.first.length; index += 4) {
        const x = (index / 4) % result.width, y = Math.floor(index / 4 / result.width);
        if (ocean(view.first, index)) blue++;
        if (ocean(view.first, index) !== ocean(view.second, index)) changed++;
        if (x < left || x > right || y < bottom || y > top) continue;
        // Around the Ocean the view sees water only: any background is a gap between the bodies.
        if (background(view.first, index) || background(view.second, index)) {
          gaps++;
          if (where.length < 12) where.push(`${x},${y}`);
        }
      }
      const at = `${view.camera.join(", ")}: ${where.join(" ")} (Ocean corners ${view.corners.map((c) => c.join(",")).join(" ")})`;
      expect(blue, at).toBeGreaterThan(0);
      expect(gaps, at).toBe(0);
      // Nothing moves between the two draws: the seam does not flicker.
      expect(changed, at).toBe(0);
    }
  });
}
