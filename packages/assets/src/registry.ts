import type { ProjectStorage, ProjectStorageReader } from "@babylonslate/core";
import { ENGINE_VERSION } from "@babylonslate/core";
import {
  decodeBabasset,
  encodeBabasset,
  readBabassetHeader,
  type BabassetHeader,
  type ChunkInput,
} from "./babasset";
import { createVfsBlobStore, type BlobStore } from "./blob-store";
import type { ContentRoot } from "./content-root";
import { encodeJobMayWrite, type EncodeJobGuard, type EncodeJobResult, type EncodeQueue } from "./encode-queue";
import { newAssetGuid } from "./guid";
import { isEnvironmentTexturePayload } from "./environment-texture";
import {
  importByExtension,
  remapImportResultGuids,
  type ImportOptions,
  type ImportResult,
} from "./importers";
import { mergeFontAttachPayload } from "./font-payload";
import { AccountedPayloadLoader } from "./payload-loader";
import {
  assetFileSuffix,
  nextCopyName,
  stripAssetFileSuffix,
} from "./unique-names";
import { DOCUMENT_CHUNK_ID, decodeAssetDocument, stampDocumentChunkName } from "./asset-document";
import { ATLAS_REFERRER_TYPES, atlasTextureGuids, headerAtlasTextureGuids } from "./atlas-textures";
import { sniffSourceImageSize, type ImageSize } from "./image-size";
import { sniffKtx2Size } from "./ktx2-info";
import { clampDimension,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  effectiveTextureMaxDimension,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  TEXTURE_BLOCK_EDGE,
  textureEncodeChunkId,
  type TextureCompressionState,
  type TextureEncodeSettings,
} from "./texture-compression";
import { payloadPixelSize, textureEncodeSettingsFor } from "./resolve-gpu-texture";
import { DEFAULT_THUMBNAIL_MAX_EDGE, generateThumbnailBytes } from "./thumbnails";
import { AREA_EMISSION_CHUNK_KIND, areaEmissionChunkId, currentAreaEmissionChunk, decodeAreaEmission, type AreaEmissionProgress } from "./area-emission";
import { sha256Hex } from "./bytes";
import { moveStorageFile, moveStorageTree, STORAGE_MOVE_BACKUP_PREFIX } from "./storage-move";

export type AreaEmissionProcessor = (request: { source: Uint8Array; sourceHash: string; mime?: string }, signal: AbortSignal, onProgress?: (progress: AreaEmissionProgress) => void) => Promise<Uint8Array>;

/** Index entry: header-only, never a decoded payload (engineplan §2.4). */
export interface IndexedAsset {
  rootId: string;
  path: string;
  header: BabassetHeader;
  /** Missing plugin/dependency guid kept so references do not drop. */
  placeholder?: boolean;
  /** Filesystem mtime in ms, from `DirEntry` / `stat` when known. */
  mtime?: number | null;
}

export type ThumbnailWriter = (
  assetGuid: string,
  bytes: Uint8Array,
) => Promise<void>;

/**
 * The registry rewrote an asset file itself (Texture encode state, committed
 * encode, derived chunk): its mtime just before and after that write.
 */
export interface OwnAssetWrite {
  path: string;
  previousMtime: number | null;
  mtime: number | null;
}

/** Marker file so empty folders survive Git and remount scans. */
export const FOLDER_MARKER_NAME = ".babylonslate-folder";

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  assets: string[];
}

/**
 * Change counter behind `AssetRegistry.generation`. Registries that share one
 * clock (every remount of a project) advance it together, so a registry that
 * replaces another never reports an earlier or repeated generation.
 */
export class RegistryGenerationClock {
  private current = 0;

  get value(): number {
    return this.current;
  }

  /** Record a change to what a registry sharing this clock reports. */
  advance(): void {
    this.current += 1;
  }
}

export interface AssetRegistryOptions {
  payloadLoader?: AccountedPayloadLoader;
  blobs?: BlobStore;
  /**
   * Shared change counter. Pass the same clock to every remount so the
   * generation keeps rising when a new registry replaces the previous one.
   */
  generationClock?: RegistryGenerationClock;
  /**
   * Textures each decoded legacy atlas referrer samples, by type and document
   * chunk sha256. Pass the same map to every remount so unchanged referrers
   * are not read and decoded again.
   */
  legacyAtlasCache?: Map<string, readonly string[]>;
  /**
   * Textures an alignment check is requeuing right now. Pass the same set to
   * every remount that shares one encode queue, so a check on the previous
   * registry and one on the next skip each other's Texture.
   */
  alignmentRequeues?: Set<string>;
}

const BLOBS_DIR_NAME = ".blobs";

/**
 * Content-root-aware asset registry (engineplan §10.2, docs/architecture/asset-registry.md).
 * Scanning and browsing only ever call `readBabassetHeader`; payload bytes
 * load on demand through `payloadLoader`.
 */
export class AssetRegistry {
  private readonly storage: ProjectStorage;
  private readonly blobs: BlobStore;
  private readonly loader: AccountedPayloadLoader;
  private readonly roots = new Map<string, ContentRoot>();
  private readonly byGuid = new Map<string, IndexedAsset>();
  private readonly byPath = new Map<string, IndexedAsset>();
  /** Empty (or marker-backed) folders discovered during scan, keyed by storage path. */
  private readonly knownFolders = new Set<string>();
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
  /** Atlas referrer (Tileset, Sprite, Sprite Animation) guid -> textures it samples. */
  private readonly atlasByReferrer = new Map<string, readonly string[]>();
  /** Texture guid -> atlas referrers sampling it. */
  private readonly atlasReferrers = new Map<string, Set<string>>();
  /** Atlas referrers whose header predates the `atlasTextures` meta. */
  private readonly legacyAtlasReferrers = new Set<string>();
  private legacyAtlasResolution: Promise<void> = Promise.resolve();
  private atlasStatusListener: ((textureGuids: string[]) => void) | null = null;
  /** Texture guid -> atlas status before the changes not yet reported. */
  private readonly atlasStatusBefore = new Map<string, boolean>();
  private atlasFlushScheduled = false;
  private ownWriteListener: ((write: OwnAssetWrite) => void) | null = null;
  private createdTextureListener: ((asset: IndexedAsset) => void) | null = null;
  private readonly legacyAtlasCache: Map<string, readonly string[]>;
  /**
   * Textures an alignment check is requeuing right now. Imports and
   * Duplicates run the pass outside the editor's serialized passes, so a
   * concurrent one skips them rather than queue a second copy.
   */
  private readonly alignmentRequeues: Set<string>;
  private readonly clock: RegistryGenerationClock;

