import { isProjectOpenElsewhere, isStorageNotFound, SourceRevisionChangedError } from "@haptic/core";
import { newGuid, normalizeDataDefinitionAsset, normalizeDataTreeAsset } from "@haptic/core";
import { normalizeImportedProject, readProjectArchive, PROJECT_IMPORT_LIMIT } from "./project-import";
import { getHostPlatform, isAppOwnedFolder, pickImportFiles } from "@haptic/vfs";
import { staticAudioGeometryFingerprint } from "../lib/audio-reverb-bake";
import { convertGlslToMaterial, normalizeMaterialDocument, normalizeMaterialFunctionDocument, validateMaterialParameterNames } from "@haptic/shader-graph";
import { EditorExtensionService } from "./editor-extension-service";
import { admitOwnerWrites, guardProjectStorage, ProjectWriteAdmission, withExclusiveWriter, withProjectWriter, type ProjectSceneWriter, type ProjectWriteLease, type ProjectWriteLockOptions } from "./project-write-admission";
import { guardProjectAssetRegistry } from "./project-authoring-ports";
import { isExtensionPackagePath, isAssetSourceRevisionChanged, mountExtensionContentRoots, resolveExtensionFieldValues, type AssetDocument, type ExtensionDescriptor } from "@haptic/assets";
import type {
  AssetDocumentKind,
  PluginEnableOverride,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
  SerializedSceneLayer,
} from "@haptic/core";
import {
  isInputAssetType,
  ENGINE_VERSION,
  normalizeInputAssetPayload,
  assetTypeForDocumentKind,
  createDefaultScene,
  projectSceneCameraFraming,
  createEmptyLayouts,
  createEmptyProject,
  normalizeProjectAppearance,
  PROJECT_COVER_FILES,
  projectCoverDataUrl,
  projectCoverFromDataUrl,
  storedProjectAppearance,
  normalizeScene,
  normalizeSceneLayer,
  normalizePrefab,
  documentId,
  parseDocumentId,
  documentKindForAssetType,
  isAssetDocumentKind,
  isExtensionAssetType,
  LAYOUT_FILE,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  type ProjectDocument,
  type ProjectMetadata,
  type ProjectAppearance,
  type RenderProjectSettings,
  isFoliageChunkId,
  isLandscapeChunkId,
} from "@haptic/core";
import type { ProjectFolderHandle, ProjectStorage, SourceControlProjectSettings } from "@haptic/core";
import {
  AssetRegistry,
  createRegistryAssetLoadingService,
  registryAssetRepresentation,
  type AssetLoadingService,
  type AssetLoadScope,
  type AssetLoadScopeOptions,
  type AssetLoadPriority,
  type RegistryLoadedAsset,
  AccountedPayloadLoader,
  readAssetCatalog,
  RegistryGenerationClock,
  type AreaEmissionProgress,
  createProjectFromTemplate,
  normalizeTilemapPayload,
  createVfsBlobStore,
  collectReferencedBlobs,
  orphanedBlobCandidates,
  sweepOrphanedBlobs,
  decodeAssetDocument,
  encodePluginSettingsDocument,
  normalizePluginSettings,
  stableStringify,
  carryStoredChunks,
  audioReverbChunk,
  AUDIO_REVERB_CHUNK_ID,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  DOCUMENT_CHUNK_ID,
  encodeAssetDocument,
  audioClipChunk,
  audioClipChunkToDrop,
  extractFoliageChunks,
  extractLandscapeChunks,
  foliageChunkIdsInHeader,
  hydrateFoliageChunksToEditor,
  hydrateLandscapeChunksToEditor,
  landscapeChunkIdsInHeader,
  unreadableComponentChunks,
  exportProjectZip,
  type ClassAssetReplacement,
  isAssetDocumentPath,
  isTracePath,
  createDefaultMigrationRegistry,
  projectContentRoot,
  readAssetDocumentHeader,
  readTraceDocument,
  readProjectTree,
  writeThumbnail,
  ProjectSearchIndex,
  type AssetCatalogRead,
  type HassetHeader,
  type ChunkInput,
  type EncodableChunk,
  type BlobStore,
  type MigrationRegistry,
  type PluginDescriptor,
  type PluginDiagnostic,
  type IndexedAsset,
  type ProjectTreeFile,
  type OwnAssetWrite,
  INCOMPLETE_PROJECT_MANIFEST,
  isCompleteProjectManifest,
  readProjectManifest,
} from "@haptic/assets";
import { decodeHasset, encodeHasset, isCarriedChunk } from "@haptic/assets/hasset";
import { runImportOffMainThread } from "@haptic/assets/import-worker-client";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "@haptic/vfs";
import { NAVMESH_CHUNK_ID, navmeshChunk } from "@haptic/navigation/chunk";
import { assetHeaderDependencyMetadata } from "../lib/asset-header-dependencies";
import {
  SEARCH_CATALOG_CLASS_IDS,
  searchNodeTitles,
} from "../lib/search-catalog";
import { isPluginDocumentReadOnly } from "../lib/plugin-ui";
import { requestProjectThumbnails } from "../lib/model-thumbnail-queue";
import {
  normalizeProjectFolderName,
  type BuiltInStarterKind,
  type CreateProjectOptions,
  type StepProgress,
} from "../lib/create-project";
import type { UpdateListedProjectOptions } from "../lib/listed-projects";
import { throwIfCancelled } from "@haptic/source-control";
import { sameRepository } from "../lib/source-control-mode";
import { createDefaultLogicGraphSerialized, defaultNodeRegistry, requireClassGraphPayload } from "./graph-validation";
import { syncExtensionNodes } from "./extension-nodes";
import {
  assetName,
  fallbackDocumentType,
  headerMetaForSave,
  parentDir,
  suppliedChunkIds,
  withSavedTextureEncodeState,
} from "./project-document-meta";
import { ProjectTextureEncoding, type TextureEncodingOptions } from "./project-texture-encoding";
import { ProjectPlugins, type PluginImportOptions, type PluginImportResult } from "./project-plugins";
import { resetAreaEmissionPreparations } from "../lib/area-emission-preparation";
import {
  assertEmptyProjectFolder,
  createInputAssets,
  openOwnedDocumentsProject,
  projectFolderIsEmpty,
  scaffoldFeatureTest,
  scaffoldPixelArtFonts,
  scaffoldKenneyMannequinEmpty,
  scaffoldOwnedProject,
  type OwnedFolder,
  type StarterScaffoldHost,
} from "./project-scaffold";
import {
  keptChunksFor,
  readExistingAssetMeta,
  readUnindexedAssetDocument,
  storeDocumentBytes,
  type AssetFileAccess,
} from "./project-asset-files";
import {
  clearDeletedAssetReferences,
  renameAsset,
  replaceClassReferencesBeforeDelete,
  type ReferenceRepairHost,
} from "./project-reference-repair";

export interface ProjectLoadResult {
  document: ProjectDocument;
  layouts: ProjectLayouts;
}

export type { PluginImportOptions, PluginImportResult } from "./project-plugins";

/**
 * What Clean Unused Project Storage did: `reclaimed` (`stopped` when a write
 * landed or the lock was busy, so files may remain for the next run),
 * `source-control` (Git owns blob retention: nothing run), `incomplete` (an
 * asset header could not be read: nothing removed), `linked` (a symbolic
 * link may alias a blob folder: nothing removed), `no-project`.
 */
/** The manual Clean Unused Project Storage reads the referenced set again at most this many times when writes interrupt it. */
const MANUAL_SWEEP_PASSES = 8;
const MANUAL_SWEEP_RETRY_MS = 250;

export type BlobReclaimResult =
  | { status: "reclaimed"; files: number; bytes: number; stopped: boolean }
  | { status: "source-control" }
  | { status: "incomplete"; unreadable: string[] }
  | { status: "linked" }
  | { status: "no-project" };

/**
 * Reverb results kept per Scene: an edit's, a newer edit's baked during its
 * Save, and the saved geometry's, with room to spare. Each is at most a few KB.
 */
const SCENE_AUDIO_REVERB_RESULTS = 4;

/**
 * Chunks `loadDocumentWithChunks` reads with a document: fixed ids, or a choice
 * made from the header of the version being read.
 */
export type DocumentChunkSelection = readonly string[] | ((header: HassetHeader) => readonly string[]);

export class ProjectService {
  private readonly writeAdmission = new ProjectWriteAdmission();
  private readonly storage: ProjectStorage;
  private readonly publicStorage: ProjectStorage;
  /** The storage behind the admission guards, handed only to `withExclusiveWrites` work. */
  private readonly unguardedStorage: ProjectStorage;
  private readonly registryViews = new WeakMap<AssetRegistry, AssetRegistry>();
  readonly extensions: EditorExtensionService;
  private projectGuid: string | null = null;
  private readonly migrations: MigrationRegistry;
  private readonly blobs: BlobStore;
  private assetRegistry: AssetRegistry | null = null;
  /** The source session `assetRegistry` was mounted in. */
  private assetRegistrySession = -1;
  private readonly registryMounts = new Set<{ session: number; promise: Promise<AssetRegistry> }>();
  private sourceLoading: AssetLoadingService | null = null;
  private sourceSession = 0;
  private projectSearchIndex: ProjectSearchIndex | null = null;
  private readonly textures: ProjectTextureEncoding;
  private readonly projectPlugins: ProjectPlugins;
  /** The last queued write of each file the registry does not index. */
  private readonly unindexedWrites = new Map<string, Promise<void>>();
  private derivedStorage: ProjectStorage | null = null;
  /** Asset guids stay stable across saves so references survive a rewrite. */
  private readonly assetGuids = new Map<string, string>();
  /** Guids a scaffold embedded in other documents before writing these paths. */
  private readonly reservedAssetGuids = new Map<string, string>();
  /**
   * Reverb results by Scene GUID, then by the static-geometry fingerprint each
   * was baked from. An unsaved geometry's result becomes persistent only with
   * the matching Scene, so a bake of other geometry (export's of the saved
   * Scene) must not replace it before that Save.
   */
  private readonly sceneAudioReverb = new Map<string, Map<string, Uint8Array>>();
  private readonly registryListeners = new Set<() => void>();
  /** Engine Extensions' storage, for the roots of engine gameplay extensions. */
  private engineExtensionStorage: ProjectStorage | null = null;
  private readonly ownWriteListeners = new Set<(write: OwnAssetWrite) => void>();
  private readonly diagnostics: string[] = [];
  private readonly diagnosticListeners = new Set<(line: string) => void>();
  /** `<path>\n<componentId>` of each unreadable Landscape already reported. */
  private readonly reportedUnreadableComponentChunks = new Set<string>();
  /** Change counter shared by every project registry, so remounts never rewind it. */
  private readonly registryClock = new RegistryGenerationClock();
  private readonly files: AssetFileAccess = {
    storageFor: (path) => this.storageForPath(path),
    blobsFor: (path) => this.blobsForPath(path),
  };

