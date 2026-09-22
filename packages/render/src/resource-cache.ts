import { copyTextureBytesForUpload, environmentTextureContainer, readEnvironmentTextureInfo, isKtx2Bytes, sniffImageSize, sniffKtx2Size } from "@babylonslate/assets";
import type { AbstractEngine, BaseTexture, Scene } from "@babylonjs/core";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import {
  TEXTURE_BYTE_CEILING,
  TEXTURE_EVICTION_TARGET_FACTOR,
} from "./perf-ceilings";
import { accountedTextureBytes, type TextureFormat } from "./texture-bytes";
import { uploadedTextureBytes } from "./uploaded-texture-bytes";

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
  hasAlpha?: boolean;
}

interface CacheEntry {
  assetGuid: string;
  key: string;
  blobUrl: string;
  extraBlobUrls: string[];
  bytes: number;
  refCount: number;
  lastUsed: number;
  contentKey: string;
  textures: Map<string, BaseTexture>;
  samplingBytes?: Map<string, number>;
  samplingDisposers?: Map<string, () => void>;
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

import { assetByteFingerprint as contentKey } from "./asset-byte-fingerprint";

function asUint8Array(bytes: Uint8Array | Blob): Uint8Array | null {
  return bytes instanceof Uint8Array ? bytes : null;
}

interface TextureSourceSize {
  width: number;
  height: number;
  ktx2MipLevels?: number;
  mipLevels?: number;
  reserveType?: number;
}

function textureSourceSize(bytes: Uint8Array): TextureSourceSize | null {
  if (environmentTextureContainer(bytes)) {
    // Full source validation belongs to import. A bounded Blob header may omit
    // the face data; wait for its real upload instead of accepting partial data.
    try {
      const info = readEnvironmentTextureInfo(bytes);
      return { width: info.width, height: info.height, mipLevels: info.mipLevels,
        reserveType: info.encoding === "linearFloat32" ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_HALF_FLOAT };
    } catch { return null; }
  }
  const ktx2 = sniffKtx2Size(bytes);
  if (ktx2 && bytes.byteLength >= 44) {
    // KTX2 levelCount follows faceCount at byte 40. Zero denotes a base level.
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { ...ktx2, ktx2MipLevels: Math.max(1, header.getUint32(40, true)) };
  }
  return ktx2 ?? sniffImageSize(bytes);
}

function environmentContainer(bytes: Uint8Array | Blob): "env" | "dds" | null {
  if (bytes instanceof Uint8Array) return environmentTextureContainer(bytes);
  if (bytes.type === "application/vnd.babylon.env") return "env";
  if (bytes.type === "image/vnd-ms.dds") return "dds";
  return null;
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
    options.hasAlpha ? "1" : "0",
  ].join(":");
}

/** KTX2 still needs `#.ktx2`. Never add `#nomip` / `#ninv` — that breaks blob upload. */
function ktx2LoaderUrl(blobUrl: string, bytes: Uint8Array | Blob): string {
  return ktx2LoaderHints(bytes).forcedExtension ? `${blobUrl}#.ktx2` : blobUrl;
}

