import {
  CascadedShadowGenerator,
  DirectionalLight,
  PointLight,
  SpotLight,
  ShadowGenerator,
  Vector3,
  Frustum,
  type AbstractMesh,
  type Camera,
  type Light,
  type Scene,
  type Plane,
} from "@babylonjs/core";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { effectiveShadowSettings } from "@babylonslate/core";
import { sceneRenderingSettings } from "./render-settings";
import {
  authoredShadowParticipation,
  hasDeformingShadowBounds,
  participatesInShadows,
  type ShadowParticipation,
} from "./shadow-mesh-policy";
import { ShadowSpatialIndex } from "./shadow-spatial-index";
import "./shadow-shader";
import { partitionShadowGeometry } from "./shadow-geometry-partitions";
import { calibratedShadowBias } from "./shadow-bias";
import { configureDirectionalShadowProjection } from "./directional-shadow-projection";
import { readEngineDrawCalls } from "./draw-calls";

type ShadowLight = DirectionalLight | PointLight | SpotLight;
export type ShadowLightStatus =
  "active" | "disabled" | "outside-relevant-area" | "budget-limited";
type Entry = {
  light: ShadowLight;
  requested: boolean;
  priority: number;
  generator: ShadowGenerator | null;
  key: string;
  camera: Camera | null;
  status: ShadowLightStatus;
};
const controllers = new WeakMap<Scene, SceneShadowController>();

