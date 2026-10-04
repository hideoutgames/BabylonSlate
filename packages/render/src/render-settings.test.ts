import { afterEach, expect, it } from "vitest";
import {
  DirectionalLight, NullEngine, RawTexture, RenderTargetTexture,
  Scene, ShadowGenerator, Vector3,
} from "@babylonjs/core";
import {
  normalizeRenderingQuality, qualityPresetPatch, qualitySettingPatch, RENDER_QUALITY_PROFILES, ScalabilitySession, type QualityLevel,
} from "@babylonslate/core";
import {
  applyMaterialTextureAnisotropy, followSceneRenderSettings, sceneRenderingSettings, sceneWaterQuality,
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

  sceneRenderingSettings(scene).localQualityOverrides = { water: { refraction: false, fft: true } };
  sceneRenderingSettings(scene).qualityOverrides = { water: { fft: false } };
  updateSceneRenderingSettings(scene);
  expect(sceneWaterQuality(scene)).toMatchObject({ refraction: false, fft: false });
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
  expect(clamped.quality).toMatchObject({ fft: false, refraction: false, reflections: "sky", fftSize: 128 });
  expect(clamped.limits).toHaveLength(3);
  expect(sceneWaterQuality(scene)).toMatchObject({ fft: true, refraction: true, reflections: "screenSpace" });

  const capable = fixture();
  Object.assign(capable.getEngine().getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
  updateSceneRenderingSettings(capable, tier("ultra"));
  expect(sceneWaterQualityDeviceClamp(capable)).toEqual({ quality: sceneWaterQuality(capable), limits: [] });
});
