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
  WATER_QUALITY_FIELDS,
  type WaterQuality,
} from "@babylonslate/core";
import {
  planSceneEffects,
  sceneEffectsKey,
  type SceneEffectsPlan,
} from "./scene-effects";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { clampWaterQualityToDevice, type WaterQualityDeviceClamp } from "./water-quality-device";

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
  /** Automatic Model LOD selection; false keeps every model on full detail. */
  autoLod: boolean;
  lodDistanceScale: number;
  /** Resolved Water quality values (no preset metadata); replaced only on a real change. */
  water: Readonly<WaterQuality>;
  /** Process-unique, so a Scene that starts following another never reuses a stale value. */
  waterRevision: number;
  waterDevice: { revision: number; clamp: WaterQualityDeviceClamp } | null;
  /** Scenes (such as SceneLayers) resolving their quality through this Scene. */
  followers: Set<Scene>;
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
  /** Local components request the shared fog pass without changing project settings. */
  fogVolumesPresent: boolean;
  /** Baked identity of the live effects settings; rebuilt only on a settings
   * change so per-frame readiness probes never serialize the block again. */
  effectsKey: string;
  /** Renderable chain for the live settings; null means no owned passes. */
  effectsPlan: SceneEffectsPlan | null;
  listeners: Set<(mode: RenderMode) => void>;
};
const scenes = new WeakMap<Scene, SceneRendering>();
/** Scenes whose project quality resolves through another Scene (SceneLayers follow the world). */
const settingsOwners = new WeakMap<Scene, Scene>();
let waterRevisions = 0;

function waterQualityValues(quality: Readonly<WaterQuality>): Readonly<WaterQuality> {
  const values: Record<string, unknown> = {};
  for (const field of WATER_QUALITY_FIELDS) values[field] = quality[field];
  return Object.freeze(values as unknown as WaterQuality);
}

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
    const quality = resolveRenderingQuality();
    state = {
      mode: "pbr",
      qualityOverrides: {},
      runtimeOverrides: {},
      localQualityOverrides: {},
      lightsDebug: false,
      textureLodBias: 0,
      textureAnisotropy: 4,
      autoLod: quality.geometry.autoLod,
      lodDistanceScale: quality.geometry.lodDistanceScale,
      water: waterQualityValues(quality.water),
      waterRevision: ++waterRevisions,
      waterDevice: null,
      followers: new Set(),
      localLightBudget: resolveLocalLightBudget(quality.lighting),
      cel: normalizeCelShadingSettings(undefined),
      project: {},
      overrides: {},
      shadows: quality.shadows,
      shadowOverrides: {},
      environmentLighting: normalizeEnvironmentLightingSettings(undefined),
      environmentOverrides: {},
      effects,
      effectsEnabled: true,
      fogVolumesPresent: false,
      effectsKey: sceneEffectsKey(effects, "pbr", true),
      effectsPlan: planSceneEffects(effects, "pbr", true),
      listeners: new Set(),
    };
    scenes.set(scene, state);
    const owned = state;
    scene.onDisposeObservable.addOnce(() => {
      owned.listeners.clear();
      for (const follower of owned.followers) settingsOwners.delete(follower);
      owned.followers.clear();
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
  state.autoLod = quality.geometry.autoLod;
  state.lodDistanceScale = quality.geometry.lodDistanceScale;
  syncWaterQuality(scene, state, quality.water);
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
    state.fogVolumesPresent,
  );
  state.effectsPlan = planSceneEffects(
    state.effects,
    state.mode,
    state.effectsEnabled,
    state.fogVolumesPresent,
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

/** Only presence changes rebuild the pass; bounds and density remain live uniforms. */
export function setSceneFogVolumesPresent(scene: Scene, present: boolean): void {
  const state = sceneRenderingSettings(scene);
  if (state.fogVolumesPresent === present || scene.isDisposed) return;
  state.fogVolumesPresent = present;
  state.effectsKey = sceneEffectsKey(state.effects, state.mode, state.effectsEnabled, present);
  state.effectsPlan = planSceneEffects(state.effects, state.mode, state.effectsEnabled, present);
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

function sameWaterQuality(a: Readonly<WaterQuality>, b: Readonly<WaterQuality>): boolean {
  return WATER_QUALITY_FIELDS.every((field) => a[field] === b[field]);
}

/** Replace the cached values only on a real change, then invalidate readiness once per Scene. */
function syncWaterQuality(scene: Scene, state: SceneRendering, next: Readonly<WaterQuality>): void {
  if (sameWaterQuality(state.water, next)) return;
  state.water = waterQualityValues(next);
  state.waterRevision = ++waterRevisions;
  markSceneReadinessDirty(scene);
  for (const follower of state.followers) markSceneReadinessDirty(follower);
}

/** The Scene whose project quality `scene` renders with: itself unless it follows another. */
export function renderSettingsOwner(scene: Scene): Scene {
  return settingsOwners.get(scene) ?? scene;
}

/**
 * Resolve `scene`'s project quality (Geometry, Water) through `owner`, as
 * SceneLayers do through the world view. Only the owner receives settings.
 */
export function followSceneRenderSettings(scene: Scene, owner: Scene): void {
  const root = renderSettingsOwner(owner);
  const previous = settingsOwners.get(scene);
  if (root === scene || previous === root) return;
  const before = sceneWaterQuality(scene);
  if (previous) scenes.get(previous)?.followers.delete(scene);
  else
    scene.onDisposeObservable.addOnce(() => {
      const current = settingsOwners.get(scene);
      if (current) scenes.get(current)?.followers.delete(scene);
      settingsOwners.delete(scene);
    });
  settingsOwners.set(scene, root);
  sceneRenderingSettings(root).followers.add(scene);
  if (!sameWaterQuality(before, sceneWaterQuality(scene))) markSceneReadinessDirty(scene);
}

/**
 * Requested project Water quality for `scene` (local editor overrides, then
 * session overrides). Cached: the same frozen object is returned until a value
 * changes. Rendering gates on `sceneWaterQualityDeviceClamp(scene).quality`.
 */
export function sceneWaterQuality(scene: Scene): Readonly<WaterQuality> {
  return sceneRenderingSettings(renderSettingsOwner(scene)).water;
}

/**
 * Changes when `sceneWaterQuality(scene)` resolves to different values, or when
 * the Scene starts following another; never per frame. Compare it in prepare.
 */
export function sceneWaterQualityRevision(scene: Scene): number {
  return sceneRenderingSettings(renderSettingsOwner(scene)).waterRevision;
}

/**
 * Water quality this Scene's device can honour, cached per revision; see
 * clampWaterQualityToDevice. Water rendering reads this, as Play readback does.
 */
export function sceneWaterQualityDeviceClamp(scene: Scene): WaterQualityDeviceClamp {
  const state = sceneRenderingSettings(scene);
  const revision = sceneWaterQualityRevision(scene);
  if (state.waterDevice?.revision !== revision)
    state.waterDevice = { revision, clamp: clampWaterQualityToDevice(sceneWaterQuality(scene), scene.getEngine().getCaps()) };
  return state.waterDevice.clamp;
}

/** Explicit editor preferences precede session commands and never change authored settings. */
export function resolveSceneRenderingQuality(scene: Scene) {
  const state = sceneRenderingSettings(scene);
  const local = state.localQualityOverrides;
  const session = state.qualityOverrides;
  return resolveRenderingQuality(state.project, state.shadowOverrides, mergeRenderingQualityOverrides(local, session));
}
