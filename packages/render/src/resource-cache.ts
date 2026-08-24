import type { AbstractEngine, BaseTexture, Scene } from "@babylonjs/core";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { accountedTextureBytes, type TextureFormat } from "./texture-bytes";

export interface ResourceCacheOptions {
  /** Accounted byte ceiling before evicting unreferenced LRU entries. */
  byteCeiling?: number;
  /** Soft factor over ceiling before eviction (default 1.2). */
  evictionFactor?: number;
  onEvict?: (assetGuid: string, reason: string) => void;
}

/** Canonical sampling options — part of the engine InternalTexture cache key. */
export interface TextureSamplingOptions {
  noMipmap?: boolean;
  samplingMode?: number;
  invertY?: boolean;
  useSRGBBuffer?: boolean;
  isCube?: boolean;
}

interface CacheEntry {
  assetGuid: string;
  blobUrl: string;
  bytes: number;
  refCount: number;
  lastUsed: number;
  samplingKey: string;
  texture?: BaseTexture;
}

/**
 * Six-face cubemap bound to the Engine, not a Scene. Scene.dispose must not
 * drop a ResourceCache-owned cube (Play overlay shares the editor Engine).
 */
export function createEngineCubeTextureFromImages(
  engine: AbstractEngine,
  files: string[],
  noMipmap = false,
): CubeTexture {
  return new CubeTexture(files.join(""), engine, { files, noMipmap });
}

/** Engine-static PNG (editor billboards). Not a project asset guid. */
export function createEngineTextureFromUrl(
  engine: AbstractEngine,
  url: string,
): Texture {
  const texture = new Texture(url, engine, {
    noMipmap: false,
    invertY: true,
    samplingMode: Texture.BILINEAR_SAMPLINGMODE,
  });
  texture.hasAlpha = true;
  return texture;
}

function samplingKey(options: TextureSamplingOptions = {}): string {
  return [
    options.noMipmap ? "1" : "0",
    String(options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE),
    options.invertY === false ? "0" : "1",
    options.useSRGBBuffer ? "1" : "0",
    options.isCube ? "1" : "0",
  ].join(":");
}

const caches = new WeakMap<AbstractEngine, ResourceCache>();

/**
 * One {@link ResourceCache} per Engine lifetime so Play / Prefab / Material /
 * UI reuse the same blob URLs and InternalTexture keys.
 */
export function resourceCacheForEngine(
  engine: AbstractEngine,
  options?: ResourceCacheOptions,
): ResourceCache {
  const existing = caches.get(engine);
  if (existing) return existing;
  const cache = new ResourceCache(options);
  caches.set(engine, cache);
  return cache;
}

/** Dispose and forget the cache when this caller owns the Engine. */
export function releaseResourceCacheForEngine(engine: AbstractEngine): void {
  const cache = caches.get(engine);
  if (!cache) return;
  caches.delete(engine);
  cache.dispose();
}

/**
 * LRU resource cache with byte ceiling and stable blob URLs per asset guid.
 * Texture construction must go through this cache (lint-enforced).
 */
export class ResourceCache {
  private readonly ceiling: number;
  private readonly evictionFactor: number;
  private readonly onEvict?: (assetGuid: string, reason: string) => void;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly blobs = new Map<string, Blob>();
  private clock = 0;
  private totalBytes = 0;

  constructor(options: ResourceCacheOptions = {}) {
    this.ceiling = options.byteCeiling ?? 512 * 1024 * 1024;
    this.evictionFactor = options.evictionFactor ?? 1.2;
    this.onEvict = options.onEvict;
  }

  blobUrlFor(assetGuid: string, bytes: Uint8Array | Blob): string {
    const existing = this.entries.get(assetGuid);
    if (existing) {
      existing.refCount += 1;
      existing.lastUsed = ++this.clock;
      return existing.blobUrl;
    }
    const blob =
      bytes instanceof Blob
        ? bytes
        : new Blob(
            [
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer,
            ],
            { type: "application/octet-stream" },
          );
    this.blobs.set(assetGuid, blob);
    const url =
      typeof URL !== "undefined" && URL.createObjectURL
        ? URL.createObjectURL(blob)
        : `blob:babylonslate/${assetGuid}`;
    const entry: CacheEntry = {
      assetGuid,
      blobUrl: url,
      bytes: 0,
      refCount: 1,
      lastUsed: ++this.clock,
      samplingKey: samplingKey(),
    };
    this.entries.set(assetGuid, entry);
    return url;
  }

