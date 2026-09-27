import { expect, test } from "@playwright/test";
import type { runRenderTargetProof } from "../apps/editor/src/testing/render-target-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`render targets capture only their selected pass on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&renderTargetProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __renderTargetProof?: unknown }).__renderTargetProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __renderTargetProof: typeof runRenderTargetProof }).__renderTargetProof(backend), backend);
    await testInfo.attach("render-target-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.mainCameraPreserved).toBe(true);
    expect(result.retainedBytes).toBe(0);
    expect(result.results.find((entry) => entry.mode === "SceneColor")!.pixel).toEqual([255, 0, 0, 255]);
    expect(result.results.find((entry) => entry.mode === "Material Red")!.pixel).toEqual([255, 0, 0, 255]);
    expect(result.results.find((entry) => entry.mode === "Material Green After Mode Change")!.pixel).toEqual([0, 255, 0, 255]);
    expect(result.results.find((entry) => entry.mode === "DepthPass")!.pixel[0]).toBeCloseTo(0.3, 2);
    const normal = result.results.find((entry) => entry.mode === "WorldNormal")!.pixel;
    expect(Math.abs(normal[0]! - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(normal[1]! - 128)).toBeLessThanOrEqual(1);
    expect(normal.slice(2)).toEqual([0, 255]);
    expect(result.results.find((entry) => entry.mode === "Empty Filter")!.pixel).toEqual([0, 0, 0, 0]);
  });
}
