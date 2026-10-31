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
  normalizeWaterBlendDistance,
  type PostProcessingEffectField,
  type PostProcessingQuality,
  type EffectiveRenderingQuality,
} from "@haptic/core";
import { ColorGradingSource } from "./color-grading";
import type { MeshAssetContext } from "./mesh-assets";
import {
  planSceneEffects,
  sceneEffectsKey,
  type SceneEffectsPlan,
} from "./scene-effects";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { clampWaterQualityToDevice, type WaterQualityDeviceClamp } from "./water-quality-device";

export type RenderShadingSettings = Partial<
  Pick<RenderProjectSettings, "mode" | "cel" | "shadows" | "quality" | "environmentLighting" | "gpuBackend" | "effects" | "water">
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
  /** The Occlusion Culling quality setting; a world view culls by it only where its Scene allows (`view-occlusion.ts`). */
  occlusionCulling: boolean;
  /** Resolved Water quality values (no preset metadata); replaced only on a real change. */
  water: Readonly<WaterQuality>;
  /** Process-unique, so a Scene that starts following another never reuses a stale value. */
  waterRevision: number;
  /** Device clamp of one revision and colour pipeline (Scene Linear changes which reflections a device can draw). */
  waterDevice: { revision: number; sceneLinear: boolean; clamp: WaterQualityDeviceClamp } | null;
  /** `resolveSceneRenderingQuality` for the quality inputs it was resolved from, which writers replace, never mutate. */
  resolvedQuality: {
    project: RenderShadingSettings;
    shadowOverrides: ShadowOverrides;
    local: QualityOverrides;
    session: QualityOverrides;
    quality: EffectiveRenderingQuality;
  } | null;
  /** Scenes (such as SceneLayers) resolving their quality through this Scene. */
  followers: Set<Scene>;
  /** Full quality whatever the tier (`pinFullRenderQuality`): a Scene Layer's, in Play or its editor tab. */
  fullQuality: boolean;
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
  /** Screen-space effects the resolved quality tier can afford. */
  effectAllowances: Pick<PostProcessingQuality, PostProcessingEffectField>;
  /** Loads the requested LUT asset; only a ready texture enters the plan. */
  colorGrading: ColorGradingSource;
  colorGradingTexture: BaseTexture | null;
  /** Baked identity of the live effects settings; rebuilt only on a settings
   * change so per-frame readiness probes never serialize the block again. */
  effectsKey: string;
  /** Renderable chain for the live settings; null means no owned passes. */
  effectsPlan: SceneEffectsPlan | null;
  /** Notified when the light block's scene-level defines change (`followLightingDefines`), after the plan is current. */
  listeners: Set<(mode: RenderMode) => void>;
  /** The key of those defines as last planned. */
  lightingDefines: string;
  /**
   * A world view's Scene (`allowSceneScreenShadows`): only its plan carries Screen-Space Shadows, and only while its
   * device draws their depth pass (read at each replan: an Engine's capabilities can change); null for any other Scene.
   */
  screenShadowsSupported: (() => boolean) | null;
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
      occlusionCulling: quality.geometry.occlusionCulling,
      water: waterQualityValues(quality.water),
      waterRevision: ++waterRevisions,
      waterDevice: null,
      resolvedQuality: null,
      followers: new Set(),
      fullQuality: false,
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
      effectAllowances: {
        ambientOcclusion: quality.postprocessing.ambientOcclusion,
        reflections: quality.postprocessing.reflections,
        volumetricLighting: quality.postprocessing.volumetricLighting,
      },
      colorGrading: undefined as unknown as ColorGradingSource,
      colorGradingTexture: null,
      effectsKey: sceneEffectsKey(effects, "pbr", true),
      effectsPlan: planSceneEffects(effects, "pbr", true),
      lightingDefines: "pbr|false",
      screenShadowsSupported: null,
      listeners: new Set(),
    };
    scenes.set(scene, state);
    const owned = state;
    owned.colorGrading = new ColorGradingSource(scene, (texture) => {
      owned.colorGradingTexture = texture;
      replanSceneEffects(owned);
    });
    scene.onDisposeObservable.addOnce(() => {
      owned.colorGrading.dispose();
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
  const { ambientOcclusion, reflections, volumetricLighting } = quality.postprocessing;
  state.effectAllowances = { ambientOcclusion, reflections, volumetricLighting };
  state.localLightBudget = resolveLocalLightBudget(quality.lighting);
  state.textureLodBias = quality.textures.lodBias;
  state.autoLod = quality.geometry.autoLod;
  state.lodDistanceScale = quality.geometry.lodDistanceScale;
  state.occlusionCulling = quality.geometry.occlusionCulling;
  syncWaterQuality(scene, state, quality.water);
  state.textureAnisotropy = Math.min(quality.textures.anisotropy, scene.getEngine().getCaps().maxAnisotropy ?? 1);
  if (state.fullQuality) holdFullQuality(scene, state);
  for (const texture of scene.textures) applyMaterialTextureAnisotropy(texture, state.textureAnisotropy);
  const mode = resolved.mode === "cel" ? "cel" : "pbr";
  state.cel = resolveCelShadingSettings(state.project.cel, {
    ...normalizeCelShadingOverrides(state.overrides),
    ...normalizeCelShadingOverrides(state.runtimeOverrides.cel),
  });
  state.effects = normalizeRenderEffectsSettings(resolved.effects);
  state.mode = mode;
  // A newly requested LUT publishes asynchronously and replans once ready.
  state.colorGrading.sync(
    state.effectsEnabled && state.effects.colorGrading.enabled ? state.effects.colorGrading.lutTextureGuid : null,
  );
  replanSceneEffects(state);
  syncImageProcessingMode(scene, state);
}

function replanSceneEffects(state: SceneRendering): void {
  const inputs = {
    fogVolumesPresent: state.fogVolumesPresent,
    colorGradingTexture: state.colorGradingTexture,
    allowed: state.effectAllowances,
    screenShadows: state.screenShadowsSupported?.() && state.shadows.enabled ? state.shadows.screenShadows : "off",
  };
  state.effectsKey = sceneEffectsKey(state.effects, state.mode, state.effectsEnabled, inputs);
  state.effectsPlan = planSceneEffects(state.effects, state.mode, state.effectsEnabled, inputs);
  // The light block's scene-level defines: the render mode and whether Screen-Space Shadows are read.
  const lightingDefines = `${state.mode}|${state.effectsPlan?.screenShadows != null}`;
  if (lightingDefines === state.lightingDefines) return;
  state.lightingDefines = lightingDefines;
  for (const listener of state.listeners) listener(state.mode);
}

/**
 * Marks `scene` as a world view's (the editor viewport's or Play's), whose plan may carry Screen-Space Shadows while
 * `supported` (its device draws the spatial geometry pass). Previews, thumbnails, Scene Layers and every other Scene
 * keep them off: their draws bind the placeholder.
 */
export function allowSceneScreenShadows(scene: Scene, supported: () => boolean): void {
  const state = sceneRenderingSettings(scene);
  state.screenShadowsSupported = supported;
  replanSceneEffects(state);
}

/** Project-enabled screen-space effects that the quality tier or the device skips, for diagnostics. */
export function sceneEffectsQualityLimits(scene: Scene): string[] {
  const state = sceneRenderingSettings(scene);
  if (!state.effectsEnabled) return [];
  const device = state.screenShadowsSupported && !state.screenShadowsSupported() && state.mode === "pbr" &&
    state.shadows.enabled && state.shadows.screenShadows !== "off" ? ["screen shadows: device capability"] : [];
  const { effects, effectAllowances: allowed } = state;
  const pbr = state.mode === "pbr";
  const skipped = [
    pbr && effects.ambientOcclusion.enabled && !allowed.ambientOcclusion ? "ambient occlusion" : null,
    effects.reflections.enabled && !allowed.reflections ? "reflections" : null,
    effects.volumetricLighting.enabled && !allowed.volumetricLighting ? "scene-wide volumetric lighting" : null,
  ].filter((name): name is string => name !== null);
  return [...(skipped.length ? [`post processing quality skips ${skipped.join(", ")}`] : []), ...device];
}

/** Texture bytes for project-level effect assets such as the grading LUT. */
export function setSceneEffectsAssets(scene: Scene, assets: MeshAssetContext | undefined): void {
  if (scene.isDisposed) return;
  sceneRenderingSettings(scene).colorGrading.setAssets(assets);
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
  replanSceneEffects(state);
}

/**
 * Materials emit linear HDR only while a Scene Linear display stage exists. This is the configured colour pipeline;
 * the live `applyByPostProcess` flag also changes for the duration of a capture's draw.
 */
function configuredSceneLinear(state: SceneRendering): boolean {
  return (
    state.effectsEnabled &&
    state.effects.colorPipeline.mode === "sceneLinear" &&
    state.mode === "pbr"
  );
}

function syncImageProcessingMode(
  scene: Scene,
  state: SceneRendering,
): void {
  const linear = configuredSceneLinear(state);
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
 * Resolve `scene`'s project quality (Water) through `owner`, as SceneLayers do
 * through the world view. Only the owner receives settings.
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

/** The highest texture anisotropy a quality tier offers (Ultra). */
const FULL_QUALITY_TEXTURE_ANISOTROPY = 16;

/**
 * Pin `scene` (a SceneLayer's, in Play or its editor tab) to full quality
 * whatever the tier, including later quality updates: textures sample at the
 * highest anisotropy the device allows with no LOD bias, and models draw full
 * detail (no Auto LOD). A Play layer's project settings still resolve through
 * the Scene it follows (`followSceneRenderSettings`).
 */
export function pinFullRenderQuality(scene: Scene): void {
  const state = sceneRenderingSettings(scene);
  if (state.fullQuality) return;
  state.fullQuality = true;
  holdFullQuality(scene, state);
  for (const texture of scene.textures) applyMaterialTextureAnisotropy(texture, state.textureAnisotropy);
  scene.onNewTextureAddedObservable.add((texture) => applyMaterialTextureAnisotropy(texture, state.textureAnisotropy));
}

/** Whether `scene` is pinned to full quality (`pinFullRenderQuality`). */
export function sceneUsesFullQuality(scene: Scene): boolean {
  return sceneRenderingSettings(scene).fullQuality;
}

/** The full-quality values a quality update must not lower. */
function holdFullQuality(scene: Scene, state: SceneRendering): void {
  state.textureAnisotropy = Math.min(FULL_QUALITY_TEXTURE_ANISOTROPY, scene.getEngine().getCaps().maxAnisotropy ?? 1);
  state.textureLodBias = 0;
  state.autoLod = false;
}

/**
 * Project Water Blend Distance for `scene` (metres; 0 when blending is off), through the Scene it follows. Not a quality
 * setting: worker water queries read the same project value. Allocation-free, so the water update reads it every frame.
 */
export function sceneWaterBlendDistance(scene: Scene): number {
  return normalizeWaterBlendDistance(sceneRenderingSettings(renderSettingsOwner(scene)).project.water?.blendDistance);
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
 * Water quality this Scene's device can honour, cached per revision and
 * configured colour pipeline: the same object until either changes, so
 * consumers may compare it by identity. The pipeline is the configured one,
 * not the live image-processing flag a capture overrides while it draws, and
 * counts only where it changes the result (no half-float render targets). See
 * clampWaterQualityToDevice. Water rendering reads this, as Play readback does.
 */
export function sceneWaterQualityDeviceClamp(scene: Scene): WaterQualityDeviceClamp {
  const state = sceneRenderingSettings(scene);
  const revision = sceneWaterQualityRevision(scene);
  const caps = scene.getEngine().getCaps();
  const sceneLinear = !caps.textureHalfFloatRender && configuredSceneLinear(state);
  const cached = state.waterDevice;
  if (cached && cached.revision === revision && cached.sceneLinear === sceneLinear) return cached.clamp;
  const clamp = clampWaterQualityToDevice(sceneWaterQuality(scene), caps, { sceneLinear });
  state.waterDevice = { revision, sceneLinear, clamp };
  return clamp;
}

/**
 * Explicit editor preferences precede session commands and never change authored settings. Cached until a quality
 * input is replaced (several readers ask every frame): the result is shared, so callers never mutate it.
 */
export function resolveSceneRenderingQuality(scene: Scene): EffectiveRenderingQuality {
  const state = sceneRenderingSettings(scene);
  const { project, shadowOverrides, localQualityOverrides: local, qualityOverrides: session } = state;
  const cached = state.resolvedQuality;
  if (cached && cached.project === project && cached.shadowOverrides === shadowOverrides && cached.local === local &&
    cached.session === session) return cached.quality;
  const quality = resolveRenderingQuality(project, shadowOverrides, mergeRenderingQualityOverrides(local, session));
  state.resolvedQuality = { project, shadowOverrides, local, session, quality };
  return quality;
}
