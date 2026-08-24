import type { ProjectStorage } from "@babylonslate/core";
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
import type { EncodeJobResult, EncodeQueue } from "./encode-queue";
import { newAssetGuid } from "./guid";
import {
  importByExtension,
  remapImportResultGuids,
  type ImportOptions,
  type ImportResult,
} from "./importers";
import { AccountedPayloadLoader } from "./payload-loader";
import {
  assetFileSuffix,
  nextCopyName,
  stripAssetFileSuffix,
} from "./unique-names";
import { DOCUMENT_CHUNK_ID, stampDocumentChunkName } from "./asset-document";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  effectiveTextureMaxDimension,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  type TextureCompressionState,
  type TextureEncodeSettings,
} from "./texture-compression";
import { DEFAULT_THUMBNAIL_MAX_EDGE, generateThumbnailBytes } from "./thumbnails";

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

/** Marker file so empty folders survive Git and remount scans. */
export const FOLDER_MARKER_NAME = ".babylonslate-folder";

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  assets: string[];
}

export interface AssetRegistryOptions {
  payloadLoader?: AccountedPayloadLoader;
  blobs?: BlobStore;
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

  constructor(storage: ProjectStorage, options: AssetRegistryOptions = {}) {
    this.storage = storage;
    this.blobs = options.blobs ?? createVfsBlobStore(storage);
    this.loader =
      options.payloadLoader ?? new AccountedPayloadLoader(storage, { blobs: this.blobs });
  }