  constructor(
    storage: ProjectStorage,
    options: TextureEncodingOptions & {
      /** Schema versions; tests inject other versions to exercise strict version checks. */
      migrations?: MigrationRegistry;
    } = {},
  ) {
    this.migrations = options.migrations ?? createDefaultMigrationRegistry();
    this.unguardedStorage = storage;
    storage = guardProjectStorage(storage, this.writeAdmission, true);
    this.storage = storage;
    this.publicStorage = guardProjectStorage(storage, this.writeAdmission);
    const assetPath = (path: string) => {
      if (!isExtensionPackagePath(path) || !path.startsWith("assets/") || !path.endsWith(".hasset")) {
        throw new Error("Extension asset writes require a project assets/*.hasset path.");
      }
    };
    const codePath = (path: string) => {
      if (!isExtensionPackagePath(path) || !path.startsWith("code/") || !/\.(?:ts|js)$/.test(path)) {
        throw new Error("Extension code APIs require a project code/*.ts or code/*.js path.");
      }
    };
    const writeAsset = async (path: string, document: Pick<AssetDocument, "type" | "name" | "payload">) => {
      assetPath(path);
      const kind = documentKindForAssetType(document.type);
      // An extension asset type is authorable while an enabled extension declares it; its payload is that type's values.
      const extensionType = kind === "extension-asset"
        ? this.extensions.getSnapshot().assetTypes.find((entry) => entry.type === document.type)
        : undefined;
      const authorable = kind === "extension-asset"
        ? extensionType !== undefined
        : kind !== null && kind !== "trace" && assetTypeForDocumentKind(kind) === document.type;
      if (!kind || !authorable) {
        throw new Error(`Extension cannot author this asset type: ${document.type}`);
      }
      await this.saveDocument(kind, path,
        extensionType ? resolveExtensionFieldValues(extensionType.fields, document.payload) : document.payload,
        extensionType ? { type: document.type } : undefined);
      this.emitRegistryChange();
    };
    const pendingAssetCreates = new Set<string>();
    this.extensions = new EditorExtensionService(storage, {
      assets: {
        list: async () => (this.assetRegistry?.list() ?? []).map((entry) => ({ path: entry.path, type: entry.header.type, name: entry.header.name, guid: entry.header.guid })),
        read: async (path) => {
          if (!this.assetRegistry?.getByPath(path)) throw new Error("Asset not found.");
          return decodeAssetDocument(await this.storageForPath(path).readBinary(path), { blobs: this.blobsForPath(path) });
        },
        create: async (path, document) => {
          assetPath(path);
          if (pendingAssetCreates.has(path)) throw new Error("An asset is already being created at this path. Choose another name.");
          pendingAssetCreates.add(path);
          try {
            if (await storage.exists(path)) throw new Error("An asset already exists at this path. Choose another name.");
            await writeAsset(path, document);
          } finally {
            pendingAssetCreates.delete(path);
          }
        },
        update: async (path, document) => {
          assetPath(path);
          const entry = this.assetRegistry?.getByPath(path);
          if (!entry || entry.header.guid !== document.guid || entry.header.type !== document.type) {
            throw new Error("Asset identity changed. Read the asset again before updating.");
          }
          await writeAsset(path, document);
        },
      },
      code: {
        read: (path) => { codePath(path); return storage.readText(path); },
        write: async (path, source) => {
          codePath(path);
          await storage.mkdir(parentDir(path), true);
          await storage.writeText(path, source);
        },
      },
      materials: { convertGlsl: convertGlslToMaterial },
      // Kept with the session's other diagnostics, under the same cap.
      log: (id, message) => this.pushDiagnostic(`[Extension ${id}] ${message}`),
    }, {
      runAuthoringWrite: operation => this.writeAdmission.run(operation),
      syncContentRoots: async (extensions) => {
        const registry = this.assetRegistry;
        if (!registry) return;
        await this.mountExtensionContent(registry, extensions);
        this.emitRegistryChange();
      },
      // Graph nodes join the editor's one node registry, which compile, validation and Add Node read.
      syncNodes: (extensions) => syncExtensionNodes(defaultNodeRegistry(), extensions),
    });
    this.blobs = createVfsBlobStore(storage);
    this.projectPlugins = new ProjectPlugins({
      storage,
      blobs: this.blobs,
      registry: () => this.assetRegistry,
      emitRegistryChange: () => this.emitRegistryChange(),
    });
    this.textures = new ProjectTextureEncoding({
      writeAdmission: this.writeAdmission,
      registry: () => this.assetRegistry,
      encodeRegistry: () => this.encodeRegistry(),
      sourceSession: () => this.sourceSession,
      registryMounts: () => this.registryMounts,
      plugins: () => this.projectPlugins.descriptors,
      emitRegistryChange: () => this.emitRegistryChange(),
      pushDiagnostic: (line) => this.pushDiagnostic(line),
    }, options);
    return admitOwnerWrites(this, this.writeAdmission, [
      "retryTextureEncoding", "retryAllFailedTextureEncoding",
      "prepareAreaEmission", "reconvertHdrEnvironment", "deleteListedProject", "openProject", "createEmptyProject",
      "createFromTemplate", "openListedProject", "closeProject",
      "updateListedProject", "reconnect", "loadCurrentProject", "syncPlugins", "applyPluginOverrides",
      "createProjectPlugin", "deleteProjectPlugin", "importPlugin", "remountRegistry",
      "replaceClassReferencesBeforeDelete", "clearDeletedAssetReferences", "renameAsset", "saveDocument",
      "writeSceneNavmeshChunk", "writeSceneAudioReverbChunk", "writeAudioClipChunk",
      "removeAudioClipChunk", "saveProject", "saveLayouts",
    ]);
  }

  /** Close new file-write admissions and wait for complete admitted owner operations. */
  lockAuthoringWrites(reason: string): ProjectWriteLease {
    return this.writeAdmission.lock(reason);
  }

  /** Resolves once a save would be admitted without waiting for a commit's lock (`ProjectWriteAdmission.whenAdmitting`). */
  whenWritesAdmitted(): Promise<void> {
    return this.writeAdmission.whenAdmitting();
  }

  /** Why a save is refused now; null while no lock refuses (a commit's lock makes a save wait instead). */
  get authoringWriteBlockedReason(): string | null { return this.writeAdmission.refusal; }

  /**
   * Runs `work` as the project's only writer (Remove Unused Files): other
   * writers are refused with `reason`, admitted ones (saves, imports, copies,
   * encodes) finish first, and `work` writes through the storage it is given
   * until it returns. Refused while another operation holds project writes
   * (Simulation); `signal` ends the wait. With `queueWrites` (a commit) other
   * writers wait for it instead of being refused.
   */
  withExclusiveWrites<T>(reason: string, work: (storage: ProjectStorage) => Promise<T>, signal?: AbortSignal, options?: ProjectWriteLockOptions): Promise<T> {
    return withExclusiveWriter(this.writeAdmission, this.unguardedStorage, reason, work, signal, options);
  }

  /**
   * Resolves once the Texture encode queue has no job waiting or running and
   * the last result is written (`EncodeQueue.whenIdle`); a queue paused with
   * work waiting (a Scene load, Play, the app in the background) is not idle
   * until it resumes and finishes. `signal` ends the wait. Publish waits for
   * it, so a project's first commit holds its encodes rather than leaving
   * them as changes.
   */
  textureEncodesIdle(signal?: AbortSignal): Promise<void> {
    return this.textures.whenIdle(signal);
  }