function revokeBlobUrl(url: string): void {
  if (!url.startsWith("blob:") || typeof URL === "undefined") return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

function revokeExtraBlobUrls(entry: CacheEntry): void {
  for (const extra of entry.extraBlobUrls) {
    revokeBlobUrl(extra);
  }
  entry.extraBlobUrls.length = 0;
}

function revokeEntryBlobUrls(entry: CacheEntry): void {
  revokeBlobUrl(entry.blobUrl);
  revokeExtraBlobUrls(entry);
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
  for (const cancel of entry.samplingDisposers?.values() ?? []) cancel();
  entry.samplingDisposers?.clear();
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
  private readonly clientBudgets = new Map<object, { bytes?: number; enabled?: boolean }>();
  private evictionTargetFactor: number;
  private budgetEnabled: boolean;
  private readonly onEvict?: (assetGuid: string, reason: string) => void;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly blobs = new Map<string, Blob>();
  private readonly textureKeys = new WeakMap<BaseTexture, string>();
  private readonly urlKeys = new Map<string, string>();
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

  /** A lease owns one exact generation. Reading its resource never acquires again. */
  acquireTexture(assetGuid: string, engine: AbstractEngine, bytes: Uint8Array | Blob,
    options: TextureSamplingOptions = {}): ResourceLease<Texture | CubeTexture> {
    return this.lease(this.prepareTexture(assetGuid, engine, bytes, options));
  }

  acquireBlobUrl(assetGuid: string, bytes: Uint8Array | Blob): ResourceLease<string> {
    return this.lease(this.prepareBlobUrl(assetGuid, bytes));
  }

  acquireCubeTextureFromImages(assetGuid: string, scene: Scene, files: string[], noMipmap = false): ResourceLease<CubeTexture> {
    return this.lease(this.prepareCubeTextureFromImages(assetGuid, scene, files, noMipmap));
  }

  /** Independent preparation ownership of an already leased resource. */
  acquireExisting<T extends BaseTexture | string>(resource: T): ResourceLease<T> {
    this.retain(resource);
    return this.lease(resource);
  }

  private lease<T extends BaseTexture | string>(resource: T): ResourceLease<T> {
    const key = this.resourceKey(resource);
    let released = false;
    return { resource, key, release: () => {
      if (released) return;
      released = true;
      this.release(key);
    } };
  }

  setByteCeiling(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.ceiling = bytes;
    this.evictToCeiling();
  }

  /** Largest live view cap wins; null releases that view's complete budget policy. */
  setClientBudget(client: object, bytes: number | null): void {
    if (bytes === null) this.clientBudgets.delete(client);
    else if (Number.isFinite(bytes) && bytes > 0) {
      this.clientBudgets.set(client, { ...this.clientBudgets.get(client), bytes });
    }
    this.evictToCeiling();
  }

  /** Any live view that disables budgeting keeps shared eviction disabled. */
  setClientBudgetEnabled(client: object, enabled: boolean): void {
    this.clientBudgets.set(client, { ...this.clientBudgets.get(client), enabled });
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
    if (anyLiveTexture(entry)) return entry.refCount === 0;
    if (this.clientTextures.size === 0) return entry.refCount === 0;
    for (const guids of this.clientTextures.values()) {
      if (guids.has(entry.assetGuid)) return false;
    }
    return true;
  }

  private prepareBlobUrl(assetGuid: string, bytes: Uint8Array | Blob): string {
    const nextKey = contentKey(bytes);
    const key = `${assetGuid}\0${nextKey}`;
    const existing = this.entries.get(key);
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
            {
              type: isKtx2Bytes(bytes)
                ? "image/ktx2"
                : "application/octet-stream",
            },
          );
    this.blobs.set(key, blob);
    const url =
      typeof URL !== "undefined" && URL.createObjectURL
        ? URL.createObjectURL(blob)
        : `blob:babylonslate/${assetGuid}`;
    const entry: CacheEntry = {
      assetGuid,
      key,
      blobUrl: url,
      extraBlobUrls: [],
      bytes: 0,
      refCount: 1,
      lastUsed: ++this.clock,
      contentKey: nextKey,
      textures: new Map(),
    };
    this.entries.set(key, entry);
    this.urlKeys.set(url, key);
    return url;
  }

  /**
   * Resolve a Texture for an asset guid through the cache so editor and Play
   * share InternalTextures per sampling key. Extra sampling keys get another
   * `createObjectURL` of the same Blob (never a `#nomip` / `#ninv` fragment).
   */
  private prepareTexture(
    assetGuid: string,
    engine: AbstractEngine,
    bytes: Uint8Array | Blob,
    options: TextureSamplingOptions = {},
  ): Texture | CubeTexture {
    const environment = environmentContainer(bytes);
    if (options.isCube && bytes instanceof Blob && !environment) throw new Error("Environment Blob inputs require application/vnd.babylon.env or image/vnd-ms.dds MIME; use Uint8Array to detect the container from its bytes.");
    if (environment && !options.isCube) throw new Error("Environment cube textures cannot be used as 2D textures.");
    if (environment && bytes instanceof Uint8Array) readEnvironmentTextureInfo(bytes);
    const key = samplingKey(options);
    const variantKey = `${assetGuid}\0${contentKey(bytes)}`;
    const existing = this.entries.get(variantKey);
    const reused = existing ? liveTexture(existing, key) : undefined;
    if (reused) {
      existing!.refCount += 1;
      existing!.lastUsed = ++this.clock;
      return reused as Texture | CubeTexture;
    }
    this.prepareBlobUrl(assetGuid, bytes);
    const entry = this.entries.get(variantKey)!;
    const blobUrl = this.blobUrlForSamplingKey(entry);
    const ktx2 = ktx2LoaderHints(bytes);
    const raw = asUint8Array(bytes);
    const loaderUrl = ktx2LoaderUrl(blobUrl, bytes);
    const texture = options.isCube
      ? new CubeTexture(blobUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          useSRGBBuffer: environment ? false : options.useSRGBBuffer ?? false,
          forcedExtension: environment ? `.${environment}` : undefined,
          prefiltered: !!environment,
          createPolynomials: !!environment,
        })
      : new Texture(loaderUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          invertY: options.invertY !== false,
          samplingMode: options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: options.useSRGBBuffer ?? false,
          mimeType: ktx2.mimeType,
          forcedExtension: ktx2.forcedExtension,
          buffer: raw ? copyTextureBytesForUpload(raw) : undefined,
        });
    texture.hasAlpha = options.hasAlpha === true;
    entry.textures.set(key, texture);
    this.textureKeys.set(texture, variantKey);
    this.trackTextureBytes(entry, key, texture, bytes, options.noMipmap !== true);
    return texture;
  }

  /** First wrapper uses the canonical blob URL; later keys get a new object URL. */
  private blobUrlForSamplingKey(entry: CacheEntry): string {
    let live = 0;
    for (const texture of entry.textures.values()) {
      if (!isDisposedGpuTexture(texture)) live += 1;
    }
    if (live === 0) return entry.blobUrl;
    const blob = this.blobs.get(entry.key);
    if (!blob || typeof URL === "undefined" || !URL.createObjectURL) {
      return entry.blobUrl;
    }
    const extra = URL.createObjectURL(blob);
    entry.extraBlobUrls.push(extra);
    return extra;
  }

  /**
   * Six-face cubemap (`px, py, pz, nx, ny, nz`) for skyboxes. IBL still uses
   * `getTexture(..., { isCube: true })` with a single DDS/ENV URL.
   */
  private prepareCubeTextureFromImages(
    assetGuid: string,
    scene: Scene,
    files: string[],
    noMipmap = false,
  ): CubeTexture {
    const key = ["cube6", noMipmap ? "1" : "0", ...files].join(":");
    const variantKey = `${assetGuid}\0${key}`;
    const existing = this.entries.get(variantKey);
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
    this.textureKeys.set(texture, variantKey);
    if (existing) {
      existing.textures.set(key, texture);
      existing.refCount += 1;
      existing.lastUsed = ++this.clock;
      this.trackTextureBytes(existing, key, texture, undefined, !noMipmap);
      return texture;
    }
    const entry: CacheEntry = {
      assetGuid,
      key: variantKey,
      blobUrl: "",
      extraBlobUrls: [],
      bytes: 0,
      refCount: 1,
      lastUsed: ++this.clock,
      contentKey: files.join(":"),
      textures: new Map([[key, texture]]),
    };
    this.entries.set(variantKey, entry);
    this.trackTextureBytes(entry, key, texture, undefined, !noMipmap);
    return texture;
  }

  /**
   * Drop GPU Texture wrappers but keep blob URLs so the next `getTexture`
   * rebuilds. Used after WebGL context restore.
   */
  releaseGpuTextures(): void {
    for (const entry of this.entries.values()) {
      disposeEntryTextures(entry);
      entry.samplingBytes?.clear();
      this.totalBytes -= entry.bytes;
      entry.bytes = 0;
      revokeExtraBlobUrls(entry);
    }
  }

  account(
    assetGuid: string,
    bytes: number,
    format: TextureFormat = "rgba8",
  ): void {
    void format;
    const entry = this.entries.get(this.resourceKey(assetGuid));
    if (!entry) {
      this.entries.set(assetGuid, {
        assetGuid,
        key: assetGuid,
        blobUrl: "",
        extraBlobUrls: [],
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

  /** Resolve the exact acquired generation, including after a context restore. */
  resourceKey(resource: string | BaseTexture): string {
    if (typeof resource !== "string") return this.textureKeys.get(resource) ?? "";
    if (this.entries.has(resource)) return resource;
    const urlKey = this.urlKeys.get(resource);
    if (urlKey) return urlKey;
    const matches = [...this.entries.values()].filter((entry) => entry.assetGuid === resource);
    if (matches.length > 1) throw new Error("Release a texture or blob URL, not an ambiguous asset GUID");
    return matches[0]?.key ?? resource;
  }

  private retain(resource: string | BaseTexture): void {
    const entry = this.entries.get(this.resourceKey(resource));
    if (entry) {
      entry.refCount += 1;
      entry.lastUsed = ++this.clock;
    }
  }

  private release(resource: string | BaseTexture): void {
    const entry = this.entries.get(this.resourceKey(resource));
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
  }

  releaseAccounting(key: string): void { this.release(key); }

  accountedBytes(): number {
    return this.totalBytes;
  }

  evictToCeiling(): void {
    const policies = [...this.clientBudgets.values()];
    const flags = policies.flatMap((policy) => policy.enabled === undefined ? [] : [policy.enabled]);
    if (flags.length ? flags.includes(false) : !this.budgetEnabled) return;
    const caps = policies.flatMap((policy) => policy.bytes === undefined ? [] : [policy.bytes]);
    const ceiling = caps.length ? Math.max(...caps) : this.ceiling;
    if (this.totalBytes <= ceiling) return;
    const target = ceiling * this.evictionTargetFactor;
    const candidates = [...this.entries.values()]
      .filter((e) => this.isUnreferenced(e))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (this.totalBytes <= target) break;
      this.evictEntry(entry.key, "lru");
    }
  }

  private trackTextureBytes(
    entry: CacheEntry,
    sampling: string,
    texture: Texture | CubeTexture,
    bytes: Uint8Array | Blob | undefined,
    withMips: boolean,
  ): void {
    entry.samplingDisposers ??= new Map();
    entry.samplingDisposers.get(sampling)?.();
    let active = true;
    let headerPending = bytes instanceof Blob;
    let size = bytes instanceof Uint8Array ? textureSourceSize(bytes) : null;
    const current = () => active && this.entries.get(entry.key) === entry && entry.textures.get(sampling) === texture;
    const update = () => {
      if (!current() || headerPending || isDisposedGpuTexture(texture)) return;
      const internal = texture.getInternalTexture();
      // Babylon 9.20's RGBA KTX2 uploader leaves internal width/height at the
      // final mip. Header base dimensions and levelCount describe its uploads.
      const uploaded = uploadedTextureBytes(internal, size?.ktx2MipLevels ?? size?.mipLevels, size?.ktx2MipLevels !== undefined ? size : undefined);
      const estimate = uploaded ?? (size ? uploadedTextureBytes({
        isReady: true, width: size.width, height: size.height, depth: 1,
        isCube: texture.isCube, is3D: false, is2DArray: false,
        format: Constants.TEXTUREFORMAT_RGBA, type: size.reserveType ?? Constants.TEXTURETYPE_UNSIGNED_BYTE,
        generateMipMaps: withMips,
      }, size.ktx2MipLevels ?? size.mipLevels) : null);
      if (estimate !== null) this.setSamplingBytes(entry, sampling, estimate);
    };
    // Texture and CubeTexture declare distinct generic Observable overloads.
    const load = texture instanceof CubeTexture
      ? texture.onLoadObservable.add(update)
      : texture.onLoadObservable.add(update);
    const disposed = texture.onDisposeObservable.add(() => {
      if (!current()) return;
      cancel();
      entry.samplingDisposers!.delete(sampling);
      entry.textures.delete(sampling);
      this.setSamplingBytes(entry, sampling, 0);
    });
    const cancel = () => {
      active = false;
      // Babylon iterates the live observer array. Defer removal so disposing
      // inside our observer cannot skip a later owner's cleanup callback.
      load?.remove(true);
      disposed?.remove(true);
    };
    entry.samplingDisposers.set(sampling, cancel);
    update();
    if (bytes instanceof Blob) {
      // Bound temporary header storage; unusual raster headers can still be
      // measured from the real upload when their dimensions are unavailable.
      void bytes.slice(0, 64 * 1024).arrayBuffer().then((header) => {
        if (!current()) return;
        size = textureSourceSize(new Uint8Array(header));
        headerPending = false;
        update();
      }, () => {
        if (!current()) return;
        headerPending = false;
        update();
      });
    }
  }

  private setSamplingBytes(entry: CacheEntry, sampling: string, bytes: number): void {
    if (this.entries.get(entry.key) !== entry) return;
    entry.samplingBytes ??= new Map();
    if (entry.samplingBytes.get(sampling) === bytes) return;
    entry.samplingBytes.set(sampling, bytes);
    this.account(entry.key, [...entry.samplingBytes.values()].reduce((total, value) => total + value, 0));
  }

  flushUnreferenced(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.isUnreferenced(entry)) {
        this.evictEntry(entry.key, "flush");
      }
    }
  }

  private evictEntry(assetGuid: string, reason: string): void {
    const entry = this.entries.get(this.resourceKey(assetGuid));
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(assetGuid);
    this.blobs.delete(assetGuid);
    this.urlKeys.delete(entry.blobUrl);
    disposeEntryTextures(entry);
    revokeEntryBlobUrls(entry);
    console.info(`[resource-cache] evict ${assetGuid} (${reason})`);
    this.onEvict?.(entry.assetGuid, reason);
  }

  dispose(): void {
    for (const guid of [...this.entries.keys()]) {
      this.evictEntry(guid, "dispose");
    }
  }
}

