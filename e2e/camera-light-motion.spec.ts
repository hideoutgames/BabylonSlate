import { expect, test } from "@playwright/test";
import type { runCameraLightMotionProof } from "../apps/editor/src/testing/camera-light-motion-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
for (const shadows of [false, true]) {
for (const frozen of [false, true]) {
  test(`stationary lights remain anchored through camera motion on ${backend} ${frozen ? "editor" : "graph"} ${shadows ? "shadowed" : "unshadowed"}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&framegraphForwardProof=1");
    await page.waitForFunction(() => "__babylonslateCameraLightMotionProof" in window);
    const result = await page.evaluate(({ backend, shadows, frozen }) => (window as unknown as {
      __babylonslateCameraLightMotionProof: typeof runCameraLightMotionProof;
    }).__babylonslateCameraLightMotionProof(backend, shadows, frozen), { backend, shadows, frozen });
    await testInfo.attach("camera-light-motion", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.captures).toHaveLength(shadows ? 36 : 24);
    for (const capture of result.captures) {
      const label = `${capture.mode} ${capture.kind} ${capture.motion}`;
      expect(capture.activeMeshesFrozen, label).toBe(frozen);
      expect(capture.litPixels, label).toBeGreaterThan(100);
      expect(capture.lightPosition, label).toEqual([0.7, 0.4, -2]);
      expect(capture.difference, label).toBeLessThanOrEqual(2);
      expect(capture.settledDifference, label).toBeLessThanOrEqual(1);
    }
  });
}
}
}
