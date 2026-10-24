import { afterEach, expect, it } from "vitest";
import {
  DirectionalLight, NullEngine, RawTexture, RenderTargetTexture,
  Scene, ShadowGenerator, Vector3,
} from "@babylonjs/core";
import {
  DEFAULT_RENDER_EFFECTS, normalizeCelShadingSettings, normalizeRenderingQuality, qualityPresetPatch, qualitySettingPatch, RENDER_QUALITY_PROFILES, ScalabilitySession, type QualityLevel,
} from "@haptic/core";
import {
  applyMaterialTextureAnisotropy, followSceneRenderSettings, sceneEffectsQualityLimits, sceneRenderingSettings, sceneWaterQuality, setSceneEffectsEnabled,
  sceneWaterQualityDeviceClamp, sceneWaterQualityRevision, updateSceneRenderingSettings,
} from "./render-settings";
import { onSceneReadinessDirty } from "./scene-readiness-signal";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  engine.getCaps().maxAnisotropy = 16;
  return new Scene(engine);
}

it("renders the same CEL fade range as session readback after a runtime override lowers an inherited start", () => {
  const scene = fixture();
  const session = new ScalabilitySession({ mode: "cel" }, 60, { celShading: { outlineFadeStart: 200 } });
  updateSceneRenderingSettings(scene, { mode: "cel" }, { outlineFadeStart: 200 });
  expect(sceneRenderingSettings(scene).cel.outlineFadeEnd).toBe(200.01);
  session.request({ kind: "patch", render: { cel: { outlineFadeStart: 25 } } });
  sceneRenderingSettings(scene).runtimeOverrides = session.overrides;
  updateSceneRenderingSettings(scene);
  expect(sceneRenderingSettings(scene).cel).toEqual(session.requested.render.cel);
  expect(sceneRenderingSettings(scene).cel.outlineFadeEnd).toBe(100);
});

it("changes authored texture quality without broadening an existing shadow map's sampling", () => {
  const scene = fixture();
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
  const light = new DirectionalLight("sun", Vector3.Down(), scene);
  const shadow = new ShadowGenerator(256, light).getShadowMap()!;
  const apply = (anisotropy: number) => {
    const quality = normalizeRenderingQuality(qualityPresetPatch("low"));
    quality.textures.anisotropy = anisotropy;
    updateSceneRenderingSettings(scene, { quality });
  };
  apply(8);
  expect(texture.anisotropicFilteringLevel).toBe(8);
  expect(shadow.anisotropicFilteringLevel).toBe(1);
  apply(2);
  expect(texture.anisotropicFilteringLevel).toBe(2);
  expect(shadow.anisotropicFilteringLevel).toBe(1);
});

it("preserves render-target sampling even during the synchronous texture-added notification", () => {
  const scene = fixture();
  let targetObserved = false;
  scene.onNewTextureAddedObservable.add((texture) => {
    if (texture instanceof RenderTargetTexture) {
      targetObserved = true;
      // A renderer owns this value even before isRenderTarget is initialized.
      texture.anisotropicFilteringLevel = 1;
    }
    applyMaterialTextureAnisotropy(texture, 8);
  });
  const target = new RenderTargetTexture("owned target", 16, scene);
  expect(targetObserved).toBe(true);
  expect(target.anisotropicFilteringLevel).toBe(1);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
  applyMaterialTextureAnisotropy(texture, 8);
  expect(texture.anisotropicFilteringLevel).toBe(8);
});