/** Exact resource ownership. release() is idempotent, including after cache disposal. */
export interface ResourceLease<T> {
  readonly resource: T;
  readonly key: string;
  release(): void;
}

export type TextureResources = Pick<ResourceCache, keyof ResourceCache>;

/** A view retains only its currently outstanding leases, never acquisition history. */
export class ResourceCacheOwner implements TextureResources {
  private readonly leases = new Set<ResourceLease<unknown>>();
  private disposed = false;
  constructor(private readonly inner: ResourceCache) {}
  private own<T>(lease: ResourceLease<T>): ResourceLease<T> {
    if (this.disposed) { lease.release(); throw new Error("Texture owner is retired"); }
    const owned = { resource: lease.resource, key: lease.key, release: () => {
      if (!this.leases.delete(owned)) return;
      lease.release();
    } };
    this.leases.add(owned);
    return owned;
  }
  acquireTexture(...args: Parameters<ResourceCache["acquireTexture"]>) { return this.own(this.inner.acquireTexture(...args)); }
  acquireBlobUrl(...args: Parameters<ResourceCache["acquireBlobUrl"]>) { return this.own(this.inner.acquireBlobUrl(...args)); }
  acquireCubeTextureFromImages(...args: Parameters<ResourceCache["acquireCubeTextureFromImages"]>) { return this.own(this.inner.acquireCubeTextureFromImages(...args)); }
  acquireExisting<T extends BaseTexture | string>(resource: T) { return this.own(this.inner.acquireExisting(resource)); }
  resourceKey(resource: string | BaseTexture) { return this.inner.resourceKey(resource); }
  setByteCeiling(bytes: number) { this.inner.setClientBudget(this, bytes); }
  setBudgetEnabled(enabled: boolean) { this.inner.setClientBudgetEnabled(this, enabled); }
  setClientBudget(...args: Parameters<ResourceCache["setClientBudget"]>) { this.inner.setClientBudget(...args); }
  setClientBudgetEnabled(...args: Parameters<ResourceCache["setClientBudgetEnabled"]>) { this.inner.setClientBudgetEnabled(...args); }
  setClientTextures(...args: Parameters<ResourceCache["setClientTextures"]>) { this.inner.setClientTextures(...args); }
  clearClientTextures(clientId: string) { this.inner.clearClientTextures(clientId); }
  account(...args: Parameters<ResourceCache["account"]>) { this.inner.account(...args); }
  accountTextureSize(...args: Parameters<ResourceCache["accountTextureSize"]>) { this.inner.accountTextureSize(...args); }
  releaseAccounting(key: string) { this.inner.releaseAccounting(key); }
  accountedBytes() { return this.inner.accountedBytes(); }
  evictToCeiling() { this.inner.evictToCeiling(); }
  flushUnreferenced() { this.inner.flushUnreferenced(); }
  releaseGpuTextures() { this.inner.releaseGpuTextures(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const lease of [...this.leases]) lease.release();
    this.inner.setClientBudget(this, null);
    this.inner.flushUnreferenced();
  }
}

