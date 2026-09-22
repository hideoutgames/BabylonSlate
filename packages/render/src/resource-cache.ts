import { installedAssetHeader, installedEnvironmentInfo, copyTextureBytesForUpload, environmentTextureContainer, readEnvironmentTextureInfo, isKtx2Bytes, sniffImageSize, sniffKtx2Size } from "@babylonslate/assets";
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
  anisotropicFilteringLevel?: number;
}

interface CacheEntry {
  assetGuid: string;
  key: string;
  blobUrl: string;
  extraBlobUrls: string[];
  uploadUrls?: Map<string, string>;
  textureUploads?: Map<string, string>;
  bytes: number;
  refCount: number;
  pending?: number;
  preparations?: Set<(reason: string) => void>;
  lastUsed: number;
  contentKey: string;
  textures: Map<string, BaseTexture>;
  samplingBytes?: Map<string, number>;
  samplingDisposers?: Map<string, () => void>;
}

// Match the existing owner-scoped readiness deadline; no upload may pin forever.
const TEXTURE_PREPARATION_TIMEOUT_MS = 30_000;

/**
 * Six-face cubemap bound to the Engine, not a Scene. Scene.dispose must not
 * drop a ResourceCache-owned cube (Play overlay shares the editor Engine).
 */
export function createEngineCubeTextureFromImages(
  engine: AbstractEngine,
  files: string[],
  noMipmap = false,
  completion?: { onLoad: () => void; onError: (message?: string) => void },
): CubeTexture {
  return new CubeTexture(files.join(""), engine, { files, noMipmap, ...completion });
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

function uploadSamplingKey(options: TextureSamplingOptions = {}): string {
  return [
    options.noMipmap ? "1" : "0",
    String(options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE),
    options.invertY === false ? "0" : "1",
    options.useSRGBBuffer ? "1" : "0",
    options.isCube ? "1" : "0",
  ].join(":");
}

function samplingKey(options: TextureSamplingOptions = {}): string {
  return `${uploadSamplingKey(options)}:${options.hasAlpha ? 1 : 0}:${options.anisotropicFilteringLevel ?? 4}`;
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
  entry.uploadUrls?.clear();
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
  if ((texture instanceof Texture || texture instanceof CubeTexture) && texture.loadingError) {
    texture.dispose();
    entry.textures.delete(key);
    return undefined;
  }
  if (!isDisposedGpuTexture(texture)) return texture;
  entry.textures.delete(key);
  return undefined;
}

function anyLiveTexture(entry: CacheEntry): BaseTexture | undefined {
  for (const key of entry.textures.keys()) {
    const texture = liveTexture(entry, key);
    if (texture) return texture;
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
  entry.textureUploads?.clear();
}

const textureRequests = new WeakMap<BaseTexture, {
  cache: ResourceCache; assetGuid: string; engine: AbstractEngine; bytes: Uint8Array | Blob; options: TextureSamplingOptions;
}>();

/** Lazily isolate wrapper sampling state while sharing a compatible native upload. */
export function acquireTextureVariant(texture: Texture, options: TextureSamplingOptions): ResourceLease<Texture> | null {
  const request = textureRequests.get(texture);
  if (!request) return null;
  return request.cache.acquireTexture(request.assetGuid, request.engine, request.bytes, { ...request.options, ...options }) as ResourceLease<Texture>;
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
  private readonly readiness = new WeakMap<BaseTexture, Promise<void>>();
  private readonly textureKeys = new WeakMap<BaseTexture, string>();
  private readonly urlKeys = new Map<string, string>();
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
    options = { ...options, anisotropicFilteringLevel: Math.max(1, Math.min(options.anisotropicFilteringLevel ?? 4, engine.getCaps().maxAnisotropy ?? 4)) };
    const lease = this.lease(this.prepareTexture(assetGuid, engine, bytes, options));
    return { ...lease, key: `${lease.key}\0${samplingKey(options)}` };
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
    return { resource, key, ready: typeof resource === "string" ? undefined : this.readiness.get(resource), release: () => {
      if (released) return;
      released = true;
      this.release(key);
    } };
  }

  private assertAdmitted(): void {
    this.evictToCeiling();
    const policies = [...this.clientBudgets.values()];
    const flags = policies.flatMap((policy) => policy.enabled === undefined ? [] : [policy.enabled]);
    if (flags.length ? flags.includes(false) : !this.budgetEnabled) return;
    const caps = policies.flatMap((policy) => policy.bytes === undefined ? [] : [policy.bytes]);
    const ceiling = caps.length ? Math.max(...caps) : this.ceiling;
    if (this.totalBytes > ceiling) throw new Error("Texture replacement exceeds the live texture byte budget");
  }

  resourceStats() {
    const entries = [...this.entries.values()];
    return { generations: entries.length, wrappers: entries.reduce((n, entry) => n + entry.textures.size, 0),
      leases: entries.reduce((n, entry) => n + entry.refCount, 0), pending: entries.reduce((n, entry) => n + (entry.pending ?? 0), 0) };
  }

  private preparing(entry: CacheEntry) {
    entry.pending = (entry.pending ?? 0) + 1;
    let active = true;
    let failure: Error | undefined;
    let validate: (() => void) | undefined;
    let preparationWork: Promise<void> | undefined;
    let retire: (() => void) | undefined;
    let detach = () => {};
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // A released owner need not await its cancelled preparation.
    void ready.catch(() => {});
    const settle = (error?: Error) => {
      if (!active) return;
      active = false;
      failure = error;
      clearTimeout(deadline);
      detach();
      entry.preparations?.delete(cancel);
      entry.pending = Math.max(0, (entry.pending ?? 1) - 1);
      if (error) reject(error); else resolve();
    };
    const failed = (error: unknown) => {
      if (!active) return;
      settle(error instanceof Error ? error : new Error(String(error)));
      retire?.();
      if (this.entries.get(entry.key) === entry && this.isUnreferenced(entry))
        this.evictEntry(entry.key, "preparation");
    };
    const cancel = (reason: string) => failed(new Error(reason));
    entry.preparations ??= new Set();
    entry.preparations.add(cancel);
    const deadline = setTimeout(() => cancel("Texture preparation exceeded the readiness deadline"), TEXTURE_PREPARATION_TIMEOUT_MS);
    const loaded = () => {
      if (!active) return;
      const complete = () => {
        if (!active) return;
        try { validate?.(); settle(); }
        catch (error) { failed(error); }
      };
      if (preparationWork) void preparationWork.then(complete, failed);
      else complete();
    };
    return { ready, validate: (check: () => void, dispose: () => void, pending?: Promise<void>) => {
      validate = check;
      preparationWork = pending;
      let retired = false;
      retire = () => { if (retired) return; retired = true; dispose(); };
      if (failure) retire();
    },
      // A constructor may call onLoad before its wrapper/accounting is installed.
      onLoad: () => { void Promise.resolve().then(loaded); },
      onError: (message?: string) => failed(new Error(message ?? "Texture upload failed")),
      observe: (texture: Texture | CubeTexture) => {
        this.readiness.set(texture, ready);
        if (!active) return;
        // Header measurement may still be pending even when the native wrapper
        // reports ready. Disposal must cancel that preparation too.
        const disposed = texture.onDisposeObservable.addOnce(() => settle(new Error("Texture retired during preparation")));
        let removeLoad = () => {};
        detach = () => { disposed?.remove(true); removeLoad(); };
        if (texture.isReady()) loaded();
        else if (texture.loadingError) failed(new Error(texture.errorObject?.message ?? "Texture upload failed"));
        else {
          if (texture instanceof CubeTexture) {
            const load = texture.onLoadObservable.addOnce(loaded);
            removeLoad = () => load?.remove(true);
          } else {
            const load = texture.onLoadObservable.addOnce(loaded);
            removeLoad = () => load?.remove(true);
          }
        }
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

  private isUnreferenced(entry: CacheEntry): boolean {
    return !entry.pending && entry.refCount === 0;
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
    const uploadKey = uploadSamplingKey(options);
    const blobUrl = this.blobUrlForSamplingKey(entry, uploadKey);
    const ktx2 = ktx2LoaderHints(bytes);
    const raw = asUint8Array(bytes);
    const preparation = this.preparing(entry);
    let texture: Texture | CubeTexture;
    try {
    texture = options.isCube
      ? new CubeTexture(blobUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          useSRGBBuffer: environment ? false : options.useSRGBBuffer ?? false,
          forcedExtension: environment ? `.${environment}` : undefined,
          prefiltered: !!environment,
          createPolynomials: !!environment,
          onLoad: preparation.onLoad, onError: preparation.onError,
        })
      : new Texture(blobUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          invertY: options.invertY !== false,
          samplingMode: options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: options.useSRGBBuffer ?? false,
          mimeType: ktx2.mimeType,
          forcedExtension: ktx2.forcedExtension,
          buffer: raw ? copyTextureBytesForUpload(raw) : undefined,
          onLoad: preparation.onLoad, onError: preparation.onError,
        });
    } catch (error) {
      preparation.onError();
      this.release(entry.key);
      if (this.isUnreferenced(entry)) this.evictEntry(entry.key, "failed");
      throw error;
    }
    texture.hasAlpha = options.hasAlpha === true;
    texture.anisotropicFilteringLevel = options.anisotropicFilteringLevel ?? 4;
    textureRequests.set(texture, { cache: this, assetGuid, engine, bytes, options });
    entry.textureUploads ??= new Map();
    entry.textureUploads.set(key, uploadKey);
    entry.textures.set(key, texture);
    this.textureKeys.set(texture, variantKey);
    try {
      const measured = this.trackTextureBytes(entry, key, texture, bytes, options.noMipmap !== true, uploadKey);
      preparation.validate(() => this.assertAdmitted(), () => texture.dispose(), measured);
      this.assertAdmitted();
      preparation.observe(texture);
    } catch (error) {
      preparation.onError();
      texture.dispose();
      this.release(entry.key);
      if (this.isUnreferenced(entry)) this.evictEntry(entry.key, "admission");
      throw error;
    }
    return texture;
  }

  /** Wrappers with identical uploads share native storage; upload variants get another URL. */
  private blobUrlForSamplingKey(entry: CacheEntry, uploadKey: string): string {
    entry.uploadUrls ??= new Map();
    const existing = entry.uploadUrls.get(uploadKey);
    if (existing) return existing;
    let url = entry.blobUrl;
    const blob = this.blobs.get(entry.key);
    if (entry.uploadUrls.size && blob && typeof URL !== "undefined" && URL.createObjectURL) {
      url = URL.createObjectURL(blob);
      entry.extraBlobUrls.push(url);
    }
    entry.uploadUrls.set(uploadKey, url);
    return url;
  }

  /**
   * Six-face cubemap (`px, py, pz, nx, ny, nz`) for skyboxes. IBL still uses
   * `acquireTexture(..., { isCube: true })` with a single DDS/ENV URL.
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
    const entry: CacheEntry = existing ?? {
      assetGuid, key: variantKey, blobUrl: "", extraBlobUrls: [], bytes: 0,
      refCount: 0, lastUsed: ++this.clock, contentKey: files.join(":"), textures: new Map(),
    };
    this.entries.set(variantKey, entry);
    entry.refCount++;
    const preparation = this.preparing(entry);
    let texture: CubeTexture | undefined;
    try {
      texture = createEngineCubeTextureFromImages(scene.getEngine(), files, noMipmap, preparation);
      this.textureKeys.set(texture, variantKey);
      entry.textures.set(key, texture);
      const measured = this.trackTextureBytes(entry, key, texture, undefined, !noMipmap);
      preparation.validate(() => this.assertAdmitted(), () => texture?.dispose(), measured);
      this.assertAdmitted();
      preparation.observe(texture);
      return texture;
    } catch (error) {
      preparation.onError();
      texture?.dispose();
      this.release(entry.key);
      if (this.isUnreferenced(entry)) this.evictEntry(entry.key, "failed");
      throw error;
    }
  }

  /**
   * Drop GPU Texture wrappers but keep blob URLs so the next `acquireTexture`
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
    if (entry.refCount === 0) {
      for (const cancel of [...entry.preparations ?? []])
        cancel("Texture preparation cancelled after its final owner released it");
    }
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
    uploadKey = sampling,
  ): Promise<void> | undefined {
    entry.samplingDisposers ??= new Map();
    entry.samplingDisposers.get(sampling)?.();
    let active = true;
    const installedHeader = bytes instanceof Blob ? installedAssetHeader(bytes) : undefined;
    const environment = bytes instanceof Blob ? installedEnvironmentInfo(bytes) : undefined;
    let headerPending = bytes instanceof Blob && !installedHeader;
    let size = bytes instanceof Uint8Array ? textureSourceSize(bytes) : installedHeader ? textureSourceSize(installedHeader) : null;
    if (environment) size = { width: environment.width, height: environment.height, mipLevels: environment.mipLevels,
      reserveType: environment.encoding === "linearFloat32" ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_HALF_FLOAT };
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
      if (estimate !== null) this.setSamplingBytes(entry, uploadKey, estimate);
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
      entry.textureUploads?.delete(sampling);
      if (![...entry.textureUploads?.values() ?? []].includes(uploadKey)) this.setSamplingBytes(entry, uploadKey, 0);
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
    if (bytes instanceof Blob && !installedHeader) {
      // Bound temporary header storage; unusual raster headers can still be
      // measured from the real upload when their dimensions are unavailable.
      return bytes.slice(0, 64 * 1024).arrayBuffer().then((header) => {
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
    for (const cancel of [...entry.preparations ?? []]) cancel("Texture preparation cancelled during cache retirement");
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
  readonly ready?: Promise<void>;
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
    const owned = { resource: lease.resource, key: lease.key, ready: lease.ready, release: () => {
      if (!this.leases.delete(owned)) return;
      lease.release();
    } };
    this.leases.add(owned);
    return owned;
  }
  acquireTexture(...args: Parameters<ResourceCache["acquireTexture"]>) { return this.own(this.inner.acquireTexture(...args)); }
  acquireBlobUrl(...args: Parameters<ResourceCache["acquireBlobUrl"]>) { return this.own(this.inner.acquireBlobUrl(...args)); }
  acquireCubeTextureFromImages(...args: Parameters<ResourceCache["acquireCubeTextureFromImages"]>) { return this.own(this.inner.acquireCubeTextureFromImages(...args)); }
  acquireExisting<T extends BaseTexture | string>(resource: T) { return this.inner.acquireExisting(resource); }
  resourceKey(resource: string | BaseTexture) { return this.inner.resourceKey(resource); }
  setByteCeiling(bytes: number) { this.inner.setClientBudget(this, bytes); }
  setBudgetEnabled(enabled: boolean) { this.inner.setClientBudgetEnabled(this, enabled); }
  setClientBudget(...args: Parameters<ResourceCache["setClientBudget"]>) { this.inner.setClientBudget(...args); }
  setClientBudgetEnabled(...args: Parameters<ResourceCache["setClientBudgetEnabled"]>) { this.inner.setClientBudgetEnabled(...args); }
  account(...args: Parameters<ResourceCache["account"]>) { this.inner.account(...args); }
  accountTextureSize(...args: Parameters<ResourceCache["accountTextureSize"]>) { this.inner.accountTextureSize(...args); }
  releaseAccounting(key: string) { this.inner.releaseAccounting(key); }
  accountedBytes() { return this.inner.accountedBytes(); }
  resourceStats() { return this.inner.resourceStats(); }
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
  dispose: () => void;
} {
  const cache = new ResourceCacheOwner(inner);
  return { cache, dispose: () => cache.dispose() };
}

/** Sprite / tilemap albedo: nearest, no mips, invertY (Babylon 2D). */
export const PIXEL_ART_TEXTURE_SAMPLING: TextureSamplingOptions = {
  noMipmap: true,
  samplingMode: Texture.NEAREST_SAMPLINGMODE,
  anisotropicFilteringLevel: 1,
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
  options: TextureSamplingOptions = {},
): ResourceLease<Texture> | null {
  if (environmentContainer(bytes)) return null;
  const lease = cache.acquireTexture(
    assetGuid,
    engine,
    bytes,
    { ...MATERIAL_TEXTURE_SAMPLING, ...options },
  );
  if (lease.resource.isCube) { lease.release(); return null; }
  return lease as ResourceLease<Texture>;
}

/** One material generation owns its sampled textures; compiler callbacks only borrow. */
export function materialTextureBindings(acquire: ((guid: string) => ResourceLease<Texture> | null) | undefined, identity?: (guid: string) => string | undefined) {
  const leases = new Map<string, ResourceLease<Texture>>();
  const bindingKey = (guid: string) => `${guid}\0${identity?.(guid) ?? ""}`;
  return {
    resolve(guid: string): Texture | null {
      const key = bindingKey(guid);
      const current = leases.get(key);
      if (current && !isDisposedGpuTexture(current.resource)) return current.resource;
      const next = acquire?.(guid);
      if (!next) return null;
      leases.set(key, next);
      current?.release();
      return next.resource;
    },
    ready(guid: string) { return leases.get(bindingKey(guid))?.ready; },
    prune(textures: readonly BaseTexture[]) {
      const used = new Set(textures);
      const generations = new Set(textures.flatMap((texture) => {
        const request = textureRequests.get(texture);
        return request ? [request.cache.resourceKey(texture)] : [];
      }));
      for (const [key, lease] of leases) {
        const request = textureRequests.get(lease.resource);
        if (used.has(lease.resource) || (request && generations.has(request.cache.resourceKey(lease.resource)))) continue;
        leases.delete(key); lease.release();
      }
    },
    dispose() { for (const lease of leases.values()) lease.release(); leases.clear(); },
  };
}
