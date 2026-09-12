import {
  CascadedShadowGenerator, DirectionalLight, PointLight, SpotLight,
  ShadowGenerator, Vector3,
  type AbstractMesh, type Camera, type Light, type Scene,
} from "@babylonjs/core";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { effectiveShadowSettings } from "@babylonslate/core";
import { sceneRenderingSettings } from "./render-settings";
import { participatesInShadows } from "./shadow-mesh-policy";
import { ShadowSpatialIndex } from "./shadow-spatial-index";

type ShadowLight = DirectionalLight | PointLight | SpotLight;
export type ShadowLightStatus = "active" | "disabled" | "outside-relevant-area" | "budget-limited";
type Entry = { light: ShadowLight; requested: boolean; priority: number; generator: ShadowGenerator | null; key: string; camera: Camera | null; status: ShadowLightStatus };
const controllers = new WeakMap<Scene, SceneShadowController>();

/** One lifecycle owner for authored lights in every world host. */
export class SceneShadowController {
  private readonly entries = new Map<Light, Entry>();
  private readonly meshes = new Set<AbstractMesh>();
  private readonly pending = new Set<AbstractMesh>();
  private readonly spatial = new ShadowSpatialIndex();
  private quality: number | null | undefined;
  constructor(private readonly scene: Scene) {
    for (const mesh of scene.meshes) this.pending.add(mesh);
    scene.onNewMeshAddedObservable.add((mesh) => { if (!mesh.isDisposed()) this.pending.add(mesh); });
    scene.onMeshRemovedObservable.add((mesh) => {
      this.pending.delete(mesh);
      this.meshes.delete(mesh);
      this.spatial.remove(mesh);
      for (const entry of this.entries.values()) entry.generator?.removeShadowCaster(mesh, false);
    });
    scene.onBeforeRenderObservable.add(() => this.sync());
    scene.onDisposeObservable.addOnce(() => {
      for (const entry of this.entries.values()) entry.generator?.dispose();
      this.entries.clear(); this.meshes.clear(); this.pending.clear();
      controllers.delete(scene);
    });
  }
  register(light: Light, requested: boolean, priority = 0): void {
    if (!(light instanceof DirectionalLight || light instanceof PointLight || light instanceof SpotLight)) return;
    let entry = this.entries.get(light);
    if (!entry) {
      entry = { light, requested, priority, generator: null, key: "", camera: null, status: "disabled" };
      this.entries.set(light, entry);
      light.onDisposeObservable.addOnce(() => {
        this.entries.get(light)?.generator?.dispose();
        this.entries.delete(light);
      });
    }
    entry.requested = requested;
    entry.priority = Number.isFinite(priority) ? priority : 0;
  }
  setLegacyQuality(size: number | null): void { this.quality = size; }
  generator(light: Light): ShadowGenerator | null { return this.entries.get(light)?.generator ?? null; }
  diagnostics(): { name: string; status: ShadowLightStatus; passes: number; mapSize: number }[] {
    return Array.from(this.entries.values(), ({ light, generator, status }) => ({
      name: light.name, status,
      passes: generator ? generator instanceof CascadedShadowGenerator ? generator.numCascades : light instanceof PointLight ? 6 : 1 : 0,
      mapSize: generator?.getShadowMap()?.getSize().width ?? 0,
    }));
  }
  sync(): void {
    const scene = this.scene;
    if (scene.isDisposed) return;
    for (const mesh of this.pending) {
      if (mesh.isDisposed()) continue;
      if (!participatesInShadows(mesh)) { mesh.receiveShadows = false; continue; }
      this.meshes.add(mesh);
      this.spatial.add(mesh);
      mesh.receiveShadows = true;
      for (const entry of this.entries.values()) entry.generator?.addShadowCaster(mesh, false);
    }
    this.pending.clear();
    const state = sceneRenderingSettings(scene);
    const { settings } = effectiveShadowSettings(state.shadows, state.shadowDeviceProfile, CascadedShadowGenerator.IsSupported, state.mode);
    if (this.quality !== undefined) {
      settings.enabled &&= this.quality !== null;
      if (this.quality !== null) settings.mapSize = Math.min(settings.mapSize, this.quality);
    }
    const camera = scene.activeCamera;
    const candidates = [...this.entries.values()].filter((entry) => {
      entry.status = "disabled";
      if (!settings.enabled || !camera || !entry.requested || !entry.light.isEnabled() || entry.light.intensity <= 0) return false;
      if (!(entry.light instanceof DirectionalLight) && Vector3.Distance(entry.light.getAbsolutePosition(), camera.globalPosition) > settings.distance + entry.light.range) {
        entry.status = "outside-relevant-area";
        return false;
      }
      entry.status = "budget-limited";
      return true;
    });
    // Retaining an allocated light at equal priority prevents allocation flicker.
    candidates.sort((a, b) => b.priority - a.priority || Number(!!b.generator) - Number(!!a.generator) || b.light.intensity - a.light.intensity || a.light.uniqueId - b.light.uniqueId);
    let directional = 0;
    let local = 0;
    for (const entry of candidates) {
      if (entry.light instanceof DirectionalLight ? directional++ < 1 : local++ < settings.maxLocalLights) entry.status = "active";
    }
    for (const entry of this.entries.values()) {
      if (entry.status !== "active") {
        entry.generator?.dispose(); entry.generator = null; entry.key = "";
        continue;
      }
      const directionalLight = entry.light instanceof DirectionalLight;
      const mapSize = directionalLight ? settings.mapSize : settings.localMapSize;
      const key = JSON.stringify([settings, mapSize, state.mode]);
      if (key === entry.key && entry.camera === camera && entry.generator) continue;
      entry.generator?.dispose();
      const generator = directionalLight && settings.cascades > 1
        ? new CascadedShadowGenerator(mapSize, entry.light as DirectionalLight, undefined, camera)
        : new ShadowGenerator(mapSize, entry.light, undefined, camera);
      if (generator instanceof CascadedShadowGenerator) {
        generator.numCascades = settings.cascades;
        generator.stabilizeCascades = true;
        generator.lambda = 0.7;
        generator.shadowMaxZ = settings.distance;
        generator.cascadeBlendPercentage = 0.05;
        generator.autoCalcDepthBounds = false;
        generator.depthClamp = true;
      } else if (entry.light instanceof DirectionalLight) {
        entry.light.shadowFrustumSize = settings.distance * 2;
        entry.light.autoCalcShadowZBounds = true;
      }
      generator.usePercentageCloserFiltering = settings.filter === "pcf";
      generator.useContactHardeningShadow = settings.filter === "pcss";
      generator.contactHardeningLightSizeUVRatio = settings.softness;
      generator.filteringQuality = settings.filterQuality === "high" ? ShadowGenerator.QUALITY_HIGH : settings.filterQuality === "medium" ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
      generator.bias = settings.depthBias;
      generator.normalBias = settings.normalBias;
      generator.frustumEdgeFalloff = 0;
      for (const mesh of this.meshes) generator.addShadowCaster(mesh, false);
      const map = generator.getShadowMap();
      if (map) map.getCustomRenderList = (layer) => {
        const transform = generator instanceof CascadedShadowGenerator
          ? generator.getCascadeTransformMatrix(layer) : generator.getTransformMatrix();
        return transform ? this.spatial.query(transform, directionalLight && settings.filter === "pcf") : null;
      };
      entry.generator = generator; entry.key = key; entry.camera = camera;
    }
  }
}

export function sceneShadowController(scene: Scene): SceneShadowController {
  let controller = controllers.get(scene);
  if (!controller) { controller = new SceneShadowController(scene); controllers.set(scene, controller); }
  return controller;
}
