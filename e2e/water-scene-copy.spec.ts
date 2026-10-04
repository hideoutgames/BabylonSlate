import { expect, test } from "@playwright/test";
import type { runWaterSceneCopyProof } from "../apps/editor/src/testing/water-scene-copy-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Exact sRGB decode of an 8-bit display channel. */
const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const TASKS = {
  // The default Play/backbuffer view: the copy draws through an own pair only while water is visible,
  // and the split decides before the output clear runs.
  legacyDisplay: [
    "Forward admitted shadows", "Clustered light mask", "Forward cull", "Water split", "Forward clear",
    "Forward objects", "Water clear", "Water opaque", "Water scene copy", "Forward transparent", "Water output",
  ],
  // An effect chain owns sampleable scene targets: the copy reads them and the transparent pass draws into them.
  sceneLinear: [
    "Forward admitted shadows", "Clustered light mask", "Forward clear", "Forward cull",
    "Water split", "Forward objects", "Water scene copy", "Forward transparent",
    "Scene Effects Display Color", "Scene post-process output",
  ],
};

for (const backend of ["webgl2", "webgpu"] as const) {
  for (const pipeline of ["legacyDisplay", "sceneLinear"] as const) {
    test(`Water scene copy holds linear colour and view depth after the opaque pass on ${backend} ${pipeline}`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
      });
      await page.goto("/?test=1&waterSceneCopyProof=1");
      await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterSceneCopyProof?: unknown }).__babylonslateWaterSceneCopyProof === "function");
      const result = await page.evaluate(({ backend, pipeline }) =>
        (window as unknown as { __babylonslateWaterSceneCopyProof: typeof runWaterSceneCopyProof })
          .__babylonslateWaterSceneCopyProof(backend, pipeline), { backend, pipeline });
      await testInfo.attach("water-scene-copy", { body: JSON.stringify(result), contentType: "application/json" });
      expect(errors).toEqual([]);
      expect(result.prepared).toEqual({ path: "frameGraph" });
      expect(result.tasks).toEqual(TASKS[pipeline]);
      expect(result.visibleWork.ownTargets).toBe(pipeline === "legacyDisplay");
      // Medium quality copies at half resolution.
      expect(result.copy).toMatchObject({ width: 48, height: 32, scale: 0.5, invSize: [1 / 96, 1 / 64] });
      // rgb is the opaque frame's colour in linear space (decoded from display colour, or the Scene Linear
      // colour as-is); a is linear view depth (the wall is ten units away).
      for (let channel = 0; channel < 3; channel += 1) {
        expect(result.copy.wall[channel]).toBeCloseTo(linear(result.outputVisible.wall[channel]!), 1.7);
        expect(result.copy.sky[channel]).toBeCloseTo(linear(result.outputVisible.sky[channel]!), 1.7);
      }
      expect(result.copy.wall[3]).toBeCloseTo(10, 1);
      // The 65000 sky sentinel is stored as the nearest half float (64992); readers treat a >= 64000 as sky.
      expect(result.copy.sky[3]).toBeGreaterThanOrEqual(64000);
      // Splitting the object pass (and swapping onto the own pair) draws the same output as the direct path.
      expect(result.outputVisible.wall[0]).toBeGreaterThan(150);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(result.outputHidden.wall[channel]! - result.outputVisible.wall[channel]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(result.outputHidden.sky[channel]! - result.outputVisible.sky[channel]!)).toBeLessThanOrEqual(1);
      }
      // Copies run only on frames with visible copy-sampling water.
      expect(result.visibleWork.copies).toBeGreaterThan(0);
      expect(result.visibleWork.copies).toBe(result.visibleWork.visibleFrames);
      expect(result.hiddenWork.copies).toBe(result.visibleWork.copies);
      expect(result.hiddenWork.frames).toBeGreaterThan(result.visibleWork.frames);
    });
  }
}
