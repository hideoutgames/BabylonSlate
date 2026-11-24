import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import {
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderEffectsSettings,
  RENDER_QUALITY_PROFILES,
  type RenderEffectsSettings,
} from "@haptic/core";
import { describe, expect, it } from "vitest";
import {
  displayEncodingEffects,
  planSceneEffects,
  planWithoutScreenEffects,
  sceneEffectsImageProcessingConfiguration,
  sceneEffectsKey,
  upscaledRenderSize,
  withoutIdleStages,
} from "./scene-effects";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

function effects(
  overrides: Partial<RenderEffectsSettings> = {},
): RenderEffectsSettings {
  return normalizeRenderEffectsSettings({
    ...DEFAULT_RENDER_EFFECTS,
    ...overrides,
  });
}

it("keeps the established pipeline for defaults in every mode", () => {
  expect(planSceneEffects(effects(), "pbr")).toBeNull();
  expect(planSceneEffects(effects(), "cel")).toBeNull();
});

it("activates local fog without global density and respects the post-processing switch", () => {
  const settings = effects({ volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting,
    density: 0.3, steps: 16, resolutionScale: 0.25 } });
  expect(planSceneEffects(settings, "pbr", true, { fogVolumesPresent: true })?.volumetricLighting).toMatchObject({
    enabled: true, density: 0, steps: 16, resolutionScale: 0.25,
  });
  expect(settings.volumetricLighting).toMatchObject({ enabled: false, density: 0.3 });
  expect(planSceneEffects(settings, "pbr", false, { fogVolumesPresent: true })).toBeNull();
  expect(planSceneEffects(settings, "pbr", true, {})).toBeNull();
  settings.volumetricLighting.enabled = true;
  expect(planSceneEffects(settings, "pbr", true, { fogVolumesPresent: true })?.volumetricLighting?.density).toBe(0.3);
});

it("adds the Scene Linear and Display Color stages for PBR only", () => {
  const linear = effects({
    colorPipeline: { mode: "sceneLinear" },
  });
  expect(planSceneEffects(linear, "pbr")).toEqual({
    sceneLinear: true,
    ambientOcclusion: null, reflections: null, volumetricLighting: null, upscale: null,
    bloom: null,
    imageProcessing: { sceneLinear: true, vignette: null, colorGrading: null },
    fxaa: false, screenShadows: null,
  });
  // CEL is display-space by construction: the linear stage never applies.
  expect(planSceneEffects(linear, "cel")).toBeNull();
});

it("keeps CEL effects display-space with identity processing", () => {
  const linear = effects({
    colorPipeline: { mode: "sceneLinear" },
    toneMapping: "aces",
    exposure: 2,
    bloom: { enabled: true, threshold: 0.5, weight: 0.4, kernel: 32, scale: 0.25 },
  });
  const plan = planSceneEffects(linear, "cel")!;
  expect(plan).toEqual({
    sceneLinear: false,
    ambientOcclusion: null, reflections: null, volumetricLighting: null, upscale: null,
    bloom: { enabled: true, threshold: 0.5, weight: 0.4, kernel: 32, scale: 0.25 },
    imageProcessing: null,
    fxaa: false, screenShadows: null,
  });
});

it("uses the display stage for the vignette on either pipeline", () => {
  const vignette = effects({
    vignette: { enabled: true, weight: 2, color: [0.1, 0.2, 0.3] },
  });
  expect(planSceneEffects(vignette, "pbr")?.imageProcessing).toEqual({
    sceneLinear: false,
    vignette: { enabled: true, weight: 2, color: [0.1, 0.2, 0.3] },
    colorGrading: null,
  });
  const linear = effects({
    colorPipeline: { mode: "sceneLinear" },
    vignette: { enabled: true, weight: 1, color: [0, 0, 0] },
  });
  expect(planSceneEffects(linear, "pbr")?.imageProcessing).toEqual({
    sceneLinear: true,
    vignette: { enabled: true, weight: 1, color: [0, 0, 0] },
    colorGrading: null,
  });
});