  /**
   * Clean Unused Project Storage: removes `assets/.blobs` files no asset
   * names (and staged write files a killed write or download left there),
   * each only once it is `minAgeMs` old by mtime. Never while Source Control
   * is on or the folder is a Git working copy (`.git`): Git and Git LFS own
   * blob retention there, and Remove Unused Files serves it.
   *
   * Safety: the referenced set is every header on disk (`collectReferencedBlobs`);
   * an unreadable header or a linked folder removes nothing. Files go a few
   * at a time, each unit under a yielding hold (`runYieldingUnit`) taken
   * only while no write is admitted and no project write happened since the
   * set was read (`writeEpoch`). A save, auto-save, import or encode arriving
   * during a unit waits for it (milliseconds) and is never refused; the
   * write then stops the sweep before its next unit. A blob written or asked
   * for (`writeBlob`) within the grace window stays, which covers an asset
   * written after its blobs.
   *
   * `automatic` (after a project opens) stops there and leaves the rest to a
   * later run. The manual run (Project Settings) reads the set again and
   * goes on, up to `MANUAL_SWEEP_PASSES` passes, waiting briefly while
   * writes are busy.
   */
  async reclaimUnusedBlobs(options: { automatic?: boolean; signal?: AbortSignal; minAgeMs?: number; now?: () => number } = {}): Promise<BlobReclaimResult> {
    if (!this.projectGuid) return { status: "no-project" };
    if (await this.sourceControlOwnsBlobs()) return { status: "source-control" };
    const sweepOptions = {
      ...(options.minAgeMs !== undefined ? { minAgeMs: options.minAgeMs } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const pass = async (): Promise<BlobReclaimResult> => {
      const epoch = this.writeAdmission.writeEpoch;
      // Cheap first look: nothing old enough that the index leaves unnamed means nothing to read further.
      const indexed = new Set((this.assetRegistry?.list() ?? []).flatMap((entry) =>
        entry.header.chunks.flatMap((chunk) => ("blob" in chunk.locator ? [chunk.locator.blob] : []))));
      if ((await orphanedBlobCandidates(this.storage, indexed, sweepOptions)).length === 0) return { status: "reclaimed", files: 0, bytes: 0, stopped: false };
      const referenced = await collectReferencedBlobs(this.storage, options.signal);
      if (!referenced.complete) return referenced.reason === "linked" ? { status: "linked" } : { status: "incomplete", unreadable: referenced.paths };
      const result = await sweepOrphanedBlobs(this.storage, referenced.blobs, {
        ...sweepOptions,
        // A write since the set was read may name a candidate: no further unit runs.
        admit: (removeUnit) => this.writeAdmission.runYieldingUnit(
          () => this.writeAdmission.writeEpoch === epoch,
          () => removeUnit(this.unguardedStorage),
        ),
      });
      return { status: "reclaimed", files: result.removed.length, bytes: result.bytes, stopped: result.stopped };
    };
    if (options.automatic) return pass();
    let files = 0;
    let bytes = 0;
    for (let attempt = 1; ; attempt++) {
      const result = await pass();
      if (result.status !== "reclaimed") return files > 0 ? { status: "reclaimed", files, bytes, stopped: true } : result;
      files += result.files;
      bytes += result.bytes;
      if (!result.stopped || attempt >= MANUAL_SWEEP_PASSES) return { status: "reclaimed", files, bytes, stopped: result.stopped };
      await new Promise((resolve) => setTimeout(resolve, MANUAL_SWEEP_RETRY_MS));
      options.signal?.throwIfAborted();
    }
  }

  /** Source Control is on in `project.json`, or the folder is a Git working copy; unreadable settings count as on. */
  private async sourceControlOwnsBlobs(): Promise<boolean> {
    try {
      const raw = JSON.parse(await this.storage.readText(PROJECT_FILE)) as { settings?: { sourceControl?: { mode?: unknown } } };
      if ((raw.settings?.sourceControl?.mode ?? "off") !== "off") return true;
      return await this.storage.exists(".git");
    } catch {
      return true;
    }
  }

  /** Save All owns one admission, even when it saves several documents after awaits. */
  withBaselineSave<T>(save: (writer: Pick<ProjectService, "saveDocument" | "saveProject"> & ProjectSceneWriter) => Promise<T>): Promise<T> {
    return withProjectWriter(this.writeAdmission, {
      saveDocument: this.saveDocument.bind(this),
      saveProject: this.saveProject.bind(this),
      ...this.sceneWriter(),
    }, save);
  }

  withSceneWrite<T>(work: (writer: ProjectSceneWriter) => Promise<T>): Promise<T> {
    return withProjectWriter(this.writeAdmission, this.sceneWriter(), work);
  }

  private sceneWriter(): ProjectSceneWriter {
    return {
      writeSceneNavmeshChunk: this.writeSceneNavmeshChunk.bind(this),
      writeSceneAudioReverbChunk: this.writeSceneAudioReverbChunk.bind(this),
    };
  }

  /** Start provider-lifetime resources; safe across Strict Mode effect probes. */
  initialize(): void {
    this.textures.initialize();
  }

  /** Release provider-lifetime resources; project close deliberately does not. */
  dispose(): void {
    this.resetAssetLoading();
    this.extensions.close().catch((error: unknown) => {
      console.warn("[editor] Closing editor extensions failed", error);
    });
    this.textures.dispose();
  }

  get sessionDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  onDiagnostic(listener: (line: string) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  /**
   * Textures whose encode is running now. The file says `pending` until the
   * encode commits, so this is the only record that it started. A new set at
   * each change, and every change is reported by `onRegistryChange`.
   */
  get textureEncodingGuids(): ReadonlySet<string> {
    return this.textures.encodingGuids;
  }

  private pushDiagnostic(line: string): void {
    this.diagnostics.push(line);
    if (this.diagnostics.length > 200) this.diagnostics.shift();
    for (const listener of this.diagnosticListeners) listener(line);
  }

  /** Bind app-private derived storage for thumbnail writes at import. */
  setDerivedStorage(derived: ProjectStorage | null): void {
    this.derivedStorage = derived;
    this.bindThumbnailWriter();
  }

  private bindThumbnailWriter(): void {
    if (!this.assetRegistry) return;
    const derived = this.derivedStorage;
    const guid = this.projectGuid;
    if (!derived || !guid) {
      this.assetRegistry.setThumbnailWriter(null);
      return;
    }
    this.assetRegistry.setThumbnailWriter(async (assetGuid, bytes) => {
      await writeThumbnail(derived, guid, assetGuid, bytes);
    });
  }

  onRegistryChange(listener: () => void): () => void {
    this.registryListeners.add(listener);
    return () => {
      this.registryListeners.delete(listener);
    };
  }

  private emitRegistryChange(): void {
    for (const listener of this.registryListeners) listener();
  }

  /**
   * Asset files the registry rewrote itself (Texture encode states, committed
   * encodes, derived chunks), with their mtimes before and after, so the
   * editor does not report its own writes as external changes.
   */
  onOwnAssetWrite(listener: (write: OwnAssetWrite) => void): () => void {
    this.ownWriteListeners.add(listener);
    return () => {
      this.ownWriteListeners.delete(listener);
    };
  }

  async retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean; usage?: string },
  ): Promise<boolean> {
    return this.textures.retryTextureEncoding(guid, options);
  }

  /**
   * The editor reports the project's source control **Enable** setting as it
   * changes, saved or not (a project load reads the saved one). Turning it on
   * stops guarded alignment jobs it no longer permits. Changing this setting
   * does not request texture processing.
   */
  setSourceControlEnabled(enabled: boolean): void {
    this.textures.setSourceControlEnabled(enabled);
  }

  /**
   * Whether Texture Details offers **Retry Encoding** for a `compressed`
   * Texture: its committed encode is stale for the alignment policy and
   * nothing re-encodes it yet. `usage` is its tab's, saved or not.
   */
  async textureAlignmentStale(guid: string, usage?: string): Promise<boolean> {
    return this.textures.textureAlignmentStale(guid, usage);
  }

  /**
   * `usageFor(guid)` is the Usage an open Texture tab shows, saved or not,
   * so the alignment pass checks and re-encodes as a Details edit did
   * instead of undoing it with the saved Usage.
   */
  setOpenTextureUsage(usageFor: ((guid: string) => string | undefined) | null): void {
    this.textures.setOpenTextureUsage(usageFor);
  }

  /**
   * Requeue compressed Textures whose committed encode is stale for the
   * alignment policy (all Textures, or `guids`). Runs one at a time on the
   * current registry. While source control is on it only requeues Textures
   * whose committed encode is still the one this session wrote, such as an
   * import picked by a Tileset (`alignmentMayWrite`); every other Texture
   * waits for the user's own edit. Resolves with the number requeued.
   */
  reconcileTextureAlignment(guids?: readonly string[]): Promise<number> {
    return this.textures.reconcileTextureAlignment(guids);
  }

  /** Alignment passes finished and still queued, and every Texture they requeued (test hook). */
  get textureAlignmentState(): { runs: number; pending: number; requeued: string[] } {
    return this.textures.alignmentState;
  }

  async prepareAreaEmission(guid: string, options: { signal?: AbortSignal; onProgress?: (value: AreaEmissionProgress) => void } = {}): Promise<void> {
    return this.textures.prepareAreaEmission(guid, options);
  }

  /**
   * Convert an environment Texture's kept `.hdr` again at another Face Size,
   * on the import worker. Resolves false when nothing was written.
   */
  async reconvertHdrEnvironment(guid: string, faceSize: number, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<boolean> {
    return this.textures.reconvertHdrEnvironment(guid, faceSize, options);
  }

  /** `skip`: Textures not to retry now (someone else's lock: a retry writes the file). */
  async retryAllFailedTextureEncoding(skip?: (path: string) => boolean): Promise<number> {
    return this.textures.retryAllFailedTextureEncoding(skip);
  }

  get storagePort(): ProjectStorage {
    return this.publicStorage;
  }

  get registry(): AssetRegistry | null {
    const registry = this.assetRegistry;
    if (!registry) return null;
    let view = this.registryViews.get(registry);
    if (!view) { view = guardProjectAssetRegistry(registry, this.writeAdmission); this.registryViews.set(registry, view); }
    return view;
  }

  /**
   * Monotonic across remounts and project switches: advances whenever the
   * current registry's contents change, including when a project closes and
   * its registry is dropped. Plugin and search-index changes are reported by
   * `onRegistryChange` instead.
   */
  get registryGeneration(): number {
    return this.registryClock.value;
  }

  get plugins(): PluginDescriptor[] {
    return this.projectPlugins.descriptors;
  }

  get pluginGraphDiagnostics(): PluginDiagnostic[] {
    return this.projectPlugins.diagnostics;
  }

  /** Export presets scan their selected plugin roots without changing editor mounts. */
  async listExportAssets(
    enabledPluginGuids: ReadonlySet<string>,
  ): Promise<IndexedAsset[]> {
    return this.projectPlugins.listExportAssets(enabledPluginGuids);
  }

  setEnginePluginStorage(storage: ProjectStorage | null): void {
    this.projectPlugins.setEnginePluginStorage(storage);
  }

  setEngineExtensionStorage(storage: ProjectStorage): void {
    this.engineExtensionStorage = storage;
    this.projectPlugins.setEngineExtensionStorage(storage);
    this.extensions.setEngineStorage(storage);
  }

  get searchIndex(): ProjectSearchIndex | null {
    return this.projectSearchIndex;
  }

  get guid(): string | null {
    return this.projectGuid;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return (await this.storage.listProjects()).filter((folder) => !isAppOwnedFolder(folder.name));
  }

  /** Permanently deletes a project in the app's own storage; chosen folders are never deleted. */
  async deleteListedProject(handle: ProjectFolderHandle): Promise<void> {
    if (!this.storage.deleteProject) throw new Error("This storage cannot delete projects");
    await this.storage.deleteProject(handle);
  }

  async openProject(
    source: "folder" | "zip" = "folder",
  ): Promise<ProjectLoadResult | null> {
    if (getHostPlatform() === "web") {
      const picked = await pickImportFiles({
        directory: source === "folder",
        multiple: source === "folder",
        accept: source === "zip" ? ".zip" : undefined,
        maxTotalBytes:
          source === "zip" ? 50 * 1024 * 1024 : PROJECT_IMPORT_LIMIT,
      });
      if (!picked.length) return null;
      const files =
        source === "zip"
          ? readProjectArchive(picked[0]!.bytes)
          : normalizeImportedProject(
              picked.map((file) => ({ path: file.name, data: file.bytes })),
            );
      const manifest = JSON.parse(
        new TextDecoder().decode(
          files.find((file) => file.path === PROJECT_FILE)!.data,
        ),
      ) as { metadata?: { name?: unknown } };
      const base =
        normalizeProjectFolderName(
          typeof manifest.metadata?.name === "string"
            ? manifest.metadata.name
            : picked[0]!.name
                .split("/")[0]!
                .replace(/\.zip$/i, ""),
        ) || "Imported Project";
      let name = base;
      let owned: OwnedFolder | null = null;
      // Existing browser projects remain untouched, even when display names
      // match. The probe that creates the folder owns it, so a failed import
      // removes that folder instead of leaving it listed and its name taken.
      for (let attempt = 1; !owned; attempt++) {
        name = attempt === 1 ? base : `${base} ${attempt}`;
        try {
          owned = await openOwnedDocumentsProject(this.storage, name);
        } catch (error) {
          // A project another tab has open takes its name as well.
          if (isProjectOpenElsewhere(error)) continue;
          throw error;
        }
        if (!(await projectFolderIsEmpty(this.storage))) owned = null;
      }
      return this.scaffoldFromTemplate(owned, name, { templateFiles: files });
    }
    await this.storage.pickProjectFolder();
    return this.loadCurrentProject();
  }

  /**
   * A new project, opened. `created` is false only when the folder the user
   * picked already held a project, which is opened as it is.
   */
  async createEmptyProject(
    name?: string,
    options?: CreateProjectOptions,
    progress?: StepProgress,
  ): Promise<ProjectLoadResult & { created: boolean }> {
    const projectName =
      name && name.trim()
        ? normalizeProjectFolderName(name)
        : isTestModeEnabled()
          ? TEST_PROJECT_NAME
          : "MyGame";
    if (options?.pickFolder) {
      await this.storage.pickProjectFolder();
      if (await this.storage.exists(PROJECT_FILE)) {
        return { ...(await this.loadCurrentProject()), created: false };
      }
      await assertEmptyProjectFolder(this.storage);
      progress?.advance();
      return { ...(await this.scaffoldNewProject(projectName, options.kind, options, progress)), created: true };
    }
    const owned = await openOwnedDocumentsProject(this.storage, projectName);
    if (await this.storage.exists(PROJECT_FILE) && !owned.createdHere) {
      throw new Error("Name already exists.");
    }
    await assertEmptyProjectFolder(this.storage);
    progress?.advance();
    const result = await scaffoldOwnedProject(this.storage, owned, () =>
      this.scaffoldNewProject(projectName, options?.kind, options, progress),
    );
    return { ...result, created: true };
  }

  async createFromTemplate(options: {
    templateFiles: ProjectTreeFile[];
    name: string;
    pickFolder?: boolean;
    appearance?: ProjectAppearance;
    progress?: StepProgress;
  }): Promise<ProjectLoadResult> {
    const projectName = normalizeProjectFolderName(options.name);
    let owned: OwnedFolder | null = null;
    if (options.pickFolder) {
      await this.storage.pickProjectFolder();
    } else {
      owned = await openOwnedDocumentsProject(this.storage, projectName);
    }
    return this.scaffoldFromTemplate(owned, projectName, options);
  }

  /** Scaffolds a template into the current folder; `owned` is null for a user-picked folder. */
  private async scaffoldFromTemplate(
    owned: OwnedFolder | null,
    projectName: string,
    options: { templateFiles: ProjectTreeFile[]; appearance?: ProjectAppearance; progress?: StepProgress },
  ): Promise<ProjectLoadResult> {
    if (await this.storage.exists(PROJECT_FILE) && !owned?.createdHere) {
      throw new Error("A project already exists in this folder.");
    }
    await assertEmptyProjectFolder(this.storage);
    options.progress?.advance();
    const guid = newGuid();
    return scaffoldOwnedProject(
      this.storage,
      owned,
      async () => {
        await createProjectFromTemplate({
          templateFiles: options.templateFiles,
          destination: this.storage,
          guid,
          name: projectName,
          onFileWritten: () => options.progress?.advance(),
        });
        // Template and imported projects bring no derived thumbnails; the editor generates them.
        requestProjectThumbnails(guid);
        const appearance = normalizeProjectAppearance(options.appearance);
        if (appearance) {
          const manifest = JSON.parse(
            await this.storage.readText(PROJECT_FILE),
          ) as {
            metadata?: Partial<ProjectMetadata>;
          };
          // A manifest without metadata stays as it is, so the load below refuses it.
          if (manifest.metadata) {
            manifest.metadata.appearance = await writeProjectCover(this.storage, appearance);
            await this.storage.writeText(
              PROJECT_FILE,
              JSON.stringify(manifest, null, 2),
            );
          }
        }
        this.projectGuid = guid;
        // Templates are imported archives that may carry Extensions, so a project made from one starts untrusted.
        await this.projectPlugins.installEnginePluginDefaultsIfNeeded();
        options.progress?.advance();
        const loaded = await this.loadCurrentProject();
        options.progress?.advance();
        return loaded;
      },
    );
  }

  /**
   * Clone: a new folder in app storage named after `name`, filled by `clone`
   * (the repository's branch), with Integrated mode and the repository (the
   * cloned branch as its default) written into its `project.json`, unless it
   * already names the repository in Integrated mode.
   * A failure or a cancel through `signal`, even one after the files arrived,
   * removes the folder; a branch with no `project.json` is refused. The
   * folder is released: open it as a listed project.
   */
  async cloneProject(options: {
    name: string;
    repositoryUrl: string;
    branch: string;
    signal?: AbortSignal;
    clone: (storage: ProjectStorage, folderId: string) => Promise<void>;
  }): Promise<ProjectFolderHandle> {
    const projectName = normalizeProjectFolderName(options.name);
    if (!projectName) throw new Error("Enter a project name.");
    const owned = await openOwnedDocumentsProject(this.storage, projectName);
    if (!owned.createdHere) {
      await this.storage.releaseFolder();
      throw new Error("A project with this name already exists.");
    }
    await scaffoldOwnedProject(this.storage, owned, async () => {
      await options.clone(this.storage, owned.handle.id);
      if (!(await this.storage.exists(PROJECT_FILE))) {
        throw new Error(`${options.branch} has no Haptic project: project.json is missing.`);
      }
      const raw = JSON.parse(await this.storage.readText(PROJECT_FILE)) as { settings?: { sourceControl?: Partial<SourceControlProjectSettings> } };
      const current = raw.settings?.sourceControl;
      // Its branch is the team's default; the clone's own branch lives in its working copy, so another branch writes nothing.
      if (!(current?.mode === "integrated" && sameRepository(current.repositoryUrl ?? "", options.repositoryUrl))) {
        raw.settings = { ...raw.settings, sourceControl: { ...current, mode: "integrated", repositoryUrl: options.repositoryUrl, branch: options.branch } };
        await this.storage.writeText(PROJECT_FILE, JSON.stringify(raw, null, 2));
      }
      // Cancel stays offered to the end: only a throw in here removes the folder.
      throwIfCancelled(options.signal);
    });
    await this.storage.releaseFolder();
    return owned.handle;
  }

  async openListedProject(handle: ProjectFolderHandle): Promise<ProjectLoadResult> {
    await this.storage.openKnownFolder(handle);
    return this.loadCurrentProject();
  }

  async closeProject(): Promise<void> {
    this.resetAssetLoading();
    this.textures.dropQueued();
    await this.extensions.close();
    await this.textures.settle();
    await this.storage.releaseFolder();
    this.projectGuid = null;
    this.assetGuids.clear();
    this.sceneAudioReverb.clear();
    this.assetRegistry = null;
    this.registryClock.advance();
    this.projectSearchIndex?.clear();
    this.projectSearchIndex = null;
    this.projectPlugins.reset();
    resetAreaEmissionPreparations();
  }

  /** Persist browser identity without changing the project folder or its assets. */
  async updateListedProject(
    handle: ProjectFolderHandle,
    details: UpdateListedProjectOptions,
  ): Promise<ProjectAppearance | undefined> {
    const name = details.name.trim();
    if (!name) return undefined;
    await this.storage.openKnownFolder(handle);
    try {
      if (!(await this.storage.exists(PROJECT_FILE))) {
        throw new Error("The project could not be found.");
      }
      const raw = JSON.parse(await this.storage.readText(PROJECT_FILE)) as Partial<ProjectDocument>;
      if (!isCompleteProjectManifest(raw)) throw new Error(INCOMPLETE_PROJECT_MANIFEST);
      raw.metadata.name = name;
      raw.metadata.updatedAt = new Date().toISOString();
      if (details.appearance !== undefined) {
        const appearance = normalizeProjectAppearance(details.appearance);
        raw.metadata.appearance = appearance ? await writeProjectCover(this.storage, appearance) : undefined;
      }
      await this.storage.writeText(PROJECT_FILE, JSON.stringify(raw, null, 2));
      return raw.metadata.appearance;
    } finally {
      await this.storage.releaseFolder();
    }
  }

  async exportZip(snapshot?: ProjectDocument): Promise<Uint8Array> {
    return exportProjectZip(this.storage, snapshot);
  }

  async needsReconnect(): Promise<boolean> {
    return (await this.storage.needsReconnect?.()) ?? false;
  }

  async reconnect(): Promise<ProjectLoadResult> {
    const validate = async (candidate: ProjectStorage) => {
      if (!(await candidate.exists(PROJECT_FILE))) {
        throw new Error("Select a project folder containing project.json.");
      }
      const manifest: unknown = JSON.parse(await candidate.readText(PROJECT_FILE));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Invalid project manifest.");
      }
      if (this.projectGuid && (!("guid" in manifest) || manifest.guid !== this.projectGuid)) {
        throw new Error("Select the folder for the currently open project.");
      }
    };
    await this.storage.reconnectFolder!(validate);
    await validate(this.storage);
    return this.loadCurrentProject();
  }

  async readTree(): Promise<ProjectTreeFile[]> {
    return readProjectTree(this.storage);
  }

  async loadCurrentProject(): Promise<ProjectLoadResult> {
    const folder = this.storage.getCurrentFolder();
    if (!folder) {
      throw new Error("No project folder selected");
    }

    this.resetAssetLoading();

    this.assetGuids.clear();
    this.sceneAudioReverb.clear();
    this.textures.forgetSessionEncodes();

    // exists() rejects for anything but a missing manifest, so an unreadable
    // project never reaches the scaffold; a missing one is scaffolded only
    // into an empty folder.
    const hasProject = await this.storage.exists(PROJECT_FILE);
    if (!hasProject) {
      await assertEmptyProjectFolder(this.storage);
      return this.scaffoldNewProject(folder.name);
    }

    const { document, guid } = readProjectManifest(await this.storage.readText(PROJECT_FILE), this.migrations);
    document.metadata.appearance = await readProjectCover(this.storage, document.metadata.appearance);
    this.projectGuid = guid;
    this.loadedTextureSettings = document.settings.textures;
    this.textures.setSourceControlEnabled((document.settings.sourceControl?.mode ?? "off") !== "off");
    this.projectPlugins.setOverrides(document.settings.pluginOverrides ?? {});

    const withDocuments = await this.ensureDocuments(document);
    const layouts = await this.loadLayouts();

    return {
      document: withDocuments,
      layouts,
    };
  }

  /** Reconcile the manifest's document list with the asset registry (header-only index). */
  private async ensureDocuments(
    document: ProjectDocument,
  ): Promise<ProjectDocument> {
    await this.mountAssetRegistry();
    const found = this.assetRegistry!.listDocumentPaths({ rootId: "project" });
    const scenes = uniquePaths([
      ...found.scenes,
      ...(found.scenes.length ? [] : await this.keepExisting(document.scenes)),
    ]);
    const graphs = uniquePaths([
      ...found.graphs,
      ...(found.graphs.length ? [] : await this.keepExisting(document.graphs)),
    ]);

    if (scenes.length && graphs.length) {
      return { ...document, scenes, graphs };
    }

    if (!scenes.length) {
      await this.saveDocument("scene", MAIN_SCENE_FILE, createDefaultScene());
      scenes.push(MAIN_SCENE_FILE);
    }
    if (!graphs.length) {
      await this.saveDocument(
        "graph",
        MAIN_CLASS_FILE,
        createDefaultLogicGraphSerialized(),
      );
      graphs.push(MAIN_CLASS_FILE);
    }
    await this.mountAssetRegistry();
    return { ...document, scenes, graphs };
  }

  private loadedTextureSettings: {
    autoRequeueUncompressed: boolean;
    maxTextureDimension: number;
  } | null = null;

  /** Editor tabs, previews, Play, and explicit preloads share one source cache. */
  get assetLoadingService(): AssetLoadingService {
    if (!this.assetRegistry) throw new Error("Open a project before loading assets");
    if (!this.sourceLoading) {
      this.sourceLoading = createRegistryAssetLoadingService(() => {
        if (!this.assetRegistry) throw new Error("The asset's project was closed");
        return this.assetRegistry;
      }, { projectId: `${this.projectGuid ?? "project"}:${this.sourceSession}` });
    }
    return this.sourceLoading;
  }

  createAssetLoadScope(owner: string, options?: AssetLoadScopeOptions): AssetLoadScope {
    return this.assetLoadingService.createScope(owner, options);
  }

  /**
   * The registry an encode callback writes through. Once Close Project or a
   * project load bumps the session, the old registry is still set, but the
   * shared storage it writes through may be released or rebound to another
   * folder, so a late result writes nothing.
   */
  private encodeRegistry(): AssetRegistry | null {
    return this.assetRegistrySession === this.sourceSession ? this.assetRegistry : null;
  }

  private resetAssetLoading(): void {
    this.sourceLoading?.dispose();
    this.sourceLoading = null;
    this.sourceSession++;
  }

  private mountAssetRegistry(): Promise<AssetRegistry> {
    const session = this.sourceSession;
    const promise = this.mountAssetRegistryAttempt(session);
    const mount = { session, promise };
    this.registryMounts.add(mount);
    const finished = () => { this.registryMounts.delete(mount); };
    void promise.then(finished, finished);
    return promise;
  }

  private async mountAssetRegistryAttempt(session: number): Promise<AssetRegistry> {
    const maxDimension =
      this.loadedTextureSettings?.maxTextureDimension ??
      DEFAULT_TEXTURE_ENCODE_SETTINGS.maxDimension;
    const registry = new AssetRegistry(this.storage, {
      blobs: this.blobs,
      alignmentRequeues: this.textures.alignmentRequeues,
      generationClock: this.registryClock,
      runImport: runImportOffMainThread,
    });
    registry.setEncodePipeline(this.textures.queue, {
      ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
      maxDimension,
    });
    registry.setOwnWriteListener((write) => {
      for (const listener of this.ownWriteListeners) listener(write);
    });
    registry.setCreatedTextureListener(({ header }) => this.textures.noteCreatedTexture(header));
    // A remount reports only conflicts the previous catalog did not have.
    const reportedConflicts = new Set((this.assetRegistry?.listGuidConflicts() ?? []).map((conflict) => conflict.path));
    await registry.mountRoot(projectContentRoot());
    if (session !== this.sourceSession) throw new DOMException("Project changed during catalog scan", "AbortError");
    this.assetRegistry = registry;
    this.assetRegistrySession = session;
    for (const conflict of registry.listGuidConflicts()) {
      if (reportedConflicts.has(conflict.path)) continue;
      this.pushDiagnostic(`${conflict.path} is hidden: it has the same asset id as ${conflict.indexedPath}. Remove the copy or import it again to give it its own id.`);
    }
    await this.syncPlugins();
    // A fresh registry starts without the gameplay extension roots the service last mounted.
    await this.mountExtensionContent(registry, this.extensions.getGameplayExtensions());
    if (session !== this.sourceSession) throw new DOMException("Project changed during catalog scan", "AbortError");
    this.projectSearchIndex = new ProjectSearchIndex(this.storage, {
      blobs: this.blobs,
      catalogClassIds: SEARCH_CATALOG_CLASS_IDS,
      nodeTitles: searchNodeTitles(),
    });
    this.bindThumbnailWriter();
    // Opening a project only builds its catalog; bulk texture processing is an
    // explicit maintenance operation.
    registry.setAtlasStatusListener((guids) => {
      this.textures.reconcileInBackground(guids);
    });
    return registry;
  }

  private mountExtensionContent(registry: AssetRegistry, extensions: readonly ExtensionDescriptor[]): Promise<void> {
    return mountExtensionContentRoots(registry, extensions, {
      storageFor: (extension) => extension.source === "engine" ? this.engineExtensionStorage ?? undefined : undefined,
    });
  }

  async syncPlugins(options: { rediscover?: boolean } = {}): Promise<void> {
    return this.projectPlugins.sync(options);
  }

  async applyPluginOverrides(
    overrides: Record<string, PluginEnableOverride>,
  ): Promise<void> {
    return this.projectPlugins.applyOverrides(overrides);
  }

  async createProjectPlugin(displayName: string): Promise<PluginDescriptor> {
    return this.projectPlugins.create(displayName);
  }

  async deleteProjectPlugin(guid: string): Promise<void> {
    return this.projectPlugins.delete(guid);
  }

  async exportPlugin(guid: string): Promise<Uint8Array> {
    return this.projectPlugins.export(guid);
  }

  async importPlugin(
    bytes: Uint8Array,
    decision?: "keep" | "replace",
    options?: PluginImportOptions,
  ): Promise<PluginImportResult> {
    return this.projectPlugins.import(bytes, decision, options);
  }

  private storageForPath(path: string): ProjectStorage {
    if (isTracePath(path)) {
      if (!this.derivedStorage) {
        throw new Error("Derived storage is not available for traces");
      }
      return this.derivedStorage;
    }
    const indexed = this.assetRegistry?.getByPath(path);
    if (indexed && this.assetRegistry) {
      return this.assetRegistry.storageFor(indexed.rootId);
    }
    const extensionRoot = this.extensionRootForPath(path);
    if (extensionRoot && this.assetRegistry) return this.assetRegistry.storageFor(extensionRoot.id);
    const plugin = this.projectPlugins.forPath(path);
    if (plugin?.source === "engine" && this.projectPlugins.engineStorage) {
      return this.projectPlugins.engineStorage;
    }
    return this.storage;
  }

  /** The mounted gameplay extension root holding a path that is not indexed yet. */
  private extensionRootForPath(path: string) {
    return this.assetRegistry?.listRoots().find((root) => root.kind === "extension" && path.startsWith(`${root.pathPrefix}/`));
  }

  private blobsForPath(path: string): BlobStore {
    const indexed = this.assetRegistry?.getByPath(path);
    if (indexed && this.assetRegistry) {
      return this.assetRegistry.blobsFor(indexed.rootId);
    }
    const extensionRoot = this.extensionRootForPath(path);
    if (extensionRoot && this.assetRegistry) return this.assetRegistry.blobsFor(extensionRoot.id);
    const storage = this.storageForPath(path);
    const plugin = this.projectPlugins.forPath(path);
    if (plugin) return createVfsBlobStore(storage, `${plugin.contentPath}/.blobs`);
    return storage === this.storage ? this.blobs : createVfsBlobStore(storage);
  }

  /** Re-scan project assets after registry file operations (import, create, delete). */
  async remountRegistry(): Promise<AssetRegistry> {
    await this.mountAssetRegistry();
    return this.registry!;
  }

  private referenceRepairHost(): ReferenceRepairHost {
    return {
      storage: this.storage,
      registry: () => this.assetRegistry,
      plugins: () => this.projectPlugins.descriptors,
      storageFor: (path) => this.storageForPath(path),
      loadDocument: this.loadDocument.bind(this),
      saveDocument: this.saveDocument.bind(this),
      remountRegistry: this.remountRegistry.bind(this),
      readStoredAssetDocument: (kind, path) => this.readStoredAssetDocument(kind, path),
      documentContent: (kind, raw) => this.documentContent(kind, raw),
    };
  }

  /** Validate all referrers before writing replacements; never delete a Class here. */
  async replaceClassReferencesBeforeDelete(
    replacements: readonly ClassAssetReplacement[],
    deletingGuids: ReadonlySet<string>,
    onProgress?: (path: string) => Promise<void>,
    options?: {
      /** Refuses (rejects) before any file changes, given every referrer that would be rewritten. */
      beforeWrite?: (paths: string[]) => Promise<void> | void;
    },
  ): Promise<void> {
    return replaceClassReferencesBeforeDelete(this.referenceRepairHost(), replacements, deletingGuids, onProgress, options);
  }

  /** Rename a Class and its name-based referrers as one recoverable file operation. */
  async renameAsset(guid: string, newName: string, options?: {
    /** Validate locks and persist recovery before any files change. */
    beforeWrite?: (paths: string[]) => Promise<void>;
  }): Promise<IndexedAsset> {
    return renameAsset(this.referenceRepairHost(), guid, newName, options);
  }

  /**
   * Set remaining writable assets' references to deleted guids to None.
   * Does not delete files — call after `deleteAsset` / `deleteFolder`.
   * Returns the referrers whose rewrite failed; the others are repaired regardless.
   */
  async clearDeletedAssetReferences(
    deletedGuids: ReadonlySet<string>,
    options: {
      deletedClassNames?: ReadonlySet<string>;
      onProgress?: (path: string) => Promise<void>;
      /** Why a referrer must not be rewritten (someone else's lock); it is returned, not written. */
      refuse?: (path: string) => string | null;
    } = {},
  ): Promise<Array<{ path: string; error: unknown }>> {
    return clearDeletedAssetReferences(this.referenceRepairHost(), deletedGuids, options);
  }

  private async keepExisting(paths: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const path of paths) {
      if (await this.storage.exists(path)) kept.push(path);
    }
    return kept;
  }

