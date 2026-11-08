import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderEffectsOverrides,
  normalizeRenderEffectsSettings,
  renderEffectsAssetGuids,
  resolveRenderEffectsSettings,
} from "./render-effects";
import { normalizeProjectSettings } from "./project";
import { normalizeSceneSettings } from "./scene";

describe("render effects settings", () => {
  it("normalizes missing and invalid input to the display-identical defaults", () => {
    for (const value of [undefined, null, 42, "bloom", []]) {
      expect(normalizeRenderEffectsSettings(value)).toEqual(
        DEFAULT_RENDER_EFFECTS,
      );
    }
    const normalized = normalizeRenderEffectsSettings({
      colorPipeline: { mode: "linear" },
      toneMapping: "filmic",
      exposure: Number.NaN,
      contrast: "high",
      vignette: "yes",
      bloom: null,
    });
    expect(normalized).toEqual(DEFAULT_RENDER_EFFECTS);
  });

  it("preserves authored values and clamps out-of-range numbers", () => {
    const normalized = normalizeRenderEffectsSettings({
      colorPipeline: { mode: "sceneLinear" },
      toneMapping: "aces",
      exposure: 2.5,
      contrast: 1.2,
      whiteBalance: { enabled: true, temperature: 3200, tint: -20 },
      vignette: { enabled: true, weight: 2.25, color: [0.1, 0.2, 0.3] },
      bloom: { enabled: true, threshold: 0.75, weight: 0.4, kernel: 96, scale: 0.25 },
      upscaling: { enabled: true, renderScale: 0.75, sharpness: 0.5 },
      // Removed settings (temporal anti-aliasing) are dropped, not carried.
      temporalAntiAliasing: { enabled: true, samples: 16, blend: 0.2 },
    });
    expect(normalized).toEqual({
      ...DEFAULT_RENDER_EFFECTS,
      colorPipeline: { mode: "sceneLinear" },
      toneMapping: "aces",
      exposure: 2.5,
      contrast: 1.2,
      whiteBalance: { enabled: true, temperature: 3200, tint: -20 },
      vignette: { enabled: true, weight: 2.25, color: [0.1, 0.2, 0.3] },
      bloom: { enabled: true, threshold: 0.75, weight: 0.4, kernel: 96, scale: 0.25 },
      upscaling: { enabled: true, renderScale: 0.75, sharpness: 0.5 },
    });
    const clamped = normalizeRenderEffectsSettings({
      exposure: 1000,
      contrast: -4,
      whiteBalance: { enabled: true, temperature: 100, tint: 900 },
      vignette: { enabled: true, weight: 50, color: [2, -1, 0.5, 9] },
      bloom: { enabled: true, threshold: -3, weight: 99, kernel: 8192.7, scale: 0 },
      upscaling: { enabled: true, renderScale: 0.1, sharpness: 9 },
    });
    expect(clamped.exposure).toBe(100);
    expect(clamped.contrast).toBe(0);
    expect(clamped.whiteBalance).toEqual({ enabled: true, temperature: 1700, tint: 150 });
    expect(clamped.vignette.weight).toBe(10);
    expect(clamped.vignette.color).toEqual([1, 0, 0.5]);
    expect(clamped.bloom.threshold).toBe(0);
    expect(clamped.bloom.weight).toBe(10);
    expect(clamped.bloom.kernel).toBe(512);
    expect(clamped.bloom.scale).toBe(0.05);
    expect(clamped.upscaling).toEqual({ enabled: true, renderScale: 0.5, sharpness: 2 });
  });

  it("thins scene-wide fog above its height by default, clamped to its limits", () => {
    expect(normalizeRenderEffectsSettings(undefined).volumetricLighting).toMatchObject({ density: 0.003, height: 0, heightFalloff: 0.1 });
    expect(normalizeRenderEffectsSettings({ volumetricLighting: { height: -12.5, heightFalloff: 9 } }).volumetricLighting)
      .toMatchObject({ height: -12.5, heightFalloff: 2 });
  });

  it("accepts only declared enum values", () => {
    for (const mode of ["sceneLinear", "legacyDisplay"] as const) {
      expect(
        normalizeRenderEffectsSettings({ colorPipeline: { mode } })
          .colorPipeline.mode,
      ).toBe(mode);
    }
    for (const toneMapping of ["none", "standard", "aces", "neutral"] as const) {
      expect(
        normalizeRenderEffectsSettings({ toneMapping }).toneMapping,
      ).toBe(toneMapping);
    }
    // An unknown value falls back to the default, Neutral.
    expect(
      normalizeRenderEffectsSettings({ toneMapping: "agx" }).toneMapping,
    ).toBe("neutral");
  });

  it("loads legacy projects without the effects block unchanged", () => {
    const settings = normalizeProjectSettings({
      render: { mode: "cel", width: 1280, height: 720 },
    });
    expect(settings.render.effects).toEqual(DEFAULT_RENDER_EFFECTS);
    expect(settings.render.mode).toBe("cel");
    expect(settings.render.width).toBe(1280);
  });

  it("round-trips an authored effects block through project settings", () => {
    const settings = normalizeProjectSettings({
      render: {
        effects: {
          ...DEFAULT_RENDER_EFFECTS,
          colorPipeline: { mode: "sceneLinear" },
          toneMapping: "neutral",
          bloom: { ...DEFAULT_RENDER_EFFECTS.bloom, enabled: true },
          ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true, radius: 1.5 },
          colorGrading: { enabled: true, lutTextureGuid: " lut-guid " },
          reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true, maxSteps: 48 },
          volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, density: 0.08 },
        },
      },
    });
    expect(settings.render.effects?.colorPipeline).toEqual({
      mode: "sceneLinear",
    });
    expect(settings.render.effects?.toneMapping).toBe("neutral");
    expect(settings.render.effects?.bloom.enabled).toBe(true);
    expect(settings.render.effects?.bloom.kernel).toBe(
      DEFAULT_RENDER_EFFECTS.bloom.kernel,
    );
    expect(settings.render.effects?.colorGrading).toEqual({ enabled: true, lutTextureGuid: "lut-guid" });
    expect(renderEffectsAssetGuids(settings.render.effects)).toEqual(["lut-guid"]);
    expect(renderEffectsAssetGuids({ ...settings.render.effects!, colorGrading: { enabled: false, lutTextureGuid: "lut-guid" } })).toEqual([]);
    expect(settings.render.effects?.ambientOcclusion).toEqual({ ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true, radius: 1.5 });
    expect(settings.render.effects?.reflections).toEqual({ ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true, maxSteps: 48 });
    expect(settings.render.effects?.volumetricLighting).toEqual({ ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, density: 0.08 });
    expect(normalizeProjectSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });
});