it("grades through the display stage only once the LUT is ready, in either mode", () => {
  const lut = { uniqueId: 7 } as unknown as BaseTexture;
  const graded = effects({ colorGrading: { enabled: true, lutTextureGuid: "lut" } });
  // Requested but still loading: no stage that would sample an unready texture.
  expect(planSceneEffects(graded, "pbr")).toBeNull();
  for (const mode of ["pbr", "cel"] as const)
    expect(planSceneEffects(graded, mode, true, { colorGradingTexture: lut })?.imageProcessing)
      .toEqual({ sceneLinear: false, vignette: null, colorGrading: lut });
  const loading = sceneEffectsKey(graded, "pbr", true);
  const ready = sceneEffectsKey(graded, "pbr", true, { colorGradingTexture: lut });
  expect(ready).not.toBe(loading);
  expect(sceneEffectsKey(graded, "pbr", true, { colorGradingTexture: { uniqueId: 8 } as unknown as BaseTexture })).not.toBe(ready);
  const disabled = effects({ colorGrading: { enabled: false, lutTextureGuid: "lut" } });
  expect(planSceneEffects(disabled, "pbr", true, { colorGradingTexture: lut })).toBeNull();

  const config = sceneEffectsImageProcessingConfiguration(graded, { sceneLinear: false, vignette: null, colorGrading: lut });
  expect(config.colorGradingEnabled).toBe(true);
  expect(config.colorGradingTexture).toBe(lut);
});

it("leaves screen effects out of a High Quality capture's plan and keeps what only its own view can draw", () => {
  const lut = { uniqueId: 7 } as unknown as BaseTexture;
  const bloom = { enabled: true, threshold: 0.5, weight: 0.4, kernel: 32, scale: 0.25 };
  const vignette = { enabled: true, weight: 2, color: [0, 0, 0] as [number, number, number] };
  const linear = effects({
    colorPipeline: { mode: "sceneLinear" }, toneMapping: "aces", exposure: 2, contrast: 1.4,
    whiteBalance: { enabled: true, temperature: 4000, tint: 0.2 }, bloom, vignette,
    colorGrading: { enabled: true, lutTextureGuid: "lut" },
  });
  const plan = planSceneEffects(linear, "pbr", true, { colorGradingTexture: lut, fxaa: true, screenShadows: "high" })!;
  expect(plan).toMatchObject({ bloom: { enabled: true }, imageProcessing: { vignette, colorGrading: lut } });
  // Scene Linear keeps a display stage that only encodes; FXAA and Screen-Space Shadows stay.
  const high = planWithoutScreenEffects(plan)!;
  expect(high).toEqual({ ...plan, bloom: null, imageProcessing: { sceneLinear: true, vignette: null, colorGrading: null } });
  const encode = sceneEffectsImageProcessingConfiguration(displayEncodingEffects(linear), high.imageProcessing!);
  expect(encode).toMatchObject({
    toneMappingEnabled: false, exposure: 1, contrast: 1, whiteBalanceEnabled: false, vignetteEnabled: false, colorGradingEnabled: false,
  });
  // Display Space has no display stage left; a plan of screen effects alone becomes none.
  const legacy = planSceneEffects(effects({ bloom, vignette }), "pbr")!;
  expect(legacy).toMatchObject({ sceneLinear: false, bloom: { enabled: true }, imageProcessing: { vignette } });
  expect(planWithoutScreenEffects(legacy)).toBeNull();
  const fxaa = planSceneEffects(effects({ bloom }), "pbr", true, { fxaa: true })!;
  expect(planWithoutScreenEffects(fxaa)).toEqual({ ...fxaa, bloom: null, imageProcessing: null });
  expect(planWithoutScreenEffects(null)).toBeNull();
});