  constructor(storage: ProjectStorage, options: AssetRegistryOptions = {}) {
    this.storage = storage;
    this.blobs = options.blobs ?? createVfsBlobStore(storage);
    this.loader =
      options.payloadLoader ?? new AccountedPayloadLoader(storage, { blobs: this.blobs });
    this.legacyAtlasCache = options.legacyAtlasCache ?? new Map();
    this.alignmentRequeues = options.alignmentRequeues ?? new Set();
    this.clock = options.generationClock ?? new RegistryGenerationClock();
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
   * committed (a `.babasset` import, a Duplicate or Copy): a new file, so its
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

  async mountRoot(root: ContentRoot): Promise<void> {
    this.roots.set(root.id, root);
    this.changed();
    const storage = this.storageOf(root);
    if (storage.withReadScope) {
      await storage.withReadScope((reader) => this.walk(root, root.pathPrefix, reader));
    } else await this.walk(root, root.pathPrefix, storage);
  }

  unmountRoot(rootId: string): void {
    if (this.roots.delete(rootId)) this.changed();
    for (const asset of [...this.byGuid.values()]) {
      if (asset.rootId === rootId) {
        this.removeFromIndex(asset);
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
    const header: BabassetHeader = {
      chunks: [],
      dependencies: [],
      engineVersion: ENGINE_VERSION,
      guid,
      mode: "thin",
      name: "Missing Asset",
      parentClass: null,
      payload: {},
      type: "Unresolved",
      version: 0,
    };
    return this.indexHeader("unresolved", `__unresolved__/${guid}`, header, true);
  }

  getByGuid(guid: string): IndexedAsset | undefined {
    return this.byGuid.get(guid);
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
    const rootNode: FolderNode = {
      name: root.pathPrefix.split("/").pop() ?? root.pathPrefix,
      path: root.pathPrefix,
      children: [],
      assets: [],
    };
    const nodes = new Map<string, FolderNode>([[root.pathPrefix, rootNode]]);

    const ensureNode = (path: string): FolderNode => {
      const existing = nodes.get(path);
      if (existing) return existing;
      const parentPath = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : root.pathPrefix;
      const parent = parentPath === path ? rootNode : ensureNode(parentPath);
      const node: FolderNode = {
        name: path.slice(path.lastIndexOf("/") + 1),
        path,
        children: [],
        assets: [],
      };
      parent.children.push(node);
      nodes.set(path, node);
      return node;
    };

    for (const folderPath of this.knownFolders) {
      if (
        folderPath === root.pathPrefix ||
        folderPath.startsWith(`${root.pathPrefix}/`)
      ) {
        ensureNode(folderPath);
      }
    }

    for (const asset of this.list({ rootId })) {
      const dir = asset.path.includes("/")
        ? asset.path.slice(0, asset.path.lastIndexOf("/"))
        : root.pathPrefix;
      const node = dir === root.pathPrefix ? rootNode : ensureNode(dir);
      node.assets.push(asset.header.guid);
    }

    sortFolderTree(rootNode);
    return rootNode;
  }

  /** Outbound deps from the header; inbound from the reverse index. */
  showReferences(guid: string): { outbound: string[]; inbound: string[] } {
    const asset = this.byGuid.get(guid);
    return {
      outbound: asset ? [...asset.header.dependencies] : [],
      inbound: [...(this.inbound.get(guid) ?? [])],
    };
  }

  async createAsset(
    rootId: string,
    relativePath: string,
    result: ImportResult,
  ): Promise<IndexedAsset> {
    return this.withCreationWrite(() => this.createAssetUnlocked(rootId, relativePath, result));
  }

  private async createAssetUnlocked(rootId: string, relativePath: string, result: ImportResult): Promise<IndexedAsset> {
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const path = joinRootPath(root, relativePath);
    if (this.byPath.has(path) || (await storage.exists(path))) {
      throw new Error(`Asset already exists: ${path}`);
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir) {
      await storage.mkdir(dir, true);
    }

    const bytes = await encodeBabasset({
      header: {
        guid: result.guid,
        type: result.type,
        name: result.name,
        engineVersion: "0.0.0",
        version: result.version,
        mode: "thin",
        dependencies: result.dependencies,
        parentClass: result.parentClass ?? null,
        payload: result.payload,
      },
      chunks: result.chunks,
      writeBlob: (sha256, data) => this.blobsOf(root).writeBlob(sha256, data),
    });
    await storage.writeBinary(path, bytes);
    const header = readBabassetHeader(bytes);
    const mtime = await this.statMtime(storage, path);
    return this.reportCreatedTexture(this.indexHeader(rootId, path, header, false, mtime));
  }

  /** Re-read a .babasset header after an in-place save so catalog fields stay current. */
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
    const header = readBabassetHeader(await storage.readBinary(path));
    const mtime = await this.statMtime(storage, path);
    return this.indexHeader(rootId, path, header, false, mtime);
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
    return this.withFolderWrite(() => this.deleteFolderUnlocked(rootId, relativeFolder));
  }

  private async deleteFolderUnlocked(rootId: string, relativeFolder: string): Promise<void> {
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const folderPath = joinRootPath(root, relativeFolder);
    for (const asset of [...this.byGuid.values()]) {
      if (asset.rootId === rootId && isWithinFolder(asset.path, folderPath)) {
        await this.deleteAssetUnlocked(asset.header.guid);
      }
    }
    await storage.remove(folderPath);
    for (const known of [...this.knownFolders]) {
      if (isWithinFolder(known, folderPath)) {
        this.removeKnownFolder(known);
      }
    }
  }

  async createFolder(rootId: string, relativeFolder: string): Promise<void> {
    return this.withCreationWrite(() => this.createFolderUnlocked(rootId, relativeFolder));
  }

  private async createFolderUnlocked(rootId: string, relativeFolder: string): Promise<void> {
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const folderPath = joinRootPath(root, relativeFolder);
    if (!relativeFolder.replace(/^\/+|\/+$/g, "")) {
      throw new Error("Cannot create the assets root folder");
    }
    if (
      this.knownFolders.has(folderPath) ||
      (await storage.exists(folderPath))
    ) {
      throw new Error(`Folder already exists: ${folderPath}`);
    }
    await storage.mkdir(folderPath, true);
    await storage.writeText(
      `${folderPath}/${FOLDER_MARKER_NAME}`,
      "# BabylonSlate folder marker\n",
    );
    this.addKnownFolder(folderPath);
    // Ensure parent folders are visible even without their own markers.
    let parent = folderPath.includes("/")
      ? folderPath.slice(0, folderPath.lastIndexOf("/"))
      : "";
    while (parent && parent.startsWith(root.pathPrefix)) {
      this.addKnownFolder(parent);
      if (parent === root.pathPrefix) break;
      parent = parent.includes("/")
        ? parent.slice(0, parent.lastIndexOf("/"))
        : "";
    }
  }

  async moveAsset(
    guid: string,
    rootId: string,
    newRelativePath: string,
  ): Promise<IndexedAsset> {
    return this.withAssetWrite(guid, () => this.moveAssetUnlocked(guid, rootId, newRelativePath));
  }

  private async moveAssetUnlocked(guid: string, rootId: string, newRelativePath: string): Promise<IndexedAsset> {
    const asset = this.byGuid.get(guid);
    if (!asset) throw new Error(`Unknown asset ${guid}`);
    if (asset.rootId !== rootId) {
      throw new Error("Cross-root moves are not supported yet");
    }
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const newPath = joinRootPath(root, newRelativePath);
    if (newPath === asset.path) return asset;
    if (this.byPath.has(newPath)) {
      throw new Error(`Target path already exists: ${newPath}`);
    }
    const bytes = await storage.readBinary(asset.path);
    await moveStorageFile(storage, asset.path, newPath, bytes);
    // Keep inbound refs: guid identity is unchanged, only the storage path moves.
    if (this.byPath.get(asset.path) === asset) {
      this.byPath.delete(asset.path);
    }
    const moved: IndexedAsset = { ...asset, path: newPath };
    this.byGuid.set(guid, moved);
    this.byPath.set(newPath, moved);
    this.changed();
    return moved;
  }

  async renameAsset(guid: string, newName: string): Promise<IndexedAsset> {
    return this.withAssetWrite(guid, () => this.renameAssetUnlocked(guid, newName));
  }

  private async renameAssetUnlocked(guid: string, newName: string): Promise<IndexedAsset> {
    const asset = this.byGuid.get(guid);
    if (!asset) throw new Error(`Unknown asset ${guid}`);
    const root = this.roots.get(asset.rootId);
    if (root) this.assertWritable(root);
    const storage = this.storageForAsset(asset);
    const blobs = this.blobsForAsset(asset);
    const safe = sanitizeFileName(newName);
    if (!safe) throw new Error("Invalid asset name");
    const dir = asset.path.includes("/")
      ? asset.path.slice(0, asset.path.lastIndexOf("/"))
      : "";
    const suffix = asset.header.type === "DataDefinition" || asset.header.type === "DataSheet" ? assetFileSuffix(asset.path) : ".babasset";
    const newPath = dir ? `${dir}/${safe}${suffix}` : `${safe}${suffix}`;
    if (newPath !== asset.path && this.byPath.has(newPath)) {
      throw new Error(`Target path already exists: ${newPath}`);
    }
    const fileBytes = await storage.readBinary(asset.path);
    const decoded = await decodeBabasset(fileBytes, (sha256) =>
      blobs.readBlob(sha256),
    );
    const chunksById = new Map<string, ChunkInput>();
    for (const entry of decoded.header.chunks) {
      const data = decoded.chunks.get(entry.id);
      if (data) {
        chunksById.set(entry.id, {
          id: entry.id,
          kind: entry.kind,
          mime: entry.mime,
          data,
        });
      }
    }
    const { chunks, ...headerRest } = decoded.header;
    void chunks;
    if (decoded.header.type === "Scene") {
      stampDocumentChunkName(chunksById, safe);
    }
    const encoded = await encodeBabasset({
      header: { ...headerRest, name: safe },
      chunks: [...chunksById.values()],
      writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
    });
    if (newPath !== asset.path) {
      await moveStorageFile(storage, asset.path, newPath, fileBytes, encoded);
      return this.indexHeader(asset.rootId, newPath, readBabassetHeader(encoded));
    }
    await storage.writeBinary(asset.path, encoded);
    return this.indexHeader(asset.rootId, asset.path, readBabassetHeader(encoded));
  }

  async duplicateAsset(
    guid: string,
    rootId: string,
    targetFolderRelative = "",
  ): Promise<IndexedAsset> {
    const duplicate = await this.withCreationWrite(() => this.duplicateAssetUnlocked(guid, rootId, targetFolderRelative));
    await this.alignCreatedTextures([duplicate]);
    return duplicate;
  }

  private async duplicateAssetUnlocked(guid: string, rootId: string, targetFolderRelative: string): Promise<IndexedAsset> {
    const asset = this.byGuid.get(guid);
    if (!asset) throw new Error(`Unknown asset ${guid}`);
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const sourceStorage = this.storageForAsset(asset);
    const sourceBlobs = this.blobsForAsset(asset);
    const destStorage = this.storageOf(root);
    const destBlobs = this.blobsOf(root);
    const fileBytes = await sourceStorage.readBinary(asset.path);
    const decoded = await decodeBabasset(fileBytes, (sha256) =>
      sourceBlobs.readBlob(sha256),
    );
    const chunksById = new Map<string, ChunkInput>();
    for (const entry of decoded.header.chunks) {
      const data = decoded.chunks.get(entry.id);
      if (data) {
        chunksById.set(entry.id, {
          id: entry.id,
          kind: entry.kind,
          mime: entry.mime,
          data,
        });
      }
    }
    const newGuid = newAssetGuid();
    const fileName = asset.path.includes("/")
      ? asset.path.slice(asset.path.lastIndexOf("/") + 1)
      : asset.path;
    const suffix = assetFileSuffix(fileName);
    const stemSource = sanitizeFileName(
      stripAssetFileSuffix(fileName) || decoded.header.name || "asset",
    );
    const targetFolderPath = joinRootPath(root, targetFolderRelative);
    const siblingStems: string[] = [];
    for (const other of this.byPath.values()) {
      if (other.rootId !== rootId) continue;
      const parent = other.path.includes("/")
        ? other.path.slice(0, other.path.lastIndexOf("/"))
        : "";
      if (parent !== targetFolderPath) continue;
      const otherFile = other.path.includes("/")
        ? other.path.slice(other.path.lastIndexOf("/") + 1)
        : other.path;
      siblingStems.push(stripAssetFileSuffix(otherFile));
    }
    const uniqueName = nextCopyName(stemSource, siblingStems);
    const relativePath = joinRelative(
      targetFolderRelative,
      `${uniqueName}${suffix}`,
    );
    const candidate = joinRootPath(root, relativePath);
    const { chunks, ...headerRest } = decoded.header;
    void chunks;
    if (decoded.header.type === "Scene") {
      stampDocumentChunkName(chunksById, uniqueName);
    }
    const encoded = await encodeBabasset({
      header: { ...headerRest, guid: newGuid, name: uniqueName },
      chunks: [...chunksById.values()],
      writeBlob: (sha256, data) => destBlobs.writeBlob(sha256, data),
    });
    const dir = candidate.includes("/")
      ? candidate.slice(0, candidate.lastIndexOf("/"))
      : "";
    if (dir) await destStorage.mkdir(dir, true);
    await destStorage.writeBinary(candidate, encoded);
    return this.reportCreatedTexture(this.indexHeader(rootId, candidate, readBabassetHeader(encoded)));
  }

  /** Copy into a folder (same as duplicate with an explicit destination folder). */
  async copyAsset(
    guid: string,
    rootId: string,
    targetFolderRelative: string,
  ): Promise<IndexedAsset> {
    return this.duplicateAsset(guid, rootId, targetFolderRelative);
  }

  async copyFolder(
    rootId: string,
    relativeFolder: string,
    targetParentRelative: string,
  ): Promise<string> {
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const fromPath = joinRootPath(root, relativeFolder);
    if (
      !this.knownFolders.has(fromPath) &&
      !(await storage.exists(fromPath))
    ) {
      throw new Error(`Unknown folder ${relativeFolder}`);
    }
    const folderName = relativeFolder.includes("/")
      ? relativeFolder.slice(relativeFolder.lastIndexOf("/") + 1)
      : relativeFolder;
    const destParentPath = joinRootPath(root, targetParentRelative);
    const siblingNames: string[] = [];
    for (const folder of this.knownFolders) {
      const parent = folder.includes("/")
        ? folder.slice(0, folder.lastIndexOf("/"))
        : "";
      if (parent === destParentPath) {
        siblingNames.push(folder.slice(folder.lastIndexOf("/") + 1));
      }
    }
    const uniqueName = nextCopyName(folderName, siblingNames);
    const destRelative = joinRelative(targetParentRelative, uniqueName);
    const destPath = joinRootPath(root, destRelative);
    if (destPath !== fromPath && isWithinFolder(destPath, fromPath)) {
      throw new Error("Cannot copy a folder into itself");
    }

    await this.createFolder(rootId, destRelative);

    const nested = [...this.knownFolders].filter(
      (folder) => folder !== fromPath && isWithinFolder(folder, fromPath),
    );
    nested.sort((a, b) => a.length - b.length);
    for (const folder of nested) {
      const suffix = folder.slice(fromPath.length + 1);
      await this.createFolder(rootId, joinRelative(destRelative, suffix));
    }

    const assets = [...this.byGuid.values()].filter(
      (asset) =>
        asset.rootId === rootId && isWithinFolder(asset.path, fromPath),
    );
    for (const asset of assets) {
      const parent = asset.path.includes("/")
        ? asset.path.slice(0, asset.path.lastIndexOf("/"))
        : "";
      const suffix =
        parent === fromPath ? "" : parent.slice(fromPath.length + 1);
      const destFolder = suffix
        ? joinRelative(destRelative, suffix)
        : destRelative;
      await this.duplicateAsset(asset.header.guid, rootId, destFolder);
    }
    return destRelative;
  }

  async duplicateFolder(
    rootId: string,
    relativeFolder: string,
  ): Promise<string> {
    const parent = relativeFolder.includes("/")
      ? relativeFolder.slice(0, relativeFolder.lastIndexOf("/"))
      : "";
    return this.copyFolder(rootId, relativeFolder, parent);
  }

  async moveFolder(
    rootId: string,
    relativeFolder: string,
    newParentRelative: string,
    newName?: string,
  ): Promise<void> {
    return this.withFolderWrite(() => this.moveFolderUnlocked(rootId, relativeFolder, newParentRelative, newName));
  }

  private async moveFolderUnlocked(rootId: string, relativeFolder: string, newParentRelative: string, newName?: string): Promise<void> {
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const fromPath = joinRootPath(root, relativeFolder);
    const currentName = relativeFolder.includes("/")
      ? relativeFolder.slice(relativeFolder.lastIndexOf("/") + 1)
      : relativeFolder;
    const folderName = newName?.trim() || currentName;
    const toRelative = joinRelative(newParentRelative, folderName);
    const toPath = joinRootPath(root, toRelative);
    if (fromPath === toPath) return;
    if (isWithinFolder(toPath, fromPath)) {
      throw new Error("Cannot move a folder into itself");
    }

    const assets = [...this.byGuid.values()].filter(
      (asset) =>
        asset.rootId === rootId && isWithinFolder(asset.path, fromPath),
    );
    const folders = await moveStorageTree(storage, fromPath, toPath);
    for (const asset of assets) {
      const path = `${toPath}/${asset.path.slice(fromPath.length + 1)}`;
      this.byPath.delete(asset.path);
      const moved = { ...asset, path };
      this.byGuid.set(asset.header.guid, moved);
      this.byPath.set(path, moved);
    }
    if (assets.length > 0) this.changed();
    for (const folder of [...this.knownFolders]) {
      if (isWithinFolder(folder, fromPath)) this.removeKnownFolder(folder);
    }
    for (const folder of folders) this.addKnownFolder(folder ? `${toPath}/${folder}` : toPath);
  }

  async importFile(
    rootId: string,
    folderRelative: string,
    fileName: string,
    bytes: Uint8Array,
    extras?: {
      modelImportScale?: number;
      sidecars?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
      attachToGuid?: string;
    },
  ): Promise<IndexedAsset[]> {
    this.assertWritable(this.getRootOrThrow(rootId));
    const options: ImportOptions = {
      fileName,
      existingGuids: new Set(this.byGuid.keys()),
      fontGuidsByName: this.fontGuidsByName(),
      modelImportScale: extras?.modelImportScale,
      sidecars: extras?.sidecars,
      attachToGuid: extras?.attachToGuid,
    };
    const rawResults = await importByExtension(fileName, bytes, options);
    const results = remapImportResultGuids(rawResults, options.existingGuids).map(
      (result) =>
        extras?.attachToGuid
          ? { ...result, attachToGuid: extras.attachToGuid, guid: extras.attachToGuid }
          : result,
    );

    const created: IndexedAsset[] = [];
    for (const result of results) {
      if (result.attachToGuid) {
        await this.attachToExistingAsset(result.attachToGuid, result);
        continue;
      }
      const relativePath = joinRelative(folderRelative, `${sanitizeFileName(result.name)}.babasset`);
      const asset = await this.createAsset(rootId, relativePath, result);
      created.push(asset);
      await this.maybeWriteThumbnail(asset, result);
      await this.maybeEnqueueTextureEncode(asset);
    }
    // After every result is indexed, so a bundled Tileset counts.
    await this.alignCreatedTextures(created);
    return created;
  }

  /**
   * A Texture created with an encode already committed (a `.babasset` import
   * or a Duplicate) is a new file, not an older one teammates may share:
   * align it now, as an image import pads its first encode, whatever the
   * editor's rule for re-encoding older Textures in the background.
   */
  private async alignCreatedTextures(assets: readonly IndexedAsset[]): Promise<void> {
    const guids = assets
      .filter((asset) => asset.header.type === "Texture" && asset.header.payload.compressionState === "compressed")
      .map((asset) => asset.header.guid);
    if (guids.length > 0) await this.reconcileTextureAlignment({ guids });
  }

  private async maybeWriteThumbnail(
    asset: IndexedAsset,
    result: ImportResult,
  ): Promise<void> {
    if (!this.thumbnailWriter) return;
    if (asset.header.type !== "Texture") return;
    const pixels = result.chunks.find(
      (chunk) => chunk.id === "pixels" || chunk.kind === "pixels",
    );
    if (!pixels?.data?.byteLength) return;
    const thumb = await generateThumbnailBytes(
      pixels.data,
      DEFAULT_THUMBNAIL_MAX_EDGE,
      pixels.mime,
    );
    if (!thumb) return;
    await this.thumbnailWriter(asset.header.guid, thumb);
  }

  /**
   * `canWrite`, when set, is asked right before the write with the header of
   * the file on disk it would replace; false skips it.
   */
  async setCompressionState(
    guid: string,
    state: TextureCompressionState,
    options?: { error?: string; canWrite?: (guid: string, current: BabassetHeader) => boolean },
  ): Promise<void> {
    await this.enqueueTextureWrite(guid, async () => {
      await this.rewriteTexture(guid, async (header, chunks, current) => {
        if (options?.canWrite && !options.canWrite(guid, current)) return null;
        const payload: Record<string, unknown> = {
          ...header.payload,
          compressionState: state,
        };
        if (state === "encode_failed") {
          if (options?.error) payload.encodeError = options.error;
        } else {
          delete payload.encodeError;
        }
        header.payload = payload;
        return { header, chunks };
      });
    });
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
   * Texture is gone, or a guarded job may not write the file on disk now:
   * `encodeJobMayWrite`).
   */
  commitCompressedTexture(result: EncodeJobResult): Promise<boolean> {
    // Entered at once: a pass that awaits this Texture's writes reads the commit.
    return this.withAssetWrite(result.assetGuid, async () => {
      const chunkId =
        result.chunkId ?? ktx2ChunkId(await encodeSettingsHash(result.settings));
      const size = sniffKtx2Size(result.ktx2);
      const blockAlign = result.settings.blockAlign;
      const sha256 = await sha256Hex(result.ktx2);
      return this.rewriteTexture(result.assetGuid, async (header, chunks, current) => {
        // A background job commits only while its guard still allows it for
        // the file it replaces, and only onto the source it encoded.
        if (!encodeJobMayWrite(result, current)) return null;
        if (isOnBlockGrid(size) && !this.isAtlasTexture(result.assetGuid)) {
          for (const [id, chunk] of chunks) {
            if (id === chunkId || !(chunk.kind === "ktx2" || id.startsWith("ktx2:"))) continue;
            const retained = sniffKtx2Size(chunk.data);
            if (retained && !isOnBlockGrid(retained)) chunks.delete(id);
          }
        }
        chunks.set(chunkId, {
          id: chunkId,
          kind: "ktx2",
          mime: "image/ktx2",
          data: result.ktx2,
        });
        const payload: Record<string, unknown> = {
          ...header.payload,
          compressionState: "compressed",
          encodeWallMs: result.wallMs,
          ktx2ChunkId: chunkId,
        };
        delete payload.encodeError;
        delete payload.ktx2Width;
        delete payload.ktx2Height;
        delete payload.ktx2BlockAlign;
        if (size) {
          payload.ktx2Width = size.width;
          payload.ktx2Height = size.height;
        }
        if (blockAlign && blockAlign > 1) payload.ktx2BlockAlign = blockAlign;
        payload.ktx2Sha256 = sha256;
        header.payload = payload;
        return { header, chunks };
      });
    });
  }

  /** Explicit asset processing/build work. Gameplay only consumes the committed chunk. */
  async prepareAreaEmission(guid: string, process: AreaEmissionProcessor, options: { signal?: AbortSignal; onProgress?: (value: AreaEmissionProgress) => void } = {}): Promise<Uint8Array> {
    if (!this.encodeQueue) throw new Error("Texture processing queue is unavailable.");
    options.signal?.throwIfAborted();
    options.onProgress?.({ phase: "queued", progress: 0 });
    return this.encodeQueue.enqueueDerived(async (signal) => {
      const asset = this.byGuid.get(guid);
      if (!asset || asset.header.type !== "Texture" || isEnvironmentTexturePayload(asset.header.payload)) throw new Error("Area emission requires a raster Texture asset.");
      const file = await this.storageForAsset(asset).readBinary(asset.path);
      const header = readBabassetHeader(file);
      const sourceEntry = header.chunks.find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
      if (!sourceEntry) throw new Error("The Texture has no retained source pixels.");
      const cached = currentAreaEmissionChunk(header);
      if (cached) {
        try {
          const bytes = await this.loader.loadChunk(file, cached, this.blobsForAsset(asset));
          if (bytes) {
            await decodeAreaEmission(bytes, sourceEntry.sha256);
            signal.throwIfAborted();
            return bytes;
          }
        } catch {
          // This is an explicit processing request. Rebuild a corrupt derived
          // representation from the retained source, never in gameplay.
          signal.throwIfAborted();
        }
      }
      this.assertWritable(this.getRootOrThrow(asset.rootId));
      const source = await this.loader.loadChunk(file, sourceEntry, this.blobsForAsset(asset));
      if (!source || await sha256Hex(source) !== sourceEntry.sha256) throw new Error("The emission source is missing or corrupt.");
      const bytes = await process({ source, sourceHash: sourceEntry.sha256, mime: sourceEntry.mime }, signal, options.onProgress);
      signal.throwIfAborted();
      await decodeAreaEmission(bytes, sourceEntry.sha256);
      options.onProgress?.({ phase: "saving", progress: 1 });
      await this.enqueueTextureWrite(guid, async () => {
        if (!this.byGuid.has(guid)) throw new Error("The Texture was removed during emission processing.");
        await this.rewriteTexture(guid, async (current, chunks) => {
          signal.throwIfAborted();
          const pixels = [...chunks.values()].find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
          if (!pixels || await sha256Hex(pixels.data) !== sourceEntry.sha256) throw new Error("The Texture changed during emission processing; stale results were discarded.");
          for (const [id, chunk] of chunks) if (chunk.kind === AREA_EMISSION_CHUNK_KIND) chunks.delete(id);
          const id = areaEmissionChunkId(sourceEntry.sha256);
          chunks.set(id, { id, kind: AREA_EMISSION_CHUNK_KIND, mime: "application/x-babylonslate-area-emission", data: bytes });
          return { header: current, chunks };
        }, () => signal.throwIfAborted());
      });
      return bytes;
    }, options.signal);
  }

  /**
   * Re-encode a Texture. `usage` overrides the saved header's Usage so a
   * Details edit that has not been saved yet encodes with its new policy.
   * A `guard`ed re-encode (the alignment pass) writes no state before its
   * commit, and its guard is asked again when the job starts and before each
   * write; it carries its source's sha256, so it writes nothing once the
   * file's source pixels changed.
   */
  async retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean; usage?: string; guard?: EncodeJobGuard },
  ): Promise<boolean> {
    const asset = this.byGuid.get(guid);
    if (!asset || asset.header.type !== "Texture" || !this.encodeQueue) {
      return false;
    }
    const state = asset.header.payload.compressionState;
    const recoverable =
      state === "encode_failed" ||
      state === "fallback_uncompressed" ||
      state === "pending" ||
      state === "encoding";
    if (!recoverable && options?.force !== true) {
      return false;
    }
    const usage = options?.usage ?? String(asset.header.payload.usage ?? "albedo");
    if (isEnvironmentTexturePayload(asset.header.payload) || !shouldCompressTexture(usage)) return false;
    if (state !== "pending" && !options?.guard) {
      await this.setCompressionState(guid, "pending");
    }
    const latest = this.byGuid.get(guid) ?? asset;
    const source = await this.loadSourcePixels(latest);
    if (!source) return false;
    await this.resolveLegacyAtlasReferrers();
    const settings = this.encodeSettingsFor(latest, usage, {
      sourceSize: sniffSourceImageSize(source.bytes),
      ...(options?.maxDimension
        ? { maxDimension: effectiveTextureMaxDimension(options.maxDimension, this.encodeSettings.maxDimension) }
        : {}),
    });
    const chunkId = await textureEncodeChunkId(settings, usage);
    const queue = this.encodeQueue;
    if (!queue) return false;
    const sourceSha256 = options?.guard ? await sha256Hex(source.bytes) : undefined;
    queue.enqueue({
      assetGuid: guid,
      source: source.bytes,
      mime: source.mime,
      settings,
      chunkId,
      usage,
      ...(options?.guard ? { guard: options.guard, sourceSha256 } : {}),
    });
    return true;
  }

