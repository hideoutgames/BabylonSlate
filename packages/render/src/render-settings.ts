import type { Scene } from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  resolveShadowSettings,
  type ShadowSettings,
  type ShadowOverrides,
  type ShadowDeviceProfile,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
  type RenderMode,
  type RenderProjectSettings,
} from "@babylonslate/core";

export type RenderShadingSettings = Partial<
  Pick<RenderProjectSettings, "mode" | "cel" | "shadows">
>;
type SceneRendering = {
  mode: RenderMode;
  cel: CelShadingSettings;
  project: RenderShadingSettings;
  overrides: CelShadingOverrides;
  shadows: ShadowSettings;
  shadowOverrides: ShadowOverrides;
  shadowDeviceProfile: ShadowDeviceProfile;
  listeners: Set<(mode: RenderMode) => void>;
};
const scenes = new WeakMap<Scene, SceneRendering>();

export function sceneRenderingSettings(scene: Scene): SceneRendering {
  let state = scenes.get(scene);
  if (!state) {
    state = {
      mode: "pbr",
      cel: normalizeCelShadingSettings(undefined),
      project: {},
      overrides: {},
      shadows: resolveShadowSettings(),
      shadowOverrides: {},
      shadowDeviceProfile: "project",
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
  state.shadows = resolveShadowSettings(state.project.shadows, state.shadowOverrides);
  const mode = state.project.mode === "cel" ? "cel" : "pbr";
  state.cel = resolveCelShadingSettings(state.project.cel, state.overrides);
  if (mode === state.mode) return;
  state.mode = mode;
  for (const listener of state.listeners) listener(mode);
}