  private async scaffoldNewProject(
    name: string,
    kind: BuiltInStarterKind = "empty",
    renderOptions?: {
      renderWidth?: number;
      renderHeight?: number;
      blackBars?: boolean;
      pixelArt?: boolean;
      appearance?: ProjectAppearance;
    },
    progress?: StepProgress,
  ): Promise<ProjectLoadResult> {
    this.resetAssetLoading();
    const render: Partial<RenderProjectSettings> | undefined = renderOptions
      ? {
          customResolution: true,
          width: renderOptions.renderWidth,
          height: renderOptions.renderHeight,
          blackBars: renderOptions.blackBars,
        }
      : undefined;
    const document = createEmptyProject(name, {
      kind: kind === "2d" ? "2d" : "empty",
      render,
      pixelArt: renderOptions?.pixelArt === true,
    });
    const appearance = normalizeProjectAppearance(renderOptions?.appearance);
    if (appearance) {
      // The picture's bytes go to its cover file; the document keeps the picture in memory for the editor.
      const stored = await writeProjectCover(this.storage, appearance);
      document.metadata.appearance = appearance.image && stored.coverFile ? { ...stored, image: appearance.image } : stored;
    }
    this.projectGuid = newGuid();
    // Its Extensions are copies of this computer's Engine Extensions: the new project starts trusted.
    this.extensions.noteCreatedProject(this.projectGuid);
    this.loadedTextureSettings = document.settings.textures;
    this.textures.setSourceControlEnabled((document.settings.sourceControl?.mode ?? "off") !== "off");
    this.projectPlugins.setOverrides(document.settings.pluginOverrides ?? {});
    const graph = createDefaultLogicGraphSerialized();
    // A Pixel Art Optimized project's scene frames its design resolution at one design pixel per texel.
    const scene = createDefaultScene(kind === "2d" ? "2d" : "3d", projectSceneCameraFraming(document.settings));
    if (kind === "blank") {
      scene.actors = [];
      scene.settings.environmentSource = "none";
      scene.settings.defaultCameraActorId = null;
    }
    await this.storage.mkdir("assets/.blobs", true);
    await this.storage.mkdir("plugins", true);
    await this.saveDocument("scene", MAIN_SCENE_FILE, scene);
    if (kind === "2d") {
      await this.saveDocument("graph", MAIN_CLASS_FILE, graph);
    } else {
      document.graphs = [];
    }
    document.settings.startupSceneGuid = await this.guidForAsset(MAIN_SCENE_FILE);
    progress?.advance();
    await this.saveProject(document, createEmptyLayouts());
    const stored = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as Record<string, unknown>;
    stored.guid = this.projectGuid;
    stored.kind = "project";
    stored.version = this.migrations.currentVersion("Project");
    await this.storage.writeText(PROJECT_FILE, JSON.stringify(stored, null, 2));
    progress?.advance();
    await this.projectPlugins.installEnginePluginDefaultsIfNeeded();
    progress?.advance();
    await this.mountAssetRegistry();
    progress?.advance();
    if (kind === "empty" || kind === "feature-test") {
      await createInputAssets(this.starterHost());
      progress?.advance();
      // FeatureTest pins import scale so the workload ignores Engine Settings.
      await scaffoldKenneyMannequinEmpty(this.starterHost(), document, kind === "feature-test" ? 1 : undefined);
      progress?.advance();
    }
    if (kind === "feature-test") {
      await scaffoldFeatureTest(this.starterHost(), document);
      progress?.advance();
    }
    if (renderOptions?.pixelArt) {
      await scaffoldPixelArtFonts(this.starterHost(), document);
      progress?.advance();
    }
    // Starter assets are written without thumbnails; the editor generates them.
    requestProjectThumbnails(this.projectGuid);
    return {
      document,
      layouts: createEmptyLayouts(),
    };
  }