  /**
   * Re-queue textures that fell back when the transcoder was unavailable, or
   * whose `pending` / `encoding` job an earlier session left behind. A Texture
   * the queue already holds a job for is left to it (a remount rescans).
   */
  async requeueUncompressedTextures(): Promise<number> {
    const queue = this.encodeQueue;
    if (!queue) return 0;
    let count = 0;
    for (const { header } of this.list({ type: "Texture" })) {
      const asset = await this.settledTexture(header.guid);
      if (!asset || queue.has(header.guid)) continue;
      const state = asset.header.payload.compressionState;
      if (
        state === "fallback_uncompressed" ||
        state === "pending" ||
        state === "encoding"
      ) {
        if (await this.retryTextureEncoding(header.guid)) count += 1;
      }
    }
    return count;
  }

  /** A Texture's index entry once its queued writes (such as a commit) have landed. */
  private async settledTexture(guid: string): Promise<IndexedAsset | undefined> {
    const writes = this.textureWriteChain.get(guid);
    if (writes) await writes;
    return this.byGuid.get(guid);
  }

  /** Paths of Scene and Graph assets for ProjectDocument reconciliation. */
  listDocumentPaths(filter?: { rootId?: string }): { scenes: string[]; graphs: string[] } {
    const scenes: string[] = [];
    const graphs: string[] = [];
    for (const asset of this.byGuid.values()) {
      if (asset.placeholder || asset.header.type === "Unresolved") continue;
      if (filter?.rootId && asset.rootId !== filter.rootId) continue;
      if (asset.header.type === "Scene") scenes.push(asset.path);
      else if (asset.header.type === "Graph" || asset.header.type === "Class") {
        graphs.push(asset.path);
      }
    }
    return { scenes: scenes.sort(), graphs: graphs.sort() };
  }

