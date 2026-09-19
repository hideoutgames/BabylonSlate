import type { BaseTexture } from "@babylonjs/core";

/**
 * The atlas stores linear rgba32float diffuse irradiance in the "physical-E"
 * convention: outgoing Lambertian diffuse is `albedo * E * coverage / PI`.
 * Dividing by PI inside the sample keeps the stored quantity a true
 * irradiance — before diffuse albedo, CEL bands, or output conversion — and
 * matches the provider calibration (`unit-albedo radiance = E / PI`).
 *
 * Host conventions differ on where that division lands: PBR's `diffuseBase`
 * accumulates `lightColor * cos * attenuation / PI`, so its baked term is
 * `E * coverage / PI`; Standard/CEL `diffuseBase` accumulates the
 * unnormalized `lightColor * cos * attenuation`, so their baked term is the
 * raw `E * coverage`.
 */
export const BAKED_IRRADIANCE_INV_PI = 0.3183098861837907;

export interface BakedIrradianceSampling {
  /** Shared rgba32float atlas texture; alpha is receiver coverage. */
  readonly texture: BaseTexture;
  /** Normalized atlas rect: `uv2 * scale + offset` lands inside the gutters. */
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
  /**
   * The atlas also carries the environment's diffuse irradiance, so the
   * receiver's ambient/IBL environment must not be applied a second time.
   */
  readonly includesEnvironment: boolean;
}

/**
 * CPU reference for the Standard/CEL injected shader composition: the raw
 * irradiance added to `diffuseBase` for one texel, matching the unnormalized
 * realtime contribution `lightColor * cos * attenuation`.
 */
export function bakedDiffuseIrradiance(
  texel: readonly [number, number, number, number],
): [number, number, number] {
  const coverage = texel[3];
  return [
    texel[0] * coverage,
    texel[1] * coverage,
    texel[2] * coverage,
  ];
}

/**
 * CPU reference for the PBR injected shader composition: the
 * energy-normalized irradiance added to `diffuseBase`, matching the realtime
 * contribution `lightColor * cos * attenuation / PI`.
 */
export function bakedNormalizedDiffuseIrradiance(
  texel: readonly [number, number, number, number],
): [number, number, number] {
  const coverage = texel[3];
  return [
    texel[0] * coverage * BAKED_IRRADIANCE_INV_PI,
    texel[1] * coverage * BAKED_IRRADIANCE_INV_PI,
    texel[2] * coverage * BAKED_IRRADIANCE_INV_PI,
  ];
}

/**
 * CPU reference for a fully covered surface: outgoing diffuse after the
 * material's own diffuse albedo multiplication, matching PBR's
 * `finalDiffuse = diffuseBase * albedo` once the normalized baked term joins
 * diffuseBase. Standard/CEL apply the albedo to the unnormalized `E`
 * contribution instead.
 */
export function bakedOutgoingDiffuse(
  albedo: readonly [number, number, number],
  irradiance: readonly [number, number, number],
  coverage: number,
): [number, number, number] {
  return [
    albedo[0] * irradiance[0] * coverage * BAKED_IRRADIANCE_INV_PI,
    albedo[1] * irradiance[1] * coverage * BAKED_IRRADIANCE_INV_PI,
    albedo[2] * irradiance[2] * coverage * BAKED_IRRADIANCE_INV_PI,
  ];
}

/**
 * Analytic physical-E under the provider's convention for one point light:
 * `E = intensity * color * cos / d^2`. Three.js `PointLight(intensity, 0, 2)`
 * and Babylon's automatic point intensity both mean candela, and Babylon's
 * `LIGHT_FALLOFF_PHYSICAL` attenuation is `1 / d^2`, so `albedo * E / PI`
 * equals realtime PBR diffuse `albedo * intensity * color * cos / (d^2 * PI)`.
 * Used by the parity proof's synthetic atlas; no path tracing involved.
 */
