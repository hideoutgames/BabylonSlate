import { expect, test } from "@playwright/test";
import type { runScenePostProcessCoordinatorProof } from "../apps/editor/src/testing/scene-post-process-coordinator-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`scene coordinator prepares post-process pixels and owns shared targets on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU|INVALID_OPERATION|context lost|fatal/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&scenePostProcessCoordinatorProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateScenePostProcessCoordinatorProof?: unknown }).__babylonslateScenePostProcessCoordinatorProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __babylonslateScenePostProcessCoordinatorProof: typeof runScenePostProcessCoordinatorProof;
    }).__babylonslateScenePostProcessCoordinatorProof(backend), backend);
    await testInfo.attach("scene-post-process-coordinator", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    const expected = [
      ["duplicates", "frameGraph", [30, 15, 8]],
      ["live-value", "frameGraph", [60, 30, 15]],
      ["resize-replay", "frameGraph", [60, 30, 15]],
      ["native-fallback", "classic", [60, 30, 15]],
      ["graph-return", "frameGraph", [60, 30, 15]],
      ["color-mask", "frameGraph", [35, 80, 2]],
      ["color-mask-native", "classic", [35, 80, 2]],
      ["empty", "frameGraph", [160, 80, 40]],
      ["depth", "frameGraph", [77, 77, 77]],
      ["normal-after-depth", "frameGraph", [128, 128, 0]],
    ] as const;
    expect(result.captures).toHaveLength(expected.length);
    for (const [index, [name, path, rgb]] of expected.entries()) {
      const capture = result.captures[index]!;
      expect(capture.name).toBe(name); expect(capture.path).toBe(path);
      rgb.forEach((value, channel) => expect(Math.abs(capture.pixel[channel]! - value), `${name}/${channel}`).toBeLessThanOrEqual(1));
      if (name === "color-mask" || name === "color-mask-native") expect(capture.pixel[3]).toBe(128);
      if (name === "empty") expect(capture.reservedBytes).toBe(0);
      else if (path === "frameGraph") expect(capture.reservedBytes).toBeGreaterThan(0);
    }
    expect(result.finalReservations.reservedBytes).toBe(0);
    expect(result.retainedGraphs).toBe(0); expect(result.retainedRenderers).toBe(0);
  });
}