  private fontGuidsByName(): Map<string, string> {
    const map = new Map<string, string>();
    for (const asset of this.byGuid.values()) {
      if (asset.header.type === "Font") {
        map.set(asset.header.name, asset.header.guid);
      }
    }
    return map;
  }

  private async maybeEnqueueTextureEncode(asset: IndexedAsset): Promise<void> {
    if (asset.header.type !== "Texture" || !this.encodeQueue) return;
    const usage = String(asset.header.payload.usage ?? "albedo");
    if (isEnvironmentTexturePayload(asset.header.payload) || !shouldCompressTexture(usage)) return;
    if (asset.header.payload.compressionState !== "pending") return;
    const source = await this.loadSourcePixels(asset);
    if (!source) return;
    await this.resolveLegacyAtlasReferrers();
    const settings = this.encodeSettingsFor(asset, usage, { sourceSize: sniffSourceImageSize(source.bytes) });
    const chunkId = await textureEncodeChunkId(settings, usage);
    this.encodeQueue?.enqueue({
      assetGuid: asset.header.guid,
      source: source.bytes,
      mime: source.mime,
      settings,
      chunkId,
      usage,
    });
  }

  /** Encode settings with the texture's current atlas status. */
  private encodeSettingsFor(
    asset: IndexedAsset,
    usage = String(asset.header.payload.usage ?? "albedo"),
    context: { sourceSize?: ImageSize | null; maxDimension?: number } = {},
  ): TextureEncodeSettings {
    return textureEncodeSettingsFor(asset.header.payload, this.encodeSettings, usage, {
      ...context,
      atlas: this.isAtlasTexture(asset.header.guid),
    });
  }