it("plans bloom and FXAA independently in Display Space", () => {
  const plan = planSceneEffects(
    effects({
      bloom: { enabled: true, threshold: 0.8, weight: 0.2, kernel: 16, scale: 0.5 },
    }),
    "pbr",
    true,
    { fxaa: true },
  );
  expect(plan?.sceneLinear).toBe(false);
  expect(plan?.bloom?.enabled).toBe(true);
  expect(plan?.imageProcessing).toBeNull();
  expect(plan?.fxaa).toBe(true);
});

it("runs FXAA for the tier's Anti-Aliasing alone, and keys it", () => {
  const plain = effects();
  expect(planSceneEffects(plain, "cel", true, { fxaa: true })).toMatchObject({ fxaa: true, bloom: null, imageProcessing: null });
  expect(planSceneEffects(plain, "pbr", false, { fxaa: true })).toBeNull();
  expect(sceneEffectsKey(plain, "pbr", true, { fxaa: true })).not.toBe(sceneEffectsKey(plain, "pbr", true));
});

it("plans an FSR chain on its own and renders it at the scaled size", () => {
  const upscaling = { enabled: true, renderScale: 0.67, sharpness: 0.2 };
  for (const mode of ["pbr", "cel"] as const) {
    const plan = planSceneEffects(effects({ upscaling }), mode);
    expect(plan?.upscale).toEqual(upscaling);
    expect(upscaledRenderSize(plan, 1920, 1080)).toEqual({ width: 1286, height: 724 });
  }
  expect(planSceneEffects(effects({ upscaling: { ...upscaling, renderScale: 1 } }), "pbr")).toBeNull();
  expect(upscaledRenderSize(null, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
});

it("plans Screen-Space Shadows on their own in PBR, never in CEL or with post-processing off, and keys only their presence", () => {
  const plain = effects();
  expect(planSceneEffects(plain, "pbr", true, { screenShadows: "off" })).toBeNull();
  expect(planSceneEffects(plain, "pbr", true, { screenShadows: "medium" })).toMatchObject({
    screenShadows: "medium", bloom: null, imageProcessing: null, fxaa: false,
  });
  expect(planSceneEffects(plain, "cel", true, { screenShadows: "medium" })).toBeNull();
  expect(planSceneEffects(plain, "pbr", false, { screenShadows: "medium" })).toBeNull();
  const [off, low, high] = (["off", "low", "high"] as const).map((screenShadows) => sceneEffectsKey(plain, "pbr", true, { screenShadows }));
  // Every level is the same pass and target, its level only uniforms: a level change keeps the prepared graph.
  expect(low).not.toBe(off);
  expect(high).toBe(low);
  expect(sceneEffectsKey(plain, "cel", true, { screenShadows: "high" })).toBe(sceneEffectsKey(plain, "cel", true));
});

describe("stages left out where they write their input unchanged", () => {
  const linear = { mode: "sceneLinear" } as const, display = { mode: "displaySpace" } as const;
  const bloom = (weight: number) => ({ ...DEFAULT_RENDER_EFFECTS.bloom, enabled: true, weight });
  const reflections = (strength: number) => ({ ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true, strength });
  const occlusion = (strength: number) => ({ ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true, strength });
  const volumetricLighting = { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true };
  const view = (overrides: Partial<RenderEffectsSettings>, inputs: Parameters<typeof planSceneEffects>[3] = {}, authoredInput = false) => {
    const plan = withoutIdleStages(planSceneEffects(effects(overrides), "pbr", true, inputs)!, { authoredInput });
    return { bloom: plan.bloom !== null, reflections: plan.reflections !== null };
  };
  it.each([
    ["bloom at weight 0, in Scene Linear", { colorPipeline: linear, bloom: bloom(0) }, {}, false, { bloom: false, reflections: false }],
    ["bloom at weight 0 beside FXAA, in Display Space", { colorPipeline: display, bloom: bloom(0) }, { fxaa: true }, false,
      { bloom: false, reflections: false }],
    // Alone it is the chain: without it the view would draw straight to its output.
    ["bloom at weight 0 alone, in Display Space", { colorPipeline: display, bloom: bloom(0) }, {}, false, { bloom: true, reflections: false }],
    ["bloom at weight 0.15", { colorPipeline: linear, bloom: bloom(0.15) }, {}, false, { bloom: true, reflections: false }],
    ["reflections at strength 0, in Scene Linear", { colorPipeline: linear, reflections: reflections(0) }, {}, false,
      { bloom: false, reflections: false }],
    ["reflections at strength 0.5", { colorPipeline: linear, reflections: reflections(0.5) }, {}, false, { bloom: false, reflections: true }],
    // The combine's gamma round trip is not exact.
    ["reflections at strength 0, in Display Space", { colorPipeline: display, reflections: reflections(0) }, {}, false,
      { bloom: false, reflections: true }],
    // An authored stack's output can be smaller than the render size, which the combine resamples.
    ["reflections at strength 0 after an authored stack", { colorPipeline: linear, reflections: reflections(0) }, {}, true,
      { bloom: false, reflections: true }],
    // Without them the volumetric march alone would read the geometry pass, which a game's world view seeds.
    ["reflections at strength 0 beside volumetric lighting", { colorPipeline: linear, reflections: reflections(0), volumetricLighting }, {}, false,
      { bloom: false, reflections: true }],
    ["reflections at strength 0 beside volumetric lighting and Screen-Space Shadows",
      { colorPipeline: linear, reflections: reflections(0), volumetricLighting }, { screenShadows: "high" }, false,
      { bloom: false, reflections: false }],
    ["reflections at strength 0 beside ambient occlusion and volumetric lighting",
      { colorPipeline: linear, reflections: reflections(0), ambientOcclusion: occlusion(1), volumetricLighting }, {}, false,
      { bloom: false, reflections: false }],
  ] as const)("%s", (_name, overrides, inputs, authoredInput, expected) => {
    expect(view(overrides, inputs, authoredInput)).toEqual(expected);
  });

  it("keeps ambient occlusion at strength 0, whose compose is not exact", () => {
    const plan = planSceneEffects(effects({ colorPipeline: linear, ambientOcclusion: occlusion(0) }), "pbr")!;
    expect(withoutIdleStages(plan, { authoredInput: false }).ambientOcclusion).toEqual(occlusion(0));
  });

  // The proofs read Babylon's shaders: bloom's merge adds `blur * weight`, and the reflections combine raises
  // `F * strength` to the exponent 1 and blends the input by one minus that. A pin move that changes them reopens them.
  it("rests on Babylon's bloom merge and reflections combine as pinned", () => {
    const core = createRequire(import.meta.url).resolve("@babylonjs/core/package.json").slice(0, -"package.json".length);
    const read = (path: string) => readFileSync(`${core}${path}`, "utf8");
    expect(read("Shaders/bloomMerge.fragment.js")).toContain("gl_FragColor.rgb=gl_FragColor.rgb+(blurred.rgb*bloomWeight);");
    const combine = read("Shaders/screenSpaceReflection2BlurCombiner.fragment.js");
    expect(combine).toContain("reflectionMultiplier=clamp(pow(fresnel*strength,vec3(reflectionSpecularFalloffExponent)),0.0,1.0);");
    expect(combine).toContain("vec3 colorMultiplier=1.0-reflectionMultiplier;vec3 finalColor=(color.rgb*colorMultiplier)+(SSR*reflectionMultiplier);");
    expect(read("PostProcesses/thinSSRBlurCombinerPostProcess.js")).toContain("this.reflectionSpecularFalloffExponent = 1;");
  });
});

it("plans nothing while the post-processing toggle is off", () => {
  const linear = effects({
    colorPipeline: { mode: "sceneLinear" },
  });
  expect(planSceneEffects(linear, "pbr", false, { fxaa: true })).toBeNull();
});

it("configures display processing only for the linear stage", () => {
  const config = sceneEffectsImageProcessingConfiguration(
    effects({
      toneMapping: "aces", exposure: 1.5, contrast: 1.2,
      whiteBalance: { enabled: true, temperature: 3200, tint: -20 },
    }),
    { sceneLinear: true, vignette: null, colorGrading: null },
  );
  expect(config.whiteBalanceEnabled).toBe(true);
  expect(config.temperature).toBe(3200);
  expect(config.tint).toBe(-20);
  expect(config.toneMappingEnabled).toBe(true);
  expect(config.toneMappingType).toBe(
    ImageProcessingConfiguration.TONEMAPPING_ACES,
  );
  expect(config.exposure).toBe(1.5);
  expect(config.contrast).toBe(1.2);
  expect(config.vignetteEnabled).toBe(false);
});

it("holds processing at identity when the stage only carries a vignette", () => {
  const config = sceneEffectsImageProcessingConfiguration(
    effects({
      toneMapping: "aces", exposure: 4, contrast: 3,
      whiteBalance: { enabled: true, temperature: 3200, tint: -20 },
    }),
    {
      sceneLinear: false,
      vignette: { enabled: true, weight: 2, color: [0.25, 0.5, 0.75] },
      colorGrading: null,
    },
  );
  expect(config.toneMappingEnabled).toBe(false);
  expect(config.exposure).toBe(1);
  expect(config.contrast).toBe(1);
  expect(config.whiteBalanceEnabled).toBe(false);
  expect(config.vignetteEnabled).toBe(true);
  expect(config.vignetteWeight).toBe(2);
  expect(config.vignetteColor.r).toBeCloseTo(0.25);
  expect(config.vignetteColor.g).toBeCloseTo(0.5);
  expect(config.vignetteColor.b).toBeCloseTo(0.75);
});

it("changes the effects key on mode, settings and the session toggle", () => {
  const linear = effects({
    colorPipeline: { mode: "sceneLinear" },
  });
  const base = sceneEffectsKey(linear, "pbr", true);
  expect(sceneEffectsKey(linear, "cel", true)).not.toBe(base);
  expect(sceneEffectsKey(linear, "pbr", false)).not.toBe(base);
  expect(
    sceneEffectsKey(effects({ exposure: 2 }), "pbr", true),
  ).not.toBe(sceneEffectsKey(effects({ exposure: 1 }), "pbr", true));
  expect(sceneEffectsKey(linear, "pbr", true)).toBe(base);
});

it("enables PBR ambient occlusion, scene reflections and scene-light fog independently", () => {
  const settings = effects({ reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true },
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true },
    volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true } });
  expect(planSceneEffects(settings, "pbr")).toMatchObject({ ambientOcclusion: settings.ambientOcclusion,
    reflections: settings.reflections, volumetricLighting: settings.volumetricLighting });
  expect(planSceneEffects(settings, "cel")).toMatchObject({ ambientOcclusion: null, reflections: settings.reflections,
    volumetricLighting: settings.volumetricLighting });
  const occlusionOnly = effects({ ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true } });
  expect(planSceneEffects(occlusionOnly, "pbr")?.ambientOcclusion).toEqual(occlusionOnly.ambientOcclusion);
  expect(planSceneEffects(occlusionOnly, "cel")).toBeNull();
  expect(planSceneEffects(settings, "pbr", false)).toBeNull();
});

