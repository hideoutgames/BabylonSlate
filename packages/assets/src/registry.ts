import type { ProjectStorage, StorageReadOptions } from "@haptic/core";
import { ENGINE_VERSION, SourceRevisionChangedError } from "@haptic/core";
import {
  ASSET_DEPENDENCY_METADATA_VERSION,
  type HassetHeader,
} from "./hasset";
import { createVfsBlobStore, type BlobStore } from "./blob-store";
import type { ContentRoot } from "./content-root";
import type { EncodeJobGuard, EncodeJobResult, EncodeQueue } from "./encode-queue";
import type { HdrEnvironmentConverter } from "./hdr-environment";
import {
  importByExtension,
  type ImportResult,
  type ImportRunner,
} from "./importers";
import { AccountedPayloadLoader, readAssetCatalog, validateAssetSourceLocator, type AssetSourceLocator } from "./payload-loader";
import { DOCUMENT_CHUNK_ID, type AssetDocument } from "./asset-document";
import type { ImageSize } from "./image-size";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  type TextureCompressionState,
  type TextureEncodeSettings,
} from "./texture-compression";
import type { AreaEmissionProgress } from "./area-emission";
import { buildClassAliasIndex, resolveDependenciesWithClassAliases, type ClassAliasIndex } from "./catalog-class-dependencies";
import { createAssetUnlocked, importFile, type ImportFileExtras } from "./registry-import";
import { copyFolder, duplicateAssetUnlocked } from "./registry-copy";
import { createFolderUnlocked, deleteFolderUnlocked, moveFolderUnlocked } from "./registry-folders";
import { moveAssetUnlocked, renameAssetUnlocked } from "./registry-asset-moves";
import {
  alignCreatedTextures,
  isTextureAlignmentStale,
  reconcileTextureAlignment,
  requeueUncompressedTextures,
  retryTextureEncoding,
  type TextureAlignmentOptions,
} from "./registry-texture-encoding";
import { commitCompressedTexture, prepareAreaEmission, reconvertHdrEnvironment, setCompressionState } from "./registry-texture-rewrite";
import { walkRoot } from "./registry-scan";
import { AtlasReferrerIndex } from "./registry-atlas";
import { buildFolderTree, isWithinFolder } from "./registry-paths";
import {
  RegistryGenerationClock,
  type AreaEmissionProcessor,
  type AssetCopyOptions,
  type AssetImportControl,
  type AssetRegistryOptions,
  type FolderNode,
  type GuidConflict,
  type IndexedAsset,
  type OwnAssetWrite,
  type RegistryHost,
  type ThumbnailWriter,
} from "./registry-types";

export { FOLDER_MARKER_NAME, RegistryGenerationClock } from "./registry-types";
export type {
  AreaEmissionProcessor,
  AssetCopyOptions,
  AssetImportControl,
  AssetRegistryOptions,
  FolderNode,
  GuidConflict,
  IndexedAsset,
  OwnAssetWrite,
  ThumbnailWriter,
} from "./registry-types";
export { contentEntryNameError, renamedAssetPath } from "./registry-paths";

const textDecoder = new TextDecoder();

/**
 * Content-root-aware asset registry (.agents/reference/architecture/asset-registry.md).
 * Scanning and browsing only ever call `readHassetHeader`; payload bytes
 * load on demand through `payloadLoader`.
 */
export class AssetRegistry {
  private readonly storage: ProjectStorage;
  private readonly blobs: BlobStore;
  private readonly loader: AccountedPayloadLoader;
  private readonly roots = new Map<string, ContentRoot>();
  private readonly byGuid = new Map<string, IndexedAsset>();
  private readonly byPath = new Map<string, IndexedAsset>();
  private readonly locatorRequests = new Map<string, { asset: IndexedAsset; promise: Promise<AssetSourceLocator> }>();
  /** Empty (or marker-backed) folders discovered during scan, keyed by storage path. */
  private readonly knownFolders = new Set<string>();
  /** Scanned files left unindexed because another file has their guid, by path. */
  private readonly guidConflicts = new Map<string, GuidConflict>();
  /** guid -> guids of assets whose header `dependencies[]` names it. */
  private readonly inbound = new Map<string, Set<string>>();
  private encodeQueue: EncodeQueue | null = null;
  private encodeSettings: TextureEncodeSettings = {
    ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
  };
  private thumbnailWriter: ThumbnailWriter | null = null;
  private readonly textureWriteChain = new Map<string, Promise<void>>();
  private folderWriteChain: Promise<void> = Promise.resolve();
  private readonly creationWrites = new Set<Promise<void>>();
  /**
   * Destination paths a create, duplicate, move or rename is writing right
   * now, case-folded as `moveStorageFile` treats spellings that alias. Each
   * operation claims its path synchronously with its index check, so two
   * overlapping writers cannot both pass the check before either indexes.
   */
  private readonly pathReservations = new Set<string>();
  /** Textures the indexed atlas referrers (Tileset, Sprite, Sprite Animation) sample. */
  private readonly atlas = new AtlasReferrerIndex(() => this.changed());
  private ownWriteListener: ((write: OwnAssetWrite) => void) | null = null;
  private createdTextureListener: ((asset: IndexedAsset) => void) | null = null;
  /**
   * Textures an alignment check is requeuing right now. Imports and
   * Duplicates run the pass outside the editor's serialized passes, so a
   * concurrent one skips them rather than queue a second copy.
   */
  private readonly alignmentRequeues: Set<string>;
  private readonly clock: RegistryGenerationClock;
  private readonly runImport: ImportRunner;
  /** This registry as its `registry-*.ts` operation modules reach it (`createHost`). */
  private readonly host: RegistryHost;
  /** Class alias index of the catalog as of `generation`; dropped when any index change advances it. */
  private classAliasMemo: { generation: number; index: ClassAliasIndex } | null = null;
  /** Symbolic inbound references of the catalog as of `generation`; dropped like `classAliasMemo`. */
  private symbolicInboundMemo: { generation: number; index: ReadonlyMap<string, readonly string[]> } | null = null;