  /** A Tileset, Sprite or Sprite Animation samples this texture as an atlas. */
  isAtlasTexture(guid: string): boolean {
    return (this.atlasReferrers.get(guid)?.size ?? 0) > 0;
  }

  /**
   * Report textures whose atlas status changed (a referrer saved, deleted,
   * duplicated, imported, or a plugin root mounted). Set after the initial
   * scan; changes are reported once legacy referrers are decoded.
   */
  setAtlasStatusListener(listener: ((textureGuids: string[]) => void) | null): void {
    this.atlasStatusListener = listener;
    this.atlasStatusBefore.clear();
  }

  /**
   * Decode referrers whose header has no `atlasTextures` meta (saved before
   * it existed, or created and never saved) so their atlases are known.
   * Serialized; the alignment pass and every enqueue await it.
   */
  resolveLegacyAtlasReferrers(): Promise<void> {
    const run = async () => {
      while (this.legacyAtlasReferrers.size > 0) {
        const guid = this.legacyAtlasReferrers.values().next().value as string;
        this.legacyAtlasReferrers.delete(guid);
        const asset = this.byGuid.get(guid);
        if (!asset || !ATLAS_REFERRER_TYPES.has(asset.header.type)) continue;
        let textures: string[] = [];
        try {
          const bytes = await this.storageForAsset(asset).readBinary(asset.path);
          const document = await decodeAssetDocument(bytes, { blobs: this.blobsForAsset(asset) });
          textures = atlasTextureGuids(asset.header.type, document.payload);
          const key = legacyAtlasCacheKey(readBabassetHeader(bytes));
          if (key) this.legacyAtlasCache.set(key, textures);
        } catch {
          // Unreadable: it samples nothing we can see.
        }
        // Re-indexed or removed meanwhile: that entry owns its atlas state.
        if (this.byGuid.get(guid) !== asset) continue;
        this.setAtlasReferrer(guid, textures);
      }
    };
    const next = this.legacyAtlasResolution.then(run, run);
    this.legacyAtlasResolution = next.catch(() => undefined);
    return next;
  }