  /**
   * Resolve a Texture for an asset guid through the cache so editor and Play
   * share one InternalTexture (stable URL + canonical sampling flags).
   */
  getTexture(
    assetGuid: string,
    engine: AbstractEngine,
    bytes: Uint8Array | Blob,
    options: TextureSamplingOptions = {},
  ): Texture | CubeTexture {
    const key = samplingKey(options);
    const existing = this.entries.get(assetGuid);
    if (existing?.texture && existing.samplingKey === key) {
      if (!isDisposedGpuTexture(existing.texture)) {
        existing.refCount += 1;
        existing.lastUsed = ++this.clock;
        return existing.texture as Texture | CubeTexture;
      }
      existing.texture = undefined;
    }
    const url = this.blobUrlFor(assetGuid, bytes);
    const entry = this.entries.get(assetGuid)!;
    if (entry.texture && entry.samplingKey !== key) {
      entry.texture.dispose();
      entry.texture = undefined;
    }
    // Canonical sampling flags are part of Babylon's InternalTexture cache key.
    const texture = options.isCube
      ? new CubeTexture(url, engine, {
          noMipmap: options.noMipmap ?? false,
          useSRGBBuffer: options.useSRGBBuffer ?? false,
        })
      : new Texture(url, engine, {
          noMipmap: options.noMipmap ?? false,
          invertY: options.invertY !== false,
          samplingMode: options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: options.useSRGBBuffer ?? false,
        });
    entry.texture = texture;
    entry.samplingKey = key;
    return texture;
  }

  /**
   * Six-face cubemap (`px, py, pz, nx, ny, nz`) for skyboxes. IBL still uses
   * `getTexture(..., { isCube: true })` with a single DDS/ENV URL.
   */
  getCubeTextureFromImages(
    assetGuid: string,
    scene: Scene,
    files: string[],
    noMipmap = false,
  ): CubeTexture {
    const key = ["cube6", noMipmap ? "1" : "0", ...files].join(":");
    const existing = this.entries.get(assetGuid);
    if (existing?.texture && existing.samplingKey === key) {
      if (!isDisposedGpuTexture(existing.texture)) {
        existing.refCount += 1;
        existing.lastUsed = ++this.clock;
        return existing.texture as CubeTexture;
      }
      existing.texture = undefined;
    }
    if (existing?.texture) {
      existing.texture.dispose();
      existing.texture = undefined;
    }
    const texture = createEngineCubeTextureFromImages(
      scene.getEngine(),
      files,
      noMipmap,
    );
    if (existing) {
      existing.texture = texture;
      existing.samplingKey = key;
      existing.refCount += 1;
      existing.lastUsed = ++this.clock;
      return texture;
    }
    this.entries.set(assetGuid, {
      assetGuid,
      blobUrl: "",
      bytes: 0,
      refCount: 1,
      lastUsed: ++this.clock,
      samplingKey: key,
      texture,
    });
    return texture;
  }

  /**
   * Drop GPU Texture wrappers but keep blob URLs so the next `getTexture`
   * rebuilds. Used after WebGL context restore.
   */
  releaseGpuTextures(): void {
    for (const entry of this.entries.values()) {
      if (!entry.texture) continue;
      entry.texture.dispose();
      entry.texture = undefined;
    }
  }

