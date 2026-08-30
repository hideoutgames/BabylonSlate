import { isKtx2Bytes, sniffImageSize, sniffKtx2Size } from "@babylonslate/assets";
import type { AbstractEngine, BaseTexture, Scene } from "@babylonjs/core";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import {
  TEXTURE_BYTE_CEILING,
  TEXTURE_EVICTION_TARGET_FACTOR,
} from "./perf-ceilings";
import { accountedTextureBytes, type TextureFormat } from "./texture-bytes";

export interface ResourceCacheOptions {
  /** Accounted byte ceiling before evicting unreferenced LRU entries. */
  byteCeiling?: number;
  /** Trim unreferenced entries toward this fraction of the ceiling (default 0.8). */
  evictionTargetFactor?: number;
  /** When false, skip LRU eviction. */
  budgetEnabled?: boolean;
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
  contentKey: string;
  textures: Map<string, BaseTexture>;
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

function contentKey(bytes: Uint8Array | Blob): string {
  if (bytes instanceof Blob) return `blob:${bytes.size}`;
  const length = bytes.byteLength;
  return `${length}:${bytes[0] ?? 0}:${bytes[Math.floor(length / 2)] ?? 0}:${bytes[length - 1] ?? 0}`;
}

function asUint8Array(bytes: Uint8Array | Blob): Uint8Array | null {
  return bytes instanceof Uint8Array ? bytes : null;
}

function ktx2LoaderHints(bytes: Uint8Array | Blob): {
  mimeType?: string;
  forcedExtension?: string;
} {
  const isKtx2 =
    bytes instanceof Blob
      ? bytes.type === "image/ktx2"
      : isKtx2Bytes(bytes);
  if (!isKtx2) return {};
  return { mimeType: "image/ktx2", forcedExtension: ".ktx2" };
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

/** Unique InternalTexture URL fragment. Never put colons in the hash (that broke blob upload). */
function textureLoaderUrl(
  blobUrl: string,
  bytes: Uint8Array | Blob,
  options: TextureSamplingOptions,
): string {
  const ktx2 = ktx2LoaderHints(bytes);
  const parts: string[] = [];
  if (options.noMipmap) parts.push("nomip");
  if (options.invertY === false) parts.push("ninv");
  if (ktx2.forcedExtension) {
    return parts.length > 0
      ? `${blobUrl}#${parts.join(".")}.ktx2`
      : `${blobUrl}#.ktx2`;
  }
  return parts.length > 0 ? `${blobUrl}#${parts.join(".")}` : blobUrl;
}

function liveTexture(
  entry: CacheEntry,
  key: string,
): BaseTexture | undefined {
  const texture = entry.textures.get(key);
  if (!texture) return undefined;
  if (!isDisposedGpuTexture(texture)) return texture;
  entry.textures.delete(key);
  return undefined;
}

function anyLiveTexture(entry: CacheEntry): BaseTexture | undefined {
  for (const [key, texture] of entry.textures) {
    if (!isDisposedGpuTexture(texture)) return texture;
    entry.textures.delete(key);
  }
  return undefined;
}

function disposeEntryTextures(entry: CacheEntry): void {
  for (const texture of entry.textures.values()) {
    texture.dispose();
  }
  entry.textures.clear();
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
  private ceiling: number;
  private evictionTargetFactor: number;
  private budgetEnabled: boolean;
  private readonly onEvict?: (assetGuid: string, reason: string) => void;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly blobs = new Map<string, Blob>();
  private readonly clientTextures = new Map<string, Set<string>>();
  private clock = 0;
  private totalBytes = 0;

  constructor(options: ResourceCacheOptions = {}) {
    this.ceiling = options.byteCeiling ?? TEXTURE_BYTE_CEILING;
    this.evictionTargetFactor =
      options.evictionTargetFactor ?? TEXTURE_EVICTION_TARGET_FACTOR;
    this.budgetEnabled = options.budgetEnabled !== false;
    this.onEvict = options.onEvict;
  }

  setByteCeiling(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.ceiling = bytes;
    this.evictToCeiling();
  }

  setBudgetEnabled(enabled: boolean): void {
    this.budgetEnabled = enabled;
    if (enabled) this.evictToCeiling();
  }

  /**
   * Pin GPU textures still referenced by one EngineHandle (viewport, Play,
   * Prefab). Union across clients so a shared cache does not evict a guid
   * another view still holds. Live GPU wrappers with `refCount > 0` (skybox
   * cubes, handle retains) stay referenced even when they are not in the pin
   * set. Accounted entries with no wrapper still follow pins-only. When no
   * client has registered, eviction uses `refCount` (tests and thumbnail paths).
   */
  setClientTextures(clientId: string, guids: Iterable<string>): void {
    this.clientTextures.set(clientId, new Set(guids));
    this.evictToCeiling();
  }

  clearClientTextures(clientId: string): void {
    if (!this.clientTextures.delete(clientId)) return;
    this.evictToCeiling();
  }

  private isUnreferenced(entry: CacheEntry): boolean {
    if (anyLiveTexture(entry) && entry.refCount > 0) return false;
    if (this.clientTextures.size === 0) return entry.refCount === 0;
    for (const guids of this.clientTextures.values()) {
      if (guids.has(entry.assetGuid)) return false;
    }
    return true;
  }

  blobUrlFor(assetGuid: string, bytes: Uint8Array | Blob): string {
    const nextKey = contentKey(bytes);
    const existing = this.entries.get(assetGuid);
    if (existing) {
      if (existing.contentKey === nextKey) {
        existing.refCount += 1;
        existing.lastUsed = ++this.clock;
        return existing.blobUrl;
      }
      disposeEntryTextures(existing);
      if (existing.blobUrl.startsWith("blob:") && typeof URL !== "undefined") {
        try {
          URL.revokeObjectURL(existing.blobUrl);
        } catch {
          // ignore
        }
      }
      this.totalBytes -= existing.bytes;
      existing.bytes = 0;
      this.entries.delete(assetGuid);
      this.blobs.delete(assetGuid);
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
            {
              type: isKtx2Bytes(bytes)
                ? "image/ktx2"
                : "application/octet-stream",
            },
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
      contentKey: nextKey,
      textures: new Map(),
    };
    this.entries.set(assetGuid, entry);
    return url;
  }

  /**
   * Resolve a Texture for an asset guid through the cache so editor and Play
   * share InternalTextures per sampling key (stable blob URL + a safe
   * `#nomip` / `#ninv` fragment). First-wins applies only within one key so
   * sprite/tilemap NEAREST does not steal a mipped 3D albedo (or invertY).
   */
  getTexture(
    assetGuid: string,
    engine: AbstractEngine,
    bytes: Uint8Array | Blob,
    options: TextureSamplingOptions = {},
  ): Texture | CubeTexture {
    const key = samplingKey(options);
    const existing = this.entries.get(assetGuid);
    const reused = existing ? liveTexture(existing, key) : undefined;
    if (reused) {
      existing!.refCount += 1;
      existing!.lastUsed = ++this.clock;
      return reused as Texture | CubeTexture;
    }
    const url = this.blobUrlFor(assetGuid, bytes);
    const entry = this.entries.get(assetGuid)!;
    const ktx2 = ktx2LoaderHints(bytes);
    const raw = asUint8Array(bytes);
    const loaderUrl = textureLoaderUrl(url, bytes, options);
    const texture = options.isCube
      ? new CubeTexture(url, engine, {
          noMipmap: options.noMipmap ?? false,
          useSRGBBuffer: options.useSRGBBuffer ?? false,
        })
      : new Texture(loaderUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          invertY: options.invertY !== false,
          samplingMode: options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: options.useSRGBBuffer ?? false,
          mimeType: ktx2.mimeType,
          forcedExtension: ktx2.forcedExtension,
          buffer: raw ? raw.slice() : undefined,
        });
    entry.textures.set(key, texture);
    this.accountLoadedBytes(assetGuid, bytes, options.noMipmap !== true);
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
    const reused = existing ? anyLiveTexture(existing) : undefined;
    if (reused) {
      existing!.refCount += 1;
      existing!.lastUsed = ++this.clock;
      return reused as CubeTexture;
    }
    const texture = createEngineCubeTextureFromImages(
      scene.getEngine(),
      files,
      noMipmap,
    );
    if (existing) {
      existing.textures.set(key, texture);
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
      contentKey: files.join(":"),
      textures: new Map([[key, texture]]),
    });
    return texture;
  }

