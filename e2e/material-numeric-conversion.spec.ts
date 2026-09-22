import { expect, test } from "@playwright/test";
import type { runFrameGraphPostProcessProof } from "../apps/editor/src/testing/framegraph-post-process-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Material numeric conversions preserve rendered channels on ${backend}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&framegraphProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateFrameGraphProof?: unknown }).__babylonslateFrameGraphProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __babylonslateFrameGraphProof: typeof runFrameGraphPostProcessProof;
    }).__babylonslateFrameGraphProof(backend, "numeric"), backend);
    await testInfo.attach("numeric-conversion-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.backend).toBe(backend);
    expect(errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.retainedMaterials).toBe(0);
    expect(result.retainedPasses).toBe(0);
    const assertPixel = (name: string, expected: readonly number[]) => {
      const capture = result.captures.find((entry) => entry.name === name);
      expect(capture, name).toBeDefined();
      for (const path of ["graph", "legacy"] as const) {
        const pixel = capture![path].slice(0, 4);
        expect(pixel).toHaveLength(4);
        pixel.forEach((value, channel) => expect(Math.abs(value - expected[channel]!), `${name} ${path} channel ${channel}`).toBeLessThanOrEqual(1));
      }
    };
    const expected = {
      float: [[32, 255, 255, 255], [32, 255, 255, 255], [32, 255, 255, 255], [32, 255, 255, 255]],
      vec2: [[32, 255, 255, 255], [32, 96, 255, 255], [32, 96, 255, 255], [32, 96, 255, 255]],
      vec3: [[32, 255, 255, 255], [32, 96, 255, 255], [32, 96, 160, 255], [32, 96, 160, 255]],
      vec4: [[32, 255, 255, 255], [32, 0, 255, 255], [32, 0, 160, 255], [32, 0, 160, 0]],
    };
    for (const from of ["float", "vec2", "vec3", "vec4"] as const) {
      for (const [index, to] of ["float", "vec2", "vec3", "vec4"].entries()) assertPixel(`${from}-${to}`, expected[from][index]!);
    }
    assertPixel("mask-float", [255, 255, 255, 255]);
    assertPixel("mask-vec2", [255, 255, 255, 255]);
    assertPixel("mask-vec3", [160, 255, 255, 255]);
    assertPixel("mask-vec4", [160, 0, 255, 255]);
    assertPixel("mixed-a", [48, 104, 191, 255]);
    assertPixel("mixed-b", [48, 104, 191, 255]);
    assertPixel("step", [255, 255, 255, 255]);
    assertPixel("atan2", [200, 118, 255, 255]);
    assertPixel("smoothstep", [128, 128, 215, 255]);
    assertPixel("remap", [85, 191, 64, 255]);
    assertPixel("multiply-float-left", [64, 128, 191, 255]);
    assertPixel("multiply-float-right", [64, 128, 191, 255]);
    assertPixel("reflect-vec4", [51, 77, 102, 128]);
    assertPixel("reflect-vec2", [64, 128, 255, 255]);
    assertPixel("reflect-float", [64, 255, 255, 255]);
    assertPixel("dot-float", [64, 255, 255, 255]);
    assertPixel("distance-float", [128, 255, 255, 255]);
    assertPixel("length-float", [128, 255, 255, 255]);
    assertPixel("normalize-float", [255, 255, 255, 255]);
    assertPixel("live-before", [64, 255, 255, 255]);
    assertPixel("live-after", [191, 255, 255, 255]);
    assertPixel("split-missing-w", [255, 255, 255, 255]);
  });
}
