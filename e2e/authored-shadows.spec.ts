import { expect, test } from "@playwright/test";
import type { runAuthoredShadowProof } from "../apps/editor/src/testing/authored-shadow-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) for (const kind of ["directional", "point", "cascades"] as const) {
  test(`authored WPO and lattice shadows match physical geometry: ${backend} ${kind}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) && /shader|WebGPU uncaptured|GPUValidation|validation error|INVALID_|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&shadowSelfShadowingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateAuthoredShadowProof?: unknown }).__babylonslateAuthoredShadowProof === "function");
    const { programs, ...result } = await page.evaluate(({ backend, kind }) => (window as unknown as {
      __babylonslateAuthoredShadowProof: typeof runAuthoredShadowProof;
    }).__babylonslateAuthoredShadowProof(backend, kind), { backend, kind });
    await testInfo.attach("authored-shadow-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    await testInfo.attach("authored-shadow-programs", { body: JSON.stringify(programs), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.observedShadowEffects).toBeGreaterThanOrEqual(2);
    expect(result.shadowEffectsReleased).toBe(true);
    expect(result.nativeCacheRestored).toBe(true);
    for (const pose of result.results) {
      expect(pose.receiverSamples, pose.pose).toBeGreaterThan(100);
      expect(pose.referenceShadowSamples, `${pose.pose} native reference casts visible shadow`).toBeGreaterThan(10);
      expect(pose.differingSamples / pose.receiverSamples, `${pose.pose} displaced shadow matches reference`).toBeLessThan(0.01);
      expect(pose.discardedShadowSamples / pose.receiverSamples, `${pose.pose} authored clip removes shadow`).toBeLessThan(0.01);
    }
    for (const shape of result.latticeResults) {
      expect(shape.receiverSamples, shape.material).toBeGreaterThan(100);
      expect(shape.referenceShadowSamples, `${shape.material} reference casts visible shadow`).toBeGreaterThan(10);
      expect(shape.differingSamples / shape.receiverSamples, `${shape.material} affine lattice shadow and normal bias`).toBeLessThan(0.01);
      if (shape.discardedShadowSamples !== null)
        expect(shape.discardedShadowSamples / shape.receiverSamples, "native cutout removes lattice shadow").toBeLessThan(0.01);
    }
  });
}