  private starterHost(): StarterScaffoldHost {
    return {
      storage: this.storage,
      registry: () => this.assetRegistry,
      saveDocument: this.saveDocument.bind(this),
      loadDocument: this.loadDocument.bind(this),
      saveProject: this.saveProject.bind(this),
      writeSceneNavmeshChunk: this.writeSceneNavmeshChunk.bind(this),
      guidForAsset: (path) => this.guidForAsset(path),
      reservedAssetGuids: this.reservedAssetGuids,
    };
  }

  async loadDocument(
    kind: AssetDocumentKind,
    path: string,
    options: { scope?: AssetLoadScope; signal?: AbortSignal } = {},
  ): Promise<
    | SerializedScene
    | SerializedSceneLayer
    | SerializedGraph
    | Record<string, unknown>
  > {
    if (kind === "trace" || isTracePath(path)) {
      if (!this.derivedStorage) {
        throw new Error("Derived storage is not available for traces");
      }
      const decoded = await readTraceDocument(this.derivedStorage, path);
      if (!decoded) {
        throw new Error(`Trace file is missing: ${path}`);
      }
      return decoded.payload;
    }
    const raw = await this.readStoredAssetDocument(kind, path, options);
    return this.documentContent(kind, raw);
  }

  /**
   * What `loadDocument` returns for a stored document the caller has already
   * read (Play preparation's closure), without reading it again.
   */
  documentContentFromStored(
    kind: Exclude<AssetDocumentKind, "trace">,
    stored: { type: string; version: number; payload: Record<string, unknown> },
  ): Awaited<ReturnType<ProjectService["loadDocument"]>> {
    return this.documentContent(kind, stored);
  }

  /**
   * The stored payload `loadDocument` starts from. It records no migration
   * bookkeeping, so a caller may read several documents ahead and apply
   * `documentContent` to each in its own order.
   */
  private async readStoredAssetDocument(
    kind: AssetDocumentKind,
    path: string,
    options: { scope?: AssetLoadScope; signal?: AbortSignal } = {},
  ): Promise<{ type: string; version: number; payload: Record<string, unknown> }> {
    if (!isAssetDocumentPath(path)) throw new Error(`${path} is not a .hasset document.`);
    return this.readAssetDocument(path, fallbackDocumentType(kind), options);
  }

  /**
   * A document, its header and the selected chunks its file holds, all from
   * one saved version: a write landing between the reads retries the whole
   * read, so one version's JSON is never paired with another's chunks. A
   * function selects from the header of the version being read, so a choice
   * such as a Texture's variant follows that version. Chunks the file does not
   * hold are absent from `chunks`.
   */
  async loadDocumentWithChunks(
    kind: Exclude<AssetDocumentKind, "trace">,
    path: string,
    chunks: DocumentChunkSelection,
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    document: Awaited<ReturnType<ProjectService["loadDocument"]>>;
    header: HassetHeader;
    chunks: ReadonlyMap<string, Uint8Array>;
  }> {
    if (!isAssetDocumentPath(path)) throw new Error(`${path} is not a .hasset document.`);
    const snapshot = await this.readSourceSnapshot(`Document ${path}`, options.signal,
      () => this.readAssetDocumentWithChunksAttempt(path, chunks, options.signal));
    const { document } = snapshot;
    this.assetGuids.set(path, document.guid);
    return {
      document: this.documentContent(kind, {
        type: document.type || fallbackDocumentType(kind),
        version: document.version,
        payload: document.payload,
      }),
      header: snapshot.header,
      chunks: snapshot.chunks,
    };
  }