  /**
   * Requeue `compressed` textures whose committed encode no longer matches
   * the alignment policy: a non-atlas encode off the 4-texel grid, or an atlas
   * encode that was padded. Particle is always aligned. Skips read-only roots
   * and textures `canWrite` refuses (the editor's rule for background
   * re-encodes). An aligned texture is never requeued. Returns the requeued
   * guids.
   */
  async reconcileTextureAlignment(options: {
    guids?: Iterable<string>;
    /**
     * Asked before the requeue, when the job starts, and before its commit
     * with the header of the file on disk it would replace (`EncodeJobGuard`).
     */
    canWrite?: (guid: string, current?: BabassetHeader) => boolean;
    /**
     * Usage to check and re-encode with instead of the saved one: an open
     * Texture tab's, which an unsaved Details edit may have changed.
     */
    usageFor?: (guid: string) => string | undefined;
    /**
     * Sizes the pass read, kept across registry remounts: KTX2 base sizes by
     * chunk sha256, and sniffed source sizes by `source:` + chunk sha256.
     */
    ktx2SizeCache?: Map<string, ImageSize | null>;
  } = {}): Promise<string[]> {
    if (!this.encodeQueue) return [];
    await this.resolveLegacyAtlasReferrers();
    const guids = options.guids
      ? [...new Set(options.guids)]
      : this.list({ type: "Texture" }).map((asset) => asset.header.guid);
    const canWrite = options.canWrite ?? (() => true);
    const guard: EncodeJobGuard = { canWrite };
    const queue = this.encodeQueue;
    const requeued: string[] = [];
    for (const guid of guids) {
      const asset = await this.settledTexture(guid);
      // Already queued (an earlier pass, or a remount's): one job is enough.
      if (queue.has(guid) || this.alignmentRequeues.has(guid) || !asset) continue;
      const usage = options.usageFor?.(guid) ?? String(asset.header.payload.usage ?? "albedo");
      if (!this.isAlignmentCandidate(asset, usage) || !canWrite(guid)) continue;
      this.alignmentRequeues.add(guid);
      try {
        if (!(await this.isAlignmentStale(asset, usage, options.ktx2SizeCache))) continue;
        // Asked again after the (possibly reading) staleness check, just
        // before the requeue, so a refusal meanwhile still stops it.
        if (!canWrite(guid) || queue.has(guid)) continue;
        if (await this.retryTextureEncoding(guid, { force: true, usage, guard })) requeued.push(guid);
      } catch {
        // One unreadable texture must not stop the pass.
      } finally {
        this.alignmentRequeues.delete(guid);
      }
    }
    return requeued;
  }

  /**
   * Whether `reconcileTextureAlignment` would requeue this Texture, whatever
   * the editor's `canWrite`: its committed encode is stale for the alignment
   * policy, and no encode for it waits or runs. Texture Details offers
   * **Retry Encoding** for it, the user's own re-encode.
   */
  async isTextureAlignmentStale(
    guid: string,
    options: { usage?: string; ktx2SizeCache?: Map<string, ImageSize | null> } = {},
  ): Promise<boolean> {
    const queue = this.encodeQueue;
    if (!queue) return false;
    await this.resolveLegacyAtlasReferrers();
    const asset = await this.settledTexture(guid);
    if (!asset || queue.has(guid) || this.alignmentRequeues.has(guid)) return false;
    const usage = options.usage ?? String(asset.header.payload.usage ?? "albedo");
    if (!this.isAlignmentCandidate(asset, usage)) return false;
    try {
      return await this.isAlignmentStale(asset, usage, options.ktx2SizeCache);
    } catch {
      return false;
    }
  }

