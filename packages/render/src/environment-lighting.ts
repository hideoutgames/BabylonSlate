import { CubeTexture, Material, type Scene } from "@babylonjs/core";
import type { MeshAssetContext } from "./mesh-assets";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { sceneRenderingSettings } from "./render-settings";
import type { ResourceCache } from "./resource-cache";

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
  private cache: ResourceCache | undefined;
  private source: CubeTexture | null = null;
  private sourceCache: ResourceCache | undefined;
  private view: CubeTexture | null = null;
  private requestChanged = false;
  private settingsKey = "";
  private disposed = false;

  constructor(private readonly scene: Scene) {
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
    cache: ResourceCache | undefined,
  ): void {
    this.requestChanged ||=
      this.guid !== guid || this.bytes !== bytes || this.cache !== cache;
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
    } else if (
      this.requestChanged ||
      !this.source ||
      !this.view ||
      isDisposedGpuTexture(this.source) ||
      isDisposedGpuTexture(this.view)
    ) {
      const source = this.cache.getTexture(
        this.guid,
        this.scene.getEngine(),
        this.bytes,
        { isCube: true },
      ) as CubeTexture;
      if (
        source === this.source &&
        this.sourceCache === this.cache &&
        this.view &&
        !isDisposedGpuTexture(this.view)
      ) {
        // Re-collected identical bytes may have a new Uint8Array identity.
        this.cache.release(source);
      } else {
        let view: CubeTexture;
        try {
          // Babylon 9.20 preserves shared irradiance when cloning a cached
          // CubeTexture. Its matrix lives on the wrapper; uploaded data does not.
          view = source.clone();
          if (view.getInternalTexture() !== source.getInternalTexture()) {
            view.dispose();
            throw new Error(
              "Environment view did not share its uploaded cube.",
            );
          }
        } catch (error) {
          this.cache.release(source);
          throw error;
        }
        this.clear();
        this.source = source;
        this.sourceCache = this.cache;
        this.view = view;
        this.scene.environmentTexture = view;
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
    if (this.source?.loadingError) {
      throw new Error(
        this.source.errorObject?.message ??
          "Environment texture failed to load.",
        { cause: this.source.errorObject?.exception },
      );
    }
    return !this.view || this.view.isReady();
  }

  private clear(): void {
    if (this.scene.environmentTexture === this.view)
      this.scene.environmentTexture = null;
    this.view?.dispose();
    this.view = null;
    if (this.source) this.sourceCache?.release(this.source);
    this.source = null;
    this.sourceCache = undefined;
  }

  private invalidateMaterials(): void {
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
