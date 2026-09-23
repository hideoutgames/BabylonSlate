import { CubeTexture, Material, type Scene } from "@babylonjs/core";
import type { MeshAssetContext } from "./mesh-assets";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { sceneRenderingSettings } from "./render-settings";
import { markSceneReadinessDirty } from "./scene-perf";
import type { TextureResources, ResourceLease } from "./resource-cache";
import { ownEnvironmentIrradiance } from "./environment-irradiance";

const controllers = new WeakMap<Scene, EnvironmentLighting>();

function controller(scene: Scene): EnvironmentLighting {
  let owned = controllers.get(scene);
  if (!owned) {
    owned = new EnvironmentLighting(scene);
    controllers.set(scene, owned);
  }
  return owned;
}

/** The source lease and texture view belong to this Scene, not its materials. */
export function applyEnvironmentLighting(
  scene: Scene,
  guid: string | null,
  assets?: MeshAssetContext,
): void {
  controller(scene).configure(
    guid,
    guid ? assets?.textureBytes?.get(guid) : undefined,
    assets?.resourceCache,
  );
}

export function syncEnvironmentLighting(scene: Scene): void {
  controllers.get(scene)?.sync();
}

/** Explicit raw samples remain consumers when automatic IBL is disabled. */
export function retainEnvironmentSample(
  scene: Scene,
  owner: object,
): () => void {
  const owned = controller(scene);
  owned.samples.add(owner);
  owned.sync();
  return () => {
    if (owned.samples.delete(owner)) owned.sync();
  };
}

export function isEnvironmentLightingReady(scene: Scene): boolean {
  return controllers.get(scene)?.isReady() ?? true;
}