  constructor(storage: ProjectStorage, options: AssetRegistryOptions = {}) {
    this.storage = storage;
    this.blobs = options.blobs ?? createVfsBlobStore(storage);
    this.loader =
      options.payloadLoader ?? new AccountedPayloadLoader(storage, { blobs: this.blobs });
    this.alignmentRequeues = options.alignmentRequeues ?? new Set();
    this.clock = options.generationClock ?? new RegistryGenerationClock();
    this.runImport = options.runImport ?? importByExtension;
    this.host = this.createHost();
  }

  /**
   * Built once the constructor has set every field it passes on. Methods
   * call through `this` when they run, so they read reassigned fields then
   * and reach a public method replaced on the instance; never `.bind`.
   */
  private createHost(): RegistryHost {
    return {
      byGuid: this.byGuid,
      byPath: this.byPath,
      roots: this.roots,
      knownFolders: this.knownFolders,
      guidConflicts: this.guidConflicts,
      alignmentRequeues: this.alignmentRequeues,
      textureWriteChain: this.textureWriteChain,
      loader: this.loader,
      encodeQueue: () => this.encodeQueue,
      encodeSettings: () => this.encodeSettings,
      thumbnailWriter: () => this.thumbnailWriter,
      writeThumbnail: (assetGuid, bytes) => this.thumbnailWriter!(assetGuid, bytes),
      reportOwnWrite: (write) => this.ownWriteListener?.(write),
      runImport: (...args) => this.runImport(...args),
      list: (...args) => this.list(...args),
      readChunk: (...args) => this.readChunk(...args),
      getAssetLocator: (...args) => this.getAssetLocator(...args),
      isAtlasTexture: (...args) => this.isAtlasTexture(...args),
      withAssetWrite: (...args) => this.withAssetWrite(...args),
      createAsset: (...args) => this.createAsset(...args),
      deleteAsset: (...args) => this.deleteAsset(...args),
      createFolder: (...args) => this.createFolder(...args),
      deleteFolder: (...args) => this.deleteFolder(...args),
      setCompressionState: (...args) => this.setCompressionState(...args),
      retryTextureEncoding: (...args) => this.retryTextureEncoding(...args),
      reconcileTextureAlignment: (...args) => this.reconcileTextureAlignment(...args),
      changed: () => this.changed(),
      addKnownFolder: (path) => this.addKnownFolder(path),
      removeKnownFolder: (path) => this.removeKnownFolder(path),
      isPathReserved: (path) => this.isPathReserved(path),
      reservePath: (path, conflict) => this.reservePath(path, conflict),
      withReservedPath: (path, conflict, work) => this.withReservedPath(path, conflict, work),
      withCreationWrite: (work) => this.withCreationWrite(work),
      indexHeader: (...args) => this.indexHeader(...args),
      indexCreatedHeader: (...args) => this.indexCreatedHeader(...args),
      repathGuidConflicts: (map) => this.repathGuidConflicts(map),
      deleteAssetUnlocked: (guid) => this.deleteAssetUnlocked(guid),
      getRootOrThrow: (rootId) => this.getRootOrThrow(rootId),
      assertWritable: (root) => this.assertWritable(root),
      storageOf: (root) => this.storageOf(root),
      blobsOf: (root) => this.blobsOf(root),
      storageForAsset: (asset) => this.storageForAsset(asset),
      blobsForAsset: (asset) => this.blobsForAsset(asset),
      statMtime: (storage, path) => this.statMtime(storage, path),
    };
  }

  /**
   * Monotonic change counter: it advances whenever what `list`, `getByGuid`,
   * `getByPath`, `folderTree`, `listRoots`, `showReferences` or
   * `isAtlasTexture` report may have changed (a header indexed or removed, a
   * move, a folder or root change, a Texture's compression state or committed
   * encode). Reads never advance it. Index entries are replaced, never
   * mutated, so memos keyed on it see every change. Registries sharing a
   * `generationClock` report the clock's latest value.
   */
  get generation(): number {
    return this.clock.value;
  }

  private changed(): void {
    this.clock.advance();
  }

  private addKnownFolder(path: string): void {
    if (this.knownFolders.has(path)) return;
    this.knownFolders.add(path);
    this.changed();
  }

