import type { Scene } from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
  type RenderMode,
  type RenderProjectSettings,
} from "@babylonslate/core";

export type RenderShadingSettings = Partial<
  Pick<RenderProjectSettings, "mode" | "cel">
>;
type SceneRendering = {
  mode: RenderMode;
  cel: CelShadingSettings;
  project: RenderShadingSettings;
  overrides: CelShadingOverrides;
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
): void {
  const state = sceneRenderingSettings(scene);
  if (project !== undefined) state.project = project;
  if (overrides !== undefined) state.overrides = overrides;
  const mode = state.project.mode === "cel" ? "cel" : "pbr";
  state.cel = resolveCelShadingSettings(state.project.cel, state.overrides);
  if (mode === state.mode) return;
  state.mode = mode;
  for (const listener of state.listeners) listener(mode);
}