export function analyticPointIrradiance(
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
  lightPosition: readonly [number, number, number],
  lightColor: readonly [number, number, number],
  intensity: number,
): [number, number, number] {
  const direction = [
    lightPosition[0] - point[0],
    lightPosition[1] - point[1],
    lightPosition[2] - point[2],
  ];
  const distance = Math.hypot(direction[0], direction[1], direction[2]);
  const cosine =
    distance > 0
      ? Math.max(
          0,
          (direction[0] * normal[0] +
            direction[1] * normal[1] +
            direction[2] * normal[2]) /
            distance,
        )
      : 0;
  const irradiance =
    (intensity * cosine) / Math.max(distance * distance, 0.000001);
  return [
    lightColor[0] * irradiance,
    lightColor[1] * irradiance,
    lightColor[2] * irradiance,
  ];
}

/**
 * Analytic physical-E for one directional light: `E = intensity * color * cos`.
 * Babylon applies no distance attenuation to directional lights in either
 * material convention, so `E` equals the realtime Standard/CEL diffuse
 * contribution `intensity * color * cos` directly. `direction` points toward
 * the light (Babylon negates the authored direction in `vLightData`).
 */
export function analyticDirectionalIrradiance(
  normal: readonly [number, number, number],
  direction: readonly [number, number, number],
  lightColor: readonly [number, number, number],
  intensity: number,
): [number, number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const cosine =
    length > 0
      ? Math.max(
          0,
          (direction[0] * normal[0] +
            direction[1] * normal[1] +
            direction[2] * normal[2]) /
            length,
        )
      : 0;
  const irradiance = intensity * cosine;
  return [
    lightColor[0] * irradiance,
    lightColor[1] * irradiance,
    lightColor[2] * irradiance,
  ];
}

/** GLSL/WGSL literal for `1 / PI`; hosts apply it where their convention divides. */
export const BAKED_IRRADIANCE_INV_PI_GLSL = "0.31830988618379067154";

/** Vertex declarations for hosts whose stock shader may not request `uv2`. */
export function bakedIrradianceVertexDeclarations(wgsl: boolean): string {
  return wgsl
    ? `#ifndef UV2\nattribute uv2: vec2f;\n#endif\nvarying vSlateBakedUV: vec2f;`
    : `#ifndef UV2\nattribute vec2 uv2;\n#endif\nvarying vec2 vSlateBakedUV;`;
}

/** Vertex main tail: pass the receiver's atlas UV through to the fragment. */
export function bakedIrradianceVertexMain(wgsl: boolean): string {
  return wgsl
    ? `vertexOutputs.vSlateBakedUV=vertexInputs.uv2;`
    : `vSlateBakedUV=uv2;`;
}

/**
 * The one sample expression shared by every host. It returns the physical-E
 * texel so callers apply coverage and their convention's `/ PI` themselves;
 * names are identical for the material plugin and the authored-graph
 * `CelLightBlock` plumbing.
 */
export function bakedIrradianceTexelSample(wgsl: boolean): string {
  return wgsl
    ? `textureSample(slateBakedIrradiance,slateBakedIrradianceSampler,fragmentInputs.vSlateBakedUV*uniforms.slateBakedRect.xy+uniforms.slateBakedRect.zw)`
    : `texture2D(slateBakedIrradiance,vSlateBakedUV*slateBakedRect.xy+slateBakedRect.zw)`;
}

/** Fragment declarations: sampler, varying and the E * coverage helper. */
export function bakedIrradianceFragmentDeclarations(wgsl: boolean): string {
  return wgsl
    ? `var slateBakedIrradiance: texture_2d<f32>;\nvar slateBakedIrradianceSampler: sampler;\nvarying vSlateBakedUV: vec2f;\nfn slateBakedIrradianceSample() -> vec3f {\nvar slateBakedTexel: vec4f=${bakedIrradianceTexelSample(true)};\nreturn slateBakedTexel.rgb*slateBakedTexel.a;\n}`
    : `uniform sampler2D slateBakedIrradiance;\nvarying vec2 vSlateBakedUV;\nvec3 slateBakedIrradianceSample() {\nvec4 slateBakedTexel=${bakedIrradianceTexelSample(false)};\nreturn slateBakedTexel.rgb*slateBakedTexel.a;\n}`;
}