  private removeKnownFolder(path: string): void {
    if (this.knownFolders.delete(path)) this.changed();
  }

  private isPathReserved(path: string): boolean {
    return this.pathReservations.has(path.toLowerCase());
  }

  /**
   * Claim `path` for one write; the returned release is idempotent. Throws
   * `conflict` when another operation holds it or an asset is indexed there.
   * Call it before the operation's first await on that path.
   */
  private reservePath(path: string, conflict: string): () => void {
    const key = path.toLowerCase();
    if (this.pathReservations.has(key) || this.byPath.has(path)) throw new Error(conflict);
    this.pathReservations.add(key);
    let held = true;
    return () => {
      if (held) this.pathReservations.delete(key);
      held = false;
    };
  }

  /** Reserve synchronously, then hold `path` until `work` settles. */
  private async withReservedPath<T>(path: string, conflict: string, work: () => Promise<T>): Promise<T> {
    const release = this.reservePath(path, conflict);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Index a file this registry just created; never evicts another asset's entry. */
  private indexCreatedHeader(rootId: string, path: string, header: HassetHeader, mtime: number | null = null): IndexedAsset {
    const existing = this.byPath.get(path);
    if (existing && existing.header.guid !== header.guid) {
      throw new Error(`Asset already exists: ${path} (indexed as ${existing.header.guid})`);
    }
    const indexed = this.indexHeader(rootId, path, header, false, mtime);
    return this.byGuid.get(header.guid) === indexed ? this.reportCreatedTexture(indexed) : indexed;
  }

  /** Bind the §3.5 encode scheduler (ProjectService owns the queue lifetime). */
  setEncodePipeline(
    queue: EncodeQueue | null,
    settings: TextureEncodeSettings = DEFAULT_TEXTURE_ENCODE_SETTINGS,
  ): void {
    this.encodeQueue = queue;
    this.encodeSettings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, ...settings };
  }

  /** Report the registry's own file rewrites, so they are not mistaken for external changes. */
  setOwnWriteListener(listener: ((write: OwnAssetWrite) => void) | null): void {
    this.ownWriteListener = listener;
  }

  /**
   * Report each Texture the registry creates with a KTX2 encode already
   * committed (a `.hasset` import, a Duplicate or Copy): a new file, so its
   * committed encode is this session's own. Called as it is indexed, before
   * any alignment check sees it.
   */
  setCreatedTextureListener(listener: ((asset: IndexedAsset) => void) | null): void {
    this.createdTextureListener = listener;
  }

  private reportCreatedTexture(asset: IndexedAsset): IndexedAsset {
    const { header } = asset;
    if (header.type === "Texture" && header.chunks.some((chunk) => chunk.id === header.payload.ktx2ChunkId)) {
      this.createdTextureListener?.(asset);
    }
    return asset;
  }

  /** Write CB thumbnails into derived data (ProjectService supplies storage). */
  setThumbnailWriter(writer: ThumbnailWriter | null): void {
    this.thumbnailWriter = writer;
  }

  get payloadLoader(): AccountedPayloadLoader {
    return this.loader;
  }

  get accountedPayloadBytes(): number {
    return this.loader.accountedPayloadBytes;
  }

  /** Resolve a catalog snapshot without touching any payload. */
  async getAssetLocator(guid: string, options: StorageReadOptions = {}): Promise<AssetSourceLocator> {
    options.signal?.throwIfAborted();
    const asset = this.byGuid.get(guid);
    if (!asset || asset.placeholder) throw new Error(`Asset is unavailable: ${guid}`);
    const storage = this.storageForAsset(asset);
    if (asset.locator && storage.hasStrongSourceRevisions) {
      const current = await storage.readBinaryRange(asset.path, 0, 0, undefined, options);
      options.signal?.throwIfAborted();
      if (this.byGuid.get(guid) !== asset) throw new SourceRevisionChangedError(`Asset changed while resolving its catalog entry: ${guid}`);
      if (current.revision === asset.locator.storageRevision && current.totalSize === asset.locator.totalSize) return asset.locator;
    }
    // Only unsignaled metadata refreshes share this promise. A scoped request
    // owns its transport signal; canceling it must not abort another consumer.
    const pending = options.signal ? undefined : this.locatorRequests.get(guid);
    if (pending?.asset === asset) return pending.promise;
    const promise = (async () => {
      const { header, locator } = await readAssetCatalog(this.storageForAsset(asset), asset.path, options);
      options.signal?.throwIfAborted();
      if (this.byGuid.get(guid) !== asset || header.guid !== guid) {
        throw new SourceRevisionChangedError(`Asset changed while resolving its catalog entry: ${guid}`);
      }
      if (asset.locator?.revision === locator.revision && asset.locator.totalSize === locator.totalSize) return asset.locator;
      this.indexHeader(asset.rootId, asset.path, header, false, asset.mtime, locator);
      return locator;
    })();
    if (options.signal) return promise;
    this.locatorRequests.set(guid, { asset, promise });
    try { return await promise; }
    finally { if (this.locatorRequests.get(guid)?.promise === promise) this.locatorRequests.delete(guid); }
  }

