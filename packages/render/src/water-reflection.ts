import { CubeTexture, PBRMaterial, Texture, type AbstractMesh, type Scene } from "@babylonjs/core";
import { ownEnvironmentIrradiance } from "./environment-irradiance";
import { resourceCacheForEngine, type ResourceLease } from "./resource-cache";
import { isSkyboxMesh } from "./skybox";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

/** A scene-owned view of its visible sky; explicit environment lighting takes precedence. */
export class WaterReflection {
  private source: CubeTexture | null = null;
  private view: CubeTexture | null = null;
  private lease: ResourceLease<CubeTexture> | null = null;
  private irradiance: ReturnType<typeof ownEnvironmentIrradiance> | null = null;
  private materials = new Set<PBRMaterial>();
  private scene: Scene;
  private pending = false;
  private skyboxes: AbstractMesh[] = [];
  private skyboxesStale = true;
  private scannedMeshes = 0;
  constructor(scene: Scene) {
    this.scene = scene;
    // Removal notifies synchronously; Babylon defers the add notification, so adds are
    // caught by the mesh count instead.
    scene.onMeshRemovedObservable.add(() => { this.skyboxesStale = true; });
    scene.onDisposeObservable.addOnce(() => this.clear());
  }
  add(material: PBRMaterial): void {
    this.materials.add(material);
    material.reflectionTexture = this.view;
    material.onDisposeObservable.addOnce(() => {
      material.reflectionTexture = null;
      this.materials.delete(material);
      if (!this.materials.size) this.clear();
    });
    this.sync();
  }
  sync(): void {
    if (!this.materials.size) return;
    const sky = this.scene.environmentTexture ? null : this.visibleSky();
    const texture = sky?.material instanceof PBRMaterial ? sky.material.reflectionTexture : null;
    const source = texture instanceof CubeTexture && texture.isReady() ? texture : null;
    if (source !== this.source) {
      this.clear();
      if (source) {
        const cache = resourceCacheForEngine(this.scene.getEngine());
        this.lease = cache.acquireExisting(source);
        this.source = source;
        this.view = source.clone();
        this.view.coordinatesMode = Texture.CUBIC_MODE;
        this.irradiance = ownEnvironmentIrradiance(this.view, source, cache, () => {
          this.scene.removePendingData(this);
          this.pending = false;
          for (const material of this.materials) material.markAsDirty(PBRMaterial.TextureDirtyFlag);
          markSceneReadinessDirty(this.scene);
        });
        for (const material of this.materials) material.reflectionTexture = this.view;
      }
      markSceneReadinessDirty(this.scene);
    }
    if (this.irradiance && !this.irradiance.isReady() && !this.pending) {
      this.pending = true;
      this.scene.addPendingData(this);
    }
  }
  /**
   * Runs every frame, so the full mesh list is scanned only after it changed. Skybox
   * metadata is set as the mesh is created, before it can be rendered.
   */
  private visibleSky(): AbstractMesh | undefined {
    const meshes = this.scene.meshes;
    if (this.skyboxesStale || meshes.length !== this.scannedMeshes) {
      this.skyboxes = meshes.filter(isSkyboxMesh);
      this.skyboxesStale = false;
      this.scannedMeshes = meshes.length;
    }
    return this.skyboxes.find((mesh) => mesh.isEnabled() && mesh.isVisible);
  }
  private clear(): void {
    this.scene.removePendingData(this);
    this.pending = false;
    for (const material of this.materials) material.reflectionTexture = null;
    this.irradiance?.dispose(); this.irradiance = null;
    this.view?.dispose(); this.view = null;
    this.lease?.release(); this.lease = null; this.source = null;
  }
}