  /**
   * Drop GPU Texture wrappers but keep blob URLs so the next `getTexture`
   * rebuilds. Used after WebGL context restore.
   */
  releaseGpuTextures(): void {
    for (const entry of this.entries.values()) {
      disposeEntryTextures(entry);
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
        contentKey: "",
        textures: new Map(),
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
    if (!this.budgetEnabled) return;
    if (this.totalBytes <= this.ceiling) return;
    const target = this.ceiling * this.evictionTargetFactor;
    const candidates = [...this.entries.values()]
      .filter((e) => this.isUnreferenced(e))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (this.totalBytes <= target) break;
      this.evictEntry(entry.assetGuid, "lru");
    }
  }

  private accountLoadedBytes(
    assetGuid: string,
    bytes: Uint8Array | Blob,
    withMips: boolean,
  ): void {
    const raw = asUint8Array(bytes);
    if (!raw) return;
    const ktx2 = sniffKtx2Size(raw);
    if (ktx2) {
      this.accountTextureSize(
        assetGuid,
        ktx2.width,
        ktx2.height,
        "astc4x4",
        withMips,
      );
      return;
    }
    const image = sniffImageSize(raw);
    if (image) {
      this.accountTextureSize(
        assetGuid,
        image.width,
        image.height,
        "rgba8",
        withMips,
      );
    }
  }

  flushUnreferenced(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.isUnreferenced(entry)) {
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
    disposeEntryTextures(entry);
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

/** Sprite / tilemap albedo: nearest, no mips, invertY (Babylon 2D). */
export const PIXEL_ART_TEXTURE_SAMPLING: TextureSamplingOptions = {
  noMipmap: true,
  samplingMode: Texture.NEAREST_SAMPLINGMODE,
};

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
