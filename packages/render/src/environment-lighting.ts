import { CubeTexture, Material, Matrix, PBRMaterial, Quaternion, Texture, type AbstractMesh, type Scene } from "@babylonjs/core";
import type { MeshAssetContext } from "./mesh-assets";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { sceneRenderingSettings } from "./render-settings";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { resourceCacheForEngine, type TextureResources, type ResourceLease } from "./resource-cache";
import { ownEnvironmentIrradiance } from "./environment-irradiance";
import { isSkyboxMesh } from "./skybox";
import { retainFilteredEnvironment, type FilteredEnvironment } from "./environment-prefilter";

const controllers = new WeakMap<Scene, EnvironmentLighting>();

function controller(scene: Scene): EnvironmentLighting {
  let owned = controllers.get(scene);
  if (!owned) {
    owned = new EnvironmentLighting(scene);
    controllers.set(scene, owned);
  }
  return owned;
}

/**
 * The source lease and texture view belong to this Scene, not its materials.
 * `skybox` lights the scene from its visible Skybox's cube instead of `guid`.
 */
export function applyEnvironmentLighting(
  scene: Scene,
  guid: string | null,
  assets?: MeshAssetContext,
  options: { skybox?: boolean } = {},
): void {
  const skybox = options.skybox === true;
  controller(scene).configure(
    skybox ? null : guid,
    !skybox && guid ? assets?.textureBytes?.get(guid) : undefined,
    assets?.resourceCache,
    skybox,
  );
}

/**
 * Reflection matrix that samples the Skybox cube where the sky shows it: the
 * sky mesh draws its cube by local direction, so world directions turn by the
 * inverse of its rotation after the Environment Rotation.
 */
