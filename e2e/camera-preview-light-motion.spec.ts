import { expect, test } from "@playwright/test";
import type { runCameraPreviewLightMotionProof } from "../apps/editor/src/testing/camera-preview-light-motion-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`camera preview lighting stays fixed while the editor camera moves on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&cameraPreviewLightMotionProof=1");
    await page.waitForFunction(() => "__babylonslateCameraPreviewLightMotionProof" in window);
    const result = await page.evaluate((backend) => (window as unknown as {
      __babylonslateCameraPreviewLightMotionProof: typeof runCameraPreviewLightMotionProof;
    }).__babylonslateCameraPreviewLightMotionProof(backend), backend);
    await testInfo.attach("camera-preview-light-motion", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.captures).toHaveLength(20);
    for (const capture of result.captures) {
      const label = `${capture.mode} ${capture.kind} ${capture.motion}`;
      expect(capture.litPixels, label).toBeGreaterThan(100);
      expect(capture.lightPosition, label).toEqual([0.7, 0.4, -2]);
      expect(capture.difference, label).toBeLessThanOrEqual(1);
    }
  });
}
