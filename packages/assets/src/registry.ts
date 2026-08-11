import type { ProjectStorage } from "@babylonslate/core";
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
import {
  importByExtension,
  remapImportResultGuids,
  type ImportOptions,
  type ImportResult,
} from "./importers";
import { AccountedPayloadLoader } from "./payload-loader";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  type TextureCompressionState,
  type TextureEncodeSettings,
} from "./texture-compression";
import { generateThumbnailBytes } from "./thumbnails";

/** Index entry: header-only, never a decoded payload (engineplan §2.4). */
export interface IndexedAsset {
  rootId: string;
  path: string;
  header: BabassetHeader;
}

export type ThumbnailWriter = (
  assetGuid: string,
  bytes: Uint8Array,
) => Promise<void>;

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
  /** guid -> guids of assets whose header `dependencies[]` names it. */
  private readonly inbound = new Map<string, Set<string>>();
  private encodeQueue: EncodeQueue | null = null;
  private encodeSettings: TextureEncodeSettings = {
    ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
  };
  private thumbnailWriter: ThumbnailWriter | null = null;

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
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : root.pathPrefix;
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
    const path = joinRootPath(root, relativePath);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir) {
      await this.storage.mkdir(dir, true);
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
      writeBlob: (sha256, data) => this.blobs.writeBlob(sha256, data),
    });
    await this.storage.writeBinary(path, bytes);
    const header = readBabassetHeader(bytes);
    return this.indexHeader(rootId, path, header);
  }

  async deleteAsset(guid: string): Promise<void> {
    const asset = this.byGuid.get(guid);
    if (!asset) return;
    await this.storage.remove(asset.path);
    this.removeFromIndex(asset);
  }

  async deleteFolder(rootId: string, relativeFolder: string): Promise<void> {
    const root = this.getRootOrThrow(rootId);
    const folderPath = joinRootPath(root, relativeFolder);
    for (const asset of [...this.byGuid.values()]) {
      if (asset.rootId === rootId && isWithinFolder(asset.path, folderPath)) {
        this.removeFromIndex(asset);
      }
    }
    await this.storage.remove(folderPath);
  }

  async importFile(
    rootId: string,
    folderRelative: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<IndexedAsset[]> {
    this.getRootOrThrow(rootId);
    const options: ImportOptions = {
      fileName,
      existingGuids: new Set(this.byGuid.keys()),
      fontGuidsByName: this.fontGuidsByName(),
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
    const thumb = await generateThumbnailBytes(pixels.data);
    if (!thumb) return;
    await this.thumbnailWriter(asset.header.guid, thumb);
  }

  async setCompressionState(
    guid: string,
    state: TextureCompressionState,
  ): Promise<void> {
    await this.rewriteTexture(guid, async (header, chunks) => {
      header.payload = { ...header.payload, compressionState: state };
      return { header, chunks };
    });
  }

  async commitCompressedTexture(result: EncodeJobResult): Promise<void> {
    const hash = await encodeSettingsHash(result.settings);
    const chunkId = ktx2ChunkId(hash);
    await this.rewriteTexture(result.assetGuid, async (header, chunks) => {
      chunks.set(chunkId, {
        id: chunkId,
        kind: "ktx2",
        mime: "image/ktx2",
        data: result.ktx2,
      });
      header.payload = {
        ...header.payload,
        compressionState: "compressed",
        encodeWallMs: result.wallMs,
        ktx2ChunkId: chunkId,
      };
      return { header, chunks };
    });
  }

  async retryTextureEncoding(guid: string): Promise<boolean> {
    const asset = this.byGuid.get(guid);
    if (!asset || asset.header.type !== "Texture" || !this.encodeQueue) {
      return false;
    }
    const state = asset.header.payload.compressionState;
    if (state !== "encode_failed" && state !== "fallback_uncompressed") {
      return false;
    }
    const source = await this.loadSourcePixels(asset);
    if (!source) return false;
    await this.setCompressionState(guid, "pending");
    this.encodeQueue.enqueue({
      assetGuid: guid,
      source,
      settings: this.encodeSettings,
    });
    return true;
  }

  /** Re-queue textures that fell back when the transcoder was unavailable. */
  async requeueUncompressedTextures(): Promise<number> {
    if (!this.encodeQueue) return 0;
    let count = 0;
    for (const asset of this.list({ type: "Texture" })) {
      if (asset.header.payload.compressionState === "fallback_uncompressed") {
        if (await this.retryTextureEncoding(asset.header.guid)) count += 1;
      }
    }
    return count;
  }

  /** Paths of Scene and Graph assets for ProjectDocument reconciliation. */
  listDocumentPaths(): { scenes: string[]; graphs: string[] } {
    const scenes: string[] = [];
    const graphs: string[] = [];
    for (const asset of this.byGuid.values()) {
      if (asset.header.type === "Scene") scenes.push(asset.path);
      else if (asset.header.type === "Graph") graphs.push(asset.path);
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
      source,
      settings: this.encodeSettings,
    });
  }

  private async loadSourcePixels(
    asset: IndexedAsset,
  ): Promise<Uint8Array | null> {
    const pixels = asset.header.chunks.find((chunk) => chunk.kind === "pixels");
    if (!pixels) return null;
    const fileBytes = await this.storage.readBinary(asset.path);
    return this.loader.loadChunk(fileBytes, pixels);
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
    const fileBytes = await this.storage.readBinary(asset.path);
    const decoded = await decodeBabasset(fileBytes, (sha256) =>
      this.blobs.readBlob(sha256),
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
      writeBlob: (sha256, data) => this.blobs.writeBlob(sha256, data),
    });
    await this.storage.writeBinary(asset.path, bytes);
    const header = readBabassetHeader(bytes);
    this.indexHeader(asset.rootId, asset.path, header);
  }

  /** Attach a representation chunk (facetype / msdf) to an existing Font asset. */
  private async attachToExistingAsset(guid: string, result: ImportResult): Promise<void> {
    const asset = this.byGuid.get(guid);
    if (!asset) {
      throw new Error(`Cannot attach representation: no asset for guid ${guid}`);
    }
    const fileBytes = await this.storage.readBinary(asset.path);
    const decoded = await decodeBabasset(fileBytes, (sha256) => this.blobs.readBlob(sha256));

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
      writeBlob: (sha256, data) => this.blobs.writeBlob(sha256, data),
    });
    await this.storage.writeBinary(asset.path, bytes);
    const header = readBabassetHeader(bytes);
    this.indexHeader(asset.rootId, asset.path, header);
  }

  private getRootOrThrow(rootId: string): ContentRoot {
    const root = this.roots.get(rootId);
    if (!root) {
      throw new Error(`Unknown content root: ${rootId}`);
    }
    return root;
  }

  private async walk(root: ContentRoot, dir: string): Promise<void> {
    let entries;
    try {
      entries = await this.storage.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDir) {
        if (entry.name === BLOBS_DIR_NAME) continue;
        await this.walk(root, path);
        continue;
      }
      if (!path.endsWith(".babasset")) continue;
      const bytes = await this.storage.readBinary(path);
      const header = readBabassetHeader(bytes);
      this.indexHeader(root.id, path, header);
    }
  }

  private indexHeader(rootId: string, path: string, header: BabassetHeader): IndexedAsset {
    const existingAtPath = this.byPath.get(path);
    if (existingAtPath) this.removeFromIndex(existingAtPath);
    const existingByGuid = this.byGuid.get(header.guid);
    if (existingByGuid) this.removeFromIndex(existingByGuid);

    const indexed: IndexedAsset = { rootId, path, header };
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
    // Drop the reverse-index bucket for this guid; remaining referrers still
    // list it in their own outbound `dependencies[]` until they are edited.
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
