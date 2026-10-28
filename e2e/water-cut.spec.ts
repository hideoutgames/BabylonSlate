import { expect, test } from "@playwright/test";
import type { runWaterCutProof } from "../apps/editor/src/testing/water-cut-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const background = (pixels: number[], index: number) => pixels[index]! > 200 && pixels[index + 1]! < 60 && pixels[index + 2]! > 200;
const water = (pixels: number[], index: number) => pixels[index + 1]! > pixels[index]! + 60 && pixels[index + 1]! > pixels[index + 2]! + 60;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`A removal volume cuts Custom Material water, in the depth pre-pass and the colour pass, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterCutProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __waterCutProof?: unknown }).__waterCutProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __waterCutProof: typeof runWaterCutProof }).__waterCutProof(backend), backend);
    await testInfo.attach(`water-cut-proof-${backend}`, { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    for (const material of ["opaque", "translucent", "waves"]) {
      const whole = result.captures.find((capture) => capture.material === material && !capture.cut)!.pixels;
      const cut = result.captures.find((capture) => capture.material === material && capture.cut)!.pixels;
      // The water fills most of the view, and the hole shows the background where the volume stands, and only there.
      let covered = 0, opened = 0, closed = 0, columns = 0;
      for (let index = 0; index < whole.length; index += 4) {
        if (water(whole, index)) covered++;
        if (water(whole, index) && background(cut, index)) { opened++; columns += (index / 4) % result.width; }
        if (background(whole, index) && !background(cut, index)) closed++;
      }
      expect(covered, material).toBeGreaterThan(result.width * result.height / 3);
      expect(opened, material).toBeGreaterThan(200);
      expect(Math.abs(columns / opened - result.holeX), material).toBeLessThan(8);
      // The waves move between the two draws, so a few silhouette pixels may change.
      expect(closed, material).toBeLessThan(opened / 10);
    }
    // The translucent Materials drew their depth pre-pass as its own program.
    expect(result.prePassEffects).toBeGreaterThanOrEqual(1);
  });
}