class EnvironmentLighting {
  readonly samples = new Set<object>();
  private guid: string | null = null;
  private bytes: Uint8Array | Blob | undefined;
  private cache: TextureResources | undefined;
  private source: CubeTexture | null = null;
  private sourceLease: ResourceLease<CubeTexture> | undefined;
  private pendingLease: ResourceLease<CubeTexture> | undefined;
  private view: CubeTexture | null = null;
  private irradiance: ReturnType<typeof ownEnvironmentIrradiance> | null = null;
  private irradianceChanged = false;
  private requestChanged = false;
  private preparationError: Error | null = null;
  private settingsKey = "";
  private disposed = false;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    scene.onBeforeRenderObservable.add(() => {
      if (this.view) this.isReady();
    });
    scene.onDisposeObservable.addOnce(() => {
      this.disposed = true;
      this.clear();
      this.samples.clear();
      controllers.delete(scene);
    });
  }

  configure(
    guid: string | null,
    bytes: Uint8Array | Blob | undefined,
    cache: TextureResources | undefined,
  ): void {
    const changed = this.guid !== guid || this.bytes !== bytes || this.cache !== cache;
    this.requestChanged ||= changed;
    if (changed) this.preparationError = null;
    this.guid = guid;
    this.bytes = bytes;
    this.cache = cache;
    this.sync();
  }

  sync(): void {
    if (this.disposed || this.scene.isDisposed) return;
    const settings = sceneRenderingSettings(this.scene).environmentLighting;
    const key = `${settings.enabled}:${settings.intensity}:${settings.rotationYDegrees}:${settings.celStrength}`;
    let changed = key !== this.settingsKey;
    this.settingsKey = key;
    // Native PBR and graph ReflectionBlock apply this multiplier once. Keep
    // scene.environmentIntensity independent for future baked/probe lighting.
    this.scene.iblIntensity = settings.enabled ? settings.intensity : 0;
    if (
      (!settings.enabled && !this.samples.size) ||
      !this.guid ||
      !this.bytes ||
      !this.cache
    ) {
      changed = !!this.view || changed;
      this.clear();
      this.preparationError = null;
    } else if (!this.preparationError && (
      this.requestChanged ||
      !this.source ||
      !this.view ||
      isDisposedGpuTexture(this.source) ||
      isDisposedGpuTexture(this.view)
    )) {
      this.pendingLease?.release();
      this.pendingLease = undefined;
      let lease: ResourceLease<CubeTexture>;
      try {
        lease = this.cache.acquireTexture(this.guid, this.scene.getEngine(), this.bytes, { isCube: true }) as ResourceLease<CubeTexture>;
      } catch (error) {
        this.requestChanged = false;
        if (!this.source) throw error;
        console.error("Environment texture replacement failed", error);
        return;
      }
      if (lease.resource === this.source && this.view && !isDisposedGpuTexture(this.view)) lease.release();
      // Native upload readiness can precede the cache's byte admission. Retain
      // the working environment until the complete owned preparation succeeds.
      else if (this.source && lease.ready) {
        this.pendingLease = lease;
        changed = true;
        void lease.ready.then(() => {
          if (this.pendingLease !== lease || this.disposed || this.scene.isDisposed) { lease.release(); return; }
          this.pendingLease = undefined;
          try { this.publish(lease); this.sync(); this.invalidateMaterials(); }
          catch (error) { lease.release(); markSceneReadinessDirty(this.scene); console.error("Environment texture replacement failed", error); }
        }, (error) => {
          if (this.pendingLease !== lease) return;
          this.pendingLease = undefined;
          lease.release();
          markSceneReadinessDirty(this.scene);
          console.error("Environment texture replacement failed", error);
        });
      } else {
        this.publish(lease);
        changed = true;
      }
    }
    this.requestChanged = false;
    if (
      this.view &&
      this.view.rotationY !== (settings.rotationYDegrees * Math.PI) / 180
    ) {
      this.view.rotationY = (settings.rotationYDegrees * Math.PI) / 180;
      changed = true;
    }
    if (changed) this.invalidateMaterials();
  }

  isReady(): boolean {
    if (this.irradianceChanged) {
      this.irradianceChanged = false;
      this.invalidateMaterials();
    }
    if (this.source?.loadingError) {
      this.failInitialPreparation(this.sourceLease!, new Error(
        this.source.errorObject?.message ??
          "Environment texture failed to load.",
        { cause: this.source.errorObject?.exception },
      ));
    }
    if (this.preparationError) throw this.preparationError;
    if (this.pendingLease) return false;
    return (
      !this.view ||
      (this.view.isReady() &&
        (!sceneRenderingSettings(this.scene).environmentLighting.enabled ||
          this.irradiance!.isReady()))
    );
  }

  private publish(lease: ResourceLease<CubeTexture>): void {
    const source = lease.resource;
    let view: CubeTexture;
    try {
      view = source.clone();
      if (view.getInternalTexture() !== source.getInternalTexture()) {
        view.dispose();
        throw new Error("Environment view did not share its uploaded cube.");
      }
    } catch (error) { lease.release(); throw error; }
    let irradiance: ReturnType<typeof ownEnvironmentIrradiance>;
    try {
      irradiance = ownEnvironmentIrradiance(view, source, this.cache!, () => {
        if (!this.disposed && this.view === view) this.irradianceChanged = true;
      });
    } catch (error) { view.dispose(); lease.release(); throw error; }
    this.clear();
    this.source = source;
    this.sourceLease = lease;
    this.view = view;
    this.irradiance = irradiance;
    this.scene.environmentTexture = view;
    void lease.ready?.catch((error) => this.failInitialPreparation(lease, error));
  }

  private failInitialPreparation(lease: ResourceLease<CubeTexture>, error: unknown): void {
    if (this.sourceLease !== lease || this.disposed) return;
    this.preparationError = error instanceof Error ? error : new Error(String(error));
    this.clear();
    markSceneReadinessDirty(this.scene);
  }

  private clear(): void {
    this.pendingLease?.release();
    this.pendingLease = undefined;
    this.irradiance?.dispose();
    this.irradiance = null;
    this.irradianceChanged = false;
    if (this.scene.environmentTexture === this.view)
      this.scene.environmentTexture = null;
    this.view?.dispose();
    this.view = null;
    this.sourceLease?.release();
    this.source = null;
    this.sourceLease = undefined;
  }

  private invalidateMaterials(): void {
    markSceneReadinessDirty(this.scene);
    const blocked = this.scene.blockMaterialDirtyMechanism;
    this.scene.blockMaterialDirtyMechanism = false;
    try {
      for (const material of this.scene.materials) {
        material.markAsDirty(Material.TextureDirtyFlag);
        // Also refresh a frozen PBR UBO's reflection matrix/intensity binding.
        material.markDirty(true);
      }
      this.scene.resetCachedMaterial();
    } finally {
      this.scene.blockMaterialDirtyMechanism = blocked;
    }
  }
}
