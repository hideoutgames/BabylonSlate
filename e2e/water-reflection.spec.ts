import { expect, test } from "@playwright/test";
import type { runWaterReflectionProof } from "../apps/editor/src/testing/water-reflection-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const red = (pixels: number[], index: number) =>
  pixels[index]! > 90 && pixels[index]! > pixels[index + 1]! * 2 + 20 && pixels[index]! > pixels[index + 2]! * 2 + 20;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Custom Material water mirrors scene objects in the view's planar reflection as built-in water does, on ${backend}`, async ({ page }, testInfo) => {
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
    const pixels = (water: string, reflections: string) =>
      result.captures.find((capture) => capture.water === water && capture.reflections === reflections)!.pixels;
    // The pole's reflection: red pixels at Planar quality that Sky quality leaves without.
    const reflection = (water: string) => {
      const planar = pixels(water, "planar"), sky = pixels(water, "sky"), found: number[] = [];
      for (let index = 0; index < planar.length; index += 4) if (red(planar, index) && !red(sky, index)) found.push(index / 4);
      return found;
    };
    const builtIn = reflection("builtIn"), graph = new Set(reflection("graph"));
    expect(builtIn.length).toBeGreaterThan(40);
    expect(graph.size).toBeGreaterThan(60);
    // Built-in water weighs the reflection by its Fresnel, the test Material shows it whole: the graph's covers
    // built-in's, centred on the same column.
    expect(builtIn.filter((pixel) => graph.has(pixel)).length / builtIn.length).toBeGreaterThan(0.8);
    const column = (found: Iterable<number>) => { const list = [...found]; return list.reduce((sum, pixel) => sum + pixel % result.width, 0) / list.length; };
    expect(Math.abs(column(builtIn) - column(graph))).toBeLessThan(1.5);
  });
}