  /**
   * A writable `compressed` Texture of a compressed Usage with source pixels
   * to re-encode from: one the alignment pass checks.
   */
  private isAlignmentCandidate(asset: IndexedAsset, usage: string): boolean {
    const payload = asset.header.payload;
    if (asset.placeholder || asset.header.type !== "Texture") return false;
    if (payload.compressionState !== "compressed") return false;
    if (isEnvironmentTexturePayload(payload) || !shouldCompressTexture(usage)) return false;
    // Without source pixels a forced retry would strand it `pending`.
    if (!asset.header.chunks.some((chunk) => chunk.kind === "pixels")) return false;
    return !this.roots.get(asset.rootId)?.readOnly;
  }

  private async isAlignmentStale(
    asset: IndexedAsset,
    usage: string,
    cache?: Map<string, ImageSize | null>,
  ): Promise<boolean> {
    // Particle keys its alignment into the chunk id: always on the grid.
    if (usage === "particle") return false;
    const padded = (committedEncodeRecord(asset.header)?.blockAlign ?? 0) > 1;
    if (this.isAtlasTexture(asset.header.guid)) return padded;
    if (padded) return false;
    const size = await this.committedKtx2Size(asset, usage, cache);
    if (size === null || isOnBlockGrid(size)) return false;
    // Requeue only if the re-encode can differ: padded, or under other
    // settings. Otherwise (a payload or sniffed size that disagrees with the
    // decoded source) it would land off the grid again and repeat after every
    // commit. Built as the requeue builds them: without a payload size, the
    // sniffed source decides the padding.
    const sourceSize = payloadPixelSize(asset.header.payload)
      ? undefined
      : await this.sniffedSourceSize(asset, cache);
    const settings = this.encodeSettingsFor(asset, usage, { sourceSize });
    if (settings.blockAlign !== undefined) return true;
    return asset.header.payload.ktx2ChunkId !== (await textureEncodeChunkId(settings, usage));
  }

  /** `sniffSourceImageSize` of the source pixels, cached by chunk sha256 under `source:`. */
  private async sniffedSourceSize(
    asset: IndexedAsset,
    cache?: Map<string, ImageSize | null>,
  ): Promise<ImageSize | null> {
    const pixels = asset.header.chunks.find((chunk) => chunk.kind === "pixels");
    if (!pixels) return null;
    const key = `source:${pixels.sha256}`;
    const cached = cache?.get(key);
    if (cached !== undefined) return cached;
    const source = await this.loadSourcePixels(asset);
    const size = source ? sniffSourceImageSize(source.bytes) : null;
    cache?.set(key, size);
    return size;
  }

  /**
   * Base size of the committed KTX2: the recorded size; else, for an encode
   * committed under today's id without a record, the clamped source size when
   * it is on the grid (padding then changes nothing); else the chunk's KTX2
   * header, which also tells a padded encode whose record was dropped (by an
   * editor that predates it) from an unpadded one.
   */
  private async committedKtx2Size(
    asset: IndexedAsset,
    usage: string,
    cache?: Map<string, ImageSize | null>,
  ): Promise<ImageSize | null> {
    const payload = asset.header.payload;
    const recorded = committedEncodeRecord(asset.header)?.size;
    if (recorded) return recorded;
    const committed = payload.ktx2ChunkId;
    if (typeof committed !== "string") return null;
    const source = payloadPixelSize(payload);
    if (source) {
      const settings = this.encodeSettingsFor(asset, usage);
      if (committed === (await textureEncodeChunkId(settings, usage))) {
        const clamped = clampDimension(source.width, source.height, settings.maxDimension);
        if (isOnBlockGrid(clamped)) return { width: clamped.width, height: clamped.height };
      }
    }
    const entry = asset.header.chunks.find((chunk) => chunk.id === committed);
    if (!entry) return null;
    const cached = cache?.get(entry.sha256);
    if (cached !== undefined) return cached;
    const file = await this.storageForAsset(asset).readBinary(asset.path);
    const bytes = await this.loader.loadChunk(file, entry, this.blobsForAsset(asset));
    const size = bytes ? sniffKtx2Size(bytes) : null;
    cache?.set(entry.sha256, size);
    return size;
  }

  private async loadSourcePixels(
    asset: IndexedAsset,
  ): Promise<{ bytes: Uint8Array; mime?: string } | null> {
    const pixels = asset.header.chunks.find((chunk) => chunk.kind === "pixels");
    if (!pixels) return null;
    const fileBytes = await this.storageForAsset(asset).readBinary(asset.path);
    const bytes = await this.loader.loadChunk(
      fileBytes,
      pixels,
      this.blobsForAsset(asset),
    );
    if (!bytes) return null;
    return { bytes, mime: pixels.mime };
  }

