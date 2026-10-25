import type { ProjectStorage } from "@haptic/core";
import type { AreaEmissionProgress } from "./area-emission";
import type { BlobStore } from "./blob-store";
import type { ContentRoot } from "./content-root";
import type { EncodeQueue } from "./encode-queue";
import type { HassetHeader } from "./hasset";
import type { ImportRunner } from "./importers";
import type { AccountedPayloadLoader, AssetSourceLocator } from "./payload-loader";
import type { AssetRegistry } from "./registry";
import type { TextureEncodeSettings } from "./texture-compression";

export type AreaEmissionProcessor = (request: { source: Uint8Array; sourceHash: string; mime?: string }, signal: AbortSignal, onProgress?: (progress: AreaEmissionProgress) => void) => Promise<Uint8Array>;

/** Index entry: header-only, never a decoded payload (engineplan §2.4). */
/** Cancellation and progress for asset and folder copies. */
export interface AssetCopyOptions {
  signal?: AbortSignal;
  /** Folder copies only: files copied so far out of the folder's total. */
  onProgress?: (copied: number, total: number) => void;
}

export interface IndexedAsset {
  rootId: string;
  path: string;
  header: HassetHeader;
  /** Storage snapshot for bounded payload reads; populated on scan or first request. */
  locator?: AssetSourceLocator;
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
export const FOLDER_MARKER_NAME = ".haptic-folder";

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  assets: string[];
}

/**
 * An asset file a scan left out of the index because an already indexed file
 * (`indexedPath`) has the same guid, such as a copy made outside the editor.
 */
export interface GuidConflict {
  rootId: string;
  path: string;
  guid: string;
  indexedPath: string;
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
   * Textures an alignment check is requeuing right now. Pass the same set to
   * every remount that shares one encode queue, so a check on the previous
   * registry and one on the next skip each other's Texture.
   */
  alignmentRequeues?: Set<string>;
  /**
   * Runs each file's importer for `importFile`; defaults to
   * `importByExtension`. The editor passes one that imports slow, pure-CPU
   * formats on a Web Worker.
   */
  runImport?: ImportRunner;
}

/** Progress and cancellation for one `importFile` or HDR reconversion. */
export interface AssetImportControl {
  /**
   * Abort before or during the conversion writes nothing; an abort that lands
   * while the file's assets are written deletes the ones already made.
   */
  signal?: AbortSignal;
  /** Fraction of the file's conversion done, from 0 to 1. */
  onProgress?: (fraction: number) => void;
}

/**
 * What the registry's operation modules (`registry-*.ts`) reach of the
 * `AssetRegistry` they work for. The maps and sets are the registry's own;
 * every method calls through the registry when it runs, so the modules see
 * the registry's current fields, and a public method replaced on the
 * instance (a test spy) also sees their calls.
 */
export interface RegistryHost extends Pick<
  AssetRegistry,
  | "list"
  | "readChunk"
  | "getAssetLocator"
  | "isAtlasTexture"
  | "withAssetWrite"
  | "createAsset"
  | "deleteAsset"
  | "createFolder"
  | "deleteFolder"
  | "setCompressionState"
  | "retryTextureEncoding"
  | "reconcileTextureAlignment"
> {
  readonly byGuid: Map<string, IndexedAsset>;
  readonly byPath: Map<string, IndexedAsset>;
  readonly roots: ReadonlyMap<string, ContentRoot>;
  readonly knownFolders: ReadonlySet<string>;
  readonly guidConflicts: Map<string, GuidConflict>;
  readonly alignmentRequeues: Set<string>;
  readonly textureWriteChain: ReadonlyMap<string, Promise<void>>;
  readonly loader: AccountedPayloadLoader;
  encodeQueue(): EncodeQueue | null;
  encodeSettings(): TextureEncodeSettings;
  thumbnailWriter(): ThumbnailWriter | null;
  /** Run the current thumbnail writer, which the caller checked is set. */
  writeThumbnail(assetGuid: string, bytes: Uint8Array): Promise<void>;
  /** Tell the own-write listener, if any. */
  reportOwnWrite(write: OwnAssetWrite): void;
  runImport(...args: Parameters<ImportRunner>): ReturnType<ImportRunner>;
  changed(): void;
  addKnownFolder(path: string): void;
  removeKnownFolder(path: string): void;
  isPathReserved(path: string): boolean;
  reservePath(path: string, conflict: string): () => void;
  withReservedPath<T>(path: string, conflict: string, work: () => Promise<T>): Promise<T>;
  withCreationWrite<T>(work: () => Promise<T>): Promise<T>;
  indexHeader(
    rootId: string,
    path: string,
    header: HassetHeader,
    placeholder?: boolean,
    mtime?: number | null,
    locator?: AssetSourceLocator,
  ): IndexedAsset;
  indexCreatedHeader(rootId: string, path: string, header: HassetHeader, mtime?: number | null): IndexedAsset;
  repathGuidConflicts(map: (path: string) => string): void;
  deleteAssetUnlocked(guid: string): Promise<void>;
  getRootOrThrow(rootId: string): ContentRoot;
  assertWritable(root: ContentRoot): void;
  storageOf(root: ContentRoot): ProjectStorage;
  blobsOf(root: ContentRoot): BlobStore;
  storageForAsset(asset: IndexedAsset): ProjectStorage;
  blobsForAsset(asset: IndexedAsset): BlobStore;
  statMtime(storage: ProjectStorage, path: string): Promise<number | null>;
}
