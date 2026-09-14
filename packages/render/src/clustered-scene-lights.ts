import {
  Light,
  DirectionalLight,
  HemisphericLight,
  NodeMaterial,
  PBRMaterial,
  PointLight,
  SpotLight,
  Camera,
  type AbstractEngine,
  type Node,
  type Observer,
  type Scene,
  type RenderTargetTexture,
} from "@babylonjs/core";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import {
  clusteredLightCapabilities,
  type ClusteredLightCapabilities,
} from "./clustered-light-capabilities";
import { registerClusteredLightPolicy } from "./clustered-light-policy";
import {
  isAuthoredLightEnabled,
  setClusteredLightMember,
} from "./light-policy";
import { findSceneShadowController } from "./shadow-controller";
import { syncSceneLighting } from "./scene-lighting";
import { beginClusteredAllocation } from "./clustered-allocation";
import { ClusteredCameraBounds } from "./clustered-camera-bounds";
import { sceneRenderingSettings } from "./render-settings";
import { forwardLightBudget } from "./forward-light-budget";
import { ManagedClusteredLightContainer } from "./clustered-light-container";
import { bindClusteredMaterialVariants } from "./clustered-material-bindings";

export type ClusteredSceneLightStatus = {
  clustered: number;
  conventional: number;
  estimatedBytes: number;
  reasons: readonly string[];
};

/**
 * Explicit prototype owner. Callers supply their authored registry because
 * Babylon removes borrowed children from scene.lights. Removing/disabling this
 * owner restores those children; it never assumes ownership of authored lights.
 */
export class ClusteredSceneLights {
  private container: ClusteredLightContainer | undefined;
  private readonly materialBindings = new Map<NodeMaterial, () => void>();
  private registry: readonly Light[];
  private readonly childDisposals = new Map<Light, Observer<Node>>();
  private disposed = false;
  private syncing = false;
  private allocationFailure: string | undefined;
  private allocatedBatches = 0;
  private cameraBounds: ClusteredCameraBounds | undefined;
  private statusValue: ClusteredSceneLightStatus = {
    clustered: 0,
    conventional: 0,
    estimatedBytes: 0,
    reasons: [],
  };
  private readonly unregister: () => void;
  private readonly onDispose: Observer<Scene>;
  private readonly restored: Observer<AbstractEngine>;

  private readonly scene: Scene;

  constructor(scene: Scene, lights: readonly Light[]) {
    this.scene = scene;
    this.registry = this.validateRegistry(lights);
    this.unregister = registerClusteredLightPolicy(scene, this);
    this.onDispose = scene.onDisposeObservable.add(() => this.dispose());
    this.restored = scene.getEngine().onContextRestoredObservable.add(() => {
      this.allocationFailure = undefined;
      this.releaseContainer();
    });
    this.watchLights();
    syncSceneLighting(scene);
  }

  setLights(lights: readonly Light[]): void {
    this.registry = this.validateRegistry(lights);
    this.watchLights();
    syncSceneLighting(this.scene);
  }

  status(): ClusteredSceneLightStatus {
    return this.statusValue;
  }

  limits(): string[] {
    return [...this.statusValue.reasons];
  }

  target(camera: Camera): RenderTargetTexture | undefined {
    if (
      this.disposed ||
      !this.container?.isEnabled() ||
      camera.getScene() !== this.scene ||
      camera.isDisposed()
    )
      return undefined;
    for (const light of this.container.lights) {
      light.parent?.computeWorldMatrix(true);
      if (light instanceof PointLight || light instanceof SpotLight)
        light.computeTransformedInformation();
    }
    return this.container._updateBatches(camera);
  }

  ownsContainer(light: Light): boolean {
    return light === this.container;
  }

