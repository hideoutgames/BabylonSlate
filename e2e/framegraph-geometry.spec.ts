import { expect, test } from "@playwright/test";
import type { runFrameGraphGeometryProof } from "../apps/editor/src/testing/framegraph-geometry-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`geometry buffers preserve native depth and world normal on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&framegraphGeometryProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateFrameGraphGeometryProof?: unknown }).__babylonslateFrameGraphGeometryProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __babylonslateFrameGraphGeometryProof: typeof runFrameGraphGeometryProof }).__babylonslateFrameGraphGeometryProof(backend), backend);
    await testInfo.attach("geometry-buffer-values", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.retainedGraphs).toBe(0);
    for (const capture of result.captures) {
      // Plane lies four units from a camera with near=1, far=11: depth=.3.
      // Its front-facing world normal is (0,0,-1), encoded into [0,1].
      const expected = capture.buffer === "depth" ? [77, 0, 0, 255] : [128, 128, 0, 255];
      expect(Math.max(...capture.pixel.map((value, index) => Math.abs(value - expected[index]!))), JSON.stringify(capture)).toBeLessThanOrEqual(1);
    }
  });
}
