import {
  syncDirectionalLightPolicy,
  isDirectionalLightExcluded,
} from "./light-policy";
import {
  CascadedShadowGenerator,
  DirectionalLight,
  PointLight,
  SpotLight,
  ShadowGenerator,
  Vector3,
  Frustum,
  Material,
  RenderTargetTexture,
  type AbstractMesh,
  type Light,
  type Scene,
  type Plane,
} from "@babylonjs/core";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import {
  effectiveShadowSettings,
  SHADOW_CAPACITY_PROFILES,
  type ShadowSettings,
} from "@babylonslate/core";
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
import {
  ENGINE_SHADOW_BUDGET,
  SHADOW_MATERIAL_SAMPLER_RESERVE,
  otherShadowReservations,
  reserveSceneShadows,
  shadowBytesPerTexel,
  type ShadowCost,
} from "./shadow-admission";

type ShadowLight = DirectionalLight | PointLight | SpotLight;
export type ShadowLightStatus =
  | "active"
  | "disabled"
  | "not-requested"
  | "non-illuminating"
  | "shadows-disabled"
  | "outside-relevant-area"
  | "budget-limited"
  | "allocation-failed";
type Entry = {
  light: ShadowLight;
  requested: boolean;
  priority: number;
  generator: ShadowGenerator | null;
  key: string;
  settings: ShadowSettings | null;
  mapSize: number;
  reason: string | null;
  failedKey: string;
  recovery: { requestKey: string; mapSize: number; error: string } | null;
  resetAllocation: boolean;
  status: ShadowLightStatus;
};
const controllers = new WeakMap<Scene, SceneShadowController>();

/** Construction is synchronous: no other renderer can allocate between checkpoints. */
function shadowAllocationCheckpoint(
  scene: Scene,
): (generator: { dispose(): void } | null) => void {
  const engine = scene.getEngine();
  const textures = new Set(scene.textures);
  const internals = new Set(engine.getLoadedTexturesCache());
  // Babylon 9.20 has no public wrapper enumeration. Read the typed cache only;
  // all ownership release goes through public dispose methods, never cache edits.
  const wrappers = new Set(engine._renderTargetWrapperCache);
  return (generator) => {
    const failures: unknown[] = [];
    const dispose = (resource: { dispose(): void }) => {
      try {
        resource.dispose();
      } catch (error) {
        failures.push(error);
      }
    };
    if (generator) dispose(generator);
    // A throwing RTT constructor has already registered itself and its observers
    // on the Scene, but has not returned into ShadowGenerator._shadowMap yet.
    for (const texture of [...scene.textures])
      if (!textures.has(texture) && texture instanceof RenderTargetTexture)
        dispose(texture);
    // Re-read after RTT disposal so each remaining orphan is released only once.
    for (const wrapper of [...engine._renderTargetWrapperCache])
      if (!wrappers.has(wrapper)) dispose(wrapper);
    for (const texture of [...engine.getLoadedTexturesCache()])
      if (
        !internals.has(texture) &&
        !engine._renderTargetWrapperCache.some(
          (wrapper) =>
            wrapper.textures?.includes(texture) ||
            wrapper.depthStencilTexture === texture,
        )
      )
        dispose(texture);
    if (failures.length)
      throw new AggregateError(
        failures,
        "Could not release a failed shadow allocation",
      );
  };
}

