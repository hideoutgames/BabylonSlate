import type { Scene } from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  resolveRenderingQuality,
  resolveLocalLightBudget,
  mergeRenderingQualityOverrides,
  type QualityOverrides,
  type ShadowSettings,
  type ShadowOverrides,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
  type RenderMode,
  type RenderProjectSettings,
  normalizeEnvironmentLightingSettings,
  resolveEnvironmentLightingSettings,
  type EnvironmentLightingSettings,
  type EnvironmentLightingOverrides,
} from "@babylonslate/core";

export type RenderShadingSettings = Partial<
  Pick<RenderProjectSettings, "mode" | "cel" | "shadows" | "quality" | "environmentLighting">
>;
type SceneRendering = {
  mode: RenderMode;
  qualityOverrides: QualityOverrides;
  localQualityOverrides: QualityOverrides;
  lightsDebug: boolean;
  textureLodBias: number;
  textureAnisotropy: number;
  localLightBudget: number;
  cel: CelShadingSettings;
  project: RenderShadingSettings;
  overrides: CelShadingOverrides;
  shadows: ShadowSettings;
  shadowOverrides: ShadowOverrides;
  environmentLighting: EnvironmentLightingSettings;
  environmentOverrides: EnvironmentLightingOverrides;
  listeners: Set<(mode: RenderMode) => void>;
};
const scenes = new WeakMap<Scene, SceneRendering>();

export function sceneRenderingSettings(scene: Scene): SceneRendering {
  let state = scenes.get(scene);
  if (!state) {
    state = {
      mode: "pbr",
      qualityOverrides: {},
      localQualityOverrides: {},
      lightsDebug: false,
      textureLodBias: 0,
      textureAnisotropy: 4,
      localLightBudget: resolveLocalLightBudget(resolveRenderingQuality().lighting),
      cel: normalizeCelShadingSettings(undefined),
      project: {},
      overrides: {},
      shadows: resolveRenderingQuality().shadows,
      shadowOverrides: {},
      environmentLighting: normalizeEnvironmentLightingSettings(undefined),
      environmentOverrides: {},
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
  environmentOverrides?: EnvironmentLightingOverrides,
): void {
  const state = sceneRenderingSettings(scene);
  if (project !== undefined) state.project = project;
  if (overrides !== undefined) state.overrides = overrides;
  if (shadowOverrides !== undefined) state.shadowOverrides = shadowOverrides;
  if (environmentOverrides !== undefined) state.environmentOverrides = environmentOverrides;
  state.environmentLighting = resolveEnvironmentLightingSettings(state.project.environmentLighting, state.environmentOverrides);
  const quality = resolveSceneRenderingQuality(scene);
  state.shadows = quality.shadows;
  state.localLightBudget = resolveLocalLightBudget(quality.lighting);
  state.textureLodBias = quality.textures.lodBias;
  state.textureAnisotropy = Math.min(quality.textures.anisotropy, scene.getEngine().getCaps().maxAnisotropy ?? 1);
  for (const texture of scene.textures) texture.anisotropicFilteringLevel = state.textureAnisotropy;
  const mode = state.project.mode === "cel" ? "cel" : "pbr";
  state.cel = resolveCelShadingSettings(state.project.cel, state.overrides);
  if (mode === state.mode) return;
  state.mode = mode;
  for (const listener of state.listeners) listener(mode);
}

/** Explicit editor preferences precede session commands and never change authored settings. */
export function resolveSceneRenderingQuality(scene: Scene) {
  const state = sceneRenderingSettings(scene);
  const local = state.localQualityOverrides;
  const session = state.qualityOverrides;
  return resolveRenderingQuality(state.project, state.shadowOverrides, mergeRenderingQualityOverrides(local, session));
}