  /** Load only the selected representation, with the catalog revision checked. */
  async readChunk(guid: string, chunkId: string, expectedRevision?: string, options: StorageReadOptions = {}): Promise<Uint8Array> {
    const locator = await this.getAssetLocator(guid, options);
    options.signal?.throwIfAborted();
    return this.readResolvedChunk(guid, chunkId, locator, expectedRevision, options);
  }

  /**
   * Read a chunk of a catalog snapshot the caller resolved earlier, without
   * resolving it again. A load of several chunks resolves once: every read is
   * still followed by a storage check against `locator`, so a save between two
   * chunks fails the read after it.
   */
  async readLocatedChunk(guid: string, chunkId: string, locator: AssetSourceLocator, expectedRevision?: string, options: StorageReadOptions = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const asset = this.byGuid.get(guid);
    if (!asset || asset.placeholder) throw new Error(`Asset is unavailable: ${guid}`);
    return this.readResolvedChunk(guid, chunkId, locator, expectedRevision, options);
  }

  private async readResolvedChunk(guid: string, chunkId: string, locator: AssetSourceLocator, expectedRevision: string | undefined, options: StorageReadOptions): Promise<Uint8Array> {
    if (expectedRevision !== undefined && locator.revision !== expectedRevision) throw new SourceRevisionChangedError(`Asset changed before reading chunk ${chunkId}: ${guid}`);
    const asset = this.byGuid.get(guid);
    if (!asset || asset.locator !== locator) throw new SourceRevisionChangedError(`Asset changed while preparing chunk ${chunkId}: ${guid}`);
    const entry = asset.header.chunks.find((chunk) => chunk.id === chunkId);
    if (!entry) throw new Error(`Missing chunk ${chunkId} in asset ${guid} (${asset.path})`);
    return this.loader.loadChunk(locator, entry, this.blobsForAsset(asset), this.storageForAsset(asset), options);
  }

  /** Reserve memory before reading: every chunk records its length. */
  async getChunkByteLength(guid: string, chunkId: string, expectedRevision?: string, options: StorageReadOptions = {}): Promise<number> {
    const locator = await this.getAssetLocator(guid, options);
    options.signal?.throwIfAborted();
    return this.chunkByteLength(guid, chunkId, locator, expectedRevision);
  }

  /** Size a chunk of a catalog snapshot the caller has just resolved, without refreshing it again. */
  async chunkByteLength(guid: string, chunkId: string, locator: AssetSourceLocator, expectedRevision?: string): Promise<number> {
    if (expectedRevision !== undefined && locator.revision !== expectedRevision) throw new SourceRevisionChangedError(`Asset changed before estimating chunk ${chunkId}: ${guid}`);
    const asset = this.byGuid.get(guid);
    if (!asset || asset.locator !== locator) throw new SourceRevisionChangedError(`Asset changed while estimating chunk ${chunkId}: ${guid}`);
    const entry = asset?.header.chunks.find((chunk) => chunk.id === chunkId);
    if (!asset || !entry) throw new Error(`Missing chunk ${chunkId} in asset ${guid}`);
    return entry.byteLength;
  }

