import { RenderTargetTexture, type BaseTexture, type Scene } from "@babylonjs/core";
import {
  mergeRenderSettings,
  type RenderSettingsPatch,
  normalizeCelShadingSettings,
  normalizeCelShadingOverrides,
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
  normalizeRenderEffectsSettings,
  type RenderEffectsSettings,
} from "@babylonslate/core";
import {
  planSceneEffects,
  sceneEffectsKey,
  type SceneEffectsPlan,
} from "./scene-effects";

export type RenderShadingSettings = Partial<
  Pick<RenderProjectSettings, "mode" | "cel" | "shadows" | "quality" | "environmentLighting" | "renderPath" | "gpuBackend" | "effects">
>;
type SceneRendering = {
  mode: RenderMode;
  qualityOverrides: QualityOverrides;
  runtimeOverrides: RenderSettingsPatch;
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
  effects: RenderEffectsSettings;
  /** Session post-processing toggle; off also restores per-material display. */
  effectsEnabled: boolean;
  /** Baked identity of the live effects settings; rebuilt only on a settings
   * change so per-frame readiness probes never serialize the block again. */
  effectsKey: string;
  /** Renderable chain for the live settings; null means no owned passes. */
  effectsPlan: SceneEffectsPlan | null;
  listeners: Set<(mode: RenderMode) => void>;
};
const scenes = new WeakMap<Scene, SceneRendering>();

/** Render targets own their sampling contract (notably hardware shadow PCF). */
export function applyMaterialTextureAnisotropy(texture: BaseTexture, level: number): void {
  // addTexture notifies inside BaseTexture's constructor, before an RTT sets
  // isRenderTarget. The prototype guard also covers that notification window.
  if (texture.isRenderTarget || texture instanceof RenderTargetTexture) return;
  texture.anisotropicFilteringLevel = level;
}

export function sceneRenderingSettings(scene: Scene): SceneRendering {
  let state = scenes.get(scene);
  if (!state) {
    const effects = normalizeRenderEffectsSettings(undefined);
    state = {
      mode: "pbr",
      qualityOverrides: {},
      runtimeOverrides: {},
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
      effects,
      effectsEnabled: true,
      effectsKey: sceneEffectsKey(effects, "pbr", true),
      effectsPlan: planSceneEffects(effects, "pbr", true),
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
  const resolved = mergeRenderSettings(state.project, state.runtimeOverrides);
  state.environmentLighting = resolveEnvironmentLightingSettings(resolveEnvironmentLightingSettings(state.project.environmentLighting, state.environmentOverrides), state.runtimeOverrides.environmentLighting);
  const quality = resolveSceneRenderingQuality(scene);
  state.shadows = quality.shadows;
  state.localLightBudget = resolveLocalLightBudget(quality.lighting);
  state.textureLodBias = quality.textures.lodBias;
  state.textureAnisotropy = Math.min(quality.textures.anisotropy, scene.getEngine().getCaps().maxAnisotropy ?? 1);
  for (const texture of scene.textures) applyMaterialTextureAnisotropy(texture, state.textureAnisotropy);
  const mode = resolved.mode === "cel" ? "cel" : "pbr";
  state.cel = resolveCelShadingSettings(state.project.cel, {
    ...normalizeCelShadingOverrides(state.overrides),
    ...normalizeCelShadingOverrides(state.runtimeOverrides.cel),
  });
  state.effects = normalizeRenderEffectsSettings(resolved.effects);
  if (mode !== state.mode) {
    state.mode = mode;
    for (const listener of state.listeners) listener(mode);
  }
  state.effectsKey = sceneEffectsKey(
    state.effects,
    state.mode,
    state.effectsEnabled,
  );
  state.effectsPlan = planSceneEffects(
    state.effects,
    state.mode,
    state.effectsEnabled,
  );
  syncImageProcessingMode(scene, state);
}

/**
 * Session post-processing toggle. Disabling also restores per-material image
 * processing so the Scene Linear pipeline never leaves materials emitting
 * linear color without a display stage to convert it.
 */
export function setSceneEffectsEnabled(scene: Scene, enabled: boolean): void {
  const state = sceneRenderingSettings(scene);
  if (state.effectsEnabled === enabled) return;
  state.effectsEnabled = enabled;
  updateSceneRenderingSettings(scene);
}

/** Materials emit linear HDR only while a Scene Linear display stage exists. */
function syncImageProcessingMode(
  scene: Scene,
  state: SceneRendering,
): void {
  const linear =
    state.effectsEnabled &&
    state.effects.colorPipeline.mode === "sceneLinear" &&
    state.mode === "pbr";
  if (scene.imageProcessingConfiguration.applyByPostProcess !== linear)
    scene.imageProcessingConfiguration.applyByPostProcess = linear;
}

/** Explicit editor preferences precede session commands and never change authored settings. */
export function resolveSceneRenderingQuality(scene: Scene) {
  const state = sceneRenderingSettings(scene);
  const local = state.localQualityOverrides;
  const session = state.qualityOverrides;
  return resolveRenderingQuality(state.project, state.shadowOverrides, mergeRenderingQualityOverrides(local, session));
}