  /** Bind the §3.5 encode scheduler (ProjectService owns the queue lifetime). */
  setEncodePipeline(
    queue: EncodeQueue | null,
    settings: TextureEncodeSettings = DEFAULT_TEXTURE_ENCODE_SETTINGS,
  ): void {
    this.encodeQueue = queue;
    this.encodeSettings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, ...settings };
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
    await this.walk(root, root.pathPrefix);
  }

  unmountRoot(rootId: string): void {
    this.roots.delete(rootId);
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
    return this.indexHeader(rootId, path, header, false, mtime);
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
    const root = this.getRootOrThrow(rootId);
    this.assertWritable(root);
    const storage = this.storageOf(root);
    const folderPath = joinRootPath(root, relativeFolder);
    for (const asset of [...this.byGuid.values()]) {
      if (asset.rootId === rootId && isWithinFolder(asset.path, folderPath)) {
        this.removeFromIndex(asset);
      }
    }
    for (const known of [...this.knownFolders]) {
      if (isWithinFolder(known, folderPath)) {
        this.knownFolders.delete(known);
      }
    }
    await storage.remove(folderPath);
  }

  async createFolder(rootId: string, relativeFolder: string): Promise<void> {
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
    this.knownFolders.add(folderPath);
    // Ensure parent folders are visible even without their own markers.
    let parent = folderPath.includes("/")
      ? folderPath.slice(0, folderPath.lastIndexOf("/"))
      : "";
    while (parent && parent.startsWith(root.pathPrefix)) {
      this.knownFolders.add(parent);
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
    const dir = newPath.includes("/")
      ? newPath.slice(0, newPath.lastIndexOf("/"))
      : "";
    if (dir) await storage.mkdir(dir, true);
    await storage.writeBinary(newPath, bytes);
    await storage.remove(asset.path);
    // Keep inbound refs: guid identity is unchanged, only the storage path moves.
    if (this.byPath.get(asset.path) === asset) {
      this.byPath.delete(asset.path);
    }
    const moved: IndexedAsset = { ...asset, path: newPath };
    this.byGuid.set(guid, moved);
    this.byPath.set(newPath, moved);
    return moved;
  }

  async renameAsset(guid: string, newName: string): Promise<IndexedAsset> {
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
    const newPath = dir ? `${dir}/${safe}.babasset` : `${safe}.babasset`;
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
      const parent = newPath.includes("/")
        ? newPath.slice(0, newPath.lastIndexOf("/"))
        : "";
      if (parent) await storage.mkdir(parent, true);
      await storage.writeBinary(newPath, encoded);
      await storage.remove(asset.path);
      this.removeFromIndex(asset);
      return this.indexHeader(asset.rootId, newPath, readBabassetHeader(encoded));
    }
    await storage.writeBinary(asset.path, encoded);
    this.removeFromIndex(asset);
    return this.indexHeader(asset.rootId, asset.path, readBabassetHeader(encoded));
  }

  async duplicateAsset(
    guid: string,
    rootId: string,
    targetFolderRelative = "",
  ): Promise<IndexedAsset> {
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
    return this.indexHeader(rootId, candidate, readBabassetHeader(encoded));
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
    for (const asset of assets) {
      const suffix = asset.path.slice(fromPath.length + 1);
      const newAssetPath = `${toPath}/${suffix}`;
      const relative = newAssetPath.startsWith(`${root.pathPrefix}/`)
        ? newAssetPath.slice(root.pathPrefix.length + 1)
        : newAssetPath;
      await this.moveAsset(asset.header.guid, rootId, relative);
    }

    // Relocate folder markers / empty folders.
    const nestedFolders = [...this.knownFolders].filter((folder) =>
      isWithinFolder(folder, fromPath),
    );
    for (const folder of nestedFolders) {
      this.knownFolders.delete(folder);
      const suffix =
        folder === fromPath ? "" : folder.slice(fromPath.length + 1);
      const next = suffix ? `${toPath}/${suffix}` : toPath;
      this.knownFolders.add(next);
      const markerFrom = `${folder}/${FOLDER_MARKER_NAME}`;
      if (await storage.exists(markerFrom)) {
        await storage.mkdir(next, true);
        const text = await storage.readText(markerFrom);
        await storage.writeText(`${next}/${FOLDER_MARKER_NAME}`, text);
      }
    }

    if (await storage.exists(fromPath)) {
      await storage.remove(fromPath);
    }
    this.knownFolders.add(toPath);
  }

  async importFile(
    rootId: string,
    folderRelative: string,
    fileName: string,
    bytes: Uint8Array,
    extras?: {
      modelImportScale?: number;
      sidecars?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
    },
  ): Promise<IndexedAsset[]> {
    this.assertWritable(this.getRootOrThrow(rootId));
    const options: ImportOptions = {
      fileName,
      existingGuids: new Set(this.byGuid.keys()),
      fontGuidsByName: this.fontGuidsByName(),
      modelImportScale: extras?.modelImportScale,
      sidecars: extras?.sidecars,
    };
    const rawResults = await importByExtension(fileName, bytes, options);
    const results = remapImportResultGuids(rawResults, options.existingGuids);

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
    return created;
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

  async setCompressionState(
    guid: string,
    state: TextureCompressionState,
    options?: { error?: string },
  ): Promise<void> {
    await this.enqueueTextureWrite(guid, async () => {
      await this.rewriteTexture(guid, async (header, chunks) => {
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

  async commitCompressedTexture(result: EncodeJobResult): Promise<void> {
    const hash = await encodeSettingsHash(result.settings);
    const chunkId = ktx2ChunkId(hash);
    await this.enqueueTextureWrite(result.assetGuid, async () => {
      await this.rewriteTexture(result.assetGuid, async (header, chunks) => {
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
        header.payload = payload;
        return { header, chunks };
      });
    });
  }

  async retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean },
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
    const usage = String(asset.header.payload.usage ?? "albedo");
    if (!shouldCompressTexture(usage)) return false;
    if (state !== "pending") {
      await this.setCompressionState(guid, "pending");
    }
    const latest = this.byGuid.get(guid) ?? asset;
    const source = await this.loadSourcePixels(latest);
    if (!source) return false;
    const assetMax =
      options && "maxDimension" in options
        ? options.maxDimension
        : latest.header.payload.maxDimension;
    this.encodeQueue.enqueue({
      assetGuid: guid,
      source: source.bytes,
      mime: source.mime,
      settings: {
        ...this.encodeSettingsFor(latest),
        maxDimension: effectiveTextureMaxDimension(
          assetMax,
          this.encodeSettings.maxDimension,
        ),
      },
    });
    return true;
  }

  /** Re-queue textures that fell back when the transcoder was unavailable. */
  async requeueUncompressedTextures(): Promise<number> {
    if (!this.encodeQueue) return 0;
    let count = 0;
    for (const asset of this.list({ type: "Texture" })) {
      const state = asset.header.payload.compressionState;
      if (
        state === "fallback_uncompressed" ||
        state === "pending" ||
        state === "encoding"
      ) {
        if (await this.retryTextureEncoding(asset.header.guid)) count += 1;
      }
    }
    return count;
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
    if (!shouldCompressTexture(usage)) return;
    if (asset.header.payload.compressionState !== "pending") return;
    const source = await this.loadSourcePixels(asset);
    if (!source) return;
    this.encodeQueue.enqueue({
      assetGuid: asset.header.guid,
      source: source.bytes,
      mime: source.mime,
      settings: this.encodeSettingsFor(asset),
    });
  }

  private encodeSettingsFor(asset: IndexedAsset): TextureEncodeSettings {
    return {
      ...this.encodeSettings,
      maxDimension: effectiveTextureMaxDimension(
        asset.header.payload.maxDimension,
        this.encodeSettings.maxDimension,
      ),
    };
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
    const next = (this.textureWriteChain.get(guid) ?? Promise.resolve()).then(
      work,
      work,
    );
    this.textureWriteChain.set(
      guid,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async rewriteTexture(
    guid: string,
    mutate: (
      header: Omit<BabassetHeader, "chunks">,
      chunks: Map<string, ChunkInput>,
    ) => Promise<{
      header: Omit<BabassetHeader, "chunks">;
      chunks: Map<string, ChunkInput>;
    }>,
  ): Promise<void> {
    const asset = this.byGuid.get(guid);
    if (!asset) return;
    const storage = this.storageForAsset(asset);
    const blobs = this.blobsForAsset(asset);
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
    const next = await mutate({ ...headerRest }, chunksById);
    const bytes = await encodeBabasset({
      header: next.header,
      chunks: [...next.chunks.values()],
      writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
    });
    await storage.writeBinary(asset.path, bytes);
    const header = readBabassetHeader(bytes);
    this.indexHeader(asset.rootId, asset.path, header);
  }

  /** Attach a representation chunk (facetype / msdf) to an existing Font asset. */
  private async attachToExistingAsset(guid: string, result: ImportResult): Promise<void> {
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
    const bytes = await encodeBabasset({
      header: { ...headerRest, payload: { ...headerRest.payload, ...result.payload } },
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

  private async walk(root: ContentRoot, dir: string): Promise<void> {
    const storage = this.storageOf(root);
    let entries;
    try {
      entries = await storage.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDir) {
        if (entry.name === BLOBS_DIR_NAME) continue;
        this.knownFolders.add(path);
        await this.walk(root, path);
        continue;
      }
      if (entry.name === FOLDER_MARKER_NAME) {
        this.knownFolders.add(dir);
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
    if (existingAtPath) this.removeFromIndex(existingAtPath);
    const existingByGuid = this.byGuid.get(header.guid);
    if (existingByGuid) this.removeFromIndex(existingByGuid);

    const indexed: IndexedAsset = { rootId, path, header, placeholder, mtime };
    this.byGuid.set(header.guid, indexed);
    this.byPath.set(path, indexed);
    for (const dep of header.dependencies) {
      let set = this.inbound.get(dep);
      if (!set) {
        set = new Set();
        this.inbound.set(dep, set);
      }
      set.add(header.guid);
    }
    return indexed;
  }

  private removeFromIndex(asset: IndexedAsset): void {
    this.byGuid.delete(asset.header.guid);
    if (this.byPath.get(asset.path) === asset) {
      this.byPath.delete(asset.path);
    }
    for (const dep of asset.header.dependencies) {
      const set = this.inbound.get(dep);
      set?.delete(asset.header.guid);
      if (set && set.size === 0) this.inbound.delete(dep);
    }
    // Remaining referrers are rewritten to None by Content Browser delete
    // (`ProjectService.clearDeletedAssetReferences`), not here — Skybox
    // Creator replace deletes then recreates the same guid.
    this.inbound.delete(asset.header.guid);
  }
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