it("runs the tier's reduced occlusion and fog from the project's own settings, and keys the detail", () => {
  const settings = effects({
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true, samples: 12, resolutionScale: 0.5 },
    volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, steps: 16, resolutionScale: 0.5 },
  });
  const { high, ultra } = RENDER_QUALITY_PROFILES;
  // Ultra's full detail plans exactly what the project asks, keyed as before the setting existed.
  const full = planSceneEffects(settings, "pbr", true, { detail: ultra.postprocessing });
  expect(full?.ambientOcclusion).toEqual(settings.ambientOcclusion);
  expect(full?.volumetricLighting).toEqual(settings.volumetricLighting);
  expect(sceneEffectsKey(settings, "pbr", true, { detail: ultra.postprocessing })).toBe(sceneEffectsKey(settings, "pbr", true));
  // Reduced: two thirds of the samples and one blur; half the steps at half the scale.
  const reduced = planSceneEffects(settings, "pbr", true, { detail: high.postprocessing });
  expect(reduced?.ambientOcclusion).toEqual({ ...settings.ambientOcclusion, samples: 8, singleBlur: true });
  expect(reduced?.volumetricLighting).toEqual({ ...settings.volumetricLighting, steps: 8, resolutionScale: 0.25 });
  const keys = new Set([
    sceneEffectsKey(settings, "pbr", true, { detail: ultra.postprocessing }),
    sceneEffectsKey(settings, "pbr", true, { detail: { ambientOcclusionDetail: "reduced", volumetricDetail: "full" } }),
    sceneEffectsKey(settings, "pbr", true, { detail: { ambientOcclusionDetail: "full", volumetricDetail: "reduced" } }),
  ]);
  expect(keys.size).toBe(3);
  // The fewest the project can ask for still round to a whole count; a tier's Fog Volumes alone march reduced too.
  const sparse = effects({
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true, samples: 4 },
    volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: false, steps: 9 },
  });
  const volumes = planSceneEffects(sparse, "pbr", true, { detail: high.postprocessing, fogVolumesPresent: true });
  expect(volumes?.ambientOcclusion?.samples).toBe(3);
  expect(volumes?.volumetricLighting).toMatchObject({ steps: 4, density: 0, resolutionScale: sparse.volumetricLighting.resolutionScale / 2 });
});