/** One lifecycle owner for authored lights in every world host. */
export class SceneShadowController {
  private readonly entries = new Map<Light, Entry>();
  private readonly meshes = new Set<AbstractMesh>();
  private readonly pending = new Set<AbstractMesh>();
  private readonly spatial = new ShadowSpatialIndex();
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
    const engine = scene.getEngine();
    const restored = engine.onContextRestoredObservable.add(() => {
      for (const entry of this.entries.values()) {
        entry.failedKey = "";
        entry.recovery = null;
        entry.resetAllocation = true;
      }
    });
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
      engine.onContextRestoredObservable.remove(restored);
      for (const entry of this.entries.values()) entry.generator?.dispose();
      this.entries.clear();
      this.meshes.clear();
      this.pending.clear();
      this.spatial.dispose();
      reserveSceneShadows(scene, { bytes: 0, passes: 0, samplers: 0 });
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
        settings: null,
        mapSize: 0,
        reason: null,
        failedKey: "",
        recovery: null,
        resetAllocation: false,
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
  status(light: Light): ShadowLightStatus | undefined {
    return this.entries.get(light)?.status;
  }
  limits(): string[] {
    const limits = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.reason) limits.add(entry.reason);
      if (entry.generator?.usePoissonSampling)
        limits.add(
          entry.light.needCube()
            ? "point shadows: Poisson filter fallback"
            : "shadows: Poisson filter capability fallback",
        );
    }
    return [...limits];
  }
  metrics(): { passes: number; bytes: number } {
    let passes = 0;
    let bytes = 0;
    for (const { light, generator } of this.entries.values()) {
      if (!generator) continue;
      const count =
        generator instanceof CascadedShadowGenerator
          ? generator.numCascades
          : light instanceof PointLight
            ? 6
            : 1;
      passes += count;
      bytes +=
        count *
        (generator.getShadowMap()?.getSize().width ?? 0) ** 2 *
        shadowBytesPerTexel(this.scene.getEngine());
    }
    return { passes, bytes };
  }
  diagnostics() {
    return this.scene.lights.map((light) => {
      const entry = this.entries.get(light);
      const generator = entry?.generator;
      return {
        name: light.name,
        illumination: isDirectionalLightExcluded(light)
          ? "directional-limit"
          : !light.isEnabled() || light.intensity <= 0
            ? "disabled"
            : "active",
        status: entry?.status ?? "unsupported",
        reason: entry?.reason ?? null,
        allocationError: entry?.recovery?.error ?? null,
        effectiveFilter: !generator
          ? null
          : generator.usePoissonSampling
            ? "poisson"
            : generator.useContactHardeningShadow
              ? "pcss"
              : "pcf",
        passes: generator
          ? generator instanceof CascadedShadowGenerator
            ? generator.numCascades
            : light instanceof PointLight
              ? 6
              : 1
          : 0,
        mapSize: generator?.getShadowMap()?.getSize().width ?? 0,
      };
    });
  }
  sync(): void {
    const scene = this.scene;
    if (scene.isDisposed) return;
    syncDirectionalLightPolicy(scene);
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
    const requested = state.shadows;
    const { settings } = effectiveShadowSettings(
      requested,
      scene.getEngine()._features.supportCSM,
      state.mode,
    );
    const camera = scene.activeCamera;
    camera?.getViewMatrix();
    const allocationRequestKey = (entry: Entry) =>
      JSON.stringify([
        entry.light instanceof DirectionalLight
          ? settings.mapSize
          : settings.localMapSize,
        entry.light.needCube(),
        entry.light instanceof DirectionalLight ? settings.cascades : 1,
        settings.profile,
      ]);
    const candidates = [...this.entries.values()].filter((entry) => {
      entry.status = "disabled";
      entry.reason = null;
      if (entry.recovery?.requestKey !== allocationRequestKey(entry))
        entry.recovery = null;
      if (isDirectionalLightExcluded(entry.light)) {
        entry.status = "non-illuminating";
        return false;
      }
      if (!entry.light.isEnabled() || entry.light.intensity <= 0) return false;
      if (!entry.requested) {
        entry.status = "not-requested";
        return false;
      }
      if (!settings.enabled) {
        entry.status = "shadows-disabled";
        return false;
      }
      if (entry.failedKey === allocationRequestKey(entry)) {
        entry.status = "allocation-failed";
        entry.reason =
          "shadow allocation failed at minimum size; awaiting settings change or context recovery";
        return false;
      }
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
    const caps = scene.getEngine().getCaps();
    const profile = SHADOW_CAPACITY_PROFILES[settings.profile];
    const other = otherShadowReservations(scene);
    const byteBudget = Math.max(
      0,
      Math.min(profile.byteBudget, ENGINE_SHADOW_BUDGET.bytes - other.bytes),
    );
    const passBudget = Math.max(
      0,
      Math.min(profile.passes, ENGINE_SHADOW_BUDGET.passes - other.passes),
    );
    const samplerBudget = Math.max(
      0,
      caps.maxTexturesImageUnits - SHADOW_MATERIAL_SAMPLER_RESERVE,
    );
    const bytesPerTexel = shadowBytesPerTexel(scene.getEngine());
    const admitted: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
    const reserveLocalMaps =
      settings.maxLocalLights > 0 &&
      candidates.some((entry) => !(entry.light instanceof DirectionalLight));
    let local = 0;
    // Reserve the single sun before local maps regardless of local priorities.
    candidates.sort(
      (a, b) =>
        Number(b.light instanceof DirectionalLight) -
        Number(a.light instanceof DirectionalLight),
    );
    let plannedLocal = 0;
    let plannedPasses = 0;
    let plannedSamplers = 0;
    let remainingLocalFaces = 0;
    const planned = candidates.filter((entry) => {
      const directional = entry.light instanceof DirectionalLight;
      const passes = directional
        ? settings.cascades
        : entry.light.needCube()
          ? 6
          : 1;
      const samplers =
        settings.filter === "pcss" && !entry.light.needCube() ? 2 : 1;
      entry.reason =
        !directional && plannedLocal >= settings.maxLocalLights
          ? "local light capacity"
          : plannedPasses + passes > passBudget
            ? "shadow face/pass budget"
            : plannedSamplers + samplers > samplerBudget
              ? "material sampler headroom"
              : null;
      if (entry.reason) return false;
      plannedPasses += passes;
      plannedSamplers += samplers;
      if (!directional) {
        plannedLocal += 1;
        remainingLocalFaces += passes;
      }
      return true;
    });
    for (const entry of planned) {
      const directional = entry.light instanceof DirectionalLight;
      const passes = directional
        ? settings.cascades
        : entry.light.needCube()
          ? 6
          : 1;
      const samplers =
        settings.filter === "pcss" && !entry.light.needCube() ? 2 : 1;
      entry.reason =
        !directional && local >= settings.maxLocalLights
          ? "local light capacity"
          : admitted.passes + passes > passBudget
            ? "shadow face/pass budget"
            : admitted.samplers + samplers > samplerBudget
              ? "material sampler headroom"
              : null;
      if (entry.reason) continue;
      const requestedSize = directional
        ? settings.mapSize
        : settings.localMapSize;
      let mapSize = Math.min(requestedSize, caps.maxTextureSize);
      if (entry.light.needCube())
        mapSize = Math.min(mapSize, caps.maxCubemapTextureSize);
      if (entry.recovery) mapSize = Math.min(mapSize, entry.recovery.mapSize);
      if (
        entry.generator &&
        !entry.resetAllocation &&
        entry.settings?.profile === settings.profile &&
        (directional ? entry.settings.mapSize : entry.settings.localMapSize) ===
          requestedSize
      )
        mapSize = Math.min(
          mapSize,
          entry.generator.getShadowMap()?.getSize().width ?? mapSize,
        );
      mapSize = 2 ** Math.floor(Math.log2(mapSize));
      // CSM constructs four layers before applying an authored lower count.
      // Admit that temporary peak as well as the final attachments.
      const peakPasses = directional && settings.cascades > 1 ? 4 : passes;
      const availableBytes = Math.min(
        byteBudget - admitted.bytes,
        directional
          ? reserveLocalMaps
            ? byteBudget / 2
            : byteBudget
          : ((byteBudget - admitted.bytes) * passes) / remainingLocalFaces,
      );
      if (!directional) remainingLocalFaces -= passes;
      while (
        mapSize >= 256 &&
        peakPasses * mapSize ** 2 * bytesPerTexel > availableBytes
      )
        mapSize /= 2;
      if (mapSize < 256) {
        entry.reason = "shadow attachment memory budget";
        continue;
      }
      entry.mapSize = mapSize;
      entry.resetAllocation = false;
      entry.reason = entry.recovery
        ? "shadow map reduced after allocation failure"
        : mapSize < requestedSize
          ? "shadow map reduced by memory or texture capability"
          : null;
      entry.status = "active";
      admitted.bytes += peakPasses * mapSize ** 2 * bytesPerTexel;
      admitted.passes += passes;
      admitted.samplers += samplers;
      if (!directional) local++;
    }
    // Release incompatible and retired maps before reserving/constructing their
    // replacements; old and new sets must never overlap outside this envelope.
    for (const entry of this.entries.values()) {
      const key = JSON.stringify([
        entry.mapSize,
        entry.light.needCube(),
        entry.light instanceof DirectionalLight ? settings.cascades : 1,
      ]);
      if (entry.status !== "active" || entry.key !== key) {
        entry.generator?.dispose();
        entry.generator = null;
        entry.key = "";
      }
    }
    reserveSceneShadows(scene, admitted);
    for (const entry of this.entries.values()) {
      if (entry.status !== "active") continue;
      const directionalLight = entry.light instanceof DirectionalLight;
      let mapSize = entry.mapSize;
      const previousSettings = entry.settings;
      entry.settings = settings;
      if (entry.generator) {
        this.applySettings(entry.generator, settings);
        if (previousSettings?.fadeFraction !== settings.fadeFraction)
          scene.markAllMaterialsAsDirty(Material.LightDirtyFlag);
        if (entry.generator instanceof CascadedShadowGenerator)
          entry.generator.shadowMaxZ = settings.distance;
        if (casterBounds && entry.generator instanceof CascadedShadowGenerator)
          entry.generator.shadowCastersBoundingInfo.reConstruct(
            casterBounds.min,
            casterBounds.max,
          );
        if (
          entry.light instanceof DirectionalLight &&
          !(entry.generator instanceof CascadedShadowGenerator)
        ) {
          if (previousSettings?.distance !== settings.distance)
            configureDirectionalShadowProjection(
              entry.light,
              scene,
              settings.distance,
              mapSize,
              this.spatial,
            );
          entry.light.forceProjectionMatrixCompute();
        }
        continue;
      }
      // Halving is bounded by the normalized 4096 maximum and 256 floor. Failed
      // attempts are fully released before smaller maps reuse the reservation.
      while (mapSize >= 256) {
        const cleanup = shadowAllocationCheckpoint(scene);
        try {
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
              defines[`SLATE_SHADOW_FADE${lightIndex}`] =
                entry.settings!.fadeFraction;
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
          this.applySettings(generator, settings);
          for (const mesh of this.meshes)
            generator.addShadowCaster(mesh, false);
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
          if (generator instanceof CascadedShadowGenerator)
            map?.onBeforeRenderObservable.add((layer) => {
              const settings = entry.settings!;
              if (!settings.autoBias) return;
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
                directionalLight && entry.settings!.filter === "pcf"
                  ? planes.slice(1)
                  : planes;
              return this.spatial.queryPlanes(activePlanes);
            };
          generator.customAllowRendering = (part) => {
            if (hasDeformingShadowBounds(part.getMesh())) return true;
            if (!activePlanes || part.getMesh().subMeshes.length < 2)
              return true;
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
          entry.mapSize = mapSize;
          entry.key = JSON.stringify([
            mapSize,
            entry.light.needCube(),
            directionalLight ? settings.cascades : 1,
          ]);
          entry.failedKey = "";
          if (entry.recovery)
            entry.reason = "shadow map reduced after allocation failure";
          break;
        } catch (error) {
          const requestKey = allocationRequestKey(entry);
          entry.failedKey = requestKey;
          entry.status = "allocation-failed";
          entry.reason =
            "shadow allocation failed at minimum size; awaiting settings change or context recovery";
          try {
            cleanup(entry.light.getShadowGenerator());
          } catch (cleanupError) {
            entry.reason = "shadow allocation cleanup failed";
            throw new AggregateError(
              [error, cleanupError],
              "Shadow allocation and resource cleanup failed",
            );
          }
          mapSize /= 2;
          entry.recovery = {
            requestKey,
            mapSize,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (entry.generator) entry.status = "active";
    }
    // Failed constructors own no allocation. Retain conservative CSM creation
    // headroom for live generators so another client cannot consume it mid-sync.
    const live: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
    for (const entry of this.entries.values()) {
      if (!entry.generator) continue;
      const cascaded = entry.generator instanceof CascadedShadowGenerator;
      const passes =
        entry.generator instanceof CascadedShadowGenerator
          ? entry.generator.numCascades
          : entry.light.needCube()
            ? 6
            : 1;
      live.bytes +=
        (cascaded ? 4 : passes) * entry.mapSize ** 2 * bytesPerTexel;
      live.passes += passes;
    }
    reserveSceneShadows(scene, live);
  }
  private applySettings(
    generator: ShadowGenerator,
    settings: ShadowSettings,
  ): void {
    generator.filter =
      settings.filter === "pcss"
        ? ShadowGenerator.FILTER_PCSS
        : ShadowGenerator.FILTER_PCF;
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
