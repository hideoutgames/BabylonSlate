import { Texture, type Scene } from "@babylonjs/core";
import type { MeshAssetContext } from "./mesh-assets";
import {
  resourceCacheForEngine,
  type ResourceLease,
  type TextureResources,
} from "./resource-cache";

/** LUT texels are addressed exactly: no mips, no flip, bilinear, clamped. */
const LUT_SAMPLING = {
  noMipmap: true,
  invertY: false,
  samplingMode: Texture.BILINEAR_SAMPLINGMODE,
  anisotropicFilteringLevel: 1,
} as const;

/**
 * One Scene's color grading LUT. The requested Texture asset is acquired from
 * the host's packed bytes through the shared ResourceCache; `onChange`
 * publishes the texture only once it is ready (or null), so the effect plan
 * never compiles a Display Color stage that samples an unloaded LUT.
 */
export class ColorGradingSource {
  private readonly scene: Scene;
  private readonly onChange: (texture: Texture | null) => void;
  private textureBytes: ReadonlyMap<string, Uint8Array | Blob> | undefined;
  private cache: TextureResources | undefined;
  private guid: string | null = null;
  private bytes: Uint8Array | Blob | undefined;
  private lease: ResourceLease<Texture> | undefined;
  private published: Texture | null = null;
  private readonly retiring = new Set<ResourceLease<Texture>>();
  private disposed = false;

  constructor(scene: Scene, onChange: (texture: Texture | null) => void) {
    this.scene = scene;
    this.onChange = onChange;
  }

  setAssets(assets: MeshAssetContext | undefined): void {
    this.textureBytes = assets?.textureBytes;
    this.cache = assets?.resourceCache;
    this.sync(this.guid);
  }

  /** Null clears grading; an unloaded or missing asset grades nothing. */
  sync(guid: string | null): void {
    if (this.disposed) return;
    const bytes = guid ? this.textureBytes?.get(guid) : undefined;
    if (guid === this.guid && bytes === this.bytes) return;
    this.guid = guid;
    this.bytes = bytes;
    this.replace(guid && bytes ? this.acquire(guid, bytes) : undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replace(undefined);
    for (const lease of this.retiring) lease.release();
    this.retiring.clear();
  }

  private acquire(guid: string, bytes: Uint8Array | Blob): ResourceLease<Texture> | undefined {
    const cache = this.cache ?? resourceCacheForEngine(this.scene.getEngine());
    let lease: ResourceLease<Texture>;
    try {
      lease = cache.acquireTexture(guid, this.scene.getEngine(), bytes, LUT_SAMPLING) as ResourceLease<Texture>;
    } catch (error) {
      console.warn("Color grading LUT could not be loaded.", error);
      return undefined;
    }
    if (lease.resource.isCube) {
      lease.release();
      console.warn("Color grading requires a 2D LUT strip texture, not a cube.");
      return undefined;
    }
    lease.resource.wrapU = Texture.CLAMP_ADDRESSMODE;
    lease.resource.wrapV = Texture.CLAMP_ADDRESSMODE;
    const publish = () => {
      if (this.lease !== lease || this.disposed) return;
      this.publish(lease.resource);
    };
    if (lease.ready)
      void lease.ready.then(publish, (error: unknown) => {
        if (this.lease === lease) console.warn("Color grading LUT failed to load.", error);
      });
    else queueMicrotask(publish);
    return lease;
  }

  private replace(next: ResourceLease<Texture> | undefined): void {
    const previous = this.lease;
    this.lease = next;
    this.publish(null);
    if (!previous) return;
    if (this.disposed || this.scene.isDisposed) {
      previous.release();
      return;
    }
    // The last plan may still reference the texture until its chain rebuilds
    // at the next view boundary; release after that frame, or on disposal.
    this.retiring.add(previous);
    this.scene.onAfterRenderObservable.addOnce(() => {
      if (this.retiring.delete(previous)) previous.release();
    });
  }

  private publish(texture: Texture | null): void {
    if (this.published === texture) return;
    this.published = texture;
    this.onChange(texture);
  }
}