/** One lifecycle owner for authored lights in every world host. */
export class SceneShadowController {
  private readonly entries = new Map<Light, Entry>();
  private readonly meshes = new Set<AbstractMesh>();
  private readonly pending = new Set<AbstractMesh>();
  private readonly spatial = new ShadowSpatialIndex();
  private quality: number | null | undefined;
  private drawCalls = 0;
  private triangles = 0;
  shadowDrawCalls(): number {
    return this.drawCalls;
  }
  shadowTriangles(): number {
    return this.triangles;
  }
  private readonly scene: Scene;
  constructor(scene: Scene) {
    this.scene = scene;
    for (const mesh of scene.meshes) this.pending.add(mesh);
    scene.onNewMeshAddedObservable.add((mesh) => {
      if (!mesh.isDisposed()) this.pending.add(mesh);
    });
    scene.onMeshRemovedObservable.add((mesh) => {
      this.pending.delete(mesh);
      this.meshes.delete(mesh);
      this.spatial.remove(mesh);
      for (const entry of this.entries.values())
        entry.generator?.removeShadowCaster(mesh, false);
    });
    scene.onBeforeRenderObservable.add(() => {
      this.drawCalls = 0;
      this.triangles = 0;
      this.sync();
    });
    scene.onDisposeObservable.addOnce(() => {
      for (const entry of this.entries.values()) entry.generator?.dispose();
      this.entries.clear();
      this.meshes.clear();
      this.pending.clear();
      this.spatial.dispose();
      controllers.delete(scene);
    });
  }
  register(light: Light, requested: boolean, priority = 0): void {
    if (!(
      light instanceof DirectionalLight ||
      light instanceof PointLight ||
      light instanceof SpotLight
    ))
      return;
    let entry = this.entries.get(light);
    if (!entry) {
      entry = {
        light,
        requested,
        priority,
        generator: null,
        key: "",
        camera: null,
        status: "disabled",
      };
      this.entries.set(light, entry);
      light.onDisposeObservable.addOnce(() => {
        this.entries.get(light)?.generator?.dispose();
        this.entries.delete(light);
      });
    }
    entry.requested = requested;
    entry.priority = Number.isFinite(priority) ? priority : 0;
  }
  setLegacyQuality(size: number | null | undefined): void {
    this.quality = size;
  }
  setParticipation(mesh: AbstractMesh, value: ShadowParticipation): void {
    const previous = mesh.metadata?.slateShadowParticipation as
      ShadowParticipation | undefined;
    if (
      previous?.castShadows === value.castShadows &&
      previous?.receiveShadows === value.receiveShadows
    )
      return;
    mesh.metadata = {
      ...mesh.metadata,
      slateShadowParticipation: {
        castShadows: value.castShadows,
        receiveShadows: value.receiveShadows,
      },
    };
    this.pending.add(mesh);
    for (const child of mesh.getChildMeshes()) this.pending.add(child);
  }
  generator(light: Light): ShadowGenerator | null {
    return this.entries.get(light)?.generator ?? null;
  }
  diagnostics(): {
    name: string;
    status: ShadowLightStatus;
    passes: number;
    mapSize: number;
  }[] {
    return Array.from(
      this.entries.values(),
      ({ light, generator, status }) => ({
        name: light.name,
        status,
        passes: generator
          ? generator instanceof CascadedShadowGenerator
            ? generator.numCascades
            : light instanceof PointLight
              ? 6
              : 1
          : 0,
        mapSize: generator?.getShadowMap()?.getSize().width ?? 0,
      }),
    );
  }
  sync(): void {
    const scene = this.scene;
    if (scene.isDisposed) return;
    for (const mesh of this.pending) {
      if (mesh.isDisposed()) continue;
      if (!participatesInShadows(mesh)) {
        mesh.receiveShadows = false;
        this.meshes.delete(mesh);
        this.spatial.remove(mesh);
        for (const entry of this.entries.values())
          entry.generator?.removeShadowCaster(mesh, false);
        continue;
      }
      const participation = authoredShadowParticipation(mesh);
      mesh.receiveShadows = participation.receiveShadows !== false;
      if (participation.castShadows === false) {
        this.meshes.delete(mesh);
        this.spatial.remove(mesh);
        for (const entry of this.entries.values())
          entry.generator?.removeShadowCaster(mesh, false);
        continue;
      }
      this.meshes.add(mesh);
      this.spatial.add(mesh);
      partitionShadowGeometry(mesh);
      for (const entry of this.entries.values())
        entry.generator?.addShadowCaster(mesh, false);
    }
    this.pending.clear();
    const casterBounds = this.spatial.bounds();
    const state = sceneRenderingSettings(scene);
    const requested =
      this.quality === undefined
        ? state.shadows
        : {
            ...state.shadows,
            enabled: state.shadows.enabled && this.quality !== null,
            mapSize: this.quality ?? state.shadows.mapSize,
          };
    const { settings } = effectiveShadowSettings(
      requested,
      state.shadowDeviceProfile,
      CascadedShadowGenerator.IsSupported,
      state.mode,
    );
    const camera = scene.activeCamera;
    const candidates = [...this.entries.values()].filter((entry) => {
      entry.status = "disabled";
      if (
        !settings.enabled ||
        !entry.requested ||
        !entry.light.isEnabled() ||
        entry.light.intensity <= 0
      )
        return false;
      if (
        camera &&
        !(entry.light instanceof DirectionalLight) &&
        Vector3.Distance(
          entry.light.getAbsolutePosition(),
          camera.globalPosition,
        ) >
          settings.distance + entry.light.range
      ) {
        entry.status = "outside-relevant-area";
        return false;
      }
      entry.status = "budget-limited";
      return true;
    });
    // A bounded retention bonus prevents flicker without permanently starving a
    // newly relevant light. Explicit authored priority remains authoritative.
    const relevance = (entry: Entry) => {
      const distanceSquared =
        camera && !(entry.light instanceof DirectionalLight)
          ? Vector3.DistanceSquared(
              entry.light.getAbsolutePosition(),
              camera.globalPosition,
            )
          : 0;
      return (
        (entry.light.intensity * (entry.generator ? 1.15 : 1)) /
        Math.max(1, distanceSquared)
      );
    };
    candidates.sort(
      (a, b) =>
        b.priority - a.priority ||
        relevance(b) - relevance(a) ||
        a.light.uniqueId - b.light.uniqueId,
    );
    let directional = 0;
    let local = 0;
    for (const entry of candidates) {
      if (
        entry.light instanceof DirectionalLight
          ? directional++ < 1
          : local++ < settings.maxLocalLights
      )
        entry.status = "active";
    }
    for (const entry of this.entries.values()) {
      if (entry.status !== "active") {
        entry.generator?.dispose();
        entry.generator = null;
        entry.key = "";
        continue;
      }
      const directionalLight = entry.light instanceof DirectionalLight;
      const mapSize = directionalLight
        ? settings.mapSize
        : settings.localMapSize;
      const key = JSON.stringify([settings, mapSize, state.mode]);
      if (key === entry.key && entry.camera === camera && entry.generator) {
        if (casterBounds && entry.generator instanceof CascadedShadowGenerator)
          entry.generator.shadowCastersBoundingInfo.reConstruct(
            casterBounds.min,
            casterBounds.max,
          );
        if (
          entry.light instanceof DirectionalLight &&
          !(entry.generator instanceof CascadedShadowGenerator)
        )
          entry.light.forceProjectionMatrixCompute();
        continue;
      }
      entry.generator?.dispose();
      const generator =
        directionalLight && settings.cascades > 1
          ? new CascadedShadowGenerator(
              mapSize,
              entry.light as DirectionalLight,
            )
          : new ShadowGenerator(mapSize, entry.light);
      if (generator instanceof CascadedShadowGenerator) {
        generator.numCascades = settings.cascades;
        generator.stabilizeCascades = true;
        generator.lambda = 0.7;
        generator.shadowMaxZ = settings.distance;
        generator.cascadeBlendPercentage = 0.05;
        generator.autoCalcDepthBounds = false;
        generator.depthClamp = true;
        generator.freezeShadowCastersBoundingInfo = true;
        if (casterBounds)
          generator.shadowCastersBoundingInfo.reConstruct(
            casterBounds.min,
            casterBounds.max,
          );
        const prepare = generator.prepareDefines.bind(generator);
        generator.prepareDefines = (defines, lightIndex) => {
          prepare(defines, lightIndex);
          defines[`SLATE_SHADOW_FADE${lightIndex}`] = settings.fadeFraction;
          defines.rebuild();
        };
      } else if (entry.light instanceof DirectionalLight) {
        configureDirectionalShadowProjection(
          entry.light,
          scene,
          settings.distance,
          mapSize,
          this.spatial,
        );
      }
      generator.usePercentageCloserFiltering = settings.filter === "pcf";
      generator.useContactHardeningShadow = settings.filter === "pcss";
      generator.contactHardeningLightSizeUVRatio = settings.softness;
      generator.filteringQuality =
        settings.filterQuality === "high"
          ? ShadowGenerator.QUALITY_HIGH
          : settings.filterQuality === "medium"
            ? ShadowGenerator.QUALITY_MEDIUM
            : ShadowGenerator.QUALITY_LOW;
      generator.bias = settings.depthBias;
      generator.normalBias = settings.normalBias;
      generator.frustumEdgeFalloff = 0;
      for (const mesh of this.meshes) generator.addShadowCaster(mesh, false);
      const map = generator.getShadowMap();
      let drawsBefore = 0;
      let indicesBefore = 0;
      map?.onBeforeBindObservable.add(() => {
        drawsBefore = readEngineDrawCalls(scene.getEngine());
        indicesBefore = scene.getActiveIndices();
      });
      map?.onAfterUnbindObservable.add(() => {
        this.drawCalls += Math.max(
          0,
          readEngineDrawCalls(scene.getEngine()) - drawsBefore,
        );
        this.triangles +=
          Math.max(0, scene.getActiveIndices() - indicesBefore) / 3;
      });
      if (generator instanceof CascadedShadowGenerator)
        map?.onBeforeBindObservable.add(
          () => generator.splitFrustum(),
          -1,
          true,
        );
      if (settings.autoBias && generator instanceof CascadedShadowGenerator)
        map?.onBeforeRenderObservable.add((layer) => {
          const min = generator.getCascadeMinExtents(layer);
          const max = generator.getCascadeMaxExtents(layer);
          if (min && max) {
            const extent = Math.max(max.x - min.x, max.y - min.y);
            generator.bias = calibratedShadowBias(
              mapSize,
              extent,
              max.z - min.z,
              settings.filterQuality,
              settings.depthBias,
            );
            const kernelRadius =
              settings.filterQuality === "high"
                ? 2.5
                : settings.filterQuality === "medium"
                  ? 1.5
                  : 0.5;
            generator.normalBias = Math.max(
              settings.normalBias,
              (kernelRadius * extent) / mapSize,
            );
          }
        });
      let activePlanes: Plane[] | null = null;
      if (map)
        map.getCustomRenderList = (layer) => {
          const transform =
            generator instanceof CascadedShadowGenerator
              ? generator.getCascadeTransformMatrix(layer)
              : generator.getTransformMatrix();
          if (!transform) return null;
          const planes = Frustum.GetPlanes(transform);
          activePlanes =
            directionalLight && settings.filter === "pcf"
              ? planes.slice(1)
              : planes;
          return this.spatial.queryPlanes(activePlanes);
        };
      generator.customAllowRendering = (part) => {
        if (hasDeformingShadowBounds(part.getMesh())) return true;
        if (!activePlanes || part.getMesh().subMeshes.length < 2) return true;
        const box = part.getBoundingInfo()?.boundingBox;
        if (!box) return true;
        for (const plane of activePlanes) {
          const n = plane.normal;
          if (
            n.x * (n.x >= 0 ? box.maximumWorld.x : box.minimumWorld.x) +
              n.y * (n.y >= 0 ? box.maximumWorld.y : box.minimumWorld.y) +
              n.z * (n.z >= 0 ? box.maximumWorld.z : box.minimumWorld.z) +
              plane.d <
            0
          )
            return false;
        }
        return true;
      };
      entry.generator = generator;
      entry.key = key;
      entry.camera = camera;
    }
  }
}

export function sceneShadowController(scene: Scene): SceneShadowController {
  let controller = controllers.get(scene);
  if (!controller) {
    controller = new SceneShadowController(scene);
    controllers.set(scene, controller);
  }
  return controller;
}
