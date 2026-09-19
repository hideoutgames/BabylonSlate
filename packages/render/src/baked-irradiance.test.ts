import { describe, expect, it } from "vitest";
import {
  BAKED_IRRADIANCE_INV_PI,
  analyticPointIrradiance,
  bakedDiffuseIrradiance,
  bakedIrradianceFragmentDeclarations,
  bakedIrradianceTexelSample,
  bakedIrradianceVertexDeclarations,
  bakedIrradianceVertexMain,
  bakedOutgoingDiffuse,
} from "./baked-irradiance";

describe("baked irradiance CPU composition", () => {
  it("scales the stored physical-E texel by coverage and 1/PI before albedo", () => {
    expect(BAKED_IRRADIANCE_INV_PI).toBeCloseTo(1 / Math.PI, 15);
    expect(bakedDiffuseIrradiance([2, 1, 0.5, 1])).toEqual([
      2 / Math.PI,
      1 / Math.PI,
      0.5 / Math.PI,
    ]);
    expect(bakedDiffuseIrradiance([2, 1, 0.5, 0.5])).toEqual([
      1 / Math.PI,
      0.5 / Math.PI,
      0.25 / Math.PI,
    ]);
    expect(bakedDiffuseIrradiance([2, 1, 0.5, 0])).toEqual([0, 0, 0]);
  });

  it("reproduces the realtime point-light diffuse for unit albedo", () => {
    // A receiver at the origin lit by a point light 2 units overhead with
    // intensity 4: E = PI * 4 / 4 = PI, so albedo * E / PI = 1 = I*cos/d^2.
    const irradiance = analyticPointIrradiance(
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 1],
      4,
    );
    expect(irradiance[0]).toBeCloseTo(Math.PI);
    expect(bakedOutgoingDiffuse([1, 1, 1], irradiance, 1)[0]).toBeCloseTo(1);
    // Angled receiver: E follows the same cosine law as realtime diffuse.
    const angled = analyticPointIrradiance(
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0.5, 0.25, 1],
      8,
    );
    const outgoing = bakedOutgoingDiffuse([0.5, 0.5, 0.5], angled, 1);
    expect(outgoing[0]).toBeCloseTo(0.5 * 8 * 0.5 / 4);
    expect(outgoing[2]).toBeCloseTo(0.5 * 8 * 1 / 4);
    expect(
      analyticPointIrradiance([0, 0, 0], [0, -1, 0], [0, 2, 0], [1, 1, 1], 4),
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
      expect(fragment).toContain("slateBakedRect");
      expect(fragment).toContain("vSlateBakedUV");
      expect(fragment).toContain("slateBakedIrradianceSample");
      // The sample applies coverage (alpha) and 1/PI, not raw RGB.
      expect(fragment).toContain("slateBakedTexel.a");
      expect(fragment).toContain("0.31830988618379067154");
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
