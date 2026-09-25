import { describe, expect, it } from "vitest";
import {
  BAKED_IRRADIANCE_INV_PI,
  analyticDirectionalIrradiance,
  analyticPointIrradiance,
  bakedIrradianceFragmentDeclarations,
  bakedIrradianceTexelSample,
  bakedIrradianceVertexDeclarations,
  bakedIrradianceVertexMain,
} from "./baked-irradiance";

describe("baked irradiance analytic references", () => {
  it("reproduces the realtime PBR point-light diffuse for unit albedo", () => {
    // PBR hosts divide the physical-E sample by PI where it joins diffuseBase.
    expect(BAKED_IRRADIANCE_INV_PI).toBeCloseTo(1 / Math.PI, 15);
    // A receiver at the origin lit by a point light 2 units overhead with
    // intensity 4: E = 4 / 4 = 1, so albedo * E / PI = 1 / PI matches the
    // realtime PBR diffuse I * cos / (d^2 * PI).
    const irradiance = analyticPointIrradiance(
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 1],
      4,
    );
    expect(irradiance[0]).toBeCloseTo(1);
    // Angled receiver: E follows the same cosine law as realtime diffuse.
    const angled = analyticPointIrradiance(
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0.5, 0.25, 1],
      8,
    );
    expect(angled[0]).toBeCloseTo((8 * 0.5) / 4);
    expect(angled[2]).toBeCloseTo((8 * 1) / 4);
    expect(
      analyticPointIrradiance([0, 0, 0], [0, -1, 0], [0, 2, 0], [1, 1, 1], 4),
    ).toEqual([0, 0, 0]);
  });

  it("reproduces the realtime Standard/CEL directional diffuse directly", () => {
    // Directional irradiance I * cos equals the unnormalized realtime
    // Standard/CEL light contribution, so the baked term needs no division.
    const irradiance = analyticDirectionalIrradiance(
      [0, 0, 1],
      [0.3, 0.4, 1],
      [1, 0.5, 0.25],
      2,
    );
    const cosine = 1 / Math.hypot(0.3, 0.4, 1);
    expect(irradiance[0]).toBeCloseTo(2 * cosine);
    expect(irradiance[1]).toBeCloseTo(cosine);
    expect(
      analyticDirectionalIrradiance([0, 0, -1], [0, 0, 1], [1, 1, 1], 2),
    ).toEqual([0, 0, 0]);
  });
});

describe("baked irradiance shader generation", () => {
  it("emits the same symbols for GLSL and WGSL hosts", () => {
    for (const wgsl of [false, true]) {
      const vertex = bakedIrradianceVertexDeclarations(wgsl);
      const vertexMain = bakedIrradianceVertexMain(wgsl);
      const fragment = bakedIrradianceFragmentDeclarations(wgsl);
      expect(vertex).toContain("vSlateBakedUV");
      expect(vertex).toContain("uv2");
      expect(vertexMain).toContain("vSlateBakedUV");
      expect(fragment).toContain("slateBakedIrradiance");
      expect(fragment).toContain("vSlateBakedUV");
      expect(fragment).toContain("slateBakedIrradianceSample");
      // The sample applies coverage (alpha) to the raw E texel; each host
      // applies its own normalization at the injection site.
      expect(fragment).toContain("slateBakedTexel.rgb*slateBakedTexel.a");
    }
    expect(bakedIrradianceTexelSample(false)).toContain("texture2D");
    expect(bakedIrradianceTexelSample(true)).toContain("textureSample");
    expect(bakedIrradianceVertexDeclarations(false)).toContain(
      "attribute vec2 uv2;",
    );
    expect(bakedIrradianceVertexDeclarations(true)).toContain(
      "attribute uv2: vec2f;",
    );
  });
});
