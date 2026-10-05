import { expect, test } from "@playwright/test";
import type { runWaterFftProof, WaterFftProofOptions } from "../apps/editor/src/testing/water-fft-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Babylon Constants: half-float component type, RGBA format, wrap (repeat) addressing. */
const HALF_FLOAT = 2, RGBA = 5, WRAP = 1;

/**
 * The smallest band, then the High and Ultra presets (more cascades and atlas segments, array layers ≥ 2, 7-8 butterfly
 * stages and the largest frequency multiples), one of them through the production forward FrameGraph Play uses.
 */
const configurations: Required<WaterFftProofOptions>[] = [
  { size: 64, cascades: 1, path: "classic" },
  { size: 128, cascades: 2, path: "frameGraph" },
  { size: 256, cascades: 3, path: "classic" },
];

for (const backend of ["webgl2", "webgpu"] as const) {
  for (const { size, cascades, path } of configurations) {
    test(`FFT ocean detail ${size}²×${cascades} matches the CPU reference texel for texel on ${backend} (${path})`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
      });
      await page.goto("/?test=1&waterFftProof=1");
      await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterFftProof?: unknown }).__babylonslateWaterFftProof === "function");
      const result = await page.evaluate(([backend, options]) =>
        (window as unknown as { __babylonslateWaterFftProof: typeof runWaterFftProof }).__babylonslateWaterFftProof(backend, options),
      [backend, { size, cascades, path }] as const);
      // Samples hold every channel's error summary only; the full readback stays in the page.
      await testInfo.attach("water-fft", { body: JSON.stringify(result), contentType: "application/json" });
      expect(errors).toEqual([]);
      expect(result.renderPaths).toEqual([path]);
      // One 2D-array texture: two RGBA16F layers per cascade, repeating like the patches it holds.
      expect(result.texture).toEqual({
        is2DArray: true, layers: 2 * cascades, width: size, height: size, type: HALF_FLOAT, format: RGBA, wrapU: WRAP, wrapV: WRAP,
      });
      expect(result.band).toEqual({ cascades, amplitudeGain: 1, patchSizes: result.expectedPatchSizes });
      expect(result.diagnostics).toMatchObject({ created: 1, built: 1, simulations: [{ size, cascades }] });
      // Two clock times: the band evolves and is dispatched again when the water clock moves.
      expect(result.samples.map((sample) => sample.time)).toEqual([3.7, 41.3]);
      for (const sample of result.samples) {
        expect(sample.channels).toHaveLength(8 * cascades);
        for (const channel of sample.channels) {
          const label = `t ${sample.time} layer ${channel.layer} channel ${channel.channel}`;
          // Every packed field (offset, height, shear, slopes, Jacobian terms) of every cascade carries the band...
          expect(channel.magnitude, label).toBeGreaterThan(1e-5);
          // ...and matches the CPU reference to half-float precision, fetched and through the bilinear REPEAT sampler.
          expect(channel.fetchError, `${label} fetch`).toBeLessThan(3e-3 * channel.magnitude);
          expect(channel.sampledError, `${label} sampled`).toBeLessThan(3e-3 * channel.magnitude);
        }
      }
      // The fields differ between the two times (the band moves).
      expect(result.samples[0]!.channels[1]!.magnitude).not.toBe(result.samples[1]!.channels[1]!.magnitude);
    });
  }
}
