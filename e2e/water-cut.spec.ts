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
    for (const material of ["opaque", "translucent", "waves", "lit"]) {
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
    // The translucent Materials drew their depth pre-pass as its own program, and the starter its geometry pass.
    expect(result.prePassEffects).toBeGreaterThanOrEqual(1);
    expect(result.geometryEffects).toBeGreaterThanOrEqual(1);
    expect(result.starterCopied).toBe(true);
    // The water starter drew: clear water, it tints the magenta background it refracts (most of the lake, measured).
    let drawn = 0;
    for (let index = 0; index < result.starterPixels.length; index += 4) {
      const [r, g, b] = [result.starterPixels[index]!, result.starterPixels[index + 1]!, result.starterPixels[index + 2]!];
      if (255 - r + g + 255 - b > 24) drawn++;
    }
    expect(drawn).toBeGreaterThan(result.width * result.height / 10);
    // In dense fog, water that shows only what lies below it draws the floor as the view sees it without the water:
    // the floor's own fog once, not the water's fog over it again. Inside the floor only: the downsampled scene copy
    // softens its silhouette.
    const onFloor = (x: number, y: number) => x >= 0 && y >= 0 && x < result.width && y < result.height &&
      !background(result.fogDirect, (y * result.width + x) * 4) && !background(result.fogThrough, (y * result.width + x) * 4);
    let floor = 0, apart = 0;
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      if (![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => onFloor(x + dx!, y + dy!))) continue;
      floor++;
      const index = (y * result.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) apart += Math.abs(result.fogDirect[index + channel]! - result.fogThrough[index + channel]!);
    }
    expect(floor).toBeGreaterThan(result.width * result.height / 6);
    expect(apart / (floor * 3)).toBeLessThan(3);
  });
}