  account(
    assetGuid: string,
    bytes: number,
    format: TextureFormat = "rgba8",
  ): void {
    void format;
    const entry = this.entries.get(assetGuid);
    if (!entry) {
      this.entries.set(assetGuid, {
        assetGuid,
        blobUrl: "",
        bytes,
        refCount: 1,
        lastUsed: ++this.clock,
        samplingKey: samplingKey(),
      });
      this.totalBytes += bytes;
      this.evictToCeiling();
      return;
    }
    this.totalBytes -= entry.bytes;
    entry.bytes = bytes;
    this.totalBytes += bytes;
    entry.lastUsed = ++this.clock;
    this.evictToCeiling();
  }

  accountTextureSize(
    assetGuid: string,
    width: number,
    height: number,
    format: TextureFormat,
    withMips: boolean,
  ): void {
    this.account(assetGuid, accountedTextureBytes(width, height, format, withMips));
  }

  retain(assetGuid: string): void {
    const entry = this.entries.get(assetGuid);
    if (entry) {
      entry.refCount += 1;
      entry.lastUsed = ++this.clock;
    }
  }

  release(assetGuid: string): void {
    const entry = this.entries.get(assetGuid);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
  }

  accountedBytes(): number {
    return this.totalBytes;
  }

  evictToCeiling(): void {
    const limit = this.ceiling * this.evictionFactor;
    if (this.totalBytes <= limit) return;
    const candidates = [...this.entries.values()]
      .filter((e) => e.refCount === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (this.totalBytes <= this.ceiling) break;
      this.evictEntry(entry.assetGuid, "lru");
    }
  }

  flushUnreferenced(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.refCount === 0) {
        this.evictEntry(entry.assetGuid, "flush");
      }
    }
  }

  private evictEntry(assetGuid: string, reason: string): void {
    const entry = this.entries.get(assetGuid);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(assetGuid);
    this.blobs.delete(assetGuid);
    entry.texture?.dispose();
    if (entry.blobUrl.startsWith("blob:") && typeof URL !== "undefined") {
      try {
        URL.revokeObjectURL(entry.blobUrl);
      } catch {
        // ignore
      }
    }
    console.info(`[resource-cache] evict ${assetGuid} (${reason})`);
    this.onEvict?.(assetGuid, reason);
  }

  dispose(): void {
    for (const guid of [...this.entries.keys()]) {
      this.evictEntry(guid, "dispose");
    }
  }
}

const HANDLE_RETAIN_METHODS = new Set([
  "getTexture",
  "getCubeTextureFromImages",
  "blobUrlFor",
  "retain",
]);

/**
 * Per-handle view of an Engine-keyed {@link ResourceCache}. Retains from this
 * handle are released on `releaseHandleRetains` so closing a Scene can drop
 * GPU wrappers without disposing the project Engine.
 */
export function bindResourceCacheToHandle(inner: ResourceCache): {
  cache: ResourceCache;
  releaseHandleRetains: () => void;
} {
  const retains = new Map<string, number>();
  const note = (assetGuid: string) => {
    retains.set(assetGuid, (retains.get(assetGuid) ?? 0) + 1);
  };
  const cache = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "dispose") {
        return () => undefined;
      }
      if (typeof prop === "string" && HANDLE_RETAIN_METHODS.has(prop)) {
        return (assetGuid: string, ...rest: unknown[]) => {
          note(assetGuid);
          return (target[prop as keyof ResourceCache] as (...args: unknown[]) => unknown)(
            assetGuid,
            ...rest,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return {
    cache,
    releaseHandleRetains() {
      for (const [assetGuid, count] of retains) {
        for (let i = 0; i < count; i += 1) inner.release(assetGuid);
      }
      retains.clear();
      inner.flushUnreferenced();
    },
  };
}

/** glTF / NodeMaterial albedo: do not invert Y (Babylon glTF loader convention). */
export const MATERIAL_TEXTURE_SAMPLING: TextureSamplingOptions = {
  invertY: false,
};

export function getMaterialTexture(
  cache: ResourceCache,
  assetGuid: string,
  engine: AbstractEngine,
  bytes: Uint8Array | Blob,
): Texture | null {
  const texture = cache.getTexture(
    assetGuid,
    engine,
    bytes,
    MATERIAL_TEXTURE_SAMPLING,
  );
  if (!texture || texture.isCube) return null;
  return texture as Texture;
}
