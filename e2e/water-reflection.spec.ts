import { expect, test } from "@playwright/test";
import type { runWaterReflectionProof } from "../apps/editor/src/testing/water-reflection-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const red = (pixels: number[], index: number) =>
  pixels[index]! > 90 && pixels[index]! > pixels[index + 1]! * 2 + 20 && pixels[index]! > pixels[index + 2]! * 2 + 20;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Custom Material water mirrors scene objects in the view's planar reflection, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterReflectionProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __waterReflectionProof?: unknown }).__waterReflectionProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __waterReflectionProof: typeof runWaterReflectionProof }).__waterReflectionProof(backend), backend);
    await testInfo.attach(`water-reflection-proof-${backend}`, { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    const pixels = (reflections: string) => result.captures.find((capture) => capture.reflections === reflections)!.pixels;
    // The pole's reflection: red pixels at Planar quality that Sky quality leaves without.
    const planar = pixels("planar"), sky = pixels("sky"), found: number[] = [];
    for (let index = 0; index < planar.length; index += 4) if (red(planar, index) && !red(sky, index)) found.push(index / 4);
    expect(found.length).toBeGreaterThan(60);
    // Below the pole (centred in the view): the reflection's mean column is the view's middle.
    const column = found.reduce((sum, pixel) => sum + pixel % result.width, 0) / found.length;
    expect(Math.abs(column - result.width / 2)).toBeLessThan(6);
  });
}