export function skyboxEnvironmentMatrix(
  rotationYDegrees: number,
  skyRotation: Quaternion | null,
  result = new Matrix(),
): Matrix {
  Matrix.RotationYToRef((rotationYDegrees * Math.PI) / 180, result);
  if (!skyRotation) return result;
  const inverse = Matrix.Identity();
  Quaternion.Inverse(skyRotation).toRotationMatrix(inverse);
  return result.multiplyToRef(inverse, result);
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
  private skybox = false;
  /** A visible Skybox whose cube is still uploading holds readiness. */
  private skyPending = false;
  /** The Skybox cube the published view lights from (filtered or not). */
  private skySource: CubeTexture | null = null;
  /** GGX filtering of the current sky; while pending it holds readiness and keeps the previous view. */
  private skyFilter: { sky: CubeTexture; filtered: FilteredEnvironment | null; state: "pending" | "ready" | "failed" } | null = null;
  private skyboxes: AbstractMesh[] = [];
  private skyboxesStale = true;
  private scannedMeshes = 0;
  /** Environment Rotation and sky rotation the view's matrix was built from; NaN forces a rebuild. */
  private readonly skyMatrixInputs = [NaN, NaN, NaN, NaN, NaN];
  private readonly skyMatrix = new Matrix();
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    // Removal notifies synchronously; Babylon defers the add notification, so
    // adds are caught by the mesh count instead.
    scene.onMeshRemovedObservable.add(() => { this.skyboxesStale = true; });
    // Rendering only applies pending changes; readiness consumers report a failure.
    scene.onBeforeRenderObservable.add(() => {
      if (this.skybox) this.followSky();
      if (this.view) this.refresh();
    });
    scene.onDisposeObservable.addOnce(() => {
      this.disposed = true;
      this.clear();
      this.releaseSkyFilter();
      this.samples.clear();
      controllers.delete(scene);
    });
  }

  configure(
    guid: string | null,
    bytes: Uint8Array | Blob | undefined,
    cache: TextureResources | undefined,
    skybox = false,
  ): void {
    const changed = this.guid !== guid || this.bytes !== bytes || this.cache !== cache || this.skybox !== skybox;
    this.requestChanged ||= changed;
    if (changed) this.preparationError = null;
    this.guid = guid;
    this.bytes = bytes;
    this.cache = cache;
    this.skybox = skybox;
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
    const wanted = settings.enabled || this.samples.size > 0;
    const sky = this.skybox && wanted ? this.skyCube() : null;
    if (!this.skybox || !wanted) {
      this.skyPending = false;
      // A published view keeps its own handle on a filtered sky.
      this.releaseSkyFilter();
    }
    const filter = sky ? this.filterSky(sky) : null;
    if (this.skybox && ((!sky && this.skyPending) || filter?.state === "pending") && this.view) {
      // A replaced Skybox keeps lighting with the previous cube until its own uploads and filters.
    } else if (filter?.state === "pending") {
      // Nothing lit yet: readiness waits for the first filtered sky.
    } else if (
      !wanted ||
      (this.skybox
        ? !sky
        : !this.guid || !this.bytes || !this.cache)
    ) {
      changed = !!this.view || changed;
      this.clear();
      this.releaseSkyFilter();
      this.preparationError = null;
    } else if (sky) {
      if (
        this.requestChanged ||
        sky !== this.skySource ||
        !this.view ||
        isDisposedGpuTexture(this.view)
      ) {
        const cache = this.cache ?? resourceCacheForEngine(this.scene.getEngine());
        try {
          const filtered = filter?.state === "ready" ? retainFilteredEnvironment(this.scene.getEngine(), sky) : null;
          // The filtered cube is held through its own handle; an unfiltered sky
          // through a cache lease beside the Skybox's own.
          this.publish(filtered
            ? { resource: filtered.cube, key: "", ready: undefined, release: () => filtered.release() }
            : cache.acquireExisting(sky), cache);
          this.skySource = sky;
          changed = true;
        } catch (error) {
          changed = !!this.view || changed;
          this.clear();
          console.error("Skybox environment lighting failed", error);
        }
      }
    } else if (!this.skybox && this.guid && this.bytes && this.cache && !this.preparationError && (
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
    if (this.view && this.skybox) {
      changed = this.applySkyRotation(settings.rotationYDegrees) || changed;
    } else if (
      this.view &&
      this.view.rotationY !== (settings.rotationYDegrees * Math.PI) / 180
    ) {
      this.view.rotationY = (settings.rotationYDegrees * Math.PI) / 180;
      changed = true;
    }
    if (changed) this.invalidateMaterials();
  }

  isReady(): boolean {
    if (this.skybox) this.followSky();
    this.refresh();
    if (this.preparationError) throw this.preparationError;
    if (this.pendingLease || this.skyPending || this.skyFilter?.state === "pending") return false;
    return (
      !this.view ||
      (this.view.isReady() &&
        (!sceneRenderingSettings(this.scene).environmentLighting.enabled ||
          this.irradiance!.isReady()))
    );
  }

  /** Apply a finished irradiance update and record a failed source upload. */
  private refresh(): void {
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
  }

  /** Republish when the visible Skybox, its cube or its rotation changed. */
  private followSky(): void {
    if (this.disposed || this.scene.isDisposed) return;
    const settings = sceneRenderingSettings(this.scene).environmentLighting;
    if (!settings.enabled && !this.samples.size) return;
    const sky = this.skyCube();
    if (sky !== this.skySource) this.sync();
    else if (this.view && this.applySkyRotation(settings.rotationYDegrees)) this.invalidateMaterials();
  }

  /** Start, or return, the GGX filtering of `sky`; a device or budget that cannot filter reads as failed. */
  private filterSky(sky: CubeTexture): NonNullable<EnvironmentLighting["skyFilter"]> {
    if (this.skyFilter?.sky === sky) return this.skyFilter;
    this.releaseSkyFilter();
    let filtered: FilteredEnvironment | null = null;
    try {
      filtered = retainFilteredEnvironment(this.scene.getEngine(), sky);
    } catch (error) {
      console.error("Skybox environment filtering failed", error);
    }
    const request: NonNullable<EnvironmentLighting["skyFilter"]> = { sky, filtered, state: filtered ? "pending" : "failed" };
    this.skyFilter = request;
    void filtered?.ready.then(() => {
      if (this.skyFilter !== request) return;
      request.state = "ready";
      markSceneReadinessDirty(this.scene);
      this.sync();
    }, (error) => {
      if (this.skyFilter !== request) return;
      request.state = "failed";
      // A failed filter keeps nothing reserved; this sky stays unfiltered.
      request.filtered?.release();
      request.filtered = null;
      console.error("Skybox environment filtering failed; lighting from the unfiltered sky", error);
      markSceneReadinessDirty(this.scene);
      this.sync();
    });
    return request;
  }

  private releaseSkyFilter(): void {
    this.skyFilter?.filtered?.release();
    this.skyFilter = null;
  }

  /** The ready cube of the first enabled, visible Skybox, or null. */
  private skyCube(): CubeTexture | null {
    const mesh = this.visibleSky();
    const texture = mesh?.material instanceof PBRMaterial ? mesh.material.reflectionTexture : null;
    const cube = texture instanceof CubeTexture && !texture.loadingError ? texture : null;
    this.skyPending = !!cube && !cube.isReady();
    return cube && !this.skyPending ? cube : null;
  }

  /** Scanned only after the mesh list changed: this runs every frame. */
  private visibleSky(): AbstractMesh | undefined {
    const meshes = this.scene.meshes;
    if (this.skyboxesStale || meshes.length !== this.scannedMeshes) {
      this.skyboxes = meshes.filter(isSkyboxMesh);
      this.skyboxesStale = false;
      this.scannedMeshes = meshes.length;
    }
    return this.skyboxes.find((mesh) => !mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible);
  }

  /** True when the view's matrix changed. Runs every frame, so it allocates nothing. */
  private applySkyRotation(rotationYDegrees: number): boolean {
    const rotation = this.visibleSky()?.absoluteRotationQuaternion ?? null;
    const inputs = this.skyMatrixInputs;
    const x = rotation?.x ?? 0, y = rotation?.y ?? 0, z = rotation?.z ?? 0, w = rotation?.w ?? 1;
    if (
      inputs[0] === rotationYDegrees && inputs[1] === x && inputs[2] === y && inputs[3] === z && inputs[4] === w &&
      this.view?.getReflectionTextureMatrix() === this.skyMatrix
    ) return false;
    inputs[0] = rotationYDegrees; inputs[1] = x; inputs[2] = y; inputs[3] = z; inputs[4] = w;
    skyboxEnvironmentMatrix(rotationYDegrees, rotation, this.skyMatrix);
    this.view!.setReflectionTextureMatrix(this.skyMatrix);
    return true;
  }

  private publish(lease: ResourceLease<CubeTexture>, cache: TextureResources = this.cache!): void {
    const source = lease.resource;
    let view: CubeTexture;
    try {
      view = source.clone();
      // A generated cube has no URL for its clone to reload: share its texture.
      const shared = source.getInternalTexture();
      if (!view.getInternalTexture() && shared) {
        shared.incrementReferences();
        view._texture = shared;
        view.gammaSpace = source.gammaSpace;
        view.lodGenerationScale = source.lodGenerationScale;
        view.lodGenerationOffset = source.lodGenerationOffset;
        view._prefiltered = source._prefiltered;
      }
      if (view.getInternalTexture() !== source.getInternalTexture()) {
        view.dispose();
        throw new Error("Environment view did not share its uploaded cube.");
      }
    } catch (error) { lease.release(); throw error; }
    let irradiance: ReturnType<typeof ownEnvironmentIrradiance>;
    try {
      irradiance = ownEnvironmentIrradiance(view, source, cache, () => {
        if (!this.disposed && this.view === view) this.irradianceChanged = true;
      });
    } catch (error) { view.dispose(); lease.release(); throw error; }
    this.clear();
    this.source = source;
    this.sourceLease = lease;
    this.view = view;
    this.irradiance = irradiance;
    // A Skybox draws its cube in skybox mode; its lighting view samples by direction.
    view.coordinatesMode = Texture.CUBIC_MODE;
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
    this.skySource = null;
    this.irradianceChanged = false;
    if (this.scene.environmentTexture === this.view)
      this.scene.environmentTexture = null;
    this.view?.dispose();
    this.view = null;
    this.skyMatrixInputs.fill(NaN);
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
