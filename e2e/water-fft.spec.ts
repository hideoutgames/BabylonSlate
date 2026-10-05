import { expect, test } from "@playwright/test";
import type { runWaterFftProof } from "../apps/editor/src/testing/water-fft-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Babylon Constants: half-float component type, RGBA format, wrap (repeat) addressing. */
const HALF_FLOAT = 2, RGBA = 5, WRAP = 1;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`FFT ocean detail matches the CPU reference texel for texel on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterFftProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterFftProof?: unknown }).__babylonslateWaterFftProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __babylonslateWaterFftProof: typeof runWaterFftProof }).__babylonslateWaterFftProof(backend), backend);
    await testInfo.attach("water-fft", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    // One 2D-array texture: two RGBA16F layers per cascade, repeating like the patch it holds.
    expect(result.texture).toEqual({ is2DArray: true, layers: 2, width: 64, height: 64, type: HALF_FLOAT, format: RGBA, wrapU: WRAP, wrapV: WRAP });
    expect(result).toMatchObject({ cascades: 1, amplitudeGain: 1, diagnostics: { created: 1, simulations: [{ size: 64, cascades: 1 }] } });
    // Two clock times: the band evolves and is dispatched again when the water clock moves.
    expect(result.samples.map((sample) => sample.time)).toEqual([3.7, 41.3]);
    for (const sample of result.samples) {
      expect(sample.channels).toHaveLength(8);
      for (const channel of sample.channels) {
        // Every packed field (offset, height, shear, slopes, Jacobian terms) carries the band...
        expect(channel.magnitude, `layer ${channel.layer} channel ${channel.channel}`).toBeGreaterThan(1e-5);
        // ...and matches the CPU reference to half-float precision, fetched and through the bilinear REPEAT sampler.
        expect(channel.fetchError, `layer ${channel.layer} channel ${channel.channel} fetch`).toBeLessThan(3e-3 * channel.magnitude);
        expect(channel.sampledError, `layer ${channel.layer} channel ${channel.channel} sampled`).toBeLessThan(3e-3 * channel.magnitude);
      }
    }
    // The fields differ between the two times (the band moves).
    expect(result.samples[0]!.channels[1]!.magnitude).not.toBe(result.samples[1]!.channels[1]!.magnitude);
  });
}
