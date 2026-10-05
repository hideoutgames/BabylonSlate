import { ImageProcessingConfiguration, type BaseTexture } from "@babylonjs/core";
import {
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderEffectsSettings,
  type RenderEffectsSettings,
} from "@babylonslate/core";
import { expect, it } from "vitest";
import {
  planSceneEffects,
  sceneEffectsImageProcessingConfiguration,
  sceneEffectsKey,
} from "./scene-effects";

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
    colorPipeline: { version: 1, mode: "sceneLinear" },
  });
  expect(planSceneEffects(linear, "pbr")).toEqual({
    sceneLinear: true,
    ambientOcclusion: null, reflections: null, volumetricLighting: null,
    bloom: null,
    imageProcessing: { sceneLinear: true, vignette: null, colorGrading: null },
    fxaa: false,
  });
  // CEL is display-space by construction: the linear stage never applies.
  expect(planSceneEffects(linear, "cel")).toBeNull();
});

it("keeps CEL effects display-space with identity processing", () => {
  const linear = effects({
    colorPipeline: { version: 1, mode: "sceneLinear" },
    toneMapping: "aces",
    exposure: 2,
    bloom: { enabled: true, threshold: 0.5, weight: 0.4, kernel: 32, scale: 0.25 },
  });
  const plan = planSceneEffects(linear, "cel")!;
  expect(plan).toEqual({
    sceneLinear: false,
    ambientOcclusion: null, reflections: null, volumetricLighting: null,
    bloom: { enabled: true, threshold: 0.5, weight: 0.4, kernel: 32, scale: 0.25 },
    imageProcessing: null,
    fxaa: false,
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
    colorPipeline: { version: 1, mode: "sceneLinear" },
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
  expect(config.colorGradingWithGreenDepth).toBe(false);
  expect(config.colorGradingBGR).toBe(false);
});

it("plans bloom and FXAA independently in Legacy Display", () => {
  const plan = planSceneEffects(
    effects({
      bloom: { enabled: true, threshold: 0.8, weight: 0.2, kernel: 16, scale: 0.5 },
      fxaa: true,
    }),
    "pbr",
  );
  expect(plan?.sceneLinear).toBe(false);
  expect(plan?.bloom?.enabled).toBe(true);
  expect(plan?.imageProcessing).toBeNull();
  expect(plan?.fxaa).toBe(true);
});

it("plans nothing while the post-processing toggle is off", () => {
  const linear = effects({
    colorPipeline: { version: 1, mode: "sceneLinear" },
    fxaa: true,
  });
  expect(planSceneEffects(linear, "pbr", false)).toBeNull();
});

it("configures display processing only for the linear stage", () => {
  const config = sceneEffectsImageProcessingConfiguration(
    effects({ toneMapping: "aces", exposure: 1.5, contrast: 1.2 }),
    { sceneLinear: true, vignette: null, colorGrading: null },
  );
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
    effects({ toneMapping: "aces", exposure: 4, contrast: 3 }),
    {
      sceneLinear: false,
      vignette: { enabled: true, weight: 2, color: [0.25, 0.5, 0.75] },
      colorGrading: null,
    },
  );
  expect(config.toneMappingEnabled).toBe(false);
  expect(config.exposure).toBe(1);
  expect(config.contrast).toBe(1);
  expect(config.vignetteEnabled).toBe(true);
  expect(config.vignetteWeight).toBe(2);
  expect(config.vignetteColor.r).toBeCloseTo(0.25);
  expect(config.vignetteColor.g).toBeCloseTo(0.5);
  expect(config.vignetteColor.b).toBeCloseTo(0.75);
});

it("changes the effects key on mode, settings and the session toggle", () => {
  const linear = effects({
    colorPipeline: { version: 1, mode: "sceneLinear" },
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
  expect(planSceneEffects(settings, "cel")).toMatchObject({ ambientOcclusion: null, reflections: null,
    volumetricLighting: settings.volumetricLighting });
  const occlusionOnly = effects({ ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true } });
  expect(planSceneEffects(occlusionOnly, "pbr")?.ambientOcclusion).toEqual(occlusionOnly.ambientOcclusion);
  expect(planSceneEffects(occlusionOnly, "cel")).toBeNull();
  expect(planSceneEffects(settings, "pbr", false)).toBeNull();
});