  private enqueueTextureWrite(
    guid: string,
    work: () => Promise<void>,
  ): Promise<void> {
    return this.withAssetWrite(guid, work);
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

  private async rewriteTexture(
    guid: string,
    mutate: (
      header: Omit<BabassetHeader, "chunks">,
      chunks: Map<string, ChunkInput>,
      /** The header as read from disk, chunk sha256s included. */
      current: BabassetHeader,
    ) => Promise<{
      header: Omit<BabassetHeader, "chunks">;
      chunks: Map<string, ChunkInput>;
    } | null>,
    assertCurrent: () => void = () => {},
  ): Promise<boolean> {
    const asset = this.byGuid.get(guid);
    if (!asset) return false;
    const storage = this.storageForAsset(asset);
    const blobs = this.blobsForAsset(asset);
    const previousMtime = await this.statMtime(storage, asset.path);
    const fileBytes = await storage.readBinary(asset.path);
    const decoded = await decodeBabasset(fileBytes, (sha256) =>
      blobs.readBlob(sha256),
    );
    const chunksById = new Map<string, ChunkInput>();
    for (const entry of decoded.header.chunks) {
      const data = decoded.chunks.get(entry.id);
      if (data) {
        chunksById.set(entry.id, {
          id: entry.id,
          kind: entry.kind,
          mime: entry.mime,
          data,
        });
      }
    }
    const { chunks, ...headerRest } = decoded.header;
    void chunks;
    const next = await mutate({ ...headerRest }, chunksById, decoded.header);
    // Nothing to write (a refused guard).
    if (!next) return false;
    const bytes = await encodeBabasset({
      header: next.header,
      chunks: [...next.chunks.values()],
      writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
    });
    assertCurrent();
    await storage.writeBinary(asset.path, bytes);
    const mtime = await this.statMtime(storage, asset.path);
    const header = readBabassetHeader(bytes);
    this.indexHeader(asset.rootId, asset.path, header, false, mtime);
    this.ownWriteListener?.({ path: asset.path, previousMtime, mtime });
    return true;
  }

  /** Attach a representation chunk (facetype / msdf) to an existing Font asset. */
  private async attachToExistingAsset(guid: string, result: ImportResult): Promise<void> {
    return this.withAssetWrite(guid, () => this.attachToExistingAssetUnlocked(guid, result));
  }

  private async attachToExistingAssetUnlocked(guid: string, result: ImportResult): Promise<void> {
    const asset = this.byGuid.get(guid);
    if (!asset) {
      throw new Error(`Cannot attach representation: no asset for guid ${guid}`);
    }
    const storage = this.storageForAsset(asset);
    const blobs = this.blobsForAsset(asset);
    const fileBytes = await storage.readBinary(asset.path);
    const decoded = await decodeBabasset(fileBytes, (sha256) => blobs.readBlob(sha256));

    const chunksById = new Map<string, ChunkInput>();
    for (const entry of decoded.header.chunks) {
      const data = decoded.chunks.get(entry.id);
      if (data) {
        chunksById.set(entry.id, { id: entry.id, kind: entry.kind, mime: entry.mime, data });
      }
    }
    for (const chunk of result.chunks) {
      chunksById.set(chunk.id, chunk);
    }

    const { chunks, ...headerRest } = decoded.header;
    void chunks;
    const familyFallback =
      typeof (headerRest.payload as { family?: unknown } | undefined)?.family ===
      "string"
        ? ((headerRest.payload as { family: string }).family)
        : asset.header.name;
    const payload =
      asset.header.type === "Font"
        ? (mergeFontAttachPayload(
            headerRest.payload,
            result.payload,
            familyFallback,
          ) as unknown as Record<string, unknown>)
        : { ...headerRest.payload, ...result.payload };
    const bytes = await encodeBabasset({
      header: { ...headerRest, payload },
      chunks: [...chunksById.values()],
      writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
    });
    await storage.writeBinary(asset.path, bytes);
    const header = readBabassetHeader(bytes);
    this.indexHeader(asset.rootId, asset.path, header);
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

  private async walk(root: ContentRoot, dir: string, storage: ProjectStorageReader): Promise<void> {
    let entries;
    try {
      entries = await storage.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDir) {
        if (entry.name === BLOBS_DIR_NAME || entry.name.startsWith(STORAGE_MOVE_BACKUP_PREFIX)) continue;
        this.addKnownFolder(path);
        await this.walk(root, path, storage);
        continue;
      }
      if (entry.name === FOLDER_MARKER_NAME) {
        this.addKnownFolder(dir);
        continue;
      }
      if (!path.endsWith(".babasset")) continue;
      const bytes = await storage.readBinary(path);
      const header = readBabassetHeader(bytes);
      this.indexHeader(root.id, path, header, false, entry.mtime ?? null);
    }
  }

  private indexHeader(
    rootId: string,
    path: string,
    header: BabassetHeader,
    placeholder = false,
    mtime: number | null = null,
  ): IndexedAsset {
    const existingAtPath = this.byPath.get(path);
    if (existingAtPath) this.removeFromIndex(existingAtPath, existingAtPath.header.guid === header.guid);
    const existingByGuid = this.byGuid.get(header.guid);
    if (existingByGuid) this.removeFromIndex(existingByGuid, true);

    const indexed: IndexedAsset = { rootId, path, header, placeholder, mtime };
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
    if (!placeholder && ATLAS_REFERRER_TYPES.has(header.type)) {
      const key = legacyAtlasCacheKey(header);
      const listed = headerAtlasTextureGuids(header.payload) ?? (key ? this.legacyAtlasCache.get(key) : undefined);
      if (listed) {
        this.setAtlasReferrer(header.guid, listed);
      } else {
        this.legacyAtlasReferrers.add(header.guid);
        this.scheduleAtlasStatusFlush();
      }
    }
    return indexed;
  }

  private setAtlasReferrer(referrer: string, textures: readonly string[]): void {
    const previous = this.atlasByReferrer.get(referrer) ?? [];
    const next = [...new Set(textures)];
    if (previous.length === 0 && next.length === 0) return;
    this.changed();
    this.noteAtlasStatus([...previous, ...next]);
    for (const guid of previous) {
      const set = this.atlasReferrers.get(guid);
      set?.delete(referrer);
      if (set && set.size === 0) this.atlasReferrers.delete(guid);
    }
    if (next.length > 0) this.atlasByReferrer.set(referrer, next);
    else this.atlasByReferrer.delete(referrer);
    for (const guid of next) {
      let set = this.atlasReferrers.get(guid);
      if (!set) {
        set = new Set();
        this.atlasReferrers.set(guid, set);
      }
      set.add(referrer);
    }
  }

  /** Remember each texture's atlas status before a change, for the listener. */
  private noteAtlasStatus(textureGuids: readonly string[]): void {
    if (!this.atlasStatusListener) return;
    for (const guid of textureGuids) {
      if (!this.atlasStatusBefore.has(guid)) {
        this.atlasStatusBefore.set(guid, this.isAtlasTexture(guid));
      }
    }
    this.scheduleAtlasStatusFlush();
  }

  private scheduleAtlasStatusFlush(): void {
    if (!this.atlasStatusListener || this.atlasFlushScheduled) return;
    this.atlasFlushScheduled = true;
    queueMicrotask(() => void this.flushAtlasStatus());
  }

  private async flushAtlasStatus(): Promise<void> {
    await this.resolveLegacyAtlasReferrers();
    this.atlasFlushScheduled = false;
    const changed = [...this.atlasStatusBefore]
      .filter(([guid, before]) => this.isAtlasTexture(guid) !== before)
      .map(([guid]) => guid);
    this.atlasStatusBefore.clear();
    if (changed.length > 0) this.atlasStatusListener?.(changed);
    // A legacy referrer indexed after the resolution finished.
    if (this.legacyAtlasReferrers.size > 0) this.scheduleAtlasStatusFlush();
  }

  private removeFromIndex(asset: IndexedAsset, preserveInbound = false): void {
    this.byGuid.delete(asset.header.guid);
    if (this.byPath.get(asset.path) === asset) {
      this.byPath.delete(asset.path);
    }
    this.changed();
    this.legacyAtlasReferrers.delete(asset.header.guid);
    this.setAtlasReferrer(asset.header.guid, []);
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

function isOnBlockGrid(size: ImageSize | null): boolean {
  return size !== null && size.width % TEXTURE_BLOCK_EDGE === 0 && size.height % TEXTURE_BLOCK_EDGE === 0;
}

/**
 * What a commit recorded about the committed encode, while `ktx2Sha256` still
 * matches the committed chunk. A writer that replaced the encode but kept the
 * fields (an editor from before they existed) leaves them describing other
 * bytes, so they are ignored.
 */
function committedEncodeRecord(
  header: BabassetHeader,
): { size: ImageSize | null; blockAlign: number | null } | null {
  const payload = header.payload;
  const committed = header.chunks.find((chunk) => chunk.id === payload.ktx2ChunkId);
  if (!committed || typeof payload.ktx2Sha256 !== "string" || committed.sha256 !== payload.ktx2Sha256) {
    return null;
  }
  const { ktx2Width: width, ktx2Height: height, ktx2BlockAlign: blockAlign } = payload;
  return {
    size: typeof width === "number" && typeof height === "number" ? { width, height } : null,
    blockAlign: typeof blockAlign === "number" ? blockAlign : null,
  };
}

/** A legacy atlas referrer's document content, when it has a document chunk. */
function legacyAtlasCacheKey(header: BabassetHeader): string | null {
  const document = header.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID);
  return document ? `${header.type}:${document.sha256}` : null;
}

function sortFolderTree(node: FolderNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.assets.sort();
  for (const child of node.children) sortFolderTree(child);
}

function joinRootPath(root: ContentRoot, relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, "");
  return trimmed ? `${root.pathPrefix}/${trimmed}` : root.pathPrefix;
}

function joinRelative(folderRelative: string, fileName: string): string {
  const trimmed = folderRelative.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/${fileName}` : fileName;
}

function isWithinFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}
