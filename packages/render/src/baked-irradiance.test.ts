import { describe, expect, it } from "vitest";
import {
  BAKED_IRRADIANCE_INV_PI,
  analyticDirectionalIrradiance,
  analyticPointIrradiance,
  bakedDiffuseIrradiance,
  bakedIrradianceFragmentDeclarations,
  bakedIrradianceTexelSample,
  bakedIrradianceVertexDeclarations,
  bakedIrradianceVertexMain,
  bakedNormalizedDiffuseIrradiance,
  bakedOutgoingDiffuse,
} from "./baked-irradiance";

describe("baked irradiance CPU composition", () => {
  it("scales the stored physical-E texel by coverage for each host convention", () => {
    expect(BAKED_IRRADIANCE_INV_PI).toBeCloseTo(1 / Math.PI, 15);
    // Standard/CEL diffuseBase takes the unnormalized E * coverage term.
    expect(bakedDiffuseIrradiance([2, 1, 0.5, 1])).toEqual([2, 1, 0.5]);
    expect(bakedDiffuseIrradiance([2, 1, 0.5, 0.5])).toEqual([1, 0.5, 0.25]);
    expect(bakedDiffuseIrradiance([2, 1, 0.5, 0])).toEqual([0, 0, 0]);
    // PBR diffuseBase takes the energy-normalized E * coverage / PI term.
    expect(bakedNormalizedDiffuseIrradiance([2, 1, 0.5, 1])).toEqual([
      2 / Math.PI,
      1 / Math.PI,
      0.5 / Math.PI,
    ]);
    expect(bakedNormalizedDiffuseIrradiance([2, 1, 0.5, 0.5])).toEqual([
      1 / Math.PI,
      0.5 / Math.PI,
      0.25 / Math.PI,
    ]);
    expect(bakedNormalizedDiffuseIrradiance([2, 1, 0.5, 0])).toEqual([0, 0, 0]);
  });

  it("reproduces the realtime PBR point-light diffuse for unit albedo", () => {
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
    expect(bakedOutgoingDiffuse([1, 1, 1], irradiance, 1)[0]).toBeCloseTo(
      1 / Math.PI,
    );
    // Angled receiver: E follows the same cosine law as realtime diffuse.
    const angled = analyticPointIrradiance(
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0.5, 0.25, 1],
      8,
    );
    const outgoing = bakedOutgoingDiffuse([0.5, 0.5, 0.5], angled, 1);
    expect(outgoing[0]).toBeCloseTo((0.5 * 8 * 0.5) / (4 * Math.PI));
    expect(outgoing[2]).toBeCloseTo((0.5 * 8 * 1) / (4 * Math.PI));
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
    expect(bakedDiffuseIrradiance([...irradiance, 1])[0]).toBeCloseTo(
      2 * cosine,
    );
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
