import {
  Light,
  DirectionalLight,
  HemisphericLight,
  NodeMaterial,
  PBRMaterial,
  PBRMetallicRoughnessBlock,
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
import { LightConstants } from "@babylonjs/core/Lights/lightConstants";
import {
  clusteredLightCapabilities,
  type ClusteredLightCapabilities,
} from "./clustered-light-capabilities";
import { registerClusteredLightPolicy } from "./clustered-light-policy";
import {
  isAuthoredLightEnabled,
  setClusteredLightMember,
  compareLightAdmission,
} from "./light-policy";
import { findSceneShadowController } from "./shadow-controller";
import { syncSceneLighting } from "./scene-lighting";
import { beginClusteredAllocation } from "./clustered-allocation";
import { ClusteredCameraBounds } from "./clustered-camera-bounds";
import { ClusteredLightOrder } from "./clustered-light-order";
import { sceneRenderingSettings } from "./render-settings";
import { forwardLightBudget } from "./forward-light-budget";
import { ManagedClusteredLightContainer } from "./clustered-light-container";
import { bindClusteredMaterialVariants } from "./clustered-material-bindings";

import {
  availableManagedLightingBytes,
  beginManagedLightingAllocation,
  type ManagedLightingLease,
} from "./managed-lighting-resources";
import {
  clusteredTextureAllocationBytes,
  clusteredTextureResources,
} from "./clustered-resource-cost";

export type ClusteredSceneLightStatus = {
  clustered: number;
  conventional: number;
  estimatedBytes: number;
  reasons: readonly string[];
  /** A compatibility/allocation fallback, distinct from informational budget limits. */
  fallbackReason?: string;
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
  private registryMembership = new Set<Light>();
  private authoredOrder: readonly Light[];
  private readonly authoredIndices = new Map<Light, number>();
  private orderDirty = true;
  private celConfiguration = "";
  private celCandidates: ReadonlySet<Light> | undefined;
  private celOrderFailure: string | undefined;
  private localSelection: Set<Light> | undefined;
  private readonly childDisposals = new Map<Light, Observer<Node>>();
  private disposed = false;
  private syncing = false;
  private allocationFailure: string | undefined;
  private allocatedBatches = 0;
  private resourceLease: ManagedLightingLease | undefined;
  private reservedTextureBytes = 0;
  private cameraBounds: ClusteredCameraBounds | undefined;
  private lightOrder: ClusteredLightOrder | undefined;
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
    this.registryMembership = new Set(this.registry);
    this.authoredOrder = [...scene.lights];
    this.updateAuthoredOrder();
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
    if (this.disposed) return;
    this.registry = this.validateRegistry(lights);
    this.registryMembership = new Set(this.registry);
    this.celConfiguration = "";
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

  borrowsLight(light: Light): boolean {
    return this.container?.lights.includes(light) ?? false;
  }

  ownsContainer(light: Light): boolean {
    return light === this.container;
  }

  allowsLocal(light: Light): boolean {
    return (
      !this.localSelection ||
      !this.registryMembership.has(light) ||
      this.localSelection.has(light)
    );
  }

  clusteredCount(): number {
    return this.container?.lights.length ?? 0;
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
        this.localSelection = undefined;
        this.releaseContainer();
        this.statusValue = {
          clustered: 0,
          conventional: this.registry.length,
          estimatedBytes: 0,
          reasons: [reason],
          fallbackReason: reason,
        };
        return;
      }
      if (!capability.supported) return;
      // Controller entries retain the authored registry even while clustered
      // children leave scene.lights. New admitted maps therefore promote them.
      findSceneShadowController(this.scene)?.sync();
      const requestedLocals = this.registry.filter(
        (light) =>
          !light.isDisposed() &&
          !(light instanceof DirectionalLight) &&
          !(light instanceof HemisphericLight) &&
          isAuthoredLightEnabled(light) &&
          light.intensity > 0 &&
          (!light.parent || light.parent.isEnabled()),
      );
      const localBudget = sceneRenderingSettings(this.scene).localLightBudget;
      if (requestedLocals.length > localBudget)
        requestedLocals.sort(
          compareLightAdmission(
            this.scene,
            requestedLocals,
            this.localSelection ?? new Set(),
          ),
        );
      const selection = this.localSelection ?? new Set<Light>();
      selection.clear();
      for (
        let index = 0;
        index < Math.min(localBudget, requestedLocals.length);
        index++
      )
        selection.add(requestedLocals[index]!);
      this.localSelection = selection;
      const eligible = requestedLocals.filter(
        (light) => this.localSelection!.has(light) && this.eligible(light),
      );
      // Bounded prototype resources: 256 children at most, and both physical
      // texture dimensions must fit before Babylon constructs/grows its batch.
      const maxBatches = Math.min(
        32,
        Math.floor(capability.maxTextureSize / 64),
      );
      const storageLimit = Math.min(
        256,
        maxBatches * capability.batchSize,
        Math.floor(capability.maxTextureSize / capability.batchSize) *
          capability.batchSize,
      );
      const batchBytes = clusteredTextureAllocationBytes(
        capability.batchSize,
        1,
        capability.backend,
      );
      const available = availableManagedLightingBytes(this.scene.getEngine());
      // Native construction allocates one empty batch before a larger replacement.
      // Both generations are reserved until synchronous cleanup is confirmed.
      const affordableBatches =
        Math.floor(available / batchBytes) -
        (!this.container && available >= batchBytes * 2 ? 1 : 0);
      const resourceLimit =
        Math.max(this.allocatedBatches, affordableBatches) *
        capability.batchSize;
      const limit = Math.min(storageLimit, resourceLimit);
      // CEL ordering is a stable structural decision; memory contention must not
      // silently split a Strongest tail and change equal-light tie semantics.
      this.configureCelOrder(storageLimit);
      if (this.celOrderFailure) {
        this.localSelection = undefined;
        this.releaseContainer();
        this.statusValue = {
          clustered: 0,
          conventional: this.registry.length,
          estimatedBytes: 0,
          reasons: [this.celOrderFailure],
          fallbackReason: this.celOrderFailure,
        };
        return;
      }
      if (this.celCandidates)
        for (let index = eligible.length - 1; index >= 0; index--)
          if (!this.celCandidates.has(eligible[index]!))
            eligible.splice(index, 1);
      if (eligible.length > limit)
        eligible.sort(
          compareLightAdmission(
            this.scene,
            eligible,
            new Set(this.container?.lights),
          ),
        );
      const memoryLimited = eligible.length > limit && limit < storageLimit;
      if (
        memoryLimited &&
        (limit === 0 || (this.celCandidates && eligible.length > limit))
      ) {
        this.localSelection = undefined;
        this.releaseContainer();
        const reason =
          "Shared managed lighting memory is reserved by other allocations; using conventional lighting.";
        this.statusValue = {
          clustered: 0,
          conventional: this.registry.length,
          estimatedBytes: 0,
          reasons: [reason],
          fallbackReason: reason,
        };
        return;
      }
      const selected = new Set(eligible.slice(0, limit));
      for (const light of this.container?.lights.slice() ?? []) {
        if (!selected.has(light)) this.returnLight(light);
      }
      if (!selected.size) {
        this.releaseContainer();
      } else {
        if (!this.container) {
          const lease = this.reserveTextures(
            capability.batchSize,
            1,
            capability.backend,
          );
          const fail = beginClusteredAllocation(this.scene, () =>
            lease.release(),
          );
          try {
            this.container = new ManagedClusteredLightContainer(
              "Slate clustered prototype",
              [],
              this.scene,
            );
            this.adoptTextures(lease, 1);
          } catch (error) {
            fail(error);
          }
        }
        const container = this.container;
        if (!container)
          throw new Error("Clustered allocation did not return an owner.");
        this.cameraBounds ??= new ClusteredCameraBounds(container);
        container.doNotSerialize = true;
        // A tail remains last, without enabling native sorting for an authored
        // Scene that previously used insertion order.
        const priority = this.scene.requireLightSorting ? -Number.MAX_VALUE : 0;
        if (container.renderPriority !== priority) this.orderDirty = true;
        container.renderPriority = priority;
        container.shadowEnabled = false;
        // Never use Babylon's default maxRange clamp to change attenuation.
        container.maxRange = Math.max(
          ...[...selected].map((light) => light.range),
        );
        for (const light of selected) {
          if (container.lights.includes(light)) continue;
          this.orderDirty = true;
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
          const lease = this.reserveTextures(
            capability.batchSize,
            batches,
            capability.backend,
          );
          const fail = beginClusteredAllocation(this.scene, () =>
            lease.release(),
          );
          try {
            container._updateBatches(this.scene.activeCamera);
            this.adoptTextures(lease, batches);
          } catch (error) {
            fail(error);
          }
        }
        this.cameraBounds.sync(
          container._updateBatches(this.scene.activeCamera),
          this.usesUnboundedPhysicalLighting(),
        );
        this.lightOrder ??= new ClusteredLightOrder(container);
        this.lightOrder.sync(
          container._updateBatches(this.scene.activeCamera),
          this.authoredOrder,
        );
        if (this.orderDirty) this.restoreAuthoredOrder(container);
      }
      const clustered = this.container?.lights.length ?? 0;
      // Babylon retains its high-water allocation when membership shrinks.
      this.statusValue = {
        clustered,
        conventional: this.registry.length - clustered,
        estimatedBytes: this.reservedTextureBytes,
        reasons:
          eligible.length > limit
            ? [
                `Clustered resource capacity: ${clustered}/${eligible.length} eligible lights; remaining lights use bounded conventional admission.`,
              ]
            : [],
      };
      if (memoryLimited)
        this.statusValue.reasons = [
          ...this.statusValue.reasons,
          "Shared managed lighting memory limits clustered storage; remaining locals use conventional admission.",
        ];
      if (requestedLocals.length > localBudget)
        this.statusValue.reasons = [
          ...this.statusValue.reasons,
          `Local lighting quality budget: ${this.localSelection.size}/${requestedLocals.length} requested locals selected across clustered and conventional lighting.`,
        ];
      if (clustered && this.usesUnboundedPhysicalLighting())
        this.statusValue = {
          ...this.statusValue,
          reasons: [
            ...this.statusValue.reasons,
            "Physical PBR retains unbounded attenuation; conservative cluster masks cover all camera tiles and slices.",
          ],
        };
    } catch (error) {
      this.localSelection = undefined;
      this.allocationFailure = `Clustered allocation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.releaseContainer();
      this.statusValue = {
        clustered: 0,
        conventional: this.registry.length,
        estimatedBytes: 0,
        reasons: [this.allocationFailure],
        fallbackReason: this.allocationFailure,
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
    this.orderDirty = true;
  }

  private releaseContainer(): void {
    if (!this.container) return;
    for (const light of this.container.lights
      .slice()
      .sort(this.compareAuthored))
      this.returnLight(light);
    // The container owns its proxy material/textures, but its child lights are
    // borrowed and must be removed before Babylon's recursively owning dispose.
    this.lightOrder?.dispose();
    this.lightOrder = undefined;
    this.cameraBounds?.dispose();
    this.cameraBounds = undefined;
    this.container.dispose(false, true);
    this.container = undefined;
    this.resourceLease?.release();
    this.resourceLease = undefined;
    this.reservedTextureBytes = 0;
    this.allocatedBatches = 0;
    // Native removeLight appends borrowed children. Restore their original
    // sequence for classic fallback/disposal, including per-mesh filtered lists.
    this.restoreAuthoredOrder();
  }

  private reserveTextures(
    batchSize: number,
    batches: number,
    backend: "webgl2" | "webgpu",
  ): ManagedLightingLease {
    const lease = beginManagedLightingAllocation(
      this.scene.getEngine(),
      clusteredTextureAllocationBytes(batchSize, batches, backend),
    );
    if (!lease)
      throw new Error(
        "Shared managed lighting replacement peak exceeds the available budget.",
      );
    return lease;
  }

  private adoptTextures(lease: ManagedLightingLease, batches: number): void {
    const resources = clusteredTextureResources(this.container!);
    lease.commit(resources);
    // Native _updateBatches has disposed the old textures before returning.
    this.resourceLease?.release();
    this.resourceLease = lease;
    this.reservedTextureBytes = resources.reduce(
      (sum, resource) => sum + resource.bytes,
      0,
    );
    this.allocatedBatches = batches;
  }

  private restoreAuthoredOrder(container?: Light): void {
    const compare = container
      ? (a: Light, b: Light) =>
          Number(a === container) - Number(b === container) ||
          this.compareAuthored(a, b)
      : this.compareAuthored;
    this.scene.lights.sort(compare);
    for (const mesh of this.scene.meshes) mesh.lightSources.sort(compare);
    // Frozen materials never re-evaluate their light defines without markDirty(true).
    for (const material of this.scene.materials)
      if (material.isFrozen) material.markDirty(true);
    this.orderDirty = false;
  }

  private readonly compareAuthored = (a: Light, b: Light): number =>
    (this.scene.requireLightSorting
      ? LightConstants.CompareLightsPriority(a, b)
      : 0) ||
    (this.authoredIndices.get(a) ?? a.uniqueId) -
      (this.authoredIndices.get(b) ?? b.uniqueId);

  private updateAuthoredOrder(): void {
    if (this.authoredOrder.some((light) => light.isDisposed())) {
      this.authoredOrder = this.authoredOrder.filter(
        (light) => !light.isDisposed(),
      );
      this.authoredIndices.clear();
    }
    if (!this.authoredIndices.size)
      this.authoredOrder.forEach((light, index) =>
        this.authoredIndices.set(light, index),
      );
    const added = [...this.scene.lights, ...this.registry].filter((light) => {
      if (
        light.isDisposed() ||
        light === this.container ||
        this.authoredIndices.has(light)
      )
        return false;
      this.authoredIndices.set(light, this.authoredIndices.size);
      return true;
    });
    if (added.length) {
      this.authoredOrder = [...this.authoredOrder, ...added];
      this.orderDirty = true;
    }
  }

  /** Resolve only on authored topology/style/quality changes, never camera/map admission. */
  private configureCelOrder(limit: number): void {
    this.updateAuthoredOrder();
    const state = sceneRenderingSettings(this.scene);
    const strongest =
      state.mode === "cel" && state.cel.lightMixing === "strongest";
    if (!strongest) {
      this.celConfiguration = "unrestricted";
      this.celCandidates = undefined;
      this.celOrderFailure = undefined;
      return;
    }
    const controller = findSceneShadowController(this.scene);
    const order = this.authoredOrder.filter((light) => !light.isDisposed());
    const candidates = new Set(
      order.filter(
        (light) =>
          this.registryMembership.has(light) &&
          isClusterableLocalLight(light) &&
          !controller?.requestsShadow(light) &&
          !light.getShadowGenerators()?.size,
      ),
    );
    const configuration =
      `${state.localLightBudget}:${limit}:${this.scene.requireLightSorting}:` +
      order
        .map(
          (light) =>
            `${light.uniqueId},${light.renderPriority},${light.shadowEnabled},${candidates.has(light)}`,
        )
        .join(";");
    if (configuration === this.celConfiguration) return;
    this.orderDirty = true;
    this.celConfiguration = configuration;
    this.celCandidates = candidates;
    this.celOrderFailure = undefined;
    order.sort(this.compareAuthored);
    let tail = false;
    for (const light of order) {
      if (candidates.has(light)) tail = true;
      else if (tail) {
        this.celOrderFailure =
          "CEL Strongest requires one stable clustered tail after conventional lights; authored interleaving uses conventional fallback.";
        return;
      }
    }
    if (candidates.size > limit && state.localLightBudget > limit)
      this.celOrderFailure =
        "CEL Strongest clustered tail exceeds storage capacity; conventional fallback preserves authored tie order.";
  }

  private eligible(light: Light): boolean {
    return (
      !light.isDisposed() &&
      (light instanceof PointLight || light instanceof SpotLight) &&
      isAuthoredLightEnabled(light) &&
      light.intensity > 0 &&
      (!light.parent || light.parent.isEnabled()) &&
      isClusterableLocalLight(light) &&
      !light.getShadowGenerators()?.size
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
              block instanceof PBRMetallicRoughnessBlock &&
              block.lightFalloff === 0,
          )),
    );
  }
}

export function isClusterableLocalLight(light: Light): boolean {
  return (
    (light instanceof PointLight || light instanceof SpotLight) &&
    light.falloffType === Light.FALLOFF_DEFAULT &&
    Number.isFinite(light.range) &&
    light.range > 0 &&
    Number.isFinite(Math.fround(light.range)) &&
    !light.excludedMeshes.length &&
    !light.includedOnlyMeshes.length &&
    !light.includeOnlyWithLayerMask &&
    !light.excludeWithLayerMask &&
    light.lightmapMode === Light.LIGHTMAP_DEFAULT &&
    (!(light instanceof SpotLight) ||
      (!light.projectionTexture && !light.iesProfileTexture))
  );
}
