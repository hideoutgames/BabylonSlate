import { expect, test } from "@playwright/test";
import type { runParticleLifecycleProof } from "../apps/editor/src/testing/particle-lifecycle-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) for (const gpu of [false, true]) {
  test(`particle emission and ownership on ${backend} with ${gpu ? "GPU" : "CPU"} simulation`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?test=1&particleLifecycleProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateParticleLifecycleProof?: unknown }).__babylonslateParticleLifecycleProof === "function");
    const result = await page.evaluate(({ backend, gpu }) => (window as unknown as {
      __babylonslateParticleLifecycleProof: typeof runParticleLifecycleProof;
    }).__babylonslateParticleLifecycleProof(backend, gpu), { backend, gpu });
    await testInfo.attach("particle-lifecycle", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.effectiveBackend).toBe(backend);
    expect(errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.resets).toBe(0);
    expect(result.acquisitions).toBe(result.releases);
    expect(result.final).toEqual(result.baseline);
    expect(result.particleBuffersAcquired).toBeGreaterThan(0);
    expect(result.liveParticleBuffers).toBe(0);
    for (const capture of result.captures) {
      if (["retired", "fractional-retired", "finite-retired"].includes(capture.name)) {
        expect(capture.systems, capture.name).toBe(0);
        expect(capture.red + capture.blue, capture.name).toBe(0);
      } else if (capture.name === "fractional-pending") {
        expect(capture.red + capture.blue).toBe(0);
      } else if (["restart-blue", "surviving-blue"].includes(capture.name)) {
        expect(capture.red, capture.name).toBe(0);
        expect(capture.blue, capture.name).toBeGreaterThan(100);
      } else if (["fractional-emission", "finite-visible", "finite-gradient-drain"].includes(capture.name)) {
        expect(capture.red, capture.name).toBeGreaterThan(100);
      } else {
        expect(capture.red, capture.name).toBeGreaterThan(100);
        expect(capture.blue, capture.name).toBeGreaterThan(100);
      }
    }
    const paused = result.captures.find((capture) => capture.name === "paused-drain")!;
    expect(paused.systems).toBe(2);
    if (gpu) expect(paused.processed.every((count) => count > 0)).toBe(true);
  });
}