  private async readAssetDocumentWithChunksAttempt(
    path: string,
    selection: DocumentChunkSelection,
    signal: AbortSignal | undefined,
    callerScope?: AssetLoadScope,
  ): Promise<{ document: AssetDocument; header: HassetHeader; chunks: Map<string, Uint8Array> }> {
    const select = (header: HassetHeader) => {
      const ids = typeof selection === "function" ? selection(header) : selection;
      return ids.filter((id) => header.chunks.some((chunk) => chunk.id === id));
    };
    const registry = this.assetRegistry;
    const indexed = registry?.getByPath(path);
    if (!registry || !indexed) {
      // One read of the whole container is one version.
      const blobs = this.blobsForPath(path);
      const decoded = await decodeHasset(await this.storageForPath(path).readBinary(path), (hash) => blobs.readBlob(hash));
      const { header } = decoded;
      const body = decoded.chunks.get(DOCUMENT_CHUNK_ID);
      return {
        document: {
          guid: header.guid, type: header.type, name: header.name, version: header.version,
          payload: body ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> : header.payload,
        },
        header,
        chunks: new Map(select(header).flatMap((id) => {
          const bytes = decoded.chunks.get(id);
          return bytes ? [[id, bytes] as const] : [];
        })),
      };
    }
    const guid = indexed.header.guid;
    // Selection runs once, on the catalog header the representation resolved.
    let selected: { header: HassetHeader; revision: string | undefined; ids: readonly string[] } | undefined;
    // The representation reads its document and chunks at the revision it
    // resolved, and fails with SourceRevisionChangedError if the file changes.
    const representation = await registryAssetRepresentation(registry, guid, {
      selectChunks: (asset) => {
        selected = { header: asset.header, revision: asset.locator?.revision, ids: select(asset.header) };
        return selected.ids;
      },
      representationKey: "document-with-chunks",
    }, { signal });
    const scope = callerScope ?? this.createAssetLoadScope(`Document Snapshot: ${path}`);
    try {
      const loaded = await scope.acquire<RegistryLoadedAsset>(guid, representation, { dependencies: "none", signal });
      const { header, revision, ids } = selected!;
      // A value cached at another revision would pair this header with other chunks.
      if (loaded.revision !== revision) throw new SourceRevisionChangedError(`Asset ${guid} changed after selecting its chunks; retry`);
      return {
        // Working copies, as for loadDocument: the cached value can be evicted.
        document: structuredClone(loaded.document),
        header,
        chunks: new Map([...loaded.chunks].filter(([id]) => ids.includes(id))),
      };
    } finally {
      if (!callerScope) scope.dispose();
    }
  }

  private documentContent(
    kind: AssetDocumentKind,
    raw: { type: string; version: number; payload: Record<string, unknown> },
  ): Awaited<ReturnType<ProjectService["loadDocument"]>> {
    this.migrations.requireCurrent(raw.type, raw.version);
    // PluginSettings.version is an author label, separate from the asset header schema version.
    if (raw.type === "PluginSettings") return raw.payload;
    const { version: _v, ...content } = raw.payload as Record<
      string,
      unknown
    > & { version?: number };
    void _v;
    if (kind === "data-definition") return { ...normalizeDataDefinitionAsset(content) };
    if (kind === "data-tree") return { ...normalizeDataTreeAsset(content) };
    // A stored Tilemap holds run-length chunks; editor documents hold dense cells.
    if (kind === "tilemap") return { ...normalizeTilemapPayload(content) };
    if (kind === "scene") {
      return normalizeScene(content);
    }
    if (kind === "scene-layer") {
      return normalizeSceneLayer(content);
    }
    if (kind === "prefab") return { ...normalizePrefab(content) };
    if (kind === "graph") {
      return requireClassGraphPayload(
        content as unknown as Record<string, unknown>,
      );
    }
    return content;
  }

  private async readAssetDocument(
    path: string,
    fallbackType: string,
    options: { scope?: AssetLoadScope; signal?: AbortSignal; componentChunks?: boolean } = {},
  ): Promise<{ type: string; version: number; payload: Record<string, unknown> }> {
    const decoded = await this.readSourceSnapshot(`Document ${path}`, options.signal,
      () => this.readAssetDocumentAttempt(path, options));
    this.assetGuids.set(path, decoded.guid);
    return {
      type: decoded.type || fallbackType,
      version: decoded.version,
      payload: decoded.payload,
    };
  }

  /** Retry a complete read, never a mixture of chunk snapshots or project sessions. */
  private async readSourceSnapshot<T>(label: string, signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
    const session = this.sourceSession;
    const check = () => {
      signal?.throwIfAborted();
      if (this.sourceSession !== session) throw new DOMException(`${label}: project changed during reading`, "AbortError");
    };
    for (let attempt = 1; ; attempt++) {
      check();
      try {
        const value = await read();
        check();
        return value;
      } catch (error) {
        check();
        if (!isAssetSourceRevisionChanged(error)) throw error;
        if (attempt === 3) throw new Error(`${label} changed during 3 read attempts; wait for saving or processing to finish, then retry.`, { cause: error });
      }
    }
  }

  private async readAssetDocumentAttempt(
    path: string,
    options: { scope?: AssetLoadScope; signal?: AbortSignal; componentChunks?: boolean },
  ): Promise<AssetDocument> {
    const indexed = this.assetRegistry?.getByPath(path);
    // Only Scenes store component chunks; Prefab and Class documents keep Landscape and Foliage data inline.
    const componentChunks = options.componentChunks === false
      ? () => []
      : (header: { type: string; chunks: ReadonlyArray<{ id: string }> }) => header.type === "Scene" ? sceneComponentChunkIds(header.chunks) : [];
    let decoded: AssetDocument;
    if (indexed && this.assetRegistry && componentChunks(indexed.header).length > 0) {
      // The document and its component chunks from one read of one version, so the document chunk is read once.
      const read = await this.readAssetDocumentWithChunksAttempt(path, componentChunks, options.signal, options.scope);
      decoded = hydrateSceneComponentChunks(read.document, read.chunks);
    } else if (indexed && this.assetRegistry) {
      const scope = options.scope ?? this.createAssetLoadScope(`Document Read: ${path}`);
      try {
        const loaded = await scope.acquireLatest<RegistryLoadedAsset>(`document:${indexed.header.guid}`, indexed.header.guid, undefined, {
          dependencies: "none", signal: options.signal,
        });
        // Working copies preserve unsaved edits independently of cache eviction.
        decoded = structuredClone(loaded.document);
      } finally {
        if (!options.scope) scope.dispose();
      }
    } else {
      const read = await readUnindexedAssetDocument(this.files, path, options.signal, componentChunks);
      decoded = read.chunks.size > 0 ? hydrateSceneComponentChunks(read.document, read.chunks) : read.document;
    }
    if (decoded.type === "Scene" || decoded.type === "Prefab" || decoded.type === "Class") {
      this.reportUnreadableComponentChunks(path, decoded.payload);
    }
    return decoded;
  }

  /**
   * Tells the user, once per component and file, about Landscape or Foliage data the document names but cannot
   * supply. A Landscape shows and plays flat, Foliage draws nothing; a save keeps the stored data untouched until the
   * component is sculpted or painted again.
   */
  private reportUnreadableComponentChunks(path: string, payload: unknown): void {
    for (const { actorName, componentId, kind } of unreadableComponentChunks(payload)) {
      const key = `${path}\n${componentId}`;
      if (this.reportedUnreadableComponentChunks.has(key)) continue;
      this.reportedUnreadableComponentChunks.add(key);
      const owner = actorName ? `the ${kind} on "${actorName}"` : `a ${kind}`;
      const effect = kind === "Landscape" ? "it shows and plays flat" : "it draws nothing";
      this.pushDiagnostic(`${path}: the ${kind === "Landscape" ? "terrain" : "instance"} data of ${owner} is missing or damaged, so ${effect}. Saving keeps the stored data; ${kind === "Landscape" ? "sculpting" : "painting"} replaces it.`);
    }
  }

  /** Writes a `.hasset` document in its asset's write queue. */
  async saveDocument(
    kind: AssetDocumentKind,
    path: string,
    content:
      | SerializedScene
      | SerializedSceneLayer
      | SerializedGraph
      | Record<string, unknown>,
    options?: { parentClass?: string | null; type?: string },
  ): Promise<void> {
    return this.withDocumentWrite(path, (currentPath) => this.saveDocumentUnlocked(kind, currentPath, content, options));
  }

  /** Resolve a queued write's location after earlier moves/deletions finish. */
  private async withDocumentWrite<T>(path: string, write: (currentPath: string) => Promise<T>): Promise<T> {
    const registry = this.assetRegistry;
    const asset = registry?.getByPath(path);
    if (!asset) {
      // A file the registry does not index (a plugin's settings, a new file)
      // still takes one write at a time.
      const run = (this.unindexedWrites.get(path) ?? Promise.resolve()).then(() => write(path));
      const settled = run.then(() => {}, () => {});
      this.unindexedWrites.set(path, settled);
      void settled.then(() => {
        if (this.unindexedWrites.get(path) === settled) this.unindexedWrites.delete(path);
      });
      return run;
    }
    return registry!.withAssetWrite(asset.header.guid, () => {
      const current = registry!.getByGuid(asset.header.guid);
      if (this.assetRegistry !== registry || !current) {
        throw new Error("The asset was closed or deleted before it could be saved");
      }
      return write(current.path);
    });
  }

