import { CubeTexture, PBRMaterial, Texture, type Scene } from "@babylonjs/core";
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
  constructor(scene: Scene) {
    this.scene = scene;
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
    const sky = this.scene.environmentTexture ? null : this.scene.meshes.find((mesh) => isSkyboxMesh(mesh) && mesh.isEnabled() && mesh.isVisible);
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
  private clear(): void {
    this.scene.removePendingData(this);
    this.pending = false;
    for (const material of this.materials) material.reflectionTexture = null;
    this.irradiance?.dispose(); this.irradiance = null;
    this.view?.dispose(); this.view = null;
    this.lease?.release(); this.lease = null; this.source = null;
  }
}
