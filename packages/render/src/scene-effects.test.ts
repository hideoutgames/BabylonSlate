import { ImageProcessingConfiguration } from "@babylonjs/core";
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

it("adds the Scene Linear and Display Color stages for PBR only", () => {
  const linear = effects({
    colorPipeline: { version: 1, mode: "sceneLinear" },
  });
  expect(planSceneEffects(linear, "pbr")).toEqual({
    sceneLinear: true,
    bloom: null,
    imageProcessing: { sceneLinear: true, vignette: null },
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
  });
  const linear = effects({
    colorPipeline: { version: 1, mode: "sceneLinear" },
    vignette: { enabled: true, weight: 1, color: [0, 0, 0] },
  });
  expect(planSceneEffects(linear, "pbr")?.imageProcessing).toEqual({
    sceneLinear: true,
    vignette: { enabled: true, weight: 1, color: [0, 0, 0] },
  });
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
    { sceneLinear: true, vignette: null },
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
