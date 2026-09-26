import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderEffectsSettings,
} from "./render-effects";
import { normalizeProjectSettings } from "./project";

describe("render effects settings", () => {
  it("normalizes missing and invalid input to the display-identical defaults", () => {
    for (const value of [undefined, null, 42, "bloom", []]) {
      expect(normalizeRenderEffectsSettings(value)).toEqual(
        DEFAULT_RENDER_EFFECTS,
      );
    }
    const normalized = normalizeRenderEffectsSettings({
      colorPipeline: { version: 7, mode: "linear" },
      toneMapping: "filmic",
      exposure: Number.NaN,
      contrast: "high",
      vignette: "yes",
      bloom: null,
      fxaa: "on",
    });
    expect(normalized).toEqual(DEFAULT_RENDER_EFFECTS);
  });

  it("preserves authored values and clamps out-of-range numbers", () => {
    const normalized = normalizeRenderEffectsSettings({
      colorPipeline: { mode: "sceneLinear" },
      toneMapping: "aces",
      exposure: 2.5,
      contrast: 1.2,
      vignette: { enabled: true, weight: 2.25, color: [0.1, 0.2, 0.3] },
      bloom: { enabled: true, threshold: 0.75, weight: 0.4, kernel: 96, scale: 0.25 },
      fxaa: true,
    });
    expect(normalized).toEqual({
      ...DEFAULT_RENDER_EFFECTS,
      colorPipeline: { version: 1, mode: "sceneLinear" },
      toneMapping: "aces",
      exposure: 2.5,
      contrast: 1.2,
      vignette: { enabled: true, weight: 2.25, color: [0.1, 0.2, 0.3] },
      bloom: { enabled: true, threshold: 0.75, weight: 0.4, kernel: 96, scale: 0.25 },
      fxaa: true,
    });
    const clamped = normalizeRenderEffectsSettings({
      exposure: 1000,
      contrast: -4,
      vignette: { enabled: true, weight: 50, color: [2, -1, 0.5, 9] },
      bloom: { enabled: true, threshold: -3, weight: 99, kernel: 8192.7, scale: 0 },
    });
    expect(clamped.exposure).toBe(100);
    expect(clamped.contrast).toBe(0);
    expect(clamped.vignette.weight).toBe(10);
    expect(clamped.vignette.color).toEqual([1, 0, 0.5]);
    expect(clamped.bloom.threshold).toBe(0);
    expect(clamped.bloom.weight).toBe(10);
    expect(clamped.bloom.kernel).toBe(512);
    expect(clamped.bloom.scale).toBe(0.05);
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
    expect(
      normalizeRenderEffectsSettings({ toneMapping: "agx" }).toneMapping,
    ).toBe("none");
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
          colorPipeline: { version: 1, mode: "sceneLinear" },
          toneMapping: "neutral",
          bloom: { ...DEFAULT_RENDER_EFFECTS.bloom, enabled: true },
          reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true, maxSteps: 48 },
          volumetricLighting: { ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, density: 0.08 },
          fxaa: true,
        },
      },
    });
    expect(settings.render.effects?.colorPipeline).toEqual({
      version: 1,
      mode: "sceneLinear",
    });
    expect(settings.render.effects?.toneMapping).toBe("neutral");
    expect(settings.render.effects?.bloom.enabled).toBe(true);
    expect(settings.render.effects?.bloom.kernel).toBe(
      DEFAULT_RENDER_EFFECTS.bloom.kernel,
    );
    expect(settings.render.effects?.fxaa).toBe(true);
    expect(settings.render.effects?.reflections).toEqual({ ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true, maxSteps: 48 });
    expect(settings.render.effects?.volumetricLighting).toEqual({ ...DEFAULT_RENDER_EFFECTS.volumetricLighting, enabled: true, density: 0.08 });
    expect(normalizeProjectSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });
});

it("bounds spatial GPU work and preserves authored settings while disabled", () => {
  const value = normalizeRenderEffectsSettings({
    reflections: { enabled: "true", maxSteps: 1e8, resolutionScale: 0, thickness: Number.NaN, strength: -1 },
    volumetricLighting: { enabled: false, maxLights: 100, steps: 15.6, density: 0.1, anisotropy: 1, maxDistance: -2 },
  });
  expect(value.reflections).toEqual({ ...DEFAULT_RENDER_EFFECTS.reflections, maxSteps: 128, resolutionScale: 0.25, strength: 0 });
  expect(value.volumetricLighting).toEqual({ ...DEFAULT_RENDER_EFFECTS.volumetricLighting, maxLights: 4, steps: 16, density: 0.1, anisotropy: 0.9, maxDistance: 0.1 });
});