it("bounds spatial GPU work and preserves authored settings while disabled", () => {
  const value = normalizeRenderEffectsSettings({
    reflections: { enabled: "true", maxSteps: 1e8, resolutionScale: 0, thickness: Number.NaN, strength: -1 },
    volumetricLighting: { enabled: false, maxLights: 100, steps: 15.6, density: 0.1, anisotropy: 1, maxDistance: -2 },
    ambientOcclusion: { enabled: 1, samples: 99.4, resolutionScale: 2, radius: 0, strength: Number.POSITIVE_INFINITY, maxDistance: 20 },
  });
  expect(value.ambientOcclusion).toEqual({ ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, samples: 32, resolutionScale: 1, radius: 0.05, maxDistance: 20 });
  expect(value.reflections).toEqual({ ...DEFAULT_RENDER_EFFECTS.reflections, maxSteps: 128, resolutionScale: 0.25, strength: 0 });
  expect(value.volumetricLighting).toEqual({ ...DEFAULT_RENDER_EFFECTS.volumetricLighting, maxLights: 4, steps: 16, density: 0.1, anisotropy: 0.9, maxDistance: 0.1 });
});

describe("Scene Post Processing overrides", () => {
  it("keeps only the leaves the project block accepts, clamped as there", () => {
    expect(normalizeRenderEffectsOverrides({
      colorPipeline: { mode: "sceneLinear" },
      toneMapping: "filmic",
      exposure: 500,
      contrast: Number.NaN,
      bloom: { enabled: true, kernel: 10.6, glow: 1 },
      vignette: { color: [2, 0.5, -1], weight: "heavy" },
      whiteBalance: { enabled: 1 },
      colorGrading: { lutTextureGuid: " lut " },
      upscaling: {},
      sharpen: true,
    })).toEqual({
      colorPipeline: { mode: "sceneLinear" },
      exposure: 100,
      bloom: { enabled: true, kernel: 11 },
      vignette: { color: [1, 0.5, 0] },
      colorGrading: { lutTextureGuid: "lut" },
    });
    // No LUT is a choice a Scene can make; a blank one is not a Texture.
    expect(normalizeRenderEffectsOverrides({ colorGrading: { lutTextureGuid: null } })).toEqual({ colorGrading: { lutTextureGuid: null } });
    expect(normalizeRenderEffectsOverrides({ colorGrading: { lutTextureGuid: "  " } })).toEqual({});
    expect(normalizeRenderEffectsOverrides("bloom")).toEqual({});
  });

  it("replaces only the overridden leaves of the project effects", () => {
    const project = { ...DEFAULT_RENDER_EFFECTS, bloom: { ...DEFAULT_RENDER_EFFECTS.bloom, enabled: true, weight: 0.4 }, exposure: 2 };
    const resolved = resolveRenderEffectsSettings(project, { bloom: { threshold: 0.5 }, vignette: { enabled: true }, contrast: 3 });
    expect(resolved.bloom).toEqual({ ...project.bloom, threshold: 0.5 });
    expect(resolved.vignette).toEqual({ ...DEFAULT_RENDER_EFFECTS.vignette, enabled: true });
    expect(resolved.exposure).toBe(2);
    expect(resolved.contrast).toBe(3);
    expect(resolved.colorPipeline).toEqual({ mode: "legacyDisplay" });
    expect(resolveRenderEffectsSettings(project, undefined)).toEqual(normalizeRenderEffectsSettings(project));
  });

  it("stores a Scene's overrides sparse, through a save and reload", () => {
    const settings = normalizeSceneSettings({ effectsOverrides: { bloom: { enabled: true }, exposure: "2" } });
    expect(settings.effectsOverrides).toEqual({ bloom: { enabled: true } });
    expect(normalizeSceneSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(normalizeSceneSettings({}).effectsOverrides).toEqual({});
  });
});