  /** Document opening does not pull in retained originals or derived representations. */
  async readAssetDocument(guid: string, options: StorageReadOptions = {}): Promise<AssetDocument> {
    const locator = await this.getAssetLocator(guid, options);
    options.signal?.throwIfAborted();
    const asset = this.byGuid.get(guid);
    if (!asset || asset.placeholder) throw new Error(`Asset is unavailable: ${guid}`);
    const { header } = asset;
    const body = header.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID);
    const payload = body
      ? JSON.parse(textDecoder.decode(await this.readChunk(guid, body.id, locator.revision, options))) as Record<string, unknown>
      : header.payload;
    if (!body) await validateAssetSourceLocator(this.storageForAsset(asset), locator, options);
    options.signal?.throwIfAborted();
    if (this.byGuid.get(guid) !== asset) throw new Error(`Asset changed while reading document: ${guid}`);
    if (!body && Object.keys(payload).length === 0 && header.type !== "Audio") {
      throw new Error(`Asset ${guid} is missing its "${DOCUMENT_CHUNK_ID}" chunk or header payload`);
    }
    return { guid, type: header.type, name: header.name, version: header.version, payload };
  }

  /**
   * Scan a root into the index, replacing what an earlier mount of the same
   * id indexed. A folder that cannot be listed fails the mount and leaves the
   * root unmounted: a partial index would hide the folder's assets, and
   * deleting that folder would remove them unseen.
   */
  async mountRoot(root: ContentRoot): Promise<void> {
    if (this.roots.has(root.id)) this.unmountRoot(root.id);
    this.roots.set(root.id, root);
    this.changed();
    const storage = this.storageOf(root);
    try {
      if (storage.withReadScope) {
        await storage.withReadScope((reader) => walkRoot(this.host, root, root.pathPrefix, reader));
      } else await walkRoot(this.host, root, root.pathPrefix, storage);
    } catch (error) {
      // A remount of this id meanwhile owns the root now.
      if (this.roots.get(root.id) === root) this.unmountRoot(root.id);
      throw error;
    }
  }

  /**
   * Asset files the scans left out of the index because an already indexed
   * file has the same guid. They stay on disk; a folder holding one cannot be
   * deleted here until the copy gets its own guid or is removed.
   */
  listGuidConflicts(): GuidConflict[] {
    return [...this.guidConflicts.values()];
  }

  unmountRoot(rootId: string): void {
    const root = this.roots.get(rootId);
    if (this.roots.delete(rootId)) this.changed();
    for (const asset of [...this.byGuid.values()]) {
      if (asset.rootId === rootId) {
        this.removeFromIndex(asset);
      }
    }
    for (const [path, conflict] of [...this.guidConflicts]) {
      if (conflict.rootId === rootId) this.guidConflicts.delete(path);
    }
    if (!root) return;
    // A remount walks storage again; folders removed meanwhile must not linger.
    const remaining = [...this.roots.values()];
    for (const folder of [...this.knownFolders]) {
      if (
        isWithinFolder(folder, root.pathPrefix) &&
        !remaining.some((other) => isWithinFolder(folder, other.pathPrefix))
      ) {
        this.removeKnownFolder(folder);
      }
    }
  }

  getRoot(rootId: string): ContentRoot | undefined {
    return this.roots.get(rootId);
  }

  listRoots(): ContentRoot[] {
    return [...this.roots.values()];
  }

  storageFor(rootId: string): ProjectStorage {
    return this.roots.get(rootId)?.storage ?? this.storage;
  }

  blobsFor(rootId: string): BlobStore {
    const root = this.roots.get(rootId);
    return root ? this.blobsOf(root) : this.blobs;
  }

  indexPlaceholder(guid: string): IndexedAsset {
    const existing = this.byGuid.get(guid);
    if (existing && !existing.placeholder) return existing;
    const header: HassetHeader = {
      chunks: [],
      dependencies: [],
      dependencyMetadataVersion: ASSET_DEPENDENCY_METADATA_VERSION,
      engineVersion: ENGINE_VERSION,
      guid,
      mode: "thin",
      name: "Missing Asset",
      parentClass: null,
      payload: {},
      requiredDependencies: [],
      type: "Unresolved",
      version: 0,
    };
    return this.indexHeader("unresolved", `__unresolved__/${guid}`, header, true);
  }

  getByGuid(guid: string): IndexedAsset | undefined {
    return this.byGuid.get(guid);
  }

  /** Full authored graph, including symbolic class references from old authoring contexts. */
  dependenciesFor(guid: string, header = this.byGuid.get(guid)?.header): string[] {
    return header ? resolveDependenciesWithClassAliases(header, () => this.classAliases()) : [];
  }

  /** Required class identities resolve entirely from the mounted metadata catalog. */
  requiredDependenciesFor(guid: string, header = this.byGuid.get(guid)?.header): string[] {
    if (!header) throw new Error(`Required asset is missing: ${guid}`);
    return resolveDependenciesWithClassAliases(header, () => this.classAliases(), true);
  }

  private classAliases(): ClassAliasIndex {
    const generation = this.generation;
    if (this.classAliasMemo?.generation !== generation) {
      this.classAliasMemo = { generation, index: buildClassAliasIndex(this.byGuid.values()) };
    }
    return this.classAliasMemo.index;
  }

  /**
   * Guid of each asset -> guids of the assets whose symbolic Class references resolve to it,
   * from the catalog as of `generation`. One pass over the catalog answers `showReferences`
   * for every asset, instead of one pass per asset asked about.
   */
  private symbolicInbound(): ReadonlyMap<string, readonly string[]> {
    const generation = this.generation;
    if (this.symbolicInboundMemo?.generation !== generation) {
      const index = new Map<string, string[]>();
      for (const asset of this.byGuid.values()) {
        if (!asset.header.classReferences?.length) continue;
        // `resolveDependenciesWithClassAliases` returns each target once.
        for (const target of resolveDependenciesWithClassAliases({ ...asset.header, dependencies: [] }, () => this.classAliases())) {
          const referrers = index.get(target);
          if (referrers) referrers.push(asset.header.guid);
          else index.set(target, [asset.header.guid]);
        }
      }
      this.symbolicInboundMemo = { generation, index };
    }
    return this.symbolicInboundMemo.index;
  }

  getByPath(path: string): IndexedAsset | undefined {
    return this.byPath.get(path);
  }

  list(filter?: { rootId?: string; type?: string }): IndexedAsset[] {
    let out = [...this.byGuid.values()];
    if (filter?.rootId) {
      out = out.filter((asset) => asset.rootId === filter.rootId);
    }
    if (filter?.type) {
      out = out.filter((asset) => asset.header.type === filter.type);
    }
    return out;
  }

  folderTree(rootId: string): FolderNode {
    const root = this.getRootOrThrow(rootId);
    return buildFolderTree(root, this.knownFolders, this.list({ rootId }));
  }

  /** Resolve symbolic classes alongside GUID edges without reading any payloads. */
  showReferences(guid: string): { outbound: string[]; inbound: string[] } {
    const symbolicInbound = this.byGuid.has(guid) ? this.symbolicInbound().get(guid) ?? [] : [];
    return {
      outbound: this.dependenciesFor(guid),
      inbound: [...new Set([
        ...(this.inbound.get(guid) ?? []),
        ...symbolicInbound,
      ])].sort(),
    };
  }

  async createAsset(
    rootId: string,
    relativePath: string,
    result: ImportResult,
  ): Promise<IndexedAsset> {
    return this.withCreationWrite(() => createAssetUnlocked(this.host, rootId, relativePath, result));
  }

  /** Re-read a .hasset header after an in-place save so catalog fields stay current. */
  async reindexPath(path: string): Promise<IndexedAsset | null> {
    const existing = this.byPath.get(path);
    const rootId =
      existing?.rootId ??
      [...this.roots.values()].find(
        (root) => path === root.pathPrefix || path.startsWith(`${root.pathPrefix}/`),
      )?.id;
    if (!rootId) return null;
    const storage = this.storageFor(rootId);
    if (!(await storage.exists(path))) return null;
    const { header, locator } = await readAssetCatalog(storage, path);
    const mtime = await this.statMtime(storage, path);
    return this.indexHeader(rootId, path, header, false, mtime, locator);
  }

  async deleteAsset(guid: string): Promise<void> {
    return this.withAssetWrite(guid, () => this.deleteAssetUnlocked(guid));
  }

  private async deleteAssetUnlocked(guid: string): Promise<void> {
    const asset = this.byGuid.get(guid);
    if (!asset) return;
    if (asset.placeholder) {
      this.removeFromIndex(asset);
      return;
    }
    const root = this.roots.get(asset.rootId);
    if (root) this.assertWritable(root);
    await this.storageForAsset(asset).remove(asset.path);
    this.removeFromIndex(asset);
  }

  async deleteFolder(rootId: string, relativeFolder: string): Promise<void> {
    return this.withFolderWrite(() => deleteFolderUnlocked(this.host, rootId, relativeFolder));
  }

  async createFolder(rootId: string, relativeFolder: string): Promise<void> {
    return this.withCreationWrite(() => createFolderUnlocked(this.host, rootId, relativeFolder));
  }

  async moveAsset(
    guid: string,
    rootId: string,
    newRelativePath: string,
  ): Promise<IndexedAsset> {
    return this.withAssetWrite(guid, () => moveAssetUnlocked(this.host, guid, rootId, newRelativePath));
  }

  /** Keep recorded guid conflicts pointing at files a move relocated. */
  private repathGuidConflicts(map: (path: string) => string): void {
    for (const [path, conflict] of [...this.guidConflicts]) {
      const next = { ...conflict, path: map(conflict.path), indexedPath: map(conflict.indexedPath) };
      if (next.path === conflict.path && next.indexedPath === conflict.indexedPath) continue;
      this.guidConflicts.delete(path);
      this.guidConflicts.set(next.path, next);
    }
  }

  async renameAsset(guid: string, newName: string): Promise<IndexedAsset> {
    return this.withAssetWrite(guid, () => renameAssetUnlocked(this.host, guid, newName));
  }

  /** With `signal`, an abort before the copy is written throws and writes nothing. */
  async duplicateAsset(
    guid: string,
    rootId: string,
    targetFolderRelative = "",
    options: AssetCopyOptions = {},
  ): Promise<IndexedAsset> {
    options.signal?.throwIfAborted();
    const duplicate = await this.withCreationWrite(() => duplicateAssetUnlocked(this.host, guid, rootId, targetFolderRelative, options.signal));
    await alignCreatedTextures(this.host, [duplicate]);
    return duplicate;
  }

  /** Copy into a folder (same as duplicate with an explicit destination folder). */
  async copyAsset(
    guid: string,
    rootId: string,
    targetFolderRelative: string,
    options: AssetCopyOptions = {},
  ): Promise<IndexedAsset> {
    return this.duplicateAsset(guid, rootId, targetFolderRelative, options);
  }

  /**
   * With `signal`, an abort stops the copy between files and deletes the
   * partly written copy before throwing, so a canceled copy leaves nothing.
   */
  copyFolder(
    rootId: string,
    relativeFolder: string,
    targetParentRelative: string,
    options: AssetCopyOptions = {},
  ): Promise<string> {
    return copyFolder(this.host, rootId, relativeFolder, targetParentRelative, options);
  }

  async duplicateFolder(
    rootId: string,
    relativeFolder: string,
    options: AssetCopyOptions = {},
  ): Promise<string> {
    const parent = relativeFolder.includes("/")
      ? relativeFolder.slice(0, relativeFolder.lastIndexOf("/"))
      : "";
    return this.copyFolder(rootId, relativeFolder, parent, options);
  }

  /**
   * Move a folder of `rootId` under `newParentRelative` of `targetRootId`
   * (the same root unless given), optionally renaming it.
   */
  async moveFolder(
    rootId: string,
    relativeFolder: string,
    newParentRelative: string,
    newName?: string,
    targetRootId = rootId,
  ): Promise<void> {
    return this.withFolderWrite(() => moveFolderUnlocked(this.host, rootId, relativeFolder, newParentRelative, newName, targetRootId));
  }

  importFile(
    rootId: string,
    folderRelative: string,
    fileName: string,
    bytes: Uint8Array,
    extras?: ImportFileExtras,
  ): Promise<IndexedAsset[]> {
    return importFile(this.host, rootId, folderRelative, fileName, bytes, extras);
  }

  /**
   * Convert an environment Texture's kept `.hdr` again with another Face
   * Size, replacing its cube. Resolves false when nothing was written (the
   * Texture is read-only, gone, or its `.hdr` changed meanwhile). Throws when
   * it keeps no `.hdr` (imported before sources were kept, or from DDS/ENV).
   */
  reconvertHdrEnvironment(
    guid: string,
    faceSize: number,
    convert: HdrEnvironmentConverter,
    control: AssetImportControl = {},
  ): Promise<boolean> {
    return reconvertHdrEnvironment(this.host, guid, faceSize, convert, control);
  }

  /**
   * `canWrite`, when set, is asked right before the write with the header of
   * the file on disk it would replace; false skips it.
   */
  setCompressionState(
    guid: string,
    state: TextureCompressionState,
    options?: { error?: string; canWrite?: (guid: string, current: HassetHeader) => boolean },
  ): Promise<void> {
    return setCompressionState(this.host, guid, state, options);
  }

  /**
   * Store an encode under its chunk id and record what was committed:
   * `ktx2Width` / `ktx2Height` from the KTX2 header, and `ktx2BlockAlign`
   * whenever padding was requested (a no-op for a size already on the grid),
   * plus `ktx2Sha256`, the committed bytes these describe. The alignment pass
   * reads these instead of the chunk while that sha256 still matches.
   *
   * An encode on the grid for a Texture no atlas uses also drops older KTX2
   * chunks off the grid: the resolver binds a retained chunk whose id it
   * prefers, or the first one when none matches, and WebGPU would decode it
   * to RGBA. An atlas keeps them (its own-size encode, should a Particle
   * Usage be switched back). Resolves false when nothing was written (the
   * Texture is gone or in a read-only root, or the job may not write the file
   * on disk now: `encodeJobMayWrite`).
   */
  commitCompressedTexture(result: EncodeJobResult): Promise<boolean> {
    return commitCompressedTexture(this.host, result);
  }

  /** Explicit asset processing/build work. Gameplay only consumes the committed chunk. */
  prepareAreaEmission(guid: string, process: AreaEmissionProcessor, options: { signal?: AbortSignal; onProgress?: (value: AreaEmissionProgress) => void } = {}): Promise<Uint8Array> {
    return prepareAreaEmission(this.host, guid, process, options);
  }

  /**
   * Re-encode a Texture. `usage` overrides the saved header's Usage so a
   * Details edit that has not been saved yet encodes with its new policy.
   * Every job carries its source's sha256, so its commit writes nothing once
   * the file's source pixels changed. A `guard`ed re-encode (the alignment
   * pass) also writes no state before its commit, and its guard is asked
   * again when the job starts and before each write. A Texture in a
   * read-only root is never queued. A Texture has one job: repeating the
   * request it already has queues nothing, a request with changed settings
   * supersedes the older job (`EncodeQueue.enqueue`), and a guarded request
   * gives way to any job. Resolves false when nothing was requested (including
   * that last case), true when the Texture is queued, running or about to be
   * committed for this request.
   */
  retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean; usage?: string; guard?: EncodeJobGuard },
  ): Promise<boolean> {
    return retryTextureEncoding(this.host, guid, options);
  }

  /**
   * Re-queue textures that fell back when the transcoder was unavailable, or
   * whose `pending` / `encoding` job an earlier session left behind. A Texture
   * the queue already holds a job for is left to it (a remount rescans).
   */
  requeueUncompressedTextures(): Promise<number> {
    return requeueUncompressedTextures(this.host);
  }

  /** Paths of Scene and Class assets for ProjectDocument reconciliation. */
  listDocumentPaths(filter?: { rootId?: string }): { scenes: string[]; graphs: string[] } {
    const scenes: string[] = [];
    const graphs: string[] = [];
    for (const asset of this.byGuid.values()) {
      if (asset.placeholder || asset.header.type === "Unresolved") continue;
      if (filter?.rootId && asset.rootId !== filter.rootId) continue;
      if (asset.header.type === "Scene") scenes.push(asset.path);
      else if (asset.header.type === "Class") graphs.push(asset.path);
    }
    return { scenes: scenes.sort(), graphs: graphs.sort() };
  }

  /** A Tileset, Sprite or Sprite Animation samples this texture as an atlas. */
  isAtlasTexture(guid: string): boolean {
    return this.atlas.isAtlasTexture(guid);
  }

  /**
   * Report textures whose atlas status changed (a referrer saved, deleted,
   * duplicated, imported, or a plugin root mounted). Set after the initial
   * scan.
   */
  setAtlasStatusListener(listener: ((textureGuids: string[]) => void) | null): void {
    this.atlas.setListener(listener);
  }

  /**
   * Requeue `compressed` textures whose committed encode no longer matches
   * the alignment policy: a non-atlas encode off the 4-texel grid, or an atlas
   * encode that was padded. Particle is always aligned. Skips read-only roots
   * and textures `canWrite` refuses (the editor's rule for background
   * re-encodes). An aligned texture is never requeued. Returns the requeued
   * guids.
   */
  reconcileTextureAlignment(options: TextureAlignmentOptions = {}): Promise<string[]> {
    return reconcileTextureAlignment(this.host, options);
  }

  /**
   * Whether `reconcileTextureAlignment` would requeue this Texture, whatever
   * the editor's `canWrite`: its committed encode is stale for the alignment
   * policy, and no encode for it waits or runs. Texture Details offers
   * **Retry Encoding** for it, the user's own re-encode.
   */
  isTextureAlignmentStale(
    guid: string,
    options: { usage?: string; ktx2SizeCache?: Map<string, ImageSize | null> } = {},
  ): Promise<boolean> {
    return isTextureAlignmentStale(this.host, guid, options);
  }

  /** Serialize read/modify/write with derived chunks, document saves and moves. */
  withAssetWrite<T>(guid: string, work: () => Promise<T>): Promise<T> {
    const next = Promise.all([this.textureWriteChain.get(guid), this.folderWriteChain]).then(work);
    const settled = next.then(() => undefined, () => undefined);
    this.textureWriteChain.set(guid, settled);
    void settled.then(() => {
      if (this.textureWriteChain.get(guid) === settled) this.textureWriteChain.delete(guid);
    });
    return next;
  }

  /** New GUIDs are not in the asset queue yet, but their files belong in a pending move. */
  private withCreationWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = this.folderWriteChain.then(work);
    const settled = next.then(() => undefined, () => undefined);
    this.creationWrites.add(settled);
    void settled.then(() => this.creationWrites.delete(settled));
    return next;
  }

  /** Fence leaf writes before enumerating a tree; later writes enter after relocation. */
  private withFolderWrite<T>(work: () => Promise<T>): Promise<T> {
    const pending = [this.folderWriteChain, ...this.textureWriteChain.values(), ...this.creationWrites];
    const next = Promise.all(pending).then(work);
    this.folderWriteChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private storageOf(root: ContentRoot): ProjectStorage {
    return root.storage ?? this.storage;
  }

  private blobsOf(root: ContentRoot): BlobStore {
    const storage = this.storageOf(root);
    const dir = `${root.pathPrefix}/.blobs`;
    if (storage === this.storage && dir === "assets/.blobs") return this.blobs;
    return createVfsBlobStore(storage, dir);
  }

  private assertWritable(root: ContentRoot): void {
    if (root.readOnly) {
      throw new Error(`Content root "${root.id}" is read-only`);
    }
  }

  private storageForAsset(asset: IndexedAsset): ProjectStorage {
    return this.storageFor(asset.rootId);
  }

  private blobsForAsset(asset: IndexedAsset): BlobStore {
    return this.blobsFor(asset.rootId);
  }

  private async statMtime(
    storage: ProjectStorage,
    path: string,
  ): Promise<number | null> {
    try {
      return (await storage.stat(path)).mtime;
    } catch {
      return null;
    }
  }

  private getRootOrThrow(rootId: string): ContentRoot {
    const root = this.roots.get(rootId);
    if (!root) {
      throw new Error(`Unknown content root: ${rootId}`);
    }
    return root;
  }

  private indexHeader(
    rootId: string,
    path: string,
    header: HassetHeader,
    placeholder = false,
    mtime: number | null = null,
    locator?: AssetSourceLocator,
  ): IndexedAsset {
    const indexed: IndexedAsset = { rootId, path, header, placeholder, mtime, locator };
    // A write that finishes after its root was unmounted leaves the index alone.
    if (!placeholder && !this.roots.has(rootId)) return indexed;
    const existingAtPath = this.byPath.get(path);
    if (existingAtPath) this.removeFromIndex(existingAtPath, existingAtPath.header.guid === header.guid);
    const existingByGuid = this.byGuid.get(header.guid);
    if (existingByGuid) this.removeFromIndex(existingByGuid, true);

    this.byGuid.set(header.guid, indexed);
    this.byPath.set(path, indexed);
    this.changed();
    for (const dep of header.dependencies) {
      let set = this.inbound.get(dep);
      if (!set) {
        set = new Set();
        this.inbound.set(dep, set);
      }
      set.add(header.guid);
    }
    if (!placeholder) this.atlas.indexReferrer(header);
    return indexed;
  }

  private removeFromIndex(asset: IndexedAsset, preserveInbound = false): void {
    this.byGuid.delete(asset.header.guid);
    if (this.byPath.get(asset.path) === asset) {
      this.byPath.delete(asset.path);
    }
    this.changed();
    this.atlas.setReferrer(asset.header.guid, []);
    for (const dep of asset.header.dependencies) {
      const set = this.inbound.get(dep);
      set?.delete(asset.header.guid);
      if (set && set.size === 0) this.inbound.delete(dep);
    }
    // Remaining referrers are rewritten to None by Content Browser delete
    // (`ProjectService.clearDeletedAssetReferences`), not here — Skybox
    // Creator replace deletes then recreates the same guid.
    if (!preserveInbound) this.inbound.delete(asset.header.guid);
  }
}