export function bindResourceCacheToHandle(inner: ResourceCache): {
  cache: ResourceCacheOwner;
  releaseHandleRetains: () => void;
} {
  const cache = new ResourceCacheOwner(inner);
  return { cache, releaseHandleRetains: () => cache.dispose() };
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

export function acquireMaterialTexture(
  cache: TextureResources,
  assetGuid: string,
  engine: AbstractEngine,
  bytes: Uint8Array | Blob,
): ResourceLease<Texture> | null {
  if (environmentContainer(bytes)) return null;
  const lease = cache.acquireTexture(
    assetGuid,
    engine,
    bytes,
    MATERIAL_TEXTURE_SAMPLING,
  );
  if (lease.resource.isCube) { lease.release(); return null; }
  return lease as ResourceLease<Texture>;
}

/** One material generation owns its sampled textures; compiler callbacks only borrow. */
export function materialTextureBindings(acquire: ((guid: string) => ResourceLease<Texture> | null) | undefined) {
  const leases = new Map<string, ResourceLease<Texture>>();
  return {
    resolve(guid: string): Texture | null {
      const current = leases.get(guid);
      if (current && !isDisposedGpuTexture(current.resource)) return current.resource;
      const next = acquire?.(guid);
      if (!next) return null;
      leases.set(guid, next);
      current?.release();
      return next.resource;
    },
    prune(textures: readonly BaseTexture[]) {
      const used = new Set(textures);
      for (const [guid, lease] of leases) if (!used.has(lease.resource)) { leases.delete(guid); lease.release(); }
    },
    dispose() { for (const lease of leases.values()) lease.release(); leases.clear(); },
  };
}