  private async saveDocumentUnlocked(
    kind: AssetDocumentKind,
    path: string,
    content: SerializedScene | SerializedSceneLayer | SerializedGraph | Record<string, unknown>,
    options?: { parentClass?: string | null; type?: string },
  ): Promise<void> {
    if (kind === "trace" || isTracePath(path)) {
      throw new Error("Trace documents are read-only");
    }
    if (kind === "material" || kind === "material-function") {
      const graph = kind === "material" ? normalizeMaterialDocument(content) : normalizeMaterialFunctionDocument(content);
      const diagnostic = validateMaterialParameterNames(graph)[0];
      if (diagnostic) throw new Error(diagnostic.message);
    }
    if (!isAssetDocumentPath(path)) throw new Error(`${path} is not a .hasset document.`);
    const storage = this.storageForPath(path);
    const blobs = this.blobsForPath(path);
    if (isPluginDocumentReadOnly(this.projectPlugins.descriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const dir = parentDir(path);
    if (dir) {
      await storage.mkdir(dir, true);
    }
    const existing = await readExistingAssetMeta(this.files, path);
    const type = kind === "extension-asset"
      ? extensionAssetTypeForSave(existing?.type ?? options?.type)
      : isAssetDocumentKind(kind)
        ? assetTypeForDocumentKind(kind)
        : "Class";
    const ownerPlugin = this.projectPlugins.forPath(path);
    let pluginContentChanged = false;
    if (ownerPlugin && type !== "PluginSettings") {
      const previous = existing
        ? await decodeAssetDocument(await storage.readBinary(path), { blobs })
        : null;
      pluginContentChanged = !previous || stableStringify(previous.payload) !== stableStringify(content);
    }
    if (type === "PluginSettings" && ownerPlugin) {
      // A settings tab may predate a content save that refreshed this stamp.
      const settings = normalizePluginSettings(content, { pluginGuid: ownerPlugin.pluginGuid });
      const authorVersionChanged = settings.version !== ownerPlugin.settings.version;
      content = {
        ...settings,
        engineVersion: authorVersionChanged ? ENGINE_VERSION : ownerPlugin.settings.engineVersion,
        pluginDependencies: settings.pluginDependencies.map((dependency) => ({
          ...dependency,
          version: authorVersionChanged
            ? this.projectPlugins.descriptors.find((entry) => entry.pluginGuid === dependency.guid)?.settings.version ?? dependency.version
            : ownerPlugin.settings.pluginDependencies.find((entry) => entry.guid === dependency.guid)?.version ?? dependency.version,
        })),
      };
    }
    if (isInputAssetType(type)) content = normalizeInputAssetPayload(type, content) as unknown as Record<string, unknown>;
    if (type === "DataDefinition") content = { ...normalizeDataDefinitionAsset(content) };
    if (type === "DataTree") content = { ...normalizeDataTreeAsset(content) };
    const version = this.migrations.currentVersion(type);
    const parentClass =
      options?.parentClass !== undefined
        ? options.parentClass
        : existing?.parentClass ?? (type === "Class" ? "Actor" : null);
    // Imported assets keep their settings in the header beside their binary
    // chunks; a Font's MSDF attach merges into that header payload.
    // A Model and an Animation keep their payload in the document chunk and a summary in the header
    // (`modelHeaderSummary`, `animationHeaderSummary`).
    const storeInHeader =
      (kind === "texture" ||
        kind === "font" ||
        kind === "skeleton") &&
      existing !== null &&
      !existing.hasDocumentChunk;
    if (storeInHeader && existing && type === "Texture") {
      content = withSavedTextureEncodeState(content as Record<string, unknown>, existing.payload);
    }

    const guid = await this.guidForAsset(path);
    const stored = existing?.catalog ?? null;
    const componentChunkSave = prepareComponentChunksForSave(type, content as unknown as Record<string, unknown>);
    const payloadToSave = componentChunkSave.payload;
    // Stored chunks this save replaces or drops are not read to carry them.
    const notKept = storedChunkIdsNotKept(stored, componentChunkSave.keepStoredChunk);
    const baseChunks = type === "Scene"
      ? await this.sceneChunksForSave(path, content as SerializedScene, guid, stored, notKept)
      : await keptChunksFor(this.files, path, stored, new Set(notKept));
    const extraChunks: EncodableChunk[] = [
      ...baseChunks.filter((chunk) => componentChunkSave.keepStoredChunk(chunk.id)),
      ...componentChunkSave.chunks,
    ];
    const bytes = await encodeAssetDocument(
      {
        type,
        name:
          type === "PluginSettings" &&
          typeof (content as { displayName?: unknown }).displayName ===
            "string" &&
          (content as { displayName: string }).displayName.trim() !== ""
            ? (content as { displayName: string }).displayName.trim()
            : (isInputAssetType(type) || type === "DataDefinition" || type === "DataTree" || isExtensionAssetType(type)) && existing?.name
              ? existing.name
              : assetName(path),
        guid,
        version,
        payload: payloadToSave,
      },
      {
        blobs,
        extraChunks,
        parentClass,
        headerPayload: storeInHeader
          ? payloadToSave
          : undefined,
        headerMeta: headerMetaForSave(type, content),
        dependencyMetadata: assetHeaderDependencyMetadata(
          type,
          payloadToSave,
          this.assetRegistry?.list(),
          parentClass,
        ),
      },
    );
    await storeDocumentBytes(this.files, path, stored, bytes, this.assetRegistry, suppliedChunkIds(extraChunks));
    if (pluginContentChanged && ownerPlugin) {
      // In the settings file's own write queue, so a PluginSettings save is
      // read here rather than replaced by the copy read before it, and is not
      // written while plugin discovery reads the stamp.
      await this.withDocumentWrite(ownerPlugin.settingsPath, async (settingsPath) => {
        const document = await decodeAssetDocument(await storage.readBinary(settingsPath));
        const settings = normalizePluginSettings(document.payload, { pluginGuid: ownerPlugin.pluginGuid });
        await storage.writeBinary(settingsPath, await encodePluginSettingsDocument({
          ...settings,
          engineVersion: ENGINE_VERSION,
          pluginDependencies: settings.pluginDependencies.map((dependency) => ({
            ...dependency,
            version: this.projectPlugins.descriptors.find((plugin) => plugin.pluginGuid === dependency.guid)?.settings.version ?? dependency.version,
          })),
        }));
        await this.syncPlugins();
      });
      this.emitRegistryChange();
    } else if (type === "PluginSettings") {
      await this.syncPlugins();
      this.emitRegistryChange();
    }
  }

  /** Binary chunk (font source, pixels, …) without decoding the document JSON. */
  async readAssetChunk(
    path: string,
    chunkId: string,
    options: { scope?: AssetLoadScope; signal?: AbortSignal; priority?: AssetLoadPriority } = {},
  ): Promise<Uint8Array | null> {
    return this.readSourceSnapshot(`Asset chunk ${path}#${chunkId}`, options.signal,
      () => this.readAssetChunkAttempt(path, chunkId, options));
  }

  private async readAssetChunkAttempt(
    path: string,
    chunkId: string,
    options: { scope?: AssetLoadScope; signal?: AbortSignal; priority?: AssetLoadPriority },
  ): Promise<Uint8Array | null> {
    const storage = this.storageForPath(path);
    const indexed = this.assetRegistry?.getByPath(path);
    if (indexed && this.assetRegistry) {
      if (!indexed.header.chunks.some((chunk) => chunk.id === chunkId)) return null;
      const registry = this.assetRegistry;
      const guid = indexed.header.guid;
      // The loader resolves the catalog snapshot (the read's one catalog read) before it loads, and the chunk read
      // checks storage against it afterwards. The reservation is sized from the indexed snapshot: a load that
      // resolves another revision retries with a fresh size, so a growing payload is never read unreserved.
      const estimated = indexed.locator ?? await registry.getAssetLocator(guid, { signal: options.signal });
      const sourceBytes = await registry.chunkByteLength(guid, chunkId, estimated, estimated.revision);
      const scope = options.scope ?? this.createAssetLoadScope(`Chunk Read: ${path}#${chunkId}`);
      try {
        return await scope.acquireLatest(`chunk:${guid}:${chunkId}`, guid, {
          key: `chunk:${chunkId}`,
          estimate: { sourceBytes, decodedBytes: 0, temporaryBytes: sourceBytes },
          load: async (asset, signal) => {
            signal.throwIfAborted();
            const locator = registry.getByGuid(guid)?.locator;
            if (!locator || asset.revision !== estimated.revision || locator.revision !== asset.revision || asset.rootId !== indexed.rootId) {
              throw new SourceRevisionChangedError(`Asset ${guid} changed after estimating chunk ${chunkId}`);
            }
            const value = await registry.readLocatedChunk(guid, chunkId, locator, asset.revision, { signal });
            signal.throwIfAborted();
            return { value, sourceBytes: value.byteLength, decodedBytes: 0 };
          },
        }, { dependencies: "none", signal: options.signal, priority: options.priority });
      } catch (error) {
        // A file deleted since it was indexed has no chunk to read.
        if (!options.signal?.aborted && !isAssetSourceRevisionChanged(error) && !(await storage.exists(path))) return null;
        throw error;
      } finally {
        if (!options.scope) scope.dispose();
      }
    }
    if (!(await storage.exists(path))) return null;
    const { header, locator } = await readAssetCatalog(storage, path, { signal: options.signal });
    const entry = header.chunks.find((chunk) => chunk.id === chunkId);
    if (!entry) return null;
    const blobs = this.blobsForPath(path);
    return new AccountedPayloadLoader(storage, { blobs }).loadChunk(locator, entry, blobs, storage, { signal: options.signal });
  }

  /**
   * The chunks a Scene payload write keeps, other than its document body and
   * `omit` (which the caller replaces): the stored ones carried over from
   * `stored` instead of read, and only probes matching the payload's geometry.
   * A reverb result baked for this geometry replaces the stored chunk, which is
   * then not read.
   */
  private async sceneChunksForSave(
    path: string,
    payload: SerializedScene | Record<string, unknown>,
    guid: string,
    stored: AssetCatalogRead | null,
    omit: readonly string[] = [],
  ): Promise<EncodableChunk[]> {
    const fingerprint = staticAudioGeometryFingerprint(payload as SerializedScene);
    const baked = this.sceneAudioReverb.get(guid)?.get(fingerprint);
    const kept = await keptChunksFor(this.files, path, stored, new Set([...omit, ...(baked ? [AUDIO_REVERB_CHUNK_ID] : [])]));
    if (baked) return [...kept, audioReverbChunk(baked)];
    if (kept.some((chunk) => chunk.id === AUDIO_REVERB_CHUNK_ID)) {
      // The fingerprint reads no Landscape or Foliage data, so their chunks are not read.
      const saved = await this.readAssetDocument(path, "Scene", { componentChunks: false });
      if (staticAudioGeometryFingerprint(normalizeScene(saved.payload)) !== fingerprint) {
        return kept.filter((chunk) => chunk.id !== AUDIO_REVERB_CHUNK_ID);
      }
    }
    return kept;
  }

  /** Persist Recast `exportNavMesh` bytes as the Scene `navmesh` extra chunk. */
  async writeSceneNavmeshChunk(
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.withDocumentWrite(path, (currentPath) => this.writeSceneNavmeshChunkUnlocked(currentPath, bytes, payload));
  }

  private async writeSceneNavmeshChunkUnlocked(
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (isPluginDocumentReadOnly(this.projectPlugins.descriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const guid = await this.guidForAsset(path);
    const existing = await readExistingAssetMeta(this.files, path);
    const stored = existing?.catalog ?? null;
    const type = existing?.type ?? "Scene";
    // The stored chunks are carried over, not read; the navmesh it replaces is not read at all.
    const componentChunkSave = prepareComponentChunksForSave(type, payload);
    const payloadToSave = componentChunkSave.payload;
    const baseChunks = await this.sceneChunksForSave(path, payload, guid, stored, [
      NAVMESH_CHUNK_ID, ...storedChunkIdsNotKept(stored, componentChunkSave.keepStoredChunk),
    ]);
    const chunks: EncodableChunk[] = [
      ...baseChunks.filter((chunk) => componentChunkSave.keepStoredChunk(chunk.id)),
      ...componentChunkSave.chunks,
      navmeshChunk(bytes),
    ];
    const encoded = await encodeAssetDocument(
      {
        type,
        name: assetName(path),
        guid,
        version: this.migrations.currentVersion(type),
        payload: payloadToSave,
      },
      {
        blobs: this.blobsForPath(path),
        extraChunks: chunks,
        parentClass: existing?.parentClass ?? null,
        // The header's index of the scene's Timeline Clips survives a bake.
        headerMeta: headerMetaForSave(type, payload),
        dependencyMetadata: assetHeaderDependencyMetadata(type, payloadToSave, this.assetRegistry?.list()),
      },
    );
    await storeDocumentBytes(this.files, path, stored, encoded, this.assetRegistry, suppliedChunkIds(chunks));
  }

  /** Update only derived bytes; unsaved geometry waits for an explicit Scene save. */
  async writeSceneAudioReverbChunk(
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (isPluginDocumentReadOnly(this.projectPlugins.descriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const registry = this.assetRegistry;
    const asset = registry?.getByPath(path);
    const baked = { fingerprint: staticAudioGeometryFingerprint(payload), bytes: bytes.slice() };
    const write = async () => {
      if (this.assetRegistry !== registry) return;
      const current = asset ? registry?.getByGuid(asset.header.guid) : null;
      if (asset && !current) return;
      const currentPath = current?.path ?? path;
      const storage = this.storageForPath(currentPath);
      const blobs = this.blobsForPath(currentPath);
      // Only the document is read, to compare its geometry. The other chunks are
      // carried over from the chunk table, and the reverb chunk this replaces is
      // not read at all; if they cannot be carried safely, everything is decoded.
      let stored: AssetCatalogRead | null = null;
      let kept: EncodableChunk[] | null = null;
      try {
        stored = await readAssetCatalog(storage, currentPath);
        kept = await carryStoredChunks(storage, blobs, stored, {
          omit: new Set([AUDIO_REVERB_CHUNK_ID]),
          load: (entry) => entry.id === DOCUMENT_CHUNK_ID,
        });
      } catch {
        // `kept` stays unset, so everything is decoded below.
      }
      let header: HassetHeader;
      let body: Uint8Array | undefined;
      if (stored && kept) {
        header = stored.header;
        body = kept.find((chunk): chunk is ChunkInput => chunk.id === DOCUMENT_CHUNK_ID && !isCarriedChunk(chunk))?.data;
      } else {
        stored = null;
        const decoded = await decodeHasset(await storage.readBinary(currentPath), (hash) => blobs.readBlob(hash));
        header = decoded.header;
        body = decoded.chunks.get(DOCUMENT_CHUNK_ID);
        kept = header.chunks.filter((entry) => entry.id !== AUDIO_REVERB_CHUNK_ID).map((entry) => ({
          id: entry.id, kind: entry.kind, mime: entry.mime, data: decoded.chunks.get(entry.id)!,
        }));
      }
      const persisted = body ? JSON.parse(new TextDecoder().decode(body)) : header.payload;
      if (header.type !== "Scene") throw new Error("Audio reverb requires a Scene asset");
      this.rememberSceneAudioReverb(header.guid, baked.fingerprint, baked.bytes);
      if (staticAudioGeometryFingerprint(normalizeScene(persisted)) !== baked.fingerprint) return;
      // Re-encode the persisted container under the same queue as Save. Preserve
      // authored JSON, schema/header metadata, dependencies, and every other chunk.
      const encoded = await encodeHasset({
        header,
        chunks: [...kept, audioReverbChunk(baked.bytes)],
        writeBlob: (hash, data) => blobs.writeBlob(hash, data),
      });
      await storeDocumentBytes(this.files, currentPath, stored, encoded, registry, [AUDIO_REVERB_CHUNK_ID]);
    };
    if (asset) await registry!.withAssetWrite(asset.header.guid, write);
    else await write();
  }

  /** Keep a result for its own geometry; the oldest beyond the limit is dropped. */
  private rememberSceneAudioReverb(guid: string, fingerprint: string, bytes: Uint8Array): void {
    const results = this.sceneAudioReverb.get(guid) ?? new Map<string, Uint8Array>();
    results.delete(fingerprint);
    results.set(fingerprint, bytes);
    for (const oldest of results.keys()) {
      if (results.size <= SCENE_AUDIO_REVERB_RESULTS) break;
      results.delete(oldest);
    }
    this.sceneAudioReverb.set(guid, results);
  }

  /** Add or replace an imported Audio clip chunk (`source` / `source:N`). */
  async writeAudioClipChunk(
    path: string,
    chunkId: string,
    bytes: Uint8Array,
    mime: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.withDocumentWrite(path, (currentPath) =>
      this.writeAudioClips(currentPath, payload, [chunkId], audioClipChunk({ id: chunkId, bytes, mime })));
  }

  /** Drop an extra Audio clip chunk. Never deletes the last `source`. */
  async removeAudioClipChunk(
    path: string,
    chunkId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const dropped = audioClipChunkToDrop(chunkId);
    return this.withDocumentWrite(path, (currentPath) =>
      this.writeAudioClips(currentPath, payload, dropped === null ? [] : [dropped]));
  }

  /**
   * Rewrite an Audio asset with `payload`: its stored chunks carried over from
   * the chunk table instead of read (a clip's blob stays unread), except
   * `omit`, which the caller replaces or drops, and `added` written after them.
   */
  private async writeAudioClips(
    path: string,
    payload: Record<string, unknown>,
    omit: readonly string[],
    added?: ChunkInput,
  ): Promise<void> {
    if (isPluginDocumentReadOnly(this.projectPlugins.descriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const existing = await readExistingAssetMeta(this.files, path);
    const stored = existing?.catalog ?? null;
    const kept = await keptChunksFor(this.files, path, stored, new Set(omit));
    const chunks = added ? [...kept, added] : kept;
    const type = existing?.type ?? "Audio";
    const storeInHeader = existing !== null && !existing.hasDocumentChunk;
    const encoded = await encodeAssetDocument(
      {
        type,
        name: assetName(path),
        guid: await this.guidForAsset(path),
        version: this.migrations.currentVersion(type),
        payload,
      },
      {
        blobs: this.blobsForPath(path),
        extraChunks: chunks,
        parentClass: existing?.parentClass ?? null,
        headerPayload: storeInHeader ? payload : undefined,
        headerMeta: headerMetaForSave(type, payload),
        dependencyMetadata: assetHeaderDependencyMetadata(type, payload, this.assetRegistry?.list(), existing?.parentClass),
      },
    );
    await storeDocumentBytes(this.files, path, stored, encoded, this.assetRegistry, suppliedChunkIds(chunks));
  }

  guidForPath(path: string): string | null {
    // The mounted registry owns identity after moves, deletions, and reindexing.
    // A former path must not lend its GUID to a new asset created there.
    if (this.assetRegistry) return this.assetRegistry.getByPath(path)?.header.guid ?? null;
    return this.assetGuids.get(path) ?? null;
  }

  /** The identity a write of `path` keeps; an existing file that cannot be read refuses the write. */
  private async guidForAsset(path: string): Promise<string> {
    const indexed = this.assetRegistry?.getByPath(path);
    if (indexed) return indexed.header.guid;
    const reserved = this.reservedAssetGuids.get(path);
    if (reserved) return reserved;
    const storage = this.storageForPath(path);
    if (await storage.exists(path)) {
      let header: ReturnType<typeof readAssetDocumentHeader>;
      try {
        header = readAssetDocumentHeader(await storage.readBinary(path));
      } catch (cause) {
        throw new Error(`${path} could not be read, so it was not overwritten.`, { cause });
      }
      this.assetGuids.set(path, header.guid);
      return header.guid;
    }
    const guid = newGuid();
    this.assetGuids.set(path, guid);
    return guid;
  }

  async saveProject(
    document: ProjectDocument,
    layouts: ProjectLayouts,
  ): Promise<void> {
    const guid = this.projectGuid ?? newGuid();
    const appearance = document.metadata.appearance;
    const text = (updatedAt: string) => JSON.stringify({
      ...document,
      metadata: { ...document.metadata, updatedAt, ...(appearance ? { appearance: storedProjectAppearance(appearance) } : {}) },
      guid,
      kind: "project",
      version: this.migrations.currentVersion("Project"),
    }, null, 2);
    this.projectGuid = guid;
    // A save that changes nothing leaves project.json as it is, `updatedAt`
    // included: a committed file that every Save All rewrote would show as a
    // change and conflict between teammates who both saved.
    let stored: string | null = null;
    try {
      stored = await this.storage.readText(PROJECT_FILE);
    } catch (error) {
      if (!isStorageNotFound(error)) throw error;
    }
    const storedUpdatedAt = stored === null ? null : storedProjectUpdatedAt(stored);
    if (stored === null || storedUpdatedAt === null || text(storedUpdatedAt) !== stored) {
      await this.storage.writeText(PROJECT_FILE, text(new Date().toISOString()));
    }
    await this.saveLayouts(layouts);
  }

  /** Write only `layout.json` (tabs, dock layouts and panel placements), which holds no project content. */
  async saveLayouts(layouts: ProjectLayouts): Promise<void> {
    await this.storage.writeText(
      LAYOUT_FILE,
      JSON.stringify({ ...layouts, assetGuids: Object.fromEntries(layouts.tabOrder.flatMap((id) => {
        const ref = parseDocumentId(id);
        const guid = ref ? this.guidForPath(ref.path) : null;
        return guid ? [[id, guid]] : [];
      })) }, null, 2),
    );
  }

  async documentExists(path: string): Promise<boolean> {
    return this.storageForPath(path).exists(path);
  }

  /** `layout.json` only restores the editor's view: one of another shape opens with the default layout. */
  async loadLayouts(): Promise<ProjectLayouts> {
    if (!(await this.storage.exists(LAYOUT_FILE))) {
      return createEmptyLayouts();
    }

    const parsed = JSON.parse(
      await this.storage.readText(LAYOUT_FILE),
    ) as Record<string, unknown>;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "documents" in parsed &&
      "tabOrder" in parsed
    ) {
      const layouts = parsed as unknown as ProjectLayouts;
      const identities = new Map(Object.entries(layouts.assetGuids ?? {}).flatMap(([id, guid]) => {
        const ref = parseDocumentId(id);
        const asset = this.assetRegistry?.getByGuid(guid);
        return ref && asset ? [[id, documentId({ kind: ref.kind, path: asset.path })] as const] : [];
      }));
      const remap = (id: string) => identities.get(id) ?? id;
      return {
        ...layouts,
        documents: Object.fromEntries(Object.entries(layouts.documents).map(([id, value]) => [remap(id), value])),
        tabOrder: [...new Set(layouts.tabOrder.map(remap))],
        activeDocumentId: layouts.activeDocumentId ? remap(layouts.activeDocumentId) : layouts.activeDocumentId,
        ...(layouts.panelPlacements ? { panelPlacements: Object.fromEntries(Object.entries(layouts.panelPlacements).map(([id, value]) => [remap(id), value])) } : {}),
        assetGuids: Object.fromEntries(Object.entries(layouts.assetGuids ?? {}).map(([id, value]) => [remap(id), value])),
      };
    }

    return createEmptyLayouts();
  }
}

/** An extension asset keeps the header type its extension declared; without one a save has nothing to write. */
function extensionAssetTypeForSave(type: string | undefined): string {
  if (!type || !isExtensionAssetType(type)) throw new Error("An extension asset needs its extension's asset type.");
  return type;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

/** `metadata.updatedAt` of a stored project.json, or null when it is not a manifest with one. */
function storedProjectUpdatedAt(text: string): string | null {
  try {
    const raw = JSON.parse(text) as { metadata?: { updatedAt?: unknown } };
    return typeof raw.metadata?.updatedAt === "string" ? raw.metadata.updatedAt : null;
  } catch {
    return null;
  }
}

/** The stored chunks a rewrite neither keeps nor reads: those `keep` refuses. */
function storedChunkIdsNotKept(stored: AssetCatalogRead | null, keep: (chunkId: string) => boolean): string[] {
  return stored?.header.chunks.flatMap((entry) => keep(entry.id) ? [] : [entry.id]) ?? [];
}

/** The Landscape and Foliage chunks a Scene's chunk table names. */
function sceneComponentChunkIds(chunks: ReadonlyArray<{ id: string }>): string[] {
  return [...landscapeChunkIdsInHeader(chunks), ...foliageChunkIdsInHeader(chunks)];
}

/**
 * Restores a Scene's binary Landscape and Foliage chunks into the base64 `data` editor documents hold.
 * A component whose chunk could not be read keeps its `chunkId`, so saving carries the stored chunk unchanged.
 */
function hydrateSceneComponentChunks(decoded: AssetDocument, chunks: ReadonlyMap<string, Uint8Array>): AssetDocument {
  return { ...decoded, payload: hydrateFoliageChunksToEditor(hydrateLandscapeChunksToEditor(decoded.payload, chunks), chunks) };
}

function prepareComponentChunksForSave(
  type: string,
  content: Record<string, unknown>,
): {
  payload: Record<string, unknown>;
  chunks: ChunkInput[];
  keepStoredChunk: (chunkId: string) => boolean;
} {
  // Prefab and Class Landscape and Foliage data stays inline: placing one copies its components into the Scene, which
  // saves its own chunks, and runtime spawns read the data from the document itself.
  if (type === "Prefab" || type === "Class") {
    return { payload: content, chunks: [], keepStoredChunk: (chunkId) => !isLandscapeChunkId(chunkId) && !isFoliageChunkId(chunkId) };
  }
  if (type !== "Scene") {
    return { payload: content, chunks: [], keepStoredChunk: () => true };
  }
  const landscape = extractLandscapeChunks(content);
  const foliage = extractFoliageChunks(landscape.payload);
  const payload = foliage.payload;
  const chunks = [...landscape.chunks, ...foliage.chunks];
  const referencedChunkIds = new Set<string>();
  const visit = (components: unknown) => {
    if (!Array.isArray(components)) return;
    for (const component of components as Array<{ classId?: string; properties?: Record<string, unknown> }>) {
      if (component?.classId !== "LandscapeComponent" && component?.classId !== "FoliageComponent") continue;
      const cid = component.properties?.chunkId;
      if (typeof cid === "string" && (isLandscapeChunkId(cid) || isFoliageChunkId(cid))) referencedChunkIds.add(cid);
    }
  };
  const record = payload as { actors?: Array<{ components?: unknown }>; components?: unknown };
  if (Array.isArray(record.actors)) for (const actor of record.actors) visit(actor.components);
  visit(record.components);
  const extractedIds = new Set(chunks.map((chunk) => chunk.id));
  return {
    payload,
    chunks,
    keepStoredChunk: (chunkId: string) =>
      (!isLandscapeChunkId(chunkId) && !isFoliageChunkId(chunkId)) || (referencedChunkIds.has(chunkId) && !extractedIds.has(chunkId)),
  };
}
/**
 * Writes the picture of `appearance` (its in-memory `image`) to its project-root cover file, removing any other cover
 * file, and returns the appearance as `project.json` stores it. Without a picture every cover file is removed.
 */
async function writeProjectCover(storage: ProjectStorage, appearance: ProjectAppearance): Promise<ProjectAppearance> {
  const cover = appearance.image ? projectCoverFromDataUrl(appearance.image) : null;
  if (cover) await storage.writeBinary(cover.file, cover.bytes);
  for (const file of PROJECT_COVER_FILES) {
    if (file !== cover?.file && await storage.exists(file)) await storage.remove(file);
  }
  const stored = storedProjectAppearance(appearance);
  delete stored.coverFile;
  return cover ? { ...stored, coverFile: cover.file } : stored;
}

/** The appearance with its cover file's picture loaded into `image`; a missing or unreadable file shows the icon. */
async function readProjectCover(storage: ProjectStorage, appearance: ProjectAppearance | undefined): Promise<ProjectAppearance | undefined> {
  if (!appearance?.coverFile) return appearance;
  try {
    return { ...appearance, image: projectCoverDataUrl(appearance.coverFile, await storage.readBinary(appearance.coverFile)) };
  } catch (error) {
    if (!isStorageNotFound(error)) throw error;
    return storedProjectAppearance(appearance);
  }
}