const tier = (level: QualityLevel) => ({ quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
const waterValues = (level: QualityLevel) => {
  const { profile: _profile, preset: _preset, ...values } = RENDER_QUALITY_PROFILES[level].water;
  void _profile;
  void _preset;
  return values;
};
function readinessInvalidations(scene: Scene) {
  const count = { value: 0 };
  onSceneReadinessDirty(scene, () => { count.value += 1; });
  return count;
}

it("keeps the cached water quality and its revision until a resolved value actually changes", () => {
  const scene = fixture();
  const dirty = readinessInvalidations(scene);
  const initial = sceneWaterQuality(scene);
  const revision = sceneWaterQualityRevision(scene);
  expect(initial).toEqual(waterValues("medium"));
  // Same values with other provenance, and unrelated settings changes, are not water changes.
  updateSceneRenderingSettings(scene, tier("medium"));
  updateSceneRenderingSettings(scene, { ...tier("medium"), mode: "cel" });
  sceneRenderingSettings(scene).qualityOverrides = qualitySettingPatch("water", { meshDensity: 0.75 });
  updateSceneRenderingSettings(scene);
  expect(sceneWaterQuality(scene)).toBe(initial);
  expect(sceneWaterQualityRevision(scene)).toBe(revision);
  expect(dirty.value).toBe(0);

  sceneRenderingSettings(scene).localQualityOverrides = { water: { refraction: false, fftSize: 256 } };
  sceneRenderingSettings(scene).qualityOverrides = { water: { fftSize: 64 } };
  updateSceneRenderingSettings(scene);
  expect(sceneWaterQuality(scene)).toMatchObject({ refraction: false, fftSize: 64 });
  expect(sceneWaterQualityRevision(scene)).not.toBe(revision);
  expect(dirty.value).toBe(1);
  const changed = sceneWaterQualityRevision(scene);
  updateSceneRenderingSettings(scene);
  expect(sceneWaterQualityRevision(scene)).toBe(changed);
  expect(dirty.value).toBe(1);
});

it("resolves a followed Scene's water quality, as SceneLayers do through the world view", () => {
  const world = fixture();
  const layer = new Scene(world.getEngine());
  updateSceneRenderingSettings(world, tier("low"));
  const dirty = readinessInvalidations(layer);
  expect(sceneWaterQuality(layer)).toEqual(waterValues("medium"));
  followSceneRenderSettings(layer, world);
  expect(sceneWaterQuality(layer)).toEqual(waterValues("low"));
  expect(dirty.value).toBe(1);
  updateSceneRenderingSettings(world, tier("ultra"));
  expect(sceneWaterQuality(layer)).toEqual(waterValues("ultra"));
  expect(sceneWaterQualityRevision(layer)).toBe(sceneWaterQualityRevision(world));
  expect(dirty.value).toBe(2);
  layer.dispose();
  updateSceneRenderingSettings(world, tier("high"));
  expect(dirty.value).toBe(2);
});

it("reports device-clamped water features while keeping the requested quality", () => {
  const scene = fixture();
  updateSceneRenderingSettings(scene, tier("high"));
  const caps = scene.getEngine().getCaps();
  caps.textureFloatRender = false;
  caps.textureHalfFloatRender = false;
  const clamped = sceneWaterQualityDeviceClamp(scene);
  expect(clamped.quality).toMatchObject({ refraction: false, reflections: "sky" });
  expect(clamped.spectrum).toBe(false);
  expect(clamped.limits).toHaveLength(3);
  expect(sceneWaterQuality(scene)).toMatchObject({ refraction: true, reflections: "screenSpace" });

  // Planar stays for flat water, but its Screen Space fallback has no scene copy to march.
  const planar = fixture();
  Object.assign(planar.getEngine().getCaps(), { textureFloatRender: true, textureHalfFloatRender: false });
  updateSceneRenderingSettings(planar, tier("ultra"));
  const planarClamp = sceneWaterQualityDeviceClamp(planar);
  expect(planarClamp.quality).toMatchObject({ reflections: "planar", refraction: false });
  expect(planarClamp.spectrum).toBe(true);
  expect(planarClamp.screenSpaceFallback).toBe(false);
  expect(planarClamp.limits).toEqual([expect.stringContaining("Water Refraction"), expect.stringContaining("Planar")]);
  // Scene Linear mirrors into a half-float target too: no planar pass can run, so readback reports Sky Only, and
  // the clamp follows the configured colour pipeline without a Water quality change.
  const sceneLinear = { ...tier("ultra"), effects: { ...DEFAULT_RENDER_EFFECTS, colorPipeline: { version: 1 as const, mode: "sceneLinear" as const } } };
  updateSceneRenderingSettings(planar, sceneLinear);
  expect(planar.imageProcessingConfiguration.applyByPostProcess).toBe(true);
  const linearClamp = sceneWaterQualityDeviceClamp(planar);
  expect(linearClamp).not.toBe(planarClamp);
  expect(linearClamp.quality.reflections).toBe("sky");
  expect(linearClamp.screenSpaceFallback).toBe(false);
  expect(linearClamp.limits).toEqual([expect.stringContaining("Water Refraction"), expect.stringContaining("Scene Linear")]);
  // A colour capture lowers the live flag only while it draws (water's readiness checks run inside): the clamp is
  // neither rebuilt nor changed, so nothing recompiles twice per frame.
  planar.imageProcessingConfiguration._applyByPostProcess = false;
  expect(sceneWaterQualityDeviceClamp(planar)).toBe(linearClamp);
  planar.imageProcessingConfiguration._applyByPostProcess = true;
  expect(sceneWaterQualityDeviceClamp(planar)).toBe(linearClamp);
  updateSceneRenderingSettings(planar, tier("ultra"));
  expect(sceneWaterQualityDeviceClamp(planar).quality.reflections).toBe("planar");

  const capable = fixture();
  Object.assign(capable.getEngine().getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
  updateSceneRenderingSettings(capable, tier("ultra"));
  const capableClamp = sceneWaterQualityDeviceClamp(capable);
  expect(capableClamp).toEqual({ quality: sceneWaterQuality(capable), screenSpaceFallback: true, spectrum: true, limits: [] });
  // With half-float targets the colour pipeline cannot change what runs, so switching it keeps the same clamp.
  updateSceneRenderingSettings(capable, sceneLinear);
  expect(sceneWaterQualityDeviceClamp(capable)).toBe(capableClamp);
});

it("replans screen-space effects when the session quality tier changes and reports what it skips", () => {
  const scene = fixture();
  updateSceneRenderingSettings(scene, { effects: {
    ...DEFAULT_RENDER_EFFECTS,
    ambientOcclusion: { ...DEFAULT_RENDER_EFFECTS.ambientOcclusion, enabled: true },
    reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true },
  } });
  const state = sceneRenderingSettings(scene);
  expect(state.effectsPlan).toMatchObject({ ambientOcclusion: { enabled: true }, reflections: null });
  expect(sceneEffectsQualityLimits(scene)).toEqual(["post processing quality skips reflections"]);
  const medium = state.effectsKey;
  state.qualityOverrides = qualityPresetPatch("high");
  updateSceneRenderingSettings(scene);
  expect(state.effectsPlan).toMatchObject({ ambientOcclusion: { enabled: true }, reflections: { enabled: true } });
  expect(state.effectsKey).not.toBe(medium);
  expect(sceneEffectsQualityLimits(scene)).toEqual([]);
  state.qualityOverrides = qualityPresetPatch("low");
  updateSceneRenderingSettings(scene);
  expect(state.effectsPlan).toBeNull();
  expect(sceneEffectsQualityLimits(scene)).toEqual(["post processing quality skips ambient occlusion, reflections"]);
});

it("tells CEL surfaces once per change whether reflections run, after the plan is current", () => {
  const scene = fixture();
  const state = sceneRenderingSettings(scene);
  const seen: [string, boolean, boolean][] = [];
  state.listeners.add((mode) => seen.push([mode, state.celReflections, state.effectsPlan?.reflections != null]));
  const effects = { ...DEFAULT_RENDER_EFFECTS, reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true } };
  state.qualityOverrides = qualityPresetPatch("high");
  // Entering CEL with the opt-in on is one change: a surface rebuilds once, already reflective.
  updateSceneRenderingSettings(scene, { mode: "cel", cel: normalizeCelShadingSettings({ reflectionsEnabled: true }), effects });
  expect(seen).toEqual([["cel", true, true]]);
  updateSceneRenderingSettings(scene);
  expect(seen).toHaveLength(1);
  // A scene override, the quality tier and the session toggle each stop reflections.
  updateSceneRenderingSettings(scene, undefined, { reflectionsEnabled: false });
  expect(seen.at(-1)).toEqual(["cel", false, false]);
  updateSceneRenderingSettings(scene, undefined, {});
  expect(seen.at(-1)).toEqual(["cel", true, true]);
  state.qualityOverrides = qualityPresetPatch("medium");
  updateSceneRenderingSettings(scene);
  expect(seen.at(-1)).toEqual(["cel", false, false]);
  expect(sceneEffectsQualityLimits(scene)).toEqual(["post processing quality skips reflections"]);
  state.qualityOverrides = qualityPresetPatch("high");
  updateSceneRenderingSettings(scene);
  setSceneEffectsEnabled(scene, false);
  expect(seen.slice(-2)).toEqual([["cel", true, true], ["cel", false, false]]);
  setSceneEffectsEnabled(scene, true);
  // PBR reflections never mark CEL surfaces reflective.
  updateSceneRenderingSettings(scene, { mode: "pbr", cel: normalizeCelShadingSettings({ reflectionsEnabled: true }), effects });
  expect(seen.at(-1)).toEqual(["pbr", false, true]);
  // Without the opt-in CEL draws no reflections, so the quality tier skips none.
  updateSceneRenderingSettings(scene, { mode: "cel", effects });
  state.qualityOverrides = qualityPresetPatch("medium");
  updateSceneRenderingSettings(scene);
  expect(state.celReflections).toBe(false);
  expect(sceneEffectsQualityLimits(scene)).toEqual([]);
});

it("applies CEL Reflection Textures only while CEL reflections run", () => {
  const scene = fixture();
  const state = sceneRenderingSettings(scene);
  let changes = 0;
  state.listeners.add(() => changes++);
  const effects = { ...DEFAULT_RENDER_EFFECTS, reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true } };
  const cel = normalizeCelShadingSettings({ reflectionsEnabled: true, reflectionTexturesEnabled: true });
  state.qualityOverrides = qualityPresetPatch("high");
  updateSceneRenderingSettings(scene, { mode: "cel", cel, effects });
  expect([state.celReflectionTextures, changes]).toEqual([true, 1]);
  // A scene override of the textures alone is its own change; reflections keep running.
  updateSceneRenderingSettings(scene, undefined, { reflectionTexturesEnabled: false });
  expect([state.celReflections, state.celReflectionTextures, changes]).toEqual([true, false, 2]);
  updateSceneRenderingSettings(scene, undefined, {});
  expect(state.celReflectionTextures).toBe(true);
  // A quality tier that skips reflections, or no project effect, leaves nothing to texture.
  state.qualityOverrides = qualityPresetPatch("medium");
  updateSceneRenderingSettings(scene);
  expect(state.celReflectionTextures).toBe(false);
  state.qualityOverrides = qualityPresetPatch("high");
  updateSceneRenderingSettings(scene, { mode: "cel", cel, effects: DEFAULT_RENDER_EFFECTS });
  expect(state.celReflectionTextures).toBe(false);
});