  /** A frame boundary transaction: remove the previous contribution before adding its replacement. */
  sync(): void {
    if (this.disposed || this.scene.isDisposed || this.syncing) return;
    this.syncing = true;
    try {
      for (const [material, restore] of this.materialBindings) {
        if (!this.scene.materials.includes(material)) {
          restore();
          this.materialBindings.delete(material);
        }
      }
      for (const material of this.scene.materials) {
        if (
          material instanceof NodeMaterial &&
          !this.materialBindings.has(material)
        )
          this.materialBindings.set(
            material,
            bindClusteredMaterialVariants(material),
          );
      }
      const capability = clusteredLightCapabilities(this.scene.getEngine());
      const reason = this.unsupported(this.scene.activeCamera, capability);
      if (reason) {
        this.releaseContainer();
        this.statusValue = {
          clustered: 0,
          conventional: this.registry.length,
          estimatedBytes: 0,
          reasons: [reason],
        };
        return;
      }
      if (!capability.supported) return;
      // Controller entries retain the authored registry even while clustered
      // children leave scene.lights. New admitted maps therefore promote them.
      findSceneShadowController(this.scene)?.sync();
      const eligible = this.registry.filter((light) => this.eligible(light));
      // Bounded prototype resources: 256 children at most, and both physical
      // texture dimensions must fit before Babylon constructs/grows its batch.
      const maxBatches = Math.min(
        32,
        Math.floor(capability.maxTextureSize / 64),
      );
      const limit = Math.min(
        256,
        maxBatches * capability.batchSize,
        Math.floor(capability.maxTextureSize / capability.batchSize) *
          capability.batchSize,
      );
      eligible.sort(
        (a, b) =>
          b.renderPriority - a.renderPriority || a.uniqueId - b.uniqueId,
      );
      const selected = new Set(eligible.slice(0, limit));
      for (const light of this.container?.lights.slice() ?? []) {
        if (!selected.has(light)) this.returnLight(light);
      }
      if (!selected.size) {
        this.releaseContainer();
      } else {
        if (!this.container) {
          const fail = beginClusteredAllocation(this.scene);
          try {
            this.container = new ManagedClusteredLightContainer(
              "Slate clustered prototype",
              [],
              this.scene,
            );
            this.allocatedBatches = 1;
          } catch (error) {
            fail(error);
          }
        }
        const container = this.container;
        if (!container)
          throw new Error("Clustered allocation did not return an owner.");
        this.cameraBounds ??= new ClusteredCameraBounds(container);
        container.doNotSerialize = true;
        container.renderPriority = Number.MAX_SAFE_INTEGER;
        container.shadowEnabled = false;
        // Never use Babylon's default maxRange clamp to change attenuation.
        container.maxRange = Math.max(
          ...[...selected].map((light) => light.range),
        );
        for (const light of selected) {
          if (container.lights.includes(light)) continue;
          setClusteredLightMember(light, true);
          const shadowEnabled = light.shadowEnabled;
          try {
            // Babylon rejects even an empty old generator Map. Actual live maps
            // were excluded above; this synchronous admission flag is restored.
            light.shadowEnabled = false;
            container.addLight(light);
          } finally {
            light.shadowEnabled = shadowEnabled;
          }
          if (!container.lights.includes(light)) {
            setClusteredLightMember(light, false);
            throw new Error("Babylon rejected an eligible clustered light.");
          }
        }
        const batches = Math.ceil(selected.size / capability.batchSize);
        if (batches > this.allocatedBatches) {
          const fail = beginClusteredAllocation(this.scene);
          try {
            container._updateBatches(this.scene.activeCamera);
            this.allocatedBatches = batches;
          } catch (error) {
            fail(error);
          }
        }
        this.cameraBounds.sync(
          container._updateBatches(this.scene.activeCamera),
          this.usesUnboundedPhysicalLighting(),
        );
      }
      const clustered = this.container?.lights.length ?? 0;
      // Babylon retains its high-water allocation when membership shrinks.
      const batches = this.container ? this.allocatedBatches : 0;
      this.statusValue = {
        clustered,
        conventional: this.registry.length - clustered,
        estimatedBytes: batches * (64 * 64 * 4 + capability.batchSize * 20 * 4),
        reasons:
          eligible.length > limit
            ? [
                `Clustered resource capacity: ${clustered}/${eligible.length} eligible lights; remaining lights use bounded conventional admission.`,
              ]
            : [],
      };
      if (clustered && this.usesUnboundedPhysicalLighting())
        this.statusValue = {
          ...this.statusValue,
          reasons: [
            ...this.statusValue.reasons,
            "Physical PBR retains unbounded attenuation; conservative cluster masks cover all camera tiles and slices.",
          ],
        };
    } catch (error) {
      this.allocationFailure = `Clustered allocation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.releaseContainer();
      this.statusValue = {
        clustered: 0,
        conventional: this.registry.length,
        estimatedBytes: 0,
        reasons: [this.allocationFailure],
      };
    } finally {
      this.syncing = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    this.scene.onDisposeObservable.remove(this.onDispose);
    this.scene.getEngine().onContextRestoredObservable.remove(this.restored);
    this.releaseContainer();
    for (const [light, observer] of this.childDisposals)
      light.onDisposeObservable.remove(observer);
    this.childDisposals.clear();
    for (const restore of this.materialBindings.values()) restore();
    this.materialBindings.clear();
  }

  private validateRegistry(lights: readonly Light[]): readonly Light[] {
    if (lights.some((light) => light.getScene() !== this.scene))
      throw new Error("Clustered lights must belong to the owning scene.");
    return [...new Set(lights)];
  }

  private watchLights(): void {
    for (const [light, observer] of this.childDisposals) {
      if (!this.registry.includes(light)) {
        light.onDisposeObservable.remove(observer);
        this.childDisposals.delete(light);
      }
    }
    for (const light of this.registry) {
      if (this.childDisposals.has(light) || light.isDisposed()) continue;
      this.childDisposals.set(
        light,
        light.onDisposeObservable.add(() => {
          // Native Light.dispose does not detach a clustered child. removeLight
          // adds it back to scene.lights, so remove that already-disposed entry too.
          this.returnLight(light);
          this.scene.removeLight(light);
          this.childDisposals.delete(light);
        }),
      );
    }
  }

  private returnLight(light: Light): void {
    this.container?.removeLight(light);
    setClusteredLightMember(light, false);
  }

  private releaseContainer(): void {
    if (!this.container) return;
    for (const light of this.container.lights.slice()) this.returnLight(light);
    // The container owns its proxy material/textures, but its child lights are
    // borrowed and must be removed before Babylon's recursively owning dispose.
    this.cameraBounds?.dispose();
    this.cameraBounds = undefined;
    this.container.dispose(false, true);
    this.container = undefined;
    this.allocatedBatches = 0;
  }

  private eligible(light: Light): boolean {
    return (
      !light.isDisposed() &&
      (light instanceof PointLight || light instanceof SpotLight) &&
      isAuthoredLightEnabled(light) &&
      light.intensity > 0 &&
      (!light.parent || light.parent.isEnabled()) &&
      light.falloffType === Light.FALLOFF_DEFAULT &&
      Number.isFinite(light.range) &&
      light.range > 0 &&
      Number.isFinite(Math.fround(light.range)) &&
      !light.excludedMeshes.length &&
      !light.includedOnlyMeshes.length &&
      !light.includeOnlyWithLayerMask &&
      !light.excludeWithLayerMask &&
      light.lightmapMode === Light.LIGHTMAP_DEFAULT &&
      !light.getShadowGenerators()?.size &&
      (!(light instanceof SpotLight) ||
        (!light.projectionTexture && !light.iesProfileTexture))
    );
  }

  private unsupported(
    camera: Camera | null,
    caps: ClusteredLightCapabilities,
  ): string | undefined {
    if (caps.supported === false) return caps.reason;
    if (this.allocationFailure) return this.allocationFailure;
    // The cluster itself requires one ordinary light UBO. Global sun/fill keep
    // their conventional priority; do not borrow children if no slot remains.
    const globals = this.scene.lights.filter(
      (light) =>
        (light instanceof DirectionalLight ||
          light instanceof HemisphericLight) &&
        isAuthoredLightEnabled(light) &&
        light.intensity > 0 &&
        (!light.parent || light.parent.isEnabled()),
    ).length;
    if (globals >= forwardLightBudget(this.scene.getEngine()).slots)
      return "No conventional shader slot remains for the clustered light container.";
    if (
      !camera ||
      camera.getScene() !== this.scene ||
      camera.isDisposed() ||
      camera.mode !== Camera.PERSPECTIVE_CAMERA ||
      camera.minZ <= 0 ||
      !Number.isFinite(camera.maxZ) ||
      camera.maxZ <= camera.minZ
    )
      return "Clustered prototype requires a live perspective camera with a finite positive depth interval.";

    return undefined;
  }

  private usesUnboundedPhysicalLighting(): boolean {
    if (sceneRenderingSettings(this.scene).mode === "cel") return false;
    return this.scene.materials.some(
      (material) =>
        (material instanceof PBRMaterial && material.usePhysicalLightFalloff) ||
        (material instanceof NodeMaterial &&
          material.attachedBlocks.some(
            (block) =>
              block.getClassName() === "PBRMetallicRoughnessBlock" &&
              "lightFalloff" in block &&
              block.lightFalloff === 0,
          )),
    );
  }
}
