import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "./project";
import { createDefaultSceneSettings, normalizeSceneSettings } from "./scene";
import { applyProjectQualityPatch, qualityPresetPatch } from "./render-quality";
import {
  normalizeCelShadingOverrides,
  normalizeCelShadingSettings,
  resolveCelShadingSettings,
} from "./cel-shading";

describe("CEL settings persistence and inheritance", () => {
  it("preserves authored outlines through save, PBR switches, quality presets and scene inheritance", () => {
    expect(normalizeCelShadingSettings({})).toMatchObject({ outlinesEnabled: true, outlineColor: [0.03, 0.03, 0.03], outlineWidth: 1 });
    const project = normalizeProjectSettings({ render: { mode: "cel", cel: normalizeCelShadingSettings({
      outlinesEnabled: false, outlineColor: [0.25, 0.5, 0.75], outlineWidth: 2.25,
      outlineDistanceFadeEnabled: true, outlineFadeStart: 25, outlineFadeEnd: 80,
    }) } });
    const low = applyProjectQualityPatch(project.render, qualityPresetPatch("low"));
    const restored = normalizeProjectSettings(JSON.parse(JSON.stringify({ ...project, render: { ...low, mode: "pbr" } })));
    expect(restored.render.cel).toEqual(project.render.cel);
    const scene = normalizeSceneSettings({ celShading: { outlinesEnabled: true, outlineWidth: 3 } });
    expect(resolveCelShadingSettings(restored.render.cel, scene.celShading)).toMatchObject({
      outlinesEnabled: true, outlineColor: [0.25, 0.5, 0.75], outlineWidth: 3,
    });
    delete scene.celShading!.outlineWidth;
    expect(resolveCelShadingSettings({ ...restored.render.cel, outlineWidth: 4 }, scene.celShading).outlineWidth).toBe(4);
    expect(normalizeCelShadingOverrides({ outlineWidth: 99, outlineColor: [-1, 0.123456, 2] })).toEqual({ outlineWidth: 8, outlineColor: [0, 0.123456, 1] });
    expect(normalizeCelShadingOverrides({ outlinesEnabled: "false", outlineWidth: NaN, outlineColor: [1, Infinity, 0] })).toEqual({});
  });
  it("resolves a finite increasing fade range after independent scene inheritance", () => {
    expect(normalizeCelShadingSettings({})).toMatchObject({ outlineDistanceFadeEnabled: false, outlineFadeStart: 50, outlineFadeEnd: 100 });
    const overrides = normalizeCelShadingOverrides({ outlineFadeEnd: 10 });
    expect(resolveCelShadingSettings({ outlineFadeStart: 20 }, overrides)).toMatchObject({ outlineFadeStart: 20, outlineFadeEnd: 20.01 });
    expect(overrides).toEqual({ outlineFadeEnd: 10 });
    expect(resolveCelShadingSettings({ outlineFadeStart: 5 }, overrides)).toMatchObject({ outlineFadeStart: 5, outlineFadeEnd: 10 });
    expect(normalizeCelShadingOverrides({ outlineFadeStart: NaN, outlineFadeEnd: Infinity, outlineDistanceFadeEnabled: "true" })).toEqual({});
    expect(normalizeCelShadingSettings({ outlineFadeStart: -20, outlineFadeEnd: -5 })).toMatchObject({ outlineFadeStart: 0, outlineFadeEnd: 0.01 });
    const bounded = normalizeCelShadingSettings({ outlineFadeStart: 1e20, outlineFadeEnd: 1e20 });
    expect(bounded.outlineFadeEnd).toBeLessThanOrEqual(1_000_000);
    expect(bounded.outlineFadeEnd).toBeGreaterThan(bounded.outlineFadeStart);
    for (const start of [500_000, 999_999.99, 2 ** 19 - 0.005, 2 ** 18 - 0.001]) {
      const range = normalizeCelShadingSettings({ outlineFadeStart: start, outlineFadeEnd: start + 0.01 });
      expect(Math.fround(range.outlineFadeEnd)).toBeGreaterThan(Math.fround(range.outlineFadeStart));
    }
  });
  it("keeps legacy and new projects in PBR, and preserves CEL settings while inactive", () => {
    expect(normalizeProjectSettings({}).render.mode).toBe("pbr");
    expect(createEmptyProject("Demo").settings.render.mode).toBe("pbr");
    const authored = normalizeProjectSettings({
      render: {
        mode: "cel",
        cel: normalizeCelShadingSettings({
          shadowBands: 5,
          lightMixing: "blend",
          specularEnabled: false,
        }),
      },
    });
    const saved = JSON.parse(JSON.stringify(authored));
    expect(normalizeProjectSettings(saved).render).toMatchObject({
      mode: "cel",
      cel: { shadowBands: 5, lightMixing: "blend", specularEnabled: false },
    });
    expect(
      normalizeProjectSettings({ render: { ...authored.render, mode: "pbr" } })
        .render.cel,
    ).toEqual(authored.render.cel);
  });

  it("inherits each absent scene key live and restores inheritance by deleting an override", () => {
    expect(createDefaultSceneSettings().celShading).toEqual({});
    const scene = normalizeSceneSettings({
      celShading: { shadowBands: 5, specularStrength: 0 },
    });
    const restored = normalizeSceneSettings(JSON.parse(JSON.stringify(scene)));
    const project = {
      shadowBands: 3,
      shadowStrength: 0.6,
      specularStrength: 0.5,
    };
    expect(
      resolveCelShadingSettings(project, restored.celShading),
    ).toMatchObject({
      shadowBands: 5,
      shadowStrength: 0.6,
      specularStrength: 0,
    });
    const changed = { ...project, shadowBands: 7, shadowStrength: 0.8 };
    expect(
      resolveCelShadingSettings(changed, restored.celShading),
    ).toMatchObject({ shadowBands: 5, shadowStrength: 0.8 });
    delete restored.celShading!.shadowBands;
    expect(
      resolveCelShadingSettings(changed, restored.celShading),
    ).toMatchObject({ shadowBands: 7, specularStrength: 0 });
  });

  it("rejects invalid overrides and bounds authored numbers before they reach shaders", () => {
    const overrides = normalizeCelShadingOverrides({
      shadowBands: 99,
      shadowThreshold: -2,
      specularSize: 0,
      shadowStrength: NaN,
      bandSoftness: 0.4,
      specularSoftness: Infinity,
      lightFalloff: "smooth",
      lightMixing: "invalid",
      unknown: 8,
      specularEnabled: "false",
    });
    expect(overrides).toEqual({
      shadowBands: 8,
      shadowThreshold: 0.05,
      specularSize: 0.01,
    });
    expect(
      resolveCelShadingSettings({ shadowStrength: 0.3 }, overrides)
        .shadowStrength,
    ).toBe(0.3);
    expect(normalizeCelShadingOverrides(null)).toEqual({});
  });
});
