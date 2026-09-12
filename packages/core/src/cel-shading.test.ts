import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "./project";
import { createDefaultSceneSettings, normalizeSceneSettings } from "./scene";
import { normalizeCelShadingOverrides, normalizeCelShadingSettings, resolveCelShadingSettings } from "./cel-shading";

describe("CEL settings persistence and inheritance", () => {
  it("keeps legacy and new projects in PBR, and preserves CEL settings while inactive", () => {
    expect(normalizeProjectSettings({}).render.mode).toBe("pbr");
    expect(createEmptyProject("Demo").settings.render.mode).toBe("pbr");
    const authored = normalizeProjectSettings({ render: { mode: "cel", cel: normalizeCelShadingSettings({ shadowBands: 5, lightFalloff: "banded" }) } });
    const saved = JSON.parse(JSON.stringify(authored));
    expect(normalizeProjectSettings(saved).render).toMatchObject({ mode: "cel", cel: { shadowBands: 5, lightFalloff: "banded" } });
    expect(normalizeProjectSettings({ render: { ...authored.render, mode: "pbr" } }).render.cel).toEqual(authored.render.cel);
  });

  it("inherits each absent scene key live and restores inheritance by deleting an override", () => {
    expect(createDefaultSceneSettings().celShading).toEqual({});
    const scene = normalizeSceneSettings({ celShading: { shadowBands: 5, specularStrength: 0 } });
    const restored = normalizeSceneSettings(JSON.parse(JSON.stringify(scene)));
    const project = { shadowBands: 3, shadowStrength: 0.6, specularStrength: 0.5 };
    expect(resolveCelShadingSettings(project, restored.celShading)).toMatchObject({ shadowBands: 5, shadowStrength: 0.6, specularStrength: 0 });
    const changed = { ...project, shadowBands: 7, shadowStrength: 0.8 };
    expect(resolveCelShadingSettings(changed, restored.celShading)).toMatchObject({ shadowBands: 5, shadowStrength: 0.8 });
    delete restored.celShading!.shadowBands;
    expect(resolveCelShadingSettings(changed, restored.celShading)).toMatchObject({ shadowBands: 7, specularStrength: 0 });
  });

  it("rejects invalid overrides and bounds authored numbers before they reach shaders", () => {
    const overrides = normalizeCelShadingOverrides({ shadowBands: 99, shadowThreshold: -2, specularSize: 0, shadowStrength: NaN, bandSoftness: Infinity, lightFalloff: "invalid", unknown: 8 });
    expect(overrides).toEqual({ shadowBands: 8, shadowThreshold: 0.05, specularSize: 0.01 });
    expect(resolveCelShadingSettings({ shadowStrength: 0.3 }, overrides).shadowStrength).toBe(0.3);
    expect(normalizeCelShadingOverrides(null)).toEqual({});
  });
});
