import { expect, test } from "@playwright/test";
import type { runWaterPlanarReflectionProof } from "../apps/editor/src/testing/water-planar-reflection-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Exact sRGB decode of an 8-bit display channel. */
const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Babylon Constants.TEXTUREFORMAT_* and TEXTURETYPE_* values. */
const FORMAT = { rgba: 5, bgra: 12 };
const TYPE = { unsignedByte: 0, halfFloat: 2 };

const CASES = [
  { pipeline: "legacyDisplay", far: false },
  { pipeline: "sceneLinear", far: false },
  { pipeline: "legacyDisplay", far: true },
] as const;

for (const backend of ["webgl2", "webgpu"] as const) {
  for (const { pipeline, far } of CASES) {
    test(`Planar water reflection holds a known hit on ${backend} ${pipeline}${far ? " 100 km from the origin" : ""}`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|planar/i.test(message.text())) errors.push(message.text());
      });
      await page.goto("/?test=1&waterPlanarReflectionProof=1");
      await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterPlanarReflectionProof?: unknown }).__babylonslateWaterPlanarReflectionProof === "function");
      const result = await page.evaluate(({ backend, pipeline, far }) =>
        (window as unknown as { __babylonslateWaterPlanarReflectionProof: typeof runWaterPlanarReflectionProof })
          .__babylonslateWaterPlanarReflectionProof(backend, pipeline, far), { backend, pipeline, far });
      await testInfo.attach("water-planar-reflection", { body: JSON.stringify(result), contentType: "application/json" });
      expect(errors).toEqual([]);
      expect(result.prepared).toEqual({ path: "frameGraph" });
      expect(result.floatingOrigin).toBe(true);
      // Ultra Planar Resolution 0.75 of the 128 × 96 view, snapped up to 8 px. Display views store display colour
      // in 8 bits (BGRA on a bgra8unorm WebGPU swap chain); Scene Linear views store linear RGBA16F.
      const display = pipeline === "legacyDisplay";
      expect(result.target).toMatchObject({
        width: 96, height: 72, gammaSpace: display, type: display ? TYPE.unsignedByte : TYPE.halfFloat,
      });
      expect([FORMAT.rgba, FORMAT.bgra]).toContain(result.target.format);
      if (backend === "webgl2" || !display) expect(result.target.format).toBe(FORMAT.rgba);
      expect(result.meshIsLake).toBe(true);
      expect(result.planeY).toBeCloseTo(0, 6);
      // The mirror camera and target stay outside scene membership.
      expect(result.sceneMembership).toEqual({ cameras: 1, textures: 0 });
      expect(result.diagnostics).toMatchObject({ views: 1, targets: 1 });
      // The contract's mapping on both backends: u = 0.5 + 0.5·x/w, v = 0.5 + 0.5·y/w, read back in texture memory
      // order (Babylon's WebGPU engine flips render-target rows to WebGL's layout, so WGSL samples the same uv).
      const hit = result.boxHit.contract;
      // The water point that sees the box holds the box as the view shows it, fully covered (alpha 1). The
      // submerged column on the mirror's line of sight is clipped by the oblique near plane, not drawn over it.
      const expected = result.boxDirect.map((channel) => display ? channel / 255 : linear(channel));
      for (let channel = 0; channel < 3; channel += 1) expect(hit[channel]).toBeCloseTo(expected[channel]!, 1.5);
      expect(hit[3]).toBeCloseTo(1, 2);
      expect(result.boxDirect[0]).toBeGreaterThan(150);
      // The column reaches the mirror pass (its face above the water is drawn) and its submerged part lies on the
      // box's line of sight, so the box hit above proves the GPU clips at the water plane.
      expect(result.columnTexel[1]).toBeGreaterThan(result.columnTexel[0]! + 0.3);
      expect(result.columnTexel[3]).toBeCloseTo(1, 2);
      expect(result.blockingNdc[0]).toBeCloseTo(result.boxHit.ndc[0]!, 4);
      expect(result.blockingNdc[1]).toBeCloseTo(result.boxHit.ndc[1]!, 4);
      // The opposite row order and a mirrored u miss the box: the mapping is not ambiguous.
      for (const miss of [result.boxHit.flippedV, result.boxHit.mirroredU]) expect(Math.abs(miss[0]! - hit[0]!) + Math.abs(miss[3]! - hit[3]!)).toBeGreaterThan(0.3);
      // Nothing reflected over empty sky: coverage 0, so the shader keeps its sky reflection there.
      expect(result.skyHit.contract).toEqual([0, 0, 0, 0]);
    });
  }
}
