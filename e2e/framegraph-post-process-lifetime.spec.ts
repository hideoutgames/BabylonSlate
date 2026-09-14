import { expect, test } from "@playwright/test";
import type { runPostProcessLifetimeProof } from "../apps/editor/src/testing/framegraph-post-process-lifetime-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Post Process replacement and disposal preserve native Effect lifetime on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|program|GL_INVALID|WebGPU|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&postProcessLifetimeProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslatePostProcessLifetimeProof?: unknown }).__babylonslatePostProcessLifetimeProof === "function");
    try {
      const result = await page.evaluate((backend) => (window as unknown as {
        __babylonslatePostProcessLifetimeProof: typeof runPostProcessLifetimeProof;
      }).__babylonslatePostProcessLifetimeProof(backend), backend);
      await testInfo.attach("post-process-effect-lifetime", { body: JSON.stringify(result), contentType: "application/json" });
      expect(result.diagnostics).toEqual([]);
      expect(result.siblingReady).toBe(true);
      expect(result.lifetime).toEqual({ retainedPasses: 0, retainedMaterials: 0, retainedScenes: 0 });
      expect(result.captures).toHaveLength(4);
      for (const capture of result.captures)
        expect(capture.pixel, capture.action).toEqual(capture.action === "replacement" ? [40, 20, 10, 255] : [160, 80, 40, 255]);
      for (const retired of result.retired) {
        expect(retired.compiledAfterRetirement).toBe(false);
        // Native WGSL pipeline creation is synchronous once its sources exist.
        // The WebGL case must hit real pending parallel compilation and its retry.
        if (backend === "webgl2") expect(retired.pending).toBe(true);
        if (retired.pending) expect(retired.lateProbes).toBeGreaterThan(0);
      }
    } finally {
      await testInfo.attach("gpu-errors", { body: JSON.stringify(errors), contentType: "application/json" });
    }
    expect(errors).toEqual([]);
  });
}
