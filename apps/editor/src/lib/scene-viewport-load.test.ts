import { describe, expect, it, vi } from "vitest";
import { normalizeCelShadingSettings, normalizeShadowSettings } from "@babylonslate/core";
import {
  isSceneViewportRemountLoad,
  runSceneViewportBlockingLoad,
  sceneViewportRenderSettingsKey,
} from "./scene-viewport-load";

it("reloads effective CEL changes while ignoring inactive and inherited-equivalent edits", () => {
  const project = { mode: "cel" as const, cel: normalizeCelShadingSettings({}) };
  const initial = sceneViewportRenderSettingsKey(project);
  expect(sceneViewportRenderSettingsKey(project, { shadowBands: 3 })).toBe(initial);
  expect(sceneViewportRenderSettingsKey(project, { specularEnabled: false })).not.toBe(initial);
  expect(sceneViewportRenderSettingsKey({ ...project, mode: "pbr" })).not.toBe(initial);
  expect(sceneViewportRenderSettingsKey({ mode: "pbr", cel: project.cel }, { shadowBands: 6 }))
    .toBe(sceneViewportRenderSettingsKey({ mode: "pbr" }));
});

it("reloads effective shadow changes in PBR and CEL and restores inherited values", () => {
  for (const mode of ["pbr", "cel"] as const) {
    const project = { mode, shadows: normalizeShadowSettings({ distance: 200 }) };
    const initial = sceneViewportRenderSettingsKey(project);
    expect(sceneViewportRenderSettingsKey(project, {}, { distance: 200 })).toBe(initial);
    expect(sceneViewportRenderSettingsKey(project, {}, { distance: 80 })).not.toBe(initial);
    expect(sceneViewportRenderSettingsKey(project, {}, {})).toBe(initial);
  }
});

describe("isSceneViewportRemountLoad", () => {
  it("is true until that engine generation has finished its first load", () => {
    expect(isSceneViewportRemountLoad(1, -1)).toBe(true);
    expect(isSceneViewportRemountLoad(2, 1)).toBe(true);
    expect(isSceneViewportRemountLoad(1, 1)).toBe(false);
  });
});

describe("runSceneViewportBlockingLoad", () => {
  it("reports collect then model-ready then shader-warm progress", async () => {
    const progress: Array<{ value: number; phase: string }> = [];
    const collect = vi.fn(async () => undefined);
    const whenModelsReady = vi.fn(async () => undefined);
    const warmShaders = vi.fn(async () => undefined);
    await runSceneViewportBlockingLoad({
      collect,
      whenModelsReady,
      warmShaders,
      onProgress: (value, phase) => progress.push({ value, phase }),
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(whenModelsReady).toHaveBeenCalledOnce();
    expect(warmShaders).toHaveBeenCalledOnce();
    expect(progress).toEqual([
      { value: 0, phase: "Collecting Assets" },
      { value: 34, phase: "Loading Models" },
      { value: 67, phase: "Warming Shaders" },
      { value: 100, phase: "Warming Shaders" },
    ]);
  });
});