it("runs reflections in CEL from the one project setting, keeping ambient occlusion PBR-only and quality allowances", () => {
  const settings = effects({ reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true },
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true } });
  expect(planSceneEffects(settings, "cel")).toMatchObject({
    reflections: settings.reflections, ambientOcclusion: null, sceneLinear: false });
  expect(planSceneEffects(effects(), "cel")).toBeNull();
  const { low, high } = RENDER_QUALITY_PROFILES;
  expect(planSceneEffects(settings, "cel", true, { allowed: low.postprocessing })).toBeNull();
  expect(planSceneEffects(settings, "cel", true, { allowed: high.postprocessing })?.reflections)
    .toEqual(settings.reflections);
});

it("skips the screen-space effects a quality tier cannot afford but keeps authored Fog Volumes", () => {
  const settings = effects({ reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true },
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true },
    volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, density: 0.3 } });
  const { low, medium, high } = RENDER_QUALITY_PROFILES;
  expect(planSceneEffects(settings, "pbr", true, { allowed: medium.postprocessing })).toMatchObject({
    ambientOcclusion: settings.ambientOcclusion, reflections: settings.reflections, volumetricLighting: null });
  expect(planSceneEffects(settings, "pbr", true, { allowed: low.postprocessing })).toBeNull();
  expect(planSceneEffects(settings, "pbr", true, { allowed: low.postprocessing, fogVolumesPresent: true })?.volumetricLighting)
    .toMatchObject({ enabled: true, density: 0 });
  expect(planSceneEffects(settings, "pbr", true, { allowed: high.postprocessing })).toMatchObject({
    ambientOcclusion: settings.ambientOcclusion, reflections: settings.reflections, volumetricLighting: settings.volumetricLighting });
  expect(sceneEffectsKey(settings, "pbr", true, { allowed: medium.postprocessing }))
    .not.toBe(sceneEffectsKey(settings, "pbr", true, { allowed: high.postprocessing }));
});
