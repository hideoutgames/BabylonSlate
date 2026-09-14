import {
  Light,
  NodeMaterial,
  PBRMaterial,
  PointLight,
  SpotLight,
  type Camera,
  type AbstractEngine,
  type Node,
  type Observer,
  type Scene,
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
  private registry: readonly Light[];
  private readonly childDisposals = new Map<Light, Observer<Node>>();
  private disposed = false;
  private syncing = false;
  private allocationFailure: string | undefined;
  private allocatedBatches = 0;
  private statusValue: ClusteredSceneLightStatus = {
    clustered: 0,
    conventional: 0,
    estimatedBytes: 0,
    reasons: [],
  };
  private readonly unregister: () => void;
  private readonly onDispose: Observer<Scene>;
  private readonly restored: Observer<AbstractEngine>;

  constructor(
    private readonly scene: Scene,
    lights: readonly Light[],
  ) {
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

  /** A frame boundary transaction: remove the previous contribution before adding its replacement. */
  sync(): void {
    if (this.disposed || this.scene.isDisposed || this.syncing) return;
    this.syncing = true;
    try {
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
            this.container = new ClusteredLightContainer(
              "Slate clustered prototype",
              [],
              this.scene,
            );
            this.allocatedBatches = 1;
          } catch (error) {
            fail(error);
          }
        }
        this.container.doNotSerialize = true;
        this.container.renderPriority = Number.MAX_SAFE_INTEGER;
        this.container.shadowEnabled = false;
        // Never use Babylon's default maxRange clamp to change attenuation.
        this.container.maxRange = Math.max(
          ...[...selected].map((light) => light.range),
        );
        for (const light of selected) {
          if (this.container.lights.includes(light)) continue;
          setClusteredLightMember(light, true);
          const shadowEnabled = light.shadowEnabled;
          try {
            // Babylon rejects even an empty old generator Map. Actual live maps
            // were excluded above; this synchronous admission flag is restored.
            light.shadowEnabled = false;
            this.container.addLight(light);
          } finally {
            light.shadowEnabled = shadowEnabled;
          }
          if (!this.container.lights.includes(light)) {
            setClusteredLightMember(light, false);
            throw new Error("Babylon rejected an eligible clustered light.");
          }
        }
        const batches = Math.ceil(selected.size / capability.batchSize);
        if (batches > this.allocatedBatches) {
          const fail = beginClusteredAllocation(this.scene);
          try {
            this.container._updateBatches(this.scene.activeCamera);
            this.allocatedBatches = batches;
          } catch (error) {
            fail(error);
          }
        } else this.container._updateBatches(this.scene.activeCamera);
      }
      const clustered = this.container?.lights.length ?? 0;
      const batches = clustered
        ? Math.ceil(clustered / capability.batchSize)
        : 0;
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
  }

  private validateRegistry(lights: readonly Light[]): readonly Light[] {
    if (lights.some((light) => light.getScene() !== this.scene))
      throw new Error("Clustered lights must belong to the owning scene.");
    return [...new Set(lights)];
  }

  private watchLights(): void {
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
      light.range < Math.sqrt(Number.MAX_VALUE) &&
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
    if (!caps.supported) return caps.reason;
    if (this.allocationFailure) return this.allocationFailure;
    if (
      !camera ||
      camera.getScene() !== this.scene ||
      camera.isDisposed() ||
      camera.minZ <= 0 ||
      !Number.isFinite(camera.maxZ) ||
      camera.maxZ <= camera.minZ
    )
      return "Clustered prototype requires a live camera with a finite positive depth interval.";
    // A physical PBR light has no authored finite cutoff. Until its conservative
    // camera bounds adapter is installed, keep its exact conventional response.
    if (
      this.scene.materials.some(
        (material) =>
          (material instanceof PBRMaterial &&
            material.usePhysicalLightFalloff) ||
          (material instanceof NodeMaterial &&
            material.attachedBlocks.some(
              (block) =>
                block.getClassName() === "PBRMetallicRoughnessBlock" &&
                "lightFalloff" in block &&
                block.lightFalloff === 0,
            )),
      )
    )
      return "Unbounded physical PBR attenuation requires conservative clustered camera bounds; using conventional lighting.";
    return undefined;
  }
}
