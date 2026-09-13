import type { Scene } from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  resolveRenderingQuality,
  type QualityOverrides,
  type ShadowSettings,
  type ShadowOverrides,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
  type RenderMode,
  type RenderProjectSettings,
} from "@babylonslate/core";

export type RenderShadingSettings = Partial<
  Pick<RenderProjectSettings, "mode" | "cel" | "shadows" | "quality">
>;
type SceneRendering = {
  mode: RenderMode;
  qualityOverrides: QualityOverrides;
  lightsDebug: boolean;
  textureLodBias: number;
  cel: CelShadingSettings;
  project: RenderShadingSettings;
  overrides: CelShadingOverrides;
  shadows: ShadowSettings;
  shadowOverrides: ShadowOverrides;
  listeners: Set<(mode: RenderMode) => void>;
};
const scenes = new WeakMap<Scene, SceneRendering>();

export function sceneRenderingSettings(scene: Scene): SceneRendering {
  let state = scenes.get(scene);
  if (!state) {
    state = {
      mode: "pbr",
      qualityOverrides: {},
      lightsDebug: false,
      textureLodBias: 0,
      cel: normalizeCelShadingSettings(undefined),
      project: {},
      overrides: {},
      shadows: resolveRenderingQuality().shadows,
      shadowOverrides: {},
      listeners: new Set(),
    };
    scenes.set(scene, state);
    const owned = state;
    scene.onDisposeObservable.addOnce(() => {
      owned.listeners.clear();
      scenes.delete(scene);
    });
  }
  return state;
}

export function updateSceneRenderingSettings(
  scene: Scene,
  project?: RenderShadingSettings,
  overrides?: CelShadingOverrides,
  shadowOverrides?: ShadowOverrides,
): void {
  const state = sceneRenderingSettings(scene);
  if (project !== undefined) state.project = project;
  if (overrides !== undefined) state.overrides = overrides;
  if (shadowOverrides !== undefined) state.shadowOverrides = shadowOverrides;
  const quality = resolveRenderingQuality(state.project, state.shadowOverrides, state.qualityOverrides);
  state.shadows = quality.shadows;
  state.textureLodBias = quality.textures.lodBias;
  const mode = state.project.mode === "cel" ? "cel" : "pbr";
  state.cel = resolveCelShadingSettings(state.project.cel, state.overrides);
  if (mode === state.mode) return;
  state.mode = mode;
  for (const listener of state.listeners) listener(mode);
}
