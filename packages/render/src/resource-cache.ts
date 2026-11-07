import { installedAssetHeader, installedEnvironmentInfo, environmentTextureContainer, readEnvironmentTextureInfo, isKtx2Bytes, sniffImageSize, sniffKtx2Size } from "@haptic/assets";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Scene } from "@babylonjs/core/scene";
import type { MaterialTextureFilter } from "@haptic/shader-graph";
import { CubeTexture, type ICubeTextureCreationOptions } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { InternalTextureSource, type InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { assetByteFingerprint as contentKey } from "./asset-byte-fingerprint";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { trackMaterialTexture } from "./nearest-textures";
import {
  TEXTURE_BYTE_CEILING,
  TEXTURE_EVICTION_TARGET_FACTOR,
} from "./perf-ceilings";
import { uploadedTextureBytes } from "./uploaded-texture-bytes";
import { deviceProfile } from "./device-profile";

export interface ResourceCacheOptions {
  /** Accounted byte ceiling before evicting unreferenced LRU entries. */
  byteCeiling?: number;
  /** When false, skip LRU eviction. */
  budgetEnabled?: boolean;
  /** The most any budget may hold on this device class (`deviceProfile().textureByteCeiling` by default). */
  deviceByteCeiling?: number;
  onEvict?: (assetGuid: string, reason: string) => void;
}

/** Canonical sampling options — part of the engine InternalTexture cache key. */
export interface TextureSamplingOptions {
  noMipmap?: boolean;
  samplingMode?: number;
  invertY?: boolean;
  isCube?: boolean;
  hasAlpha?: boolean;
  anisotropicFilteringLevel?: number;
}

interface CacheEntry {
  assetGuid: string;
  key: string;
  /** The object URL of the entry's Blob; empty until something fetches the bytes by URL (`entryBlobUrl`). */
  blobUrl: string;
  extraBlobUrls: string[];
  /**
   * Per upload key, the URL its native texture loads from: an object URL, or, for an upload Babylon decodes from the
   * buffer it is given (a 2D KTX2 from bytes), a name that is never fetched (`BUFFER_UPLOAD_URL`).
   */
  uploadUrls?: Map<string, string>;
  textureUploads?: Map<string, string>;
  bytes: number;
  refCount: number;
  /** Outstanding leases per sampling key of `textures`. */
  samplingLeases?: Map<string, number>;
  pending?: number;
  preparations?: Set<(reason: string) => void>;
  lastUsed: number;
  textures: Map<string, BaseTexture>;
  samplingBytes?: Map<string, number>;
  samplingDisposers?: Map<string, () => void>;
  /** A six-face cube's face URLs: blob URLs of other entries, or engine data. */
  faceUrls?: readonly string[];
}

/** Entries a released world view leased, held past flushes for the Engine's next world view. */
interface TextureHandover {
  keys: Set<string>;
  claimed: boolean;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

// Match the existing owner-scoped readiness deadline; no upload may pin forever.
const TEXTURE_PREPARATION_TIMEOUT_MS = 30_000;
/** How long a texture handover waits for the Engine's next world view to claim it. */
export const TEXTURE_HANDOVER_CLAIM_MS = 10_000;
/** Longest a claimed handover keeps what its view has not leased, for a view that never presents. */
const TEXTURE_HANDOVER_MS = 120_000;

/**
 * Six-face cubemap bound to the Engine, not a Scene. Scene.dispose must not
 * drop a ResourceCache-owned cube (Play overlay shares the editor Engine).
 */
function createEngineCubeTextureFromImages(
  engine: AbstractEngine,
  files: string[],
  noMipmap = false,
  completion?: CubeCompletion,
): CubeTexture {
  return trackedCubeTexture(files.join(""), engine, { files, noMipmap }, completion);
}

type CubeCompletion = { onLoad: () => void; onError: (message?: string) => void };

/** A cube's native upload: settled once it finished or failed; `waiting` runs on settling, true when it finished. */
const cubeUploads = new WeakMap<CubeTexture, { settled: boolean; waiting: Array<(loaded: boolean) => void> }>();

function trackedCubeTexture(
  url: string,
  engine: AbstractEngine,
  options: ICubeTextureCreationOptions,
  completion?: CubeCompletion,
): CubeTexture {
  const upload = { settled: false, waiting: [] as Array<(loaded: boolean) => void> };
  const settle = (loaded: boolean) => {
    upload.settled = true;
    for (const release of upload.waiting.splice(0)) release(loaded);
  };
  const texture = new CubeTexture(url, engine, {
    ...options,
    onLoad: () => { settle(true); completion?.onLoad(); },
    onError: (message?: string) => { settle(false); completion?.onError(message); },
  });
  cubeUploads.set(texture, upload);
  return texture;
}

/**
 * Babylon uploads a cube when its last face decodes and never checks that the texture was disposed meanwhile:
 * texImage2D, generateMipmap and texParameter then hit an unbound target ("no texture bound"), and the next
 * presentation reads GL error 1282. A cube disposed mid-load drops its wrapper at once but keeps its native
 * texture until the upload settles, bounded by the preparation deadline.
 */
function disposeTexture(texture: BaseTexture): void {
  const upload = texture instanceof CubeTexture ? cubeUploads.get(texture) : undefined;
  const native = texture.getInternalTexture();
  if (upload && !upload.settled && native && !native.isReady) {
    native.incrementReferences();
    let held = true;
    // A failed load needs no release: Babylon disposes the native texture before it reports the error.
    const release = (dispose: boolean) => {
      if (!held) return;
      held = false;
      clearTimeout(deadline);
      if (dispose && !native.getEngine().isDisposed) native.dispose();
    };
    const deadline = setTimeout(() => release(true), TEXTURE_PREPARATION_TIMEOUT_MS);
    upload.waiting.push(release);
  }
  texture.dispose();
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
    options.isCube ? "1" : "0",
  ].join(":");
}

function samplingKey(options: TextureSamplingOptions = {}): string {
  return `${uploadSamplingKey(options)}:${options.hasAlpha ? 1 : 0}:${options.anisotropicFilteringLevel ?? 4}`;
}

/**
 * The scheme of the URL a buffer-decoded upload is named by: Babylon decodes a 2D KTX2 from the buffer it is given and
 * never fetches its URL, which only keys its texture cache, so such an upload needs no Blob copy of its bytes.
 */
const BUFFER_UPLOAD_URL = "haptic-buffer:";

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
    disposeTexture(texture);
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
): ResourceCache {
  const existing = caches.get(engine);
  if (existing) return existing;
  const cache = new ResourceCache();
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

/** A native texture as a leak report names it. */
export interface EngineTextureDescription {
  /** Its upload URL (a ResourceCache blob URL for assets), else the kind of source that created it. */
  name: string;
  size: string;
  cube: boolean;
  /** Wrappers still sharing the native texture. */
  references: number;
  /** The Engine's ResourceCache entry whose wrapper uploads this texture, if any. */
  resourceCache: { assetGuid: string; leases: number } | null;
}

/** The native textures `engine`'s ResourceCache holds, with no lease on them, for the Engine's next world view. */
export function texturesHeldForHandover(engine: AbstractEngine): ReadonlySet<InternalTexture> {
  const cache = caches.get(engine);
  return cache ? ResourceCache.heldTextures(cache) : new Set();
}

/** Names a native texture the Engine still caches, and says whether the Engine's ResourceCache owns it. */
export function describeEngineTexture(engine: AbstractEngine, texture: InternalTexture): EngineTextureDescription {
  const cache = caches.get(engine);
  return {
    name: texture.url || InternalTextureSource[texture._source] || "unnamed",
    size: `${texture.baseWidth}×${texture.baseHeight}`,
    cube: texture.isCube,
    references: texture._references,
    resourceCache: cache ? ResourceCache.entryHolding(cache, texture) : null,
  };
}

/**
 * LRU resource cache with byte ceiling and stable blob URLs per asset guid.
 * Texture construction must go through this cache (lint-enforced).
 */
export class ResourceCache {
  private ceiling: number;
  private readonly deviceCeiling: number;
  private readonly clientBudgets = new Map<object, { bytes?: number; enabled?: boolean }>();
  private budgetEnabled: boolean;
  private readonly onEvict?: (assetGuid: string, reason: string) => void;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly blobs = new Map<string, Blob>();
  private readonly readiness = new WeakMap<BaseTexture, Promise<void>>();
  private readonly textureKeys = new WeakMap<BaseTexture, string>();
  /** The sampling key each wrapper was built for; its leases count per sampling. */
  private readonly textureSamplings = new WeakMap<BaseTexture, string>();
  /** Shared-upload wrappers whose own preparation passed load-time admission. */
  private readonly admittedTextures = new WeakSet<BaseTexture>();
  private readonly urlKeys = new Map<string, string>();
  /** Names minted for buffer-decoded uploads (`BUFFER_UPLOAD_URL`), unique for the cache's life. */
  private bufferUploads = 0;
  private clock = 0;
  private totalBytes = 0;
  private handover: TextureHandover | null = null;
  private handoverGeneration = 0;

  constructor(options: ResourceCacheOptions = {}) {
    this.ceiling = options.byteCeiling ?? TEXTURE_BYTE_CEILING;
    this.deviceCeiling = options.deviceByteCeiling ?? deviceProfile().textureByteCeiling;
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
    const entry = this.entries.get(key);
    const sampling = typeof resource === "string" ? undefined : this.textureSamplings.get(resource);
    if (entry && sampling !== undefined) {
      entry.samplingLeases ??= new Map();
      entry.samplingLeases.set(sampling, (entry.samplingLeases.get(sampling) ?? 0) + 1);
    }
    let released = false;
    return { resource, key, ready: typeof resource === "string" ? undefined : this.readiness.get(resource), release: () => {
      if (released) return;
      released = true;
      // A generation evicted since holds nothing of a later one with the same key.
      this.release(key, entry && this.entries.get(key) === entry ? sampling : undefined);
    } };
  }

  /** Null when any view (or, without view flags, the cache) disables budgeting. */
  private effectiveCeiling(): number | null {
    const policies = [...this.clientBudgets.values()];
    const flags = policies.flatMap((policy) => policy.enabled === undefined ? [] : [policy.enabled]);
    if (flags.length ? flags.includes(false) : !this.budgetEnabled) return null;
    const caps = policies.flatMap((policy) => policy.bytes === undefined ? [] : [policy.bytes]);
    return Math.min(caps.length ? Math.max(...caps) : this.ceiling, this.deviceCeiling);
  }

  private assertAdmitted(): void {
    this.evictToCeiling();
    const ceiling = this.effectiveCeiling();
    if (ceiling !== null && this.totalBytes > ceiling) throw new Error("Texture replacement exceeds the live texture byte budget");
  }

  /** The entry of `cache` whose wrapper uploads this native texture; static to keep the per-handle owner surface unchanged. */
  static entryHolding(cache: ResourceCache, texture: InternalTexture): { assetGuid: string; leases: number } | null {
    for (const entry of cache.entries.values()) {
      // Samplings that share an upload share its native texture; another sampling's leases do not hold it.
      const samplings = [...entry.textures].filter(([, wrapper]) => wrapper.getInternalTexture() === texture);
      if (samplings.length === 0) continue;
      const leases = samplings.reduce((total, [sampling, wrapper]) => total + (cache.textureSamplings.get(wrapper) === sampling
        ? entry.samplingLeases?.get(sampling) ?? 0 : entry.refCount), 0);
      return { assetGuid: entry.assetGuid, leases };
    }
    return null;
  }

  /** The native textures of the held entries no lease holds; static to keep the per-handle owner surface unchanged. */
  static heldTextures(cache: ResourceCache): Set<InternalTexture> {
    const textures = new Set<InternalTexture>();
    for (const key of cache.handover?.keys ?? []) {
      const entry = cache.entries.get(key);
      if (!entry || !cache.isUnreferenced(entry)) continue;
      for (const wrapper of entry.textures.values()) {
        const native = wrapper.getInternalTexture();
        if (native) textures.add(native);
      }
    }
    return textures;
  }

  /**
   * Hold `keys`, the entries a released world view leased, past flushes for the Engine's next world view, merged into
   * whatever is held already (a hold that view claimed and has not ended included). They stay accounted, and an LRU
   * trim may still evict them. `claimHandover` keeps those that view names; a hold nothing claims is flushed after
   * `TEXTURE_HANDOVER_CLAIM_MS`.
   */
  holdForHandover(keys: Iterable<string>): void {
    const held = this.handover?.keys ?? new Set<string>();
    if (this.handover) clearTimeout(this.handover.timer);
    for (const key of keys) if (this.entries.has(key)) held.add(key);
    if (held.size === 0) { this.handover = null; return; }
    const generation = ++this.handoverGeneration;
    this.handover = { keys: held, claimed: false, generation,
      timer: setTimeout(() => this.endHandover(generation), TEXTURE_HANDOVER_CLAIM_MS) };
  }

  /**
   * The Engine's next world view claims the hold with its texture sources (asset guid to installed bytes). A held entry
   * of other content, and a six-face cube built from one, is flushed now, before that view allocates anything; the view
   * leases the rest as its load asks for them and calls the returned function once it has presented, failed or been
   * disposed, which flushes what it left unleased. Null when nothing is held or the hold is claimed already.
   */
  claimHandover(sources: Iterable<ReadonlyMap<string, Uint8Array | Blob> | undefined>): (() => void) | null {
    const handover = this.handover;
    if (!handover || handover.claimed) return null;
    const named = new Set<string>();
    for (const source of sources) for (const [guid, bytes] of source ?? []) named.add(`${guid}\0${contentKey(bytes)}`);
    const wanted = (entry: CacheEntry) => entry.faceUrls
      ? entry.faceUrls.every((url) => !url.startsWith("blob:") || named.has(this.urlKeys.get(url) ?? ""))
      : named.has(entry.key);
    for (const key of [...handover.keys]) {
      const entry = this.entries.get(key);
      if (entry && wanted(entry)) continue;
      handover.keys.delete(key);
      if (entry) this.flushEntry(entry, "handover");
    }
    clearTimeout(handover.timer);
    if (handover.keys.size === 0) { this.handover = null; return null; }
    handover.claimed = true;
    const generation = handover.generation;
    handover.timer = setTimeout(() => this.endHandover(generation), TEXTURE_HANDOVER_MS);
    return () => this.endHandover(generation);
  }

  /** Ends hold `generation`: flushes its entries no lease holds, and the samplings no lease holds in the others. */
  private endHandover(generation: number): void {
    const handover = this.handover;
    if (!handover || handover.generation !== generation) return;
    this.handover = null;
    clearTimeout(handover.timer);
    for (const key of handover.keys) {
      const entry = this.entries.get(key);
      if (entry) this.flushEntry(entry, "handover");
    }
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

  private prepareBlobUrl(assetGuid: string, bytes: Uint8Array | Blob, identity = contentKey(bytes)): string {
    return this.entryBlobUrl(this.referenceEntry(assetGuid, identity), bytes);
  }

  /** Takes one reference on the entry of `identity`, creating it (with no Blob or object URL yet) when absent. */
  private referenceEntry(assetGuid: string, identity: string): CacheEntry {
    const key = `${assetGuid}\0${identity}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount += 1;
      existing.lastUsed = ++this.clock;
      return existing;
    }
    const entry: CacheEntry = {
      assetGuid,
      key,
      blobUrl: "",
      extraBlobUrls: [],
      bytes: 0,
      refCount: 1,
      lastUsed: ++this.clock,
      textures: new Map(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** The entry's object URL, minting its Blob (a copy of `bytes`) the first time something fetches them by URL. */
  private entryBlobUrl(entry: CacheEntry, bytes: Uint8Array | Blob): string {
    if (entry.blobUrl) return entry.blobUrl;
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
    this.blobs.set(entry.key, blob);
    const url =
      typeof URL !== "undefined" && URL.createObjectURL
        ? URL.createObjectURL(blob)
        : `blob:haptic/${entry.assetGuid}`;
    entry.blobUrl = url;
    this.urlKeys.set(url, entry.key);
    return url;
  }

  /**
   * Resolve a Texture for an asset guid through the cache so editor and Play
   * share InternalTextures per sampling key. Extra upload keys get another
   * `createObjectURL` of the same Blob (never a `#nomip` / `#ninv` fragment),
   * or, for a 2D KTX2 decoded from its buffer, another never-fetched name.
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
    const identity = contentKey(bytes);
    const variantKey = `${assetGuid}\0${identity}`;
    const existing = this.entries.get(variantKey);
    const reused = existing ? liveTexture(existing, key) : undefined;
    if (reused) {
      existing!.refCount += 1;
      existing!.lastUsed = ++this.clock;
      return reused as Texture | CubeTexture;
    }
    const entry = this.referenceEntry(assetGuid, identity);
    const uploadKey = uploadSamplingKey(options);
    const ktx2 = ktx2LoaderHints(bytes);
    const raw = asUint8Array(bytes);
    // Babylon decodes a 2D KTX2 from the buffer it is given and never fetches its URL; every other upload (a cube, a
    // Blob input, an image, whose loader fetches the URL and never reads a buffer) loads from the entry's Blob.
    const fromBuffer = !options.isCube && raw !== null && ktx2.mimeType !== undefined;
    const blobUrl = this.uploadUrl(entry, uploadKey, fromBuffer ? null : bytes);
    // Babylon 9.29 uploads a block-compressed KTX2 without invertY (WebGPU
    // passes false, WebGL2 sets no UNPACK_FLIP_Y) and, unlike KTX1 and .basis,
    // sets no _invertVScale for it. Upload a 2D KTX2 unflipped whatever the
    // request, and flip V on the wrapper instead, so it reads the same way up
    // as its PNG whether the decoder picks a block format or RGBA. Upload keys
    // keep the requested invertY: flipped and unflipped wrappers stay distinct.
    const flipV = !options.isCube && ktx2.mimeType !== undefined && options.invertY !== false;
    const preparation = this.preparing(entry);
    let texture: Texture | CubeTexture;
    try {
    texture = options.isCube
      ? trackedCubeTexture(blobUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          useSRGBBuffer: false,
          forcedExtension: environment ? `.${environment}` : undefined,
          prefiltered: !!environment,
          createPolynomials: !!environment,
        }, preparation)
      : new Texture(blobUrl, engine, {
          noMipmap: options.noMipmap ?? false,
          invertY: options.invertY !== false && !flipV,
          samplingMode: options.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: false,
          mimeType: ktx2.mimeType,
          forcedExtension: ktx2.forcedExtension,
          // A copy: the decoder may take ownership of the buffer it is given.
          buffer: fromBuffer ? raw.slice() : undefined,
          onLoad: preparation.onLoad, onError: preparation.onError,
        });
    } catch (error) {
      preparation.onError();
      this.release(entry.key);
      if (this.isUnreferenced(entry)) this.evictEntry(entry.key, "failed");
      throw error;
    }
    // Before any material binds it: engine-owned wrappers have no Scene to
    // dirty materials on a later identity/non-identity matrix change.
    if (flipV && texture instanceof Texture) {
      texture.vScale = -1;
      texture.vOffset = 1;
    }
    texture.hasAlpha = options.hasAlpha === true;
    texture.anisotropicFilteringLevel = options.anisotropicFilteringLevel ?? 4;
    textureRequests.set(texture, { cache: this, assetGuid, engine, bytes, options });
    entry.textureUploads ??= new Map();
    const uploads = entry.textureUploads;
    // The earliest live wrapper on an upload owns its admission; later variants
    // add no accounted bytes. Check again at load: a rejected owner is removed.
    // Binding defers to any earlier sharer so it cannot throw; load defers only
    // to one that already passed admission, so a later-rejected owner cannot
    // leave this variant holding the upload.
    const admit = (loaded: boolean) => {
      for (const [sampling, upload] of uploads) {
        if (sampling === key) break;
        if (upload !== uploadKey) continue;
        if (!loaded) return;
        const sharer = entry.textures.get(sampling);
        if (sharer && this.admittedTextures.has(sharer)) {
          this.admittedTextures.add(texture);
          return;
        }
      }
      this.assertAdmitted();
      if (loaded) this.admittedTextures.add(texture);
    };
    uploads.set(key, uploadKey);
    entry.textures.set(key, texture);
    this.textureKeys.set(texture, variantKey);
    this.textureSamplings.set(texture, key);
    try {
      const measured = this.trackTextureBytes(entry, key, texture, bytes, options.noMipmap !== true, uploadKey);
      preparation.validate(() => admit(true), () => disposeTexture(texture), measured);
      admit(false);
      preparation.observe(texture);
    } catch (error) {
      preparation.onError();
      disposeTexture(texture);
      this.release(entry.key);
      if (this.isUnreferenced(entry)) this.evictEntry(entry.key, "admission");
      throw error;
    }
    return texture;
  }

  /**
   * Wrappers with identical uploads share native storage; upload variants get another URL. `bytes` is null for an
   * upload decoded from its buffer, which a unique, never-fetched name keys instead of an object URL.
   */
  private uploadUrl(entry: CacheEntry, uploadKey: string, bytes: Uint8Array | Blob | null): string {
    entry.uploadUrls ??= new Map();
    const existing = entry.uploadUrls.get(uploadKey);
    if (existing) return existing;
    let url: string;
    if (bytes === null) {
      url = `${BUFFER_UPLOAD_URL}${entry.assetGuid}/${++this.bufferUploads}`;
      this.urlKeys.set(url, entry.key);
    } else {
      url = this.entryBlobUrl(entry, bytes);
      const blob = this.blobs.get(entry.key);
      if ([...entry.uploadUrls.values()].includes(url) && blob && typeof URL !== "undefined" && URL.createObjectURL) {
        url = URL.createObjectURL(blob);
        entry.extraBlobUrls.push(url);
      }
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
      refCount: 0, lastUsed: ++this.clock, textures: new Map(), faceUrls: files,
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
      preparation.validate(() => this.assertAdmitted(), () => texture && disposeTexture(texture), measured);
      this.assertAdmitted();
      preparation.observe(texture);
      return texture;
    } catch (error) {
      preparation.onError();
      if (texture) disposeTexture(texture);
      this.release(entry.key);
      if (this.isUnreferenced(entry)) this.evictEntry(entry.key, "failed");
      throw error;
    }
  }

  /**
   * Set an entry's accounted bytes and evict to the ceiling. Production only
   * re-measures acquired entries; an unknown key creates an accounting-only
   * entry holding one reference (released with `releaseAccounting`), which
   * tests use to drive eviction and budgets without allocating textures.
   */
  account(assetGuid: string, bytes: number): void {
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

  private release(resource: string | BaseTexture, sampling?: string): void {
    const entry = this.entries.get(this.resourceKey(resource));
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    let samplingReleased = false;
    if (sampling !== undefined && entry.samplingLeases) {
      const leases = Math.max(0, (entry.samplingLeases.get(sampling) ?? 0) - 1);
      if (leases > 0) entry.samplingLeases.set(sampling, leases);
      else { entry.samplingLeases.delete(sampling); samplingReleased = true; }
    }
    if (entry.refCount === 0) {
      for (const cancel of [...entry.preparations ?? []])
        cancel("Texture preparation cancelled after its final owner released it");
    } else if (samplingReleased) this.retireSampling(entry, sampling!);
  }

  /**
   * Dispose a sampling no lease holds while other leases keep its entry, with its own upload and object URL when no
   * other sampling shares them. Entry eviction never reaches it then, so keeping it would pin a native texture nobody
   * samples. An unreferenced entry keeps every sampling until it is evicted or flushed.
   */
  private retireSampling(entry: CacheEntry, sampling: string): void {
    const texture = entry.textures.get(sampling);
    const uploadKey = entry.textureUploads?.get(sampling);
    if (!texture) return;
    // Its dispose observer (trackTextureBytes) removes the wrapper and, for an upload no other sampling shares, its bytes.
    disposeTexture(texture);
    if (uploadKey === undefined || [...entry.textureUploads?.values() ?? []].includes(uploadKey)) return;
    const url = entry.uploadUrls?.get(uploadKey);
    if (!url || url === entry.blobUrl) return;
    entry.uploadUrls!.delete(uploadKey);
    if (url.startsWith(BUFFER_UPLOAD_URL)) this.urlKeys.delete(url);
    const extra = entry.extraBlobUrls.indexOf(url);
    if (extra >= 0) entry.extraBlobUrls.splice(extra, 1);
    revokeBlobUrl(url);
  }

  /** Drop one reference on `key`; tests use it to release the reference an accounting-only `account()` entry holds. */
  releaseAccounting(key: string): void { this.release(key); }

  accountedBytes(): number {
    return this.totalBytes;
  }

  evictToCeiling(): void {
    const ceiling = this.effectiveCeiling();
    if (ceiling === null || this.totalBytes <= ceiling) return;
    const target = ceiling * TEXTURE_EVICTION_TARGET_FACTOR;
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
      // Babylon 9.29's RGBA KTX2 uploader leaves internal width/height at the
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
    for (const entry of [...this.entries.values()])
      // A held entry waits for the Engine's next world view, which ends the hold.
      if (!this.handover?.keys.has(entry.key)) this.flushEntry(entry, "flush");
  }

  private flushEntry(entry: CacheEntry, reason: string): void {
    if (this.isUnreferenced(entry)) {
      this.evictEntry(entry.key, reason);
    } else if (entry.refCount > 0) {
      // A sampling whose last lease went while its entry was unreferenced stays pinned once another lease holds the
      // entry again; flush it like an unreferenced entry. Six-face cube wrappers record no sampling.
      for (const [sampling, texture] of [...entry.textures])
        if (this.textureSamplings.get(texture) === sampling && !entry.samplingLeases?.get(sampling)) this.retireSampling(entry, sampling);
    }
  }

  private evictEntry(assetGuid: string, reason: string): void {
    const entry = this.entries.get(this.resourceKey(assetGuid));
    if (!entry) return;
    this.handover?.keys.delete(entry.key);
    this.totalBytes -= entry.bytes;
    this.entries.delete(entry.key);
    this.blobs.delete(entry.key);
    this.urlKeys.delete(entry.blobUrl);
    for (const url of entry.uploadUrls?.values() ?? []) if (url.startsWith(BUFFER_UPLOAD_URL)) this.urlKeys.delete(url);
    for (const cancel of [...entry.preparations ?? []]) cancel("Texture preparation cancelled during cache retirement");
    disposeEntryTextures(entry);
    revokeEntryBlobUrls(entry);
    console.info(`[resource-cache] evict ${assetGuid} (${reason})`);
    this.onEvict?.(entry.assetGuid, reason);
  }

  dispose(): void {
    if (this.handover) clearTimeout(this.handover.timer);
    this.handover = null;
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

/** The public ResourceCache surface a per-view owner forwards; raw accounting and the Engine's handover stay on the cache. */
export type TextureResources = Omit<ResourceCache, "account" | "releaseAccounting" | "holdForHandover" | "claimHandover">;

/** A view retains only its currently outstanding leases, never acquisition history. */
export class ResourceCacheOwner implements TextureResources {
  private readonly leases = new Set<ResourceLease<unknown>>();
  private disposed = false;
  private readonly inner: ResourceCache;
  constructor(inner: ResourceCache) { this.inner = inner; }
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
  /**
   * Deliberately untracked: callers retain a resource for an in-flight native
   * upload or readback and release it when that settles, even after `dispose`.
   */
  acquireExisting<T extends BaseTexture | string>(resource: T) { return this.inner.acquireExisting(resource); }
  resourceKey(resource: string | BaseTexture) { return this.inner.resourceKey(resource); }
  setByteCeiling(bytes: number) { this.inner.setClientBudget(this, bytes); }
  setBudgetEnabled(enabled: boolean) { this.inner.setClientBudgetEnabled(this, enabled); }
  setClientBudget(...args: Parameters<ResourceCache["setClientBudget"]>) { this.inner.setClientBudget(...args); }
  setClientBudgetEnabled(...args: Parameters<ResourceCache["setClientBudgetEnabled"]>) { this.inner.setClientBudgetEnabled(...args); }
  accountedBytes() { return this.inner.accountedBytes(); }
  resourceStats() { return this.inner.resourceStats(); }
  evictToCeiling() { this.inner.evictToCeiling(); }
  flushUnreferenced() { this.inner.flushUnreferenced(); }
  /** The cache entries this owner's outstanding leases hold. */
  leasedKeys(): string[] {
    const keys = new Set([...this.leases].map((lease) => this.inner.resourceKey(lease.resource as string | BaseTexture)));
    keys.delete("");
    return [...keys];
  }
  /** Releases every lease and flushes what nothing holds; `handOver` (entry keys) is held for the Engine's next world view instead. */
  dispose(handOver?: Iterable<string>) {
    if (this.disposed) return;
    this.disposed = true;
    for (const lease of [...this.leases]) lease.release();
    this.inner.setClientBudget(this, null);
    if (handOver) this.inner.holdForHandover(handOver);
    this.inner.flushUnreferenced();
  }
}

export function bindResourceCacheToHandle(inner: ResourceCache): {
  cache: ResourceCacheOwner;
  dispose: (handOver?: Iterable<string>) => void;
} {
  const cache = new ResourceCacheOwner(inner);
  return { cache, dispose: (handOver) => cache.dispose(handOver) };
}

/** Sprite / tilemap albedo: nearest, no mips, invertY (Babylon 2D; a KTX2 flips V on its wrapper instead). */
export const PIXEL_ART_TEXTURE_SAMPLING: TextureSamplingOptions = {
  noMipmap: true,
  samplingMode: Texture.NEAREST_SAMPLINGMODE,
  anisotropicFilteringLevel: 1,
};

/** glTF / NodeMaterial albedo: do not invert Y (Babylon glTF loader convention). */
export const MATERIAL_TEXTURE_SAMPLING: TextureSamplingOptions = {
  invertY: false,
};

/** A Material's sampling of a texture for a Texture Sample's Filter: Nearest is pixel art's, without the flip. */
export function materialTextureSampling(filter?: MaterialTextureFilter): TextureSamplingOptions | undefined {
  return filter === "nearest" ? PIXEL_ART_TEXTURE_SAMPLING : undefined;
}

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
  // The cache's own uploads are Textures; an injected cache (a preview's or a test's) may hand back anything.
  if (lease.resource instanceof Texture) trackMaterialTexture(engine, lease.resource, lease.ready);
  return lease as ResourceLease<Texture>;
}

/** One material generation owns its sampled textures; compiler callbacks only borrow. */
export function materialTextureBindings(
  acquire: ((guid: string, filter?: MaterialTextureFilter) => ResourceLease<Texture> | null) | undefined,
  identity?: (guid: string) => string | undefined,
) {
  const leases = new Map<string, ResourceLease<Texture>>();
  const bindingKey = (guid: string, filter?: MaterialTextureFilter) => `${guid}\0${identity?.(guid) ?? ""}\0${filter ?? "linear"}`;
  return {
    resolve(guid: string, filter?: MaterialTextureFilter): Texture | null {
      const key = bindingKey(guid, filter);
      const current = leases.get(key);
      if (current && !isDisposedGpuTexture(current.resource)) return current.resource;
      const next = acquire?.(guid, filter);
      if (!next) return null;
      leases.set(key, next);
      current?.release();
      return next.resource;
    },
    ready(guid: string, filter?: MaterialTextureFilter) { return leases.get(bindingKey(guid, filter))?.ready; },
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
