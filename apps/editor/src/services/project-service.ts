import { createDefaultInputAssets } from "@babylonslate/core";
import { normalizeDataObjectAsset, normalizeDataSheetAsset } from "@babylonslate/core";
import { normalizeImportedProject, readProjectArchive, PROJECT_IMPORT_LIMIT } from "./project-import";
import { getHostPlatform, pickImportFiles } from "@babylonslate/vfs";
import type { DockviewApi } from "dockview-react";
import { staticAudioGeometryFingerprint } from "../lib/audio-reverb-bake";
import { convertGlslToMaterial, normalizeMaterialDocument, normalizeMaterialFunctionDocument, validateMaterialParameterNames } from "@babylonslate/shader-graph";
import { EditorExtensionService } from "./editor-extension-service";
import { ENGINE_EXTENSION_LIBRARY_ROOT } from "../lib/engine-extension-library";
import { installEngineExtensionDefaults, isExtensionPackagePath, type AssetDocument } from "@babylonslate/assets";
import type {
  DocumentKind,
  PluginEnableOverride,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
  SerializedSceneLayer,
} from "@babylonslate/core";
import {
  isInputAssetType,
  ENGINE_VERSION,
  normalizeInputAssetPayload,
  assetTypeForDocumentKind,
  assetTypeForDocumentSave,
  createDefaultScene,
  createEmptyLayouts,
  createEmptyProject,
  normalizeProjectSettings,
  normalizeProjectAppearance,
  migrateGameInstanceClassFromScenes,
  normalizeScene,
  normalizeSceneLayer,
  classHeaderMeta,
  documentId,
  documentKindForAssetType,
  isAssetDocumentKind,
  LAYOUT_FILE,
  MAIN_CLASS_FILE,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  migrateLegacyLayout,
  PROJECT_FILE,
  type ProjectDocument,
  type ProjectMetadata,
  type ProjectAppearance,
  type RenderProjectSettings,
} from "@babylonslate/core";
import type { ProjectFolderHandle, ProjectStorage } from "@babylonslate/core";
import {
  AssetRegistry,
  RegistryGenerationClock,
  type AreaEmissionProgress,
  type AreaEmissionProcessor,
  canUseWorkerEncode,
  createProjectFromTemplate,
  createVfsBlobStore,
  createWorkerEncodeFn,
  decodeAssetDocument,
  encodePluginSettingsDocument,
  normalizePluginSettings,
  stableStringify,
  decodeBabasset,
  encodeBabasset,
  AUDIO_REVERB_CHUNK_ID,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  DOCUMENT_CHUNK_ID,
  EncodeQueue,
  encodeAssetDocument,
  encodeJobMayWrite,
  extraChunksFromDecoded,
  extraChunksWithAudioReverb,
  extraChunksWithAudioClip,
  extraChunksWithoutAudioClip,
  exportProjectZip,
  fallbackParentClass,
  clearDeletedAssetRefs,
  replaceClassAssetReferences,
  type ClassAssetReplacement,
  isAssetDocumentPath,
  isTracePath,
  loadPayloadWithMigration,
  defaultRegistry,
  projectContentRoot,
  readAssetDocumentHeader,
  readTraceDocument,
  readProjectTree,
  writeThumbnail,
  ProjectSearchIndex,
  type BabassetHeader,
  type ChunkInput,
  type BlobStore,
  type EncodeFn,
  stubEncodeKtx2,
  type MigrationPending,
  type PluginDescriptor,
  type PluginDiagnostic,
  type IndexedAsset,
  type ProjectTreeFile,
  createDefaultPluginSettings,
  discoverEnginePlugins,
  discoverProjectPlugins,
  exportPluginZip,
  indexUnresolvedPlaceholders,
  inspectBabplugin,
  applyPluginImport,
  installEnginePluginDefaults,
  mountEnabledPlugins,
  planPluginImport,
  resolvePluginEnabled,
  resolvePluginGraph,
  shadowEnginePlugins,
  stripAssetFileSuffix,
  writeProjectPlugin,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  ATLAS_REFERRER_TYPES,
  ATLAS_TEXTURES_META,
  atlasTextureGuids,
  type ImageSize,
  type OwnAssetWrite,
  type InspectedBabplugin,
  type PluginImportPlan,
} from "@babylonslate/assets";
import { processAreaEmissionInWorker } from "@babylonslate/assets/area-emission-client";
import { onEncodeQueuePause } from "./encode-queue-pause";
import { validateClassDeletionReplacements } from "../lib/class-deletion";
import { createAppSettingsStore, isTestModeEnabled, TEST_PROJECT_NAME } from "@babylonslate/vfs";
import { extraChunksWithNavmesh } from "@babylonslate/navigation";
import {
  newAssetFileName,
  assetHeaderDependencies,
  materialHeaderMeta,
} from "../lib/content-browser-helpers";
import {
  SEARCH_CATALOG_CLASS_IDS,
  SEARCH_NODE_TITLES,
} from "../lib/search-catalog";
import { uniquePluginFolderName, pluginRootId, isPluginDocumentReadOnly } from "../lib/plugin-ui";
import { ENGINE_PLUGIN_LIBRARY_ROOT } from "../lib/engine-plugin-library";
import {
  normalizeProjectFolderName,
  type CreateProjectOptions,
} from "../lib/create-project";
import type { UpdateListedProjectOptions } from "../lib/listed-projects";
import { loadKenneyMannequinGlb } from "../lib/kenney-mannequin";
import { editorEncodeWorkerUrl } from "../lib/public-engine-assets";
import {
  applyKenneyMannequinEmptyScaffold,
  MANNEQUIN_CLASS_FILE,
} from "../lib/scaffold-empty-3d";
import { createDefaultLogicGraphSerialized, hydrateClassDocumentPayload } from "./graph-validation";

function headerMetaForSave(
  type: string,
  content:
    | SerializedScene
    | SerializedSceneLayer
    | SerializedGraph
    | Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Sheets render indexed values without loading one document per visible row.
  // This header snapshot is always derived from the body being saved.
  if (type === "DataObject") return { ...normalizeDataObjectAsset(content) };
  if (type === "DataSheet") return { ...normalizeDataSheetAsset(content) };
  if (isInputAssetType(type)) {
    const input = normalizeInputAssetPayload(type, content);
    return { valueType: input.valueType };
  }
  const materialMeta = materialHeaderMeta(
    type,
    content as Record<string, unknown>,
  );
  if (materialMeta) return materialMeta;
  if (type === "Class" || type === "Graph") {
    return classHeaderMeta(
      content as {
        members?: Array<{
          id?: string;
          kind: string;
          name: string;
          typeId?: string;
          typeClassId?: string;
          functionId?: string;
          assetGuid?: string;
          overridable?: boolean;
          implementsInterface?: { assetGuid: string; methodName: string };
          overrides?: { classId: string; name: string };
          pins?: Array<{
            name: string;
            typeId?: string;
            direction?: "in" | "out";
            typeClassId?: string;
          }>;
        }>;
      },
    );
  }
  if (type === "ScriptInterface") {
    const payload = content as {
      guid?: string;
      name?: string;
      methods?: Array<{
        name: string;
        pins: Array<{
          name: string;
          typeId: string;
          direction: "in" | "out";
          typeClassId?: string;
        }>;
      }>;
    };
    return {
      guid: typeof payload.guid === "string" ? payload.guid : "",
      name: typeof payload.name === "string" ? payload.name : "Interface",
      methods: Array.isArray(payload.methods) ? payload.methods : [],
    };
  }
  if (type === "SpriteAnimation") {
    const parsed = parseSpriteAnimationPayload(content);
    return {
      durationMs: spriteAnimationDurationMs(parsed),
      [ATLAS_TEXTURES_META]: atlasTextureGuids(type, content as Record<string, unknown>),
    };
  }
  if (ATLAS_REFERRER_TYPES.has(type)) {
    // The registry reads a referrer's atlases from its header, never its document.
    return { [ATLAS_TEXTURES_META]: atlasTextureGuids(type, content as Record<string, unknown>) };
  }
  return undefined;
}

/** Texture payload fields owned by the registry's encode queue, not the document. */
const TEXTURE_ENCODE_STATE_KEYS = [
  "compressionState",
  "ktx2ChunkId",
  "encodeError",
  "encodeWallMs",
  "ktx2Width",
  "ktx2Height",
  "ktx2BlockAlign",
  "ktx2Sha256",
] as const;

/**
 * An open Texture document keeps the payload it opened with, but encodes can
 * commit meanwhile. Saving takes these fields from the file (absent stays
 * absent) so `ktx2ChunkId` never points back at a superseded encode.
 */
function withSavedTextureEncodeState(
  content: Record<string, unknown>,
  saved: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...content };
  for (const key of TEXTURE_ENCODE_STATE_KEYS) {
    if (key in saved) next[key] = saved[key];
    else delete next[key];
  }
  return next;
}

/** sha256 of the KTX2 chunk a Texture's header commits to (`ktx2ChunkId`), if any. */
function committedKtx2Sha256(header: Pick<BabassetHeader, "payload" | "chunks"> | undefined): string | null {
  const id = header?.payload.ktx2ChunkId;
  return header?.chunks.find((chunk) => chunk.id === id)?.sha256 ?? null;
}

export interface ProjectLoadResult {
  document: ProjectDocument;
  layouts: ProjectLayouts;
  migrationPending: MigrationPending[];
}

export type PluginImportResult =
  | { status: "imported"; descriptor: PluginDescriptor }
  | { status: "kept" }
  | {
      status: "conflict";
      incoming: InspectedBabplugin;
      plan: Extract<PluginImportPlan, { kind: "conflict" }>;
    };

function newGuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assetName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return stripAssetFileSuffix(file) || file.replace(/\.babasset$/, "");
}

function parentDir(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

type OwnedFolder = { handle: ProjectFolderHandle; createdHere: boolean };

export class ProjectService {
  private readonly storage: ProjectStorage;
  readonly extensions: EditorExtensionService;
  private engineExtensionStorage: ProjectStorage | null = null;
  private projectGuid: string | null = null;
  private migrationPending: MigrationPending[] = [];
  private migrateOnSaveApproved = false;
  private readonly migrations = defaultRegistry();
  private readonly blobs: BlobStore;
  private assetRegistry: AssetRegistry | null = null;
  private projectSearchIndex: ProjectSearchIndex | null = null;
  private readonly encodeQueue: EncodeQueue;
  private readonly emissionJobs = new Set<AbortController>();
  private readonly processAreaEmission: AreaEmissionProcessor;
  private workerEncode:
    | (EncodeFn & { dispose: () => void; recycleCount: () => number })
    | null = null;
  private encodeQueuePauseUnsubscribe: (() => void) | null = null;
  private readonly configuredEncode?: EncodeFn;
  private readonly createWorkerEncode: () =>
    | (EncodeFn & { dispose: () => void; recycleCount: () => number })
    | null;
  private transcoderAvailable = true;
  private derivedStorage: ProjectStorage | null = null;
  private enginePluginStorage: ProjectStorage | null = null;
  private pluginDescriptors: PluginDescriptor[] = [];
  private pluginDiagnostics: PluginDiagnostic[] = [];
  private pluginOverrides: Record<string, PluginEnableOverride> = {};
  /** Asset guids stay stable across saves so references survive a rewrite. */
  private readonly assetGuids = new Map<string, string>();
  /** Unsaved geometry results become persistent only with the matching Scene. */
  private readonly sceneAudioReverb = new Map<string, { fingerprint: string; bytes: Uint8Array }>();
  private readonly registryListeners = new Set<() => void>();
  private readonly ownWriteListeners = new Set<(write: OwnAssetWrite) => void>();
  private readonly diagnostics: string[] = [];
  private readonly diagnosticListeners = new Set<(line: string) => void>();
  /**
   * The open project's source control **Enable** setting, saved or not. While
   * it is on, nothing re-encodes a Texture in the background: only the user's
   * own edits, and Textures whose committed encode this session wrote, re-align.
   */
  private sourceControlEnabled = false;
  /** The Usage an open Texture tab shows, saved or not (the editor sets it). */
  private openTextureUsage: ((guid: string) => string | undefined) | null = null;
  /**
   * Texture guid -> sha256 of the KTX2 chunk this project session last wrote
   * for it: an encode it committed, or the one a file it created carries (a
   * `.babasset` import, Duplicate or Copy). It exempts the Texture only while
   * that encode is still the committed one in the file on disk: a git revert
   * or pull that replaces it ends the exemption, even for a job queued before.
   */
  private readonly sessionEncodes = new Map<string, string>();
  /** Committed KTX2 (and sniffed source) sizes by chunk sha256, kept across registry remounts. */
  private readonly ktx2SizeCache = new Map<string, ImageSize | null>();
  /** Textures decoded legacy atlas referrers sample, by content, kept across registry remounts. */
  private readonly legacyAtlasCache = new Map<string, readonly string[]>();
  /** Textures an alignment check is requeuing, shared by remounts as the encode queue is. */
  private readonly alignmentRequeues = new Set<string>();
  /** Change counter shared by every project registry, so remounts never rewind it. */
  private readonly registryClock = new RegistryGenerationClock();
  private textureAlignmentChain: Promise<unknown> = Promise.resolve();
  private readonly textureAlignment = { runs: 0, pending: 0, requeued: new Set<string>() };

  constructor(
    storage: ProjectStorage,
    options: {
      encode?: EncodeFn;
      processAreaEmission?: AreaEmissionProcessor;
      createWorkerEncode?: () =>
        | (EncodeFn & { dispose: () => void; recycleCount: () => number })
        | null;
    } = {},
  ) {
    this.storage = storage;
    const assetPath = (path: string) => {
      if (!isExtensionPackagePath(path) || !path.startsWith("assets/") || !path.endsWith(".babasset")) {
        throw new Error("Extension asset writes require a project assets/*.babasset path.");
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
      if (!kind || assetTypeForDocumentKind(kind) !== document.type || kind === "trace") {
        throw new Error(`Extension cannot author this asset type: ${document.type}`);
      }
      await this.saveDocument(kind, path, document.payload);
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
      log: (id, message) => {
        const line = `[Extension ${id}] ${message}`;
        this.diagnostics.push(line);
        for (const listener of this.diagnosticListeners) listener(line);
      },
    });
    this.blobs = createVfsBlobStore(storage);
    this.configuredEncode = options.encode;
    this.processAreaEmission = options.processAreaEmission ?? processAreaEmissionInWorker;
    this.createWorkerEncode = options.createWorkerEncode ?? (() =>
      canUseWorkerEncode()
        ? createWorkerEncodeFn({ workerUrl: editorEncodeWorkerUrl() })
        : null);
    this.encodeQueue = new EncodeQueue({
      encode: (source, settings, mime) =>
        (this.configuredEncode ?? this.workerEncode ?? stubEncodeKtx2)(
          source,
          settings,
          mime,
        ),
      onState: (guid, state, job) => {
        // `compressed` is written with the KTX2 chunk in onComplete. A guarded
        // (alignment) job leaves the saved state alone until it commits, so
        // nothing on disk requeues it later, source control on or not.
        if (state === "compressed" || job.guard) return;
        void this.assetRegistry
          ?.setCompressionState(guid, state)
          .then(() => this.emitRegistryChange());
      },
      onComplete: async (result) => {
        const registry = this.assetRegistry;
        if (!(await registry?.commitCompressedTexture(result))) {
          // Refused (a guarded job the file on disk no longer allows): Texture
          // Details rechecks whether the Texture is left stale for the user.
          this.emitRegistryChange();
          return;
        }
        const committed = registry && committedKtx2Sha256(registry.getByGuid(result.assetGuid)?.header);
        if (committed) this.sessionEncodes.set(result.assetGuid, committed);
        this.emitRegistryChange();
        // A Tileset, Sprite or Sprite Animation may have picked the texture
        // while it encoded; recheck it with the Usage the pass will use (an
        // open tab's, else the saved one), unless another Usage chose this
        // encode: an unsaved Details edit in a tab closed since.
        const saved = this.assetRegistry?.getByGuid(result.assetGuid)?.header.payload.usage;
        const usage = this.openTextureUsage?.(result.assetGuid) ?? String(saved ?? "albedo");
        if (result.usage === undefined || result.usage === usage) {
          void this.reconcileTextureAlignment([result.assetGuid]);
        }
      },
      onError: (guid, error, job) => {
        this.emitTextureEncodeDiagnostic(guid, error);
        const message = error instanceof Error ? error.message : String(error);
        void this.assetRegistry
          ?.setCompressionState(guid, "encode_failed", {
            error: message,
            ...(job.guard ? { canWrite: (_guid: string, current: BabassetHeader) => encodeJobMayWrite(job, current) } : {}),
          })
          .then(() => this.emitRegistryChange());
      },
      // A guarded job dropped unencoded may leave its Texture stale for the user.
      onDrop: () => this.emitRegistryChange(),
    });
  }

  /** Start provider-lifetime resources; safe across Strict Mode effect probes. */
  initialize(): void {
    if (this.encodeQueuePauseUnsubscribe) return;
    if (!this.configuredEncode) {
      this.workerEncode = this.createWorkerEncode();
    }
    this.encodeQueuePauseUnsubscribe = onEncodeQueuePause((paused) => {
      if (paused) this.encodeQueue.pause();
      else this.encodeQueue.resume();
    });
  }

  /** Release provider-lifetime resources; project close deliberately does not. */
  dispose(): void {
    void this.extensions.close();
    this.cancelEmissionJobs();
    this.encodeQueuePauseUnsubscribe?.();
    this.encodeQueuePauseUnsubscribe = null;
    this.workerEncode?.dispose();
    this.workerEncode = null;
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

  private emitTextureEncodeDiagnostic(guid: string, error: unknown): void {
    const asset = this.assetRegistry?.getByGuid(guid);
    const name = asset?.header.name?.trim() || "Texture";
    const message = error instanceof Error ? error.message : String(error);
    const line = `Texture encode failed for ${name} (${guid}): ${message}`;
    this.diagnostics.push(line);
    if (this.diagnostics.length > 200) this.diagnostics.shift();
    for (const listener of this.diagnosticListeners) listener(line);
  }

  /** When self-hosted transcoder files are missing, prefer source chunks. */
  async setTranscoderAvailable(available: boolean): Promise<void> {
    this.transcoderAvailable = available;
    if (!available && this.assetRegistry) {
      await this.markCompressedTexturesFallback();
    }
  }

  get isTranscoderAvailable(): boolean {
    return this.transcoderAvailable;
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

  private async markCompressedTexturesFallback(): Promise<void> {
    if (!this.assetRegistry) return;
    for (const asset of this.assetRegistry.list({ type: "Texture" })) {
      const hasKtx2 = asset.header.chunks.some(
        (chunk) => chunk.kind === "ktx2" || chunk.id.startsWith("ktx2:"),
      );
      const state = asset.header.payload.compressionState;
      if (hasKtx2 && state === "compressed") {
        await this.assetRegistry.setCompressionState(
          asset.header.guid,
          "fallback_uncompressed",
        );
      }
    }
  }

  get textureEncodeQueue(): EncodeQueue {
    return this.encodeQueue;
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

  /** Pause encode jobs while Preview runs (engineplan §3.5). */
  pauseTextureEncodeQueue(): void {
    this.encodeQueue.pause();
  }

  resumeTextureEncodeQueue(): void {
    this.encodeQueue.resume();
  }

  async retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean; usage?: string },
  ): Promise<boolean> {
    return (
      (await this.assetRegistry?.retryTextureEncoding(guid, options)) ?? false
    );
  }

  /**
   * The editor reports the project's source control **Enable** setting as it
   * changes, saved or not (a project load reads the saved one). Turning it on
   * stops the alignment pass, including the re-encodes it queued; turning it
   * off runs the pass.
   */
  setSourceControlEnabled(enabled: boolean): void {
    if (this.sourceControlEnabled === enabled) return;
    this.sourceControlEnabled = enabled;
    if (!enabled) void this.reconcileTextureAlignment();
  }

  /**
   * Whether the alignment pass may rewrite a Texture now: not read-only, and
   * source control is off or its committed encode is the one this project
   * session last wrote (such as an import a Tileset then picks); a git revert
   * or pull that replaced that encode ends it. Asked again when its job
   * starts, and before its commit with `current`, the file on disk the commit
   * would replace, which the index may not describe yet.
   */
  private alignmentMayWrite(guid: string, current?: BabassetHeader): boolean {
    const registry = this.assetRegistry;
    const asset = registry?.getByGuid(guid);
    if (!registry || !asset) return false;
    if (registry.getRoot(asset.rootId)?.readOnly || isPluginDocumentReadOnly(this.pluginDescriptors, asset.path)) {
      return false;
    }
    if (!this.sourceControlEnabled) return true;
    const committed = committedKtx2Sha256(current ?? asset.header);
    return committed !== null && this.sessionEncodes.get(guid) === committed;
  }

  /**
   * Whether Texture Details offers **Retry Encoding** for a `compressed`
   * Texture: its committed encode is stale for the alignment policy and
   * nothing re-encodes it yet (source control on, so the pass leaves it for
   * the user). `usage` is its tab's, saved or not.
   */
  async textureAlignmentStale(guid: string, usage?: string): Promise<boolean> {
    const registry = this.assetRegistry;
    const asset = registry?.getByGuid(guid);
    if (!registry || !asset || isPluginDocumentReadOnly(this.pluginDescriptors, asset.path)) return false;
    return registry.isTextureAlignmentStale(guid, {
      usage: usage ?? this.openTextureUsage?.(guid),
      ktx2SizeCache: this.ktx2SizeCache,
    });
  }

  /**
   * `usageFor(guid)` is the Usage an open Texture tab shows, saved or not,
   * so the alignment pass checks and re-encodes as a Details edit did
   * instead of undoing it with the saved Usage.
   */
  setOpenTextureUsage(usageFor: ((guid: string) => string | undefined) | null): void {
    this.openTextureUsage = usageFor;
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
    const run = async () => {
      const registry = this.assetRegistry;
      if (!registry) return 0;
      const requeued = await registry.reconcileTextureAlignment({
        guids,
        canWrite: (guid, current) => this.alignmentMayWrite(guid, current),
        usageFor: this.openTextureUsage ?? undefined,
        ktx2SizeCache: this.ktx2SizeCache,
      });
      this.textureAlignment.runs += 1;
      for (const guid of requeued) this.textureAlignment.requeued.add(guid);
      if (requeued.length > 0) this.emitRegistryChange();
      return requeued.length;
    };
    this.textureAlignment.pending += 1;
    const next = this.textureAlignmentChain.then(run, run).finally(() => {
      this.textureAlignment.pending -= 1;
    });
    this.textureAlignmentChain = next.catch(() => 0);
    return next;
  }

  /** Alignment passes finished and still queued, and every Texture they requeued (test hook). */
  get textureAlignmentState(): { runs: number; pending: number; requeued: string[] } {
    const { runs, pending, requeued } = this.textureAlignment;
    return { runs, pending, requeued: [...requeued] };
  }

  async prepareAreaEmission(guid: string, options: { signal?: AbortSignal; onProgress?: (value: AreaEmissionProgress) => void } = {}): Promise<void> {
    const registry = this.assetRegistry;
    if (!registry) throw new Error("Open a project before processing emission textures.");
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    this.emissionJobs.add(controller);
    try {
      await registry.prepareAreaEmission(guid, this.processAreaEmission, { ...options, signal: controller.signal });
      if (this.assetRegistry === registry) this.emitRegistryChange();
    } finally {
      this.emissionJobs.delete(controller);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  private cancelEmissionJobs(): void {
    for (const job of this.emissionJobs) job.abort(new Error("Area emission processing cancelled because the project closed."));
    this.emissionJobs.clear();
  }

  async retryAllFailedTextureEncoding(): Promise<number> {
    if (!this.assetRegistry) return 0;
    let count = 0;
    for (const asset of this.assetRegistry.list({ type: "Texture" })) {
      const state = asset.header.payload.compressionState;
      if (
        state === "encode_failed" ||
        state === "fallback_uncompressed" ||
        state === "pending" ||
        state === "encoding"
      ) {
        if (await this.assetRegistry.retryTextureEncoding(asset.header.guid)) {
          count += 1;
        }
      }
    }
    return count;
  }

  get storagePort(): ProjectStorage {
    return this.storage;
  }

  get registry(): AssetRegistry | null {
    return this.assetRegistry;
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
    return this.pluginDescriptors;
  }

  get pluginGraphDiagnostics(): PluginDiagnostic[] {
    return this.pluginDiagnostics;
  }

  /** Export presets scan their selected plugin roots without changing editor mounts. */
  async listExportAssets(
    enabledPluginGuids: ReadonlySet<string>,
    overrides: Record<string, PluginEnableOverride> = this.pluginOverrides,
  ): Promise<IndexedAsset[]> {
    const exportRegistry = new AssetRegistry(this.storage, {
      blobs: this.blobs,
    });
    await mountEnabledPlugins(exportRegistry, this.pluginDescriptors, {
      enabledGuids: enabledPluginGuids,
      overrides,
      storageFor: (plugin) =>
        plugin.source === "engine"
          ? (this.enginePluginStorage ?? undefined)
          : undefined,
    });
    const byGuid = new Map(
      (this.assetRegistry?.list() ?? [])
        .filter((asset) => !asset.rootId.startsWith("plugin:"))
        .map((asset) => [asset.header.guid, asset]),
    );
    for (const asset of exportRegistry.list())
      byGuid.set(asset.header.guid, asset);
    return [...byGuid.values()];
  }

  setEnginePluginStorage(storage: ProjectStorage | null): void {
    this.enginePluginStorage = storage;
  }

  setEngineExtensionStorage(storage: ProjectStorage): void {
    this.engineExtensionStorage = storage;
    this.extensions.setEngineStorage(storage);
  }

  private async installEnginePluginDefaultsIfNeeded(): Promise<void> {
    if (this.engineExtensionStorage) await installEngineExtensionDefaults(this.storage, this.engineExtensionStorage);
    if (!this.enginePluginStorage) return;
    await installEnginePluginDefaults(this.storage, this.enginePluginStorage);
  }

  setPluginOverrides(
    overrides: Record<string, PluginEnableOverride>,
  ): void {
    this.pluginOverrides = overrides;
  }

  get searchIndex(): ProjectSearchIndex | null {
    return this.projectSearchIndex;
  }

  get guid(): string | null {
    return this.projectGuid;
  }

  get pendingMigrations(): MigrationPending[] {
    return [...this.migrationPending];
  }

  approveMigrateOnSave(): void {
    this.migrateOnSaveApproved = true;
  }

  clearMigrateOnSaveApproval(): void {
    this.migrateOnSaveApproved = false;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return (await this.storage.listProjects()).filter(
      (folder) => folder.name !== ENGINE_PLUGIN_LIBRARY_ROOT && folder.name !== ENGINE_EXTENSION_LIBRARY_ROOT && folder.name !== "__slate_templates__",
    );
  }

  async deleteListedProject(handle: ProjectFolderHandle): Promise<void> {
    await this.storage.deleteProject?.(handle);
  }

  async openProject(
    source: "folder" | "zip" = "folder",
  ): Promise<ProjectLoadResult | null> {
    if (getHostPlatform() === "web") {
      const picked = await pickImportFiles({
        directory: source === "folder",
        multiple: source === "folder",
        accept: source === "zip" ? ".zip,.babproject" : undefined,
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
                .replace(/\.(zip|babproject)$/i, ""),
        ) || "Imported Project";
      let name = base;
      let suffix = 2;
      // Existing browser projects remain untouched, even when display names match.
      for (;;) {
        await this.storage.openDocumentsProject(name);
        if (!(await this.storage.exists(PROJECT_FILE))) break;
        name = `${base} ${suffix++}`;
      }
      return this.createFromTemplate({ templateFiles: files, name });
    }
    await this.storage.pickProjectFolder();
    return this.loadCurrentProject();
  }

  async createEmptyProject(
    name?: string,
    options?: CreateProjectOptions,
  ): Promise<ProjectLoadResult> {
    const projectName =
      name && name.trim()
        ? normalizeProjectFolderName(name)
        : isTestModeEnabled()
          ? TEST_PROJECT_NAME
          : "MyGame";
    if (options?.pickFolder) {
      await this.storage.pickProjectFolder();
      if (await this.storage.exists(PROJECT_FILE)) {
        return this.loadCurrentProject();
      }
      return this.scaffoldNewProject(projectName, options.kind, options);
    }
    const owned = await this.openOwnedDocumentsProject(projectName);
    if (await this.storage.exists(PROJECT_FILE)) {
      throw new Error("Name already exists.");
    }
    return this.scaffoldOwnedProject(owned, () =>
      this.scaffoldNewProject(projectName, options?.kind, options),
    );
  }

  async createFromTemplate(options: {
    templateFiles: ProjectTreeFile[];
    name: string;
    pickFolder?: boolean;
    appearance?: ProjectAppearance;
  }): Promise<ProjectLoadResult> {
    const projectName = normalizeProjectFolderName(options.name);
    let owned: OwnedFolder | null = null;
    if (options.pickFolder) {
      await this.storage.pickProjectFolder();
    } else {
      owned = await this.openOwnedDocumentsProject(projectName);
    }
    if (await this.storage.exists(PROJECT_FILE)) {
      throw new Error("A project already exists in this folder.");
    }
    const guid = newGuid();
    return this.scaffoldOwnedProject(
      owned,
      async () => {
        await createProjectFromTemplate({
          templateFiles: options.templateFiles,
          destination: this.storage,
          guid,
          name: projectName,
        });
        const appearance = normalizeProjectAppearance(options.appearance);
        if (appearance) {
          const manifest = JSON.parse(
            await this.storage.readText(PROJECT_FILE),
          ) as {
            metadata?: Partial<ProjectMetadata>;
          };
          manifest.metadata = {
            ...createEmptyProject(projectName).metadata,
            ...manifest.metadata,
            appearance,
          };
          await this.storage.writeText(
            PROJECT_FILE,
            JSON.stringify(manifest, null, 2),
          );
        }
        this.projectGuid = guid;
        await this.installEnginePluginDefaultsIfNeeded();
        return this.loadCurrentProject();
      },
    );
  }

  /** Opens the Documents-tier folder for `name`, recording whether this call created it. */
  private async openOwnedDocumentsProject(name: string): Promise<OwnedFolder> {
    const known = await this.storage.listProjects();
    const handle = await this.storage.openDocumentsProject(name);
    const registered = known.some((p) => p.id === handle.id);
    let empty = false;
    if (!registered) {
      try {
        empty = (await this.storage.readdir(".")).length === 0;
      } catch {
        empty = false;
      }
    }
    return { handle, createdHere: !registered && empty };
  }

  private async scaffoldOwnedProject<T>(
    owned: OwnedFolder | null,
    scaffold: () => Promise<T>,
  ): Promise<T> {
    try {
      return await scaffold();
    } catch (cause) {
      // A failed scaffold leaves a registered folder that never reaches the
      // recents list but still blocks the name via the project-file check.
      // Drop only folders this call created itself and still owns;
      // user-picked folders and pre-existing folders stay.
      if (
        owned?.createdHere &&
        this.storage.deleteProject &&
        this.storage.getCurrentFolder()?.id === owned.handle.id
      ) {
        try {
          await this.storage.deleteProject(owned.handle);
        } catch (cleanupError) {
          console.warn(
            `Could not remove partially created project "${owned.handle.name}"`,
            cleanupError,
          );
        }
      }
      throw cause;
    }
  }

  async openListedProject(handle: ProjectFolderHandle): Promise<ProjectLoadResult> {
    await this.storage.openKnownFolder(handle);
    return this.loadCurrentProject();
  }

  async closeProject(): Promise<void> {
    this.sessionEncodes.clear();
    await this.extensions.close();
    this.cancelEmissionJobs();
    await this.storage.releaseFolder();
    this.projectGuid = null;
    this.migrationPending = [];
    this.migrateOnSaveApproved = false;
    this.assetGuids.clear();
    this.sceneAudioReverb.clear();
    this.assetRegistry = null;
    this.registryClock.advance();
    this.projectSearchIndex?.clear();
    this.projectSearchIndex = null;
    this.pluginDescriptors = [];
    this.pluginDiagnostics = [];
    this.pluginOverrides = {};
  }

  /** Compatibility wrapper for display-name-only callers. */
  async renameListedProjectDisplayName(
    handle: ProjectFolderHandle,
    displayName: string,
  ): Promise<void> {
    return this.updateListedProject(handle, { name: displayName });
  }

  /** Persist browser identity without changing the project folder or its assets. */
  async updateListedProject(
    handle: ProjectFolderHandle,
    details: UpdateListedProjectOptions,
  ): Promise<void> {
    const name = details.name.trim();
    if (!name) return;
    await this.storage.openKnownFolder(handle);
    try {
      if (!(await this.storage.exists(PROJECT_FILE))) {
        throw new Error("The project could not be found.");
      }
      const raw = JSON.parse(await this.storage.readText(PROJECT_FILE)) as {
        name?: string;
        metadata?: Partial<ProjectMetadata>;
      };
      raw.metadata ??= createEmptyProject(name).metadata;
      raw.metadata.name = name;
      raw.metadata.updatedAt = new Date().toISOString();
      if (typeof raw.name === "string") raw.name = name;
      if (details.appearance !== undefined) {
        raw.metadata.appearance = normalizeProjectAppearance(details.appearance);
      }
      await this.storage.writeText(PROJECT_FILE, JSON.stringify(raw, null, 2));
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

    this.migrationPending = [];
    this.migrateOnSaveApproved = false;
    this.assetGuids.clear();
    this.sceneAudioReverb.clear();
    this.sessionEncodes.clear();

    const hasProject = await this.storage.exists(PROJECT_FILE);
    if (!hasProject) {
      return this.scaffoldNewProject(folder.name);
    }

    const raw = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as ProjectDocument & { guid?: string; kind?: string; version?: number };
    const document = normalizeProjectDocument(raw, folder.name);
    this.projectGuid = raw.guid ?? newGuid();
    this.loadedTextureSettings = document.settings.textures;
    this.sourceControlEnabled = document.settings.sourceControl?.enabled === true;
    this.pluginOverrides = document.settings.pluginOverrides ?? {};

    // Project manifest schema migration (type Project).
    const projectVersion =
      typeof raw.version === "number"
        ? raw.version
        : this.migrations.currentVersion("Project");
    const migrated = loadPayloadWithMigration(this.migrations, {
      type: "Project",
      version: projectVersion,
      payload: raw as unknown as Record<string, unknown>,
      path: PROJECT_FILE,
    });
    if (migrated.pending) {
      this.migrationPending.push(migrated.pending);
    }

    const withDocuments = await this.ensureDocuments(document);
    const scenePayloads: SerializedScene[] = [];
    if (!withDocuments.settings.gameInstanceClass) {
      for (const path of withDocuments.scenes) {
        try {
          const loaded = await this.loadDocument("scene", path);
          if (loaded && typeof loaded === "object" && "settings" in loaded) {
            scenePayloads.push(loaded as SerializedScene);
          }
        } catch {
          /* unreadable scene */
        }
      }
    }
    const settings = migrateGameInstanceClassFromScenes(
      withDocuments.settings,
      scenePayloads,
    );
    const migratedDocument =
      settings === withDocuments.settings
        ? withDocuments
        : { ...withDocuments, settings };
    const layouts = await this.loadLayouts(
      documentId({
        kind: "scene",
        path: migratedDocument.scenes[0] ?? MAIN_SCENE_FILE,
      }),
    );

    return {
      document: migratedDocument,
      layouts,
      migrationPending: this.pendingMigrations,
    };
  }

  /**
   * Reconcile the manifest's document list with the asset registry (header-only
   * index). Legacy `.json` scene/graph files still participate via a thin
   * fallback so pre-container projects keep opening.
   */
  private async ensureDocuments(
    document: ProjectDocument,
  ): Promise<ProjectDocument> {
    await this.mountAssetRegistry();
    const found = this.assetRegistry!.listDocumentPaths({ rootId: "project" });
    const legacy = await this.discoverLegacyJsonDocuments();
    const scenes = uniquePaths([
      ...found.scenes,
      ...legacy.scenes,
      ...(found.scenes.length || legacy.scenes.length
        ? []
        : await this.keepExisting(document.scenes)),
    ]);
    const graphs = uniquePaths([
      ...found.graphs,
      ...legacy.graphs,
      ...(found.graphs.length || legacy.graphs.length
        ? []
        : await this.keepExisting(document.graphs)),
    ]);

    if (scenes.length && graphs.length) {
      return { ...document, scenes, graphs };
    }

    if (!scenes.length) {
      await this.saveDocument("scene", MAIN_SCENE_FILE, createDefaultScene());
      scenes.push(MAIN_SCENE_FILE);
    }
    if (!graphs.length) {
      if (await this.storage.exists(MAIN_GRAPH_FILE)) {
        graphs.push(MAIN_GRAPH_FILE);
      } else {
        await this.saveDocument(
          "graph",
          MAIN_CLASS_FILE,
          createDefaultLogicGraphSerialized(),
        );
        graphs.push(MAIN_CLASS_FILE);
      }
    }
    await this.mountAssetRegistry();
    return { ...document, scenes, graphs };
  }

  private loadedTextureSettings: {
    autoRequeueUncompressed: boolean;
    maxTextureDimension: number;
  } | null = null;

  private async mountAssetRegistry(): Promise<AssetRegistry> {
    const maxDimension =
      this.loadedTextureSettings?.maxTextureDimension ??
      DEFAULT_TEXTURE_ENCODE_SETTINGS.maxDimension;
    const registry = new AssetRegistry(this.storage, {
      blobs: this.blobs,
      legacyAtlasCache: this.legacyAtlasCache,
      alignmentRequeues: this.alignmentRequeues,
      generationClock: this.registryClock,
    });
    registry.setEncodePipeline(this.encodeQueue, {
      ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
      maxDimension,
    });
    registry.setOwnWriteListener((write) => {
      for (const listener of this.ownWriteListeners) listener(write);
    });
    // A file this session creates is its own new work, not one teammates share.
    registry.setCreatedTextureListener(({ header }) => {
      const committed = committedKtx2Sha256(header);
      if (committed) this.sessionEncodes.set(header.guid, committed);
    });
    await registry.mountRoot(projectContentRoot());
    this.assetRegistry = registry;
    await this.syncPlugins();
    this.projectSearchIndex = new ProjectSearchIndex(this.storage, {
      blobs: this.blobs,
      catalogClassIds: SEARCH_CATALOG_CLASS_IDS,
      nodeTitles: SEARCH_NODE_TITLES,
    });
    this.bindThumbnailWriter();
    // Every encode pads by atlas status, so legacy Tilesets, Sprites and
    // Sprite Animations must be decoded before anything is queued.
    await registry.resolveLegacyAtlasReferrers();
    const auto = this.loadedTextureSettings?.autoRequeueUncompressed ?? true;
    if (auto) {
      await registry.requeueUncompressedTextures();
    }
    registry.setAtlasStatusListener((guids) => {
      void this.reconcileTextureAlignment(guids);
    });
    // Open and every remount recheck what is on disk now (nothing while
    // source control is on).
    void this.reconcileTextureAlignment();
    return registry;
  }

  async syncPlugins(): Promise<void> {
    const registry = this.assetRegistry;
    if (!registry) return;
    const projectPlugins = await discoverProjectPlugins(this.storage);
    const enginePlugins = this.enginePluginStorage
      ? await discoverEnginePlugins(this.enginePluginStorage)
      : [];
    this.pluginDescriptors = shadowEnginePlugins(
      projectPlugins,
      enginePlugins,
    );
    const enabledGuids = new Set(
      this.pluginDescriptors
        .filter((plugin) =>
          resolvePluginEnabled(
            plugin.settings.enabledByDefault,
            this.pluginOverrides[plugin.pluginGuid]?.enabled,
          ),
        )
        .map((plugin) => plugin.pluginGuid),
    );
    for (const plugin of this.pluginDescriptors) {
      const rootId = pluginRootId(plugin.pluginGuid);
      if (!enabledGuids.has(plugin.pluginGuid) && registry.getRoot(rootId)) {
        registry.unmountRoot(rootId);
      }
    }
    await mountEnabledPlugins(registry, this.pluginDescriptors, {
      enabledGuids,
      overrides: this.pluginOverrides,
      storageFor: (plugin) =>
        plugin.source === "engine"
          ? (this.enginePluginStorage ?? undefined)
          : undefined,
    });
    const { diagnostics } = resolvePluginGraph(
      this.pluginDescriptors.filter((plugin) => enabledGuids.has(plugin.pluginGuid)),
      undefined,
      this.pluginOverrides,
    );
    this.pluginDiagnostics = diagnostics;
    const discoveredGuids = new Set(
      this.pluginDescriptors.map((plugin) => plugin.pluginGuid),
    );
    indexUnresolvedPlaceholders(registry, {
      expectedGuids: Object.keys(this.pluginOverrides).filter(
        (guid) => !discoveredGuids.has(guid),
      ),
    });
  }

  async applyPluginOverrides(
    overrides: Record<string, PluginEnableOverride>,
  ): Promise<void> {
    this.pluginOverrides = overrides;
    await this.syncPlugins();
    this.emitRegistryChange();
  }

  async createProjectPlugin(displayName: string): Promise<PluginDescriptor> {
    const name = displayName.trim() || "Plugin";
    const existing = await discoverProjectPlugins(this.storage);
    const folderName = uniquePluginFolderName(
      name,
      existing.map((plugin) => plugin.folderName),
    );
    const settings = createDefaultPluginSettings({
      pluginGuid: newGuid(),
      displayName: name,
    });
    const descriptor = await writeProjectPlugin(
      this.storage,
      folderName,
      settings,
    );
    await this.syncPlugins();
    this.emitRegistryChange();
    return descriptor;
  }

  async deleteProjectPlugin(guid: string): Promise<void> {
    const plugin = this.pluginDescriptors.find(
      (entry) => entry.pluginGuid === guid,
    );
    if (!plugin) return;
    if (plugin.source === "engine") {
      throw new Error("Engine plugins cannot be deleted from the project");
    }
    this.assetRegistry?.unmountRoot(pluginRootId(guid));
    await this.storage.remove(plugin.folderPath);
    const next = { ...this.pluginOverrides };
    delete next[guid];
    this.pluginOverrides = next;
    await this.syncPlugins();
    this.emitRegistryChange();
  }

  async exportPlugin(guid: string): Promise<Uint8Array> {
    const plugin = this.pluginDescriptors.find(
      (entry) => entry.pluginGuid === guid,
    );
    if (!plugin) {
      throw new Error(`Unknown plugin ${guid}`);
    }
    const storage =
      plugin.source === "engine"
        ? this.enginePluginStorage
        : this.storage;
    if (!storage) {
      throw new Error("Plugin storage is not available");
    }
    return exportPluginZip(storage, plugin);
  }

  async importPlugin(
    bytes: Uint8Array,
    decision?: "keep" | "replace",
  ): Promise<PluginImportResult> {
    const incoming = await inspectBabplugin(bytes);
    const occupiedGuids = new Set<string>([
      ...this.pluginDescriptors.map((plugin) => plugin.pluginGuid),
      ...(this.assetRegistry?.list().map((asset) => asset.header.guid) ?? []),
    ]);
    const plan = planPluginImport({
      incoming,
      existingPlugins: this.pluginDescriptors,
      occupiedGuids,
      existingFolderNames: this.pluginDescriptors.map(
        (plugin) => plugin.folderName,
      ),
    });
    if (plan.kind === "conflict") {
      if (decision === "keep") return { status: "kept" };
      if (decision !== "replace") {
        return { status: "conflict", incoming, plan };
      }
      await applyPluginImport(this.storage, incoming, {
        ...plan,
        replace: true,
      });
    } else {
      await applyPluginImport(this.storage, incoming, plan);
    }
    await this.syncPlugins();
    this.emitRegistryChange();
    const guid =
      plan.kind === "remap-plugin" ? plan.nextGuid : incoming.settings.pluginGuid;
    const descriptor = this.pluginDescriptors.find(
      (plugin) => plugin.pluginGuid === guid,
    );
    if (!descriptor) {
      throw new Error("Plugin import did not produce a descriptor");
    }
    return { status: "imported", descriptor };
  }

  private pluginForPath(path: string): PluginDescriptor | undefined {
    return this.pluginDescriptors.find(
      (entry) =>
        path === entry.settingsPath ||
        path.startsWith(`${entry.folderPath}/`),
    );
  }

  private storageForPath(path: string): ProjectStorage {
    if (isTracePath(path)) {
      if (!this.derivedStorage) {
        throw new Error("Derived storage is not available for traces");
      }
      return this.derivedStorage;
    }
    const indexed = this.assetRegistry
      ?.list()
      .find((asset) => asset.path === path);
    if (indexed && this.assetRegistry) {
      return this.assetRegistry.storageFor(indexed.rootId);
    }
    const plugin = this.pluginForPath(path);
    if (plugin?.source === "engine" && this.enginePluginStorage) {
      return this.enginePluginStorage;
    }
    return this.storage;
  }

  private blobsForPath(path: string): BlobStore {
    const indexed = this.assetRegistry
      ?.list()
      .find((asset) => asset.path === path);
    if (indexed && this.assetRegistry) {
      return this.assetRegistry.blobsFor(indexed.rootId);
    }
    const storage = this.storageForPath(path);
    const plugin = this.pluginForPath(path);
    if (plugin) return createVfsBlobStore(storage, `${plugin.contentPath}/.blobs`);
    return storage === this.storage ? this.blobs : createVfsBlobStore(storage);
  }

  /** Re-scan project assets after registry file operations (import, create, delete). */
  async remountRegistry(): Promise<AssetRegistry> {
    const registry = await this.mountAssetRegistry();
    if (!this.transcoderAvailable) {
      await this.markCompressedTexturesFallback();
    }
    return registry;
  }

  /** Validate all referrers before writing replacements; never delete a Class here. */
  async replaceClassReferencesBeforeDelete(
    replacements: readonly ClassAssetReplacement[],
    deletingGuids: ReadonlySet<string>,
    onProgress?: (path: string) => Promise<void>,
  ): Promise<void> {
    const registry = this.assetRegistry;
    if (!registry) throw new Error("The asset registry is unavailable.");
    const assets = registry.list();
    validateClassDeletionReplacements(replacements, assets, deletingGuids);
    const plans: Array<{
      kind: Exclude<DocumentKind, "content-browser">;
      path: string;
      content: Awaited<ReturnType<ProjectService["loadDocument"]>>;
      parentClass: string | null;
    }> = [];
    for (const asset of assets) {
      if (deletingGuids.has(asset.header.guid)) continue;
      const kind = documentKindForAssetType(asset.header.type);
      if (!kind || kind === "trace") continue;
      await onProgress?.(asset.path);
      const content = await this.loadDocument(kind, asset.path);
      const walked = replaceClassAssetReferences(content, replacements);
      const header = replaceClassAssetReferences({
        parentClass: asset.header.parentClass ?? null,
        dependencies: asset.header.dependencies,
      }, replacements);
      if (!walked.changed && !header.changed) continue;
      if (registry.getRoot(asset.rootId)?.readOnly || isPluginDocumentReadOnly(this.pluginDescriptors, asset.path)) {
        throw new Error(`${asset.path} is read-only and still references a selected Class.`);
      }
      plans.push({ kind, path: asset.path, content: walked.value, parentClass: header.value.parentClass });
    }
    for (const plan of plans) {
      await onProgress?.(plan.path);
      await this.saveDocument(plan.kind, plan.path, plan.content, { parentClass: plan.parentClass });
    }
  }

  /**
   * Set remaining writable assets' references to deleted guids to None.
   * Does not delete files — call after `deleteAsset` / `deleteFolder`.
   */
  async clearDeletedAssetReferences(
    deletedGuids: ReadonlySet<string>,
    options: {
      deletedClassNames?: ReadonlySet<string>;
      onProgress?: (path: string) => Promise<void>;
    } = {},
  ): Promise<void> {
    const registry = this.assetRegistry;
    const deletedClassNames = options.deletedClassNames ?? new Set();
    if (!registry) return;
    if (deletedGuids.size === 0 && deletedClassNames.size === 0) return;

    for (const asset of registry.list()) {
      if (deletedGuids.has(asset.header.guid)) continue;
      const root = registry.getRoot(asset.rootId);
      if (root?.readOnly) continue;
      if (isPluginDocumentReadOnly(this.pluginDescriptors, asset.path)) continue;
      const kind = documentKindForAssetType(asset.header.type);
      if (!kind) continue;

      await options.onProgress?.(asset.path);

      let content:
        | SerializedScene
        | SerializedSceneLayer
        | SerializedGraph
        | Record<string, unknown>;
      try {
        content = await this.loadDocument(kind, asset.path);
      } catch {
        continue;
      }
      const walked = clearDeletedAssetRefs(
        content,
        deletedGuids,
        deletedClassNames,
      );
      const isClass =
        asset.header.type === "Class" || asset.header.type === "Graph";
      const nextParent = isClass
        ? fallbackParentClass(asset.header.parentClass, deletedClassNames)
        : undefined;
      const parentChanged =
        nextParent !== undefined &&
        nextParent !== (asset.header.parentClass ?? null);
      if (!walked.changed && !parentChanged) continue;
      try {
        await this.saveDocument(
          kind,
          asset.path,
          walked.value,
          parentChanged ? { parentClass: nextParent } : undefined,
        );
      } catch {
        /* read-only or unreadable referrer — leave on disk */
      }
    }
  }

  private async keepExisting(paths: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const path of paths) {
      if (await this.storage.exists(path)) kept.push(path);
    }
    return kept;
  }

  /** Pre-container `.json` documents that the registry does not index. */
  private async discoverLegacyJsonDocuments(): Promise<{
    scenes: string[];
    graphs: string[];
  }> {
    const scenes: string[] = [];
    const graphs: string[] = [];

    for (const dir of ["assets", "scenes", "graphs"]) {
      let entries;
      try {
        entries = await this.storage.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDir) continue;
        const path = `${dir}/${entry.name}`;
        if (/\.scene\.json$/.test(entry.name)) scenes.push(path);
        if (/\.graph\.json$/.test(entry.name)) graphs.push(path);
      }
    }
    return { scenes: scenes.sort(), graphs: graphs.sort() };
  }

  private async scaffoldNewProject(
    name: string,
    kind: "blank" | "empty" | "2d" = "empty",
    renderOptions?: {
      renderWidth?: number;
      renderHeight?: number;
      blackBars?: boolean;
      appearance?: ProjectAppearance;
    },
  ): Promise<ProjectLoadResult> {
    const render: Partial<RenderProjectSettings> | undefined = renderOptions
      ? {
          customResolution: true,
          width: renderOptions.renderWidth,
          height: renderOptions.renderHeight,
          blackBars: renderOptions.blackBars,
        }
      : undefined;
    const document = createEmptyProject(name, {
      kind: kind === "blank" ? "empty" : kind,
      render,
    });
    const appearance = normalizeProjectAppearance(renderOptions?.appearance);
    if (appearance) document.metadata.appearance = appearance;
    this.projectGuid = newGuid();
    this.loadedTextureSettings = document.settings.textures;
    this.sourceControlEnabled = document.settings.sourceControl?.enabled === true;
    this.pluginOverrides = document.settings.pluginOverrides ?? {};
    const graph = createDefaultLogicGraphSerialized();
    const scene = createDefaultScene(kind === "2d" ? "2d" : "3d");
    if (kind === "blank") {
      scene.actors = [];
      scene.settings.mainCameraActorId = null;
      scene.settings.mainCameraComponentId = null;
    }
    await this.storage.mkdir("assets/.blobs", true);
    await this.storage.mkdir("plugins", true);
    await this.saveDocument("scene", MAIN_SCENE_FILE, scene);
    if (kind === "2d") {
      await this.saveDocument("graph", MAIN_CLASS_FILE, graph);
    } else {
      document.graphs = [];
    }
    document.settings.input = { actions: [], axes: [] };
    document.settings.startupSceneGuid = await this.guidForAsset(MAIN_SCENE_FILE);
    await this.saveProject(document, createEmptyLayouts());
    const stored = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as Record<string, unknown>;
    stored.guid = this.projectGuid;
    stored.kind = "project";
    stored.version = this.migrations.currentVersion("Project");
    await this.storage.writeText(PROJECT_FILE, JSON.stringify(stored, null, 2));
    await this.installEnginePluginDefaultsIfNeeded();
    await this.mountAssetRegistry();
    if (kind === "empty") {
      await this.createInputAssets();
      await this.scaffoldKenneyMannequinEmpty(document);
    }
    return {
      document,
      layouts: createEmptyLayouts(),
      migrationPending: [],
    };
  }

  private async createInputAssets(): Promise<void> {
    await this.storage.mkdir("assets/Input", true);
    for (const { type, name, ...payload } of createDefaultInputAssets()) {
      const path = `assets/Input/${newAssetFileName(type, name)}`;
      await this.saveDocument(type === "InputAction" ? "input-action" : "input-axis", path, payload);
    }
  }

  private async scaffoldKenneyMannequinEmpty(
    document: ProjectDocument,
  ): Promise<void> {
    const registry = this.assetRegistry;
    if (!registry) {
      throw new Error("Asset registry is not mounted.");
    }
    const scene = (await this.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const engineSettings = await createAppSettingsStore().load();
    const next = await applyKenneyMannequinEmptyScaffold({
      registry,
      scene,
      mannequinBytes: await loadKenneyMannequinGlb(),
      modelImportScale: engineSettings.modelImportDefaultScale,
    });
    await this.saveDocument("scene", MAIN_SCENE_FILE, next);
    if (await this.storage.exists(MAIN_CLASS_FILE)) {
      await this.storage.remove(MAIN_CLASS_FILE);
    }
    const classPath = `assets/${MANNEQUIN_CLASS_FILE}`;
    document.graphs = [classPath];
    await this.saveProject(document, createEmptyLayouts());
  }

  async loadDocument(
    kind: Exclude<DocumentKind, "content-browser">,
    path: string,
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
    const fallbackType = isAssetDocumentKind(kind)
      ? assetTypeForDocumentKind(kind)
      : "Class";
    const raw = isAssetDocumentPath(path)
      ? await this.readAssetDocument(path, fallbackType)
      : await this.readLegacyJsonDocument(path, fallbackType);

    const migrated = loadPayloadWithMigration(this.migrations, {
      type: raw.type,
      version: raw.version,
      payload: raw.payload,
      path,
    });
    if (migrated.pending) {
      // Loading an unmigrated asset again keeps one entry for its path.
      const existing = this.migrationPending.findIndex((entry) => entry.path === path);
      if (existing === -1) this.migrationPending.push(migrated.pending);
      else this.migrationPending[existing] = migrated.pending;
    }
    // PluginSettings.version is an author label, separate from the asset header schema version.
    if (raw.type === "PluginSettings") return migrated.payload;
    const { version: _v, ...content } = migrated.payload as Record<
      string,
      unknown
    > & { version?: number };
    void _v;
    if (kind === "data-object") return { ...normalizeDataObjectAsset(content) };
    if (kind === "data-sheet") return { ...normalizeDataSheetAsset(content) };
    if (kind === "scene") {
      return normalizeScene(content);
    }
    if (kind === "scene-layer") {
      return normalizeSceneLayer(content);
    }
    if (kind === "graph") {
      return hydrateClassDocumentPayload(
        content as unknown as Record<string, unknown>,
      );
    }
    return content;
  }

  private async readAssetDocument(
    path: string,
    fallbackType: string,
  ): Promise<{ type: string; version: number; payload: Record<string, unknown> }> {
    const decoded = await decodeAssetDocument(
      await this.storageForPath(path).readBinary(path),
      { blobs: this.blobsForPath(path) },
    );
    this.assetGuids.set(path, decoded.guid);
    return {
      type: decoded.type || fallbackType,
      version: decoded.version,
      payload: decoded.payload,
    };
  }

  /** Projects authored before assets moved to .babasset still load from JSON. */
  private async readLegacyJsonDocument(
    path: string,
    type: string,
  ): Promise<{ type: string; version: number; payload: Record<string, unknown> }> {
    const raw = JSON.parse(await this.storage.readText(path)) as Record<
      string,
      unknown
    > & { version?: number };
    return {
      type,
      version:
        typeof raw.version === "number"
          ? raw.version
          : this.migrations.currentVersion(type),
      payload: raw,
    };
  }

  async saveDocument(
    kind: Exclude<DocumentKind, "content-browser">,
    path: string,
    content:
      | SerializedScene
      | SerializedSceneLayer
      | SerializedGraph
      | Record<string, unknown>,
    options?: { parentClass?: string | null },
  ): Promise<void> {
    return this.withDocumentWrite(path, (currentPath) => this.saveDocumentUnlocked(kind, currentPath, content, options));
  }

  /** Resolve a queued write's location after earlier moves/deletions finish. */
  private async withDocumentWrite<T>(path: string, write: (currentPath: string) => Promise<T>): Promise<T> {
    const registry = this.assetRegistry;
    const asset = registry?.getByPath(path);
    if (!asset) return write(path);
    return registry!.withAssetWrite(asset.header.guid, () => {
      const current = registry!.getByGuid(asset.header.guid);
      if (this.assetRegistry !== registry || !current) {
        throw new Error("The asset was closed or deleted before it could be saved");
      }
      return write(current.path);
    });
  }

  private async saveDocumentUnlocked(
    kind: Exclude<DocumentKind, "content-browser">,
    path: string,
    content: SerializedScene | SerializedSceneLayer | SerializedGraph | Record<string, unknown>,
    options?: { parentClass?: string | null },
  ): Promise<void> {
    if (kind === "trace" || isTracePath(path)) {
      throw new Error("Trace documents are read-only");
    }
    if (kind === "material" || kind === "material-function") {
      const graph = kind === "material" ? normalizeMaterialDocument(content) : normalizeMaterialFunctionDocument(content);
      const diagnostic = validateMaterialParameterNames(graph)[0];
      if (diagnostic) throw new Error(diagnostic.message);
    }
    if (this.migrationPending.some((p) => p.path === path) && !this.migrateOnSaveApproved) {
      throw new Error(
        "Asset schema migration requires user approval before save",
      );
    }
    const storage = this.storageForPath(path);
    const blobs = this.blobsForPath(path);
    if (isPluginDocumentReadOnly(this.pluginDescriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const dir = parentDir(path);
    if (dir) {
      await storage.mkdir(dir, true);
    }
    const existing = isAssetDocumentPath(path)
      ? await this.readExistingAssetMeta(path)
      : null;
    const type =
      kind === "asset-settings" && existing?.type
        ? existing.type
        : isAssetDocumentKind(kind)
          ? assetTypeForDocumentSave(kind, existing?.type)
          : "Class";
    const ownerPlugin = this.pluginForPath(path);
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
            ? this.pluginDescriptors.find((entry) => entry.pluginGuid === dependency.guid)?.settings.version ?? dependency.version
            : ownerPlugin.settings.pluginDependencies.find((entry) => entry.guid === dependency.guid)?.version ?? dependency.version,
        })),
      };
    }
    if (isInputAssetType(type)) content = normalizeInputAssetPayload(type, content) as unknown as Record<string, unknown>;
    if (type === "DataObject") content = { ...normalizeDataObjectAsset(content) };
    if (type === "DataSheet") content = { ...normalizeDataSheetAsset(content) };
    const version = this.migrations.currentVersion(type);
    const parentClass =
      options?.parentClass !== undefined
        ? options.parentClass
        : existing?.parentClass ?? (type === "Class" ? "Actor" : null);
    const storeInHeader =
      (kind === "asset-settings" ||
        kind === "texture" ||
        kind === "model" ||
        kind === "skeleton" ||
        kind === "animation") &&
      existing !== null &&
      !existing.hasDocumentChunk;
    if (storeInHeader && existing && type === "Texture") {
      content = withSavedTextureEncodeState(content as Record<string, unknown>, existing.payload);
    }

    if (isAssetDocumentPath(path)) {
      const guid = await this.guidForAsset(path);
      const extraChunks = type === "Scene"
        ? await this.sceneExtraChunksForWrite(path, content as SerializedScene, guid)
        : await this.extraChunksFor(path);
      const bytes = await encodeAssetDocument(
        {
          type,
          name:
            type === "PluginSettings" &&
            typeof (content as { displayName?: unknown }).displayName ===
              "string" &&
            (content as { displayName: string }).displayName.trim() !== ""
              ? (content as { displayName: string }).displayName.trim()
              : (isInputAssetType(type) || type === "DataObject" || type === "DataSheet") && existing?.name
                ? existing.name
                : assetName(path),
          guid,
          version,
          payload: content as unknown as Record<string, unknown>,
        },
        {
          blobs,
          extraChunks,
          parentClass,
          headerPayload: storeInHeader
            ? (content as unknown as Record<string, unknown>)
            : undefined,
          headerMeta: headerMetaForSave(type, content),
          dependencies: assetHeaderDependencies(
            type,
            content as unknown as Record<string, unknown>,
            this.assetRegistry?.list(),
            parentClass,
          ),
        },
      );
      await storage.writeBinary(path, bytes);
      await this.assetRegistry?.reindexPath(path);
    } else {
      await storage.writeText(
        path,
        JSON.stringify({ ...content, version }, null, 2),
      );
    }
    this.migrationPending = this.migrationPending.filter((p) => p.path !== path);
    if (pluginContentChanged && ownerPlugin) {
      const document = await decodeAssetDocument(await storage.readBinary(ownerPlugin.settingsPath));
      const settings = normalizePluginSettings(document.payload, { pluginGuid: ownerPlugin.pluginGuid });
      await storage.writeBinary(ownerPlugin.settingsPath, await encodePluginSettingsDocument({
        ...settings,
        engineVersion: ENGINE_VERSION,
        pluginDependencies: settings.pluginDependencies.map((dependency) => ({
          ...dependency,
          version: this.pluginDescriptors.find((plugin) => plugin.pluginGuid === dependency.guid)?.settings.version ?? dependency.version,
        })),
      }));
    }
    if (type === "PluginSettings" || pluginContentChanged) {
      await this.syncPlugins();
      this.emitRegistryChange();
    }
  }

  /** Binary chunk (font source, pixels, …) without decoding the document JSON. */
  async readAssetChunk(
    path: string,
    chunkId: string,
  ): Promise<Uint8Array | null> {
    const storage = this.storageForPath(path);
    const blobs = this.blobsForPath(path);
    if (!(await storage.exists(path))) return null;
    const decoded = await decodeBabasset(
      await storage.readBinary(path),
      (hash) => blobs.readBlob(hash),
    );
    return decoded.chunks.get(chunkId) ?? null;
  }

  /** Every Scene payload write must keep only probes matching that geometry. */
  private async sceneExtraChunksForWrite(
    path: string,
    payload: SerializedScene | Record<string, unknown>,
    guid: string,
  ): Promise<ChunkInput[]> {
    const extra = await this.extraChunksFor(path);
    const fingerprint = staticAudioGeometryFingerprint(payload as SerializedScene);
    const baked = this.sceneAudioReverb.get(guid);
    if (baked?.fingerprint === fingerprint) return extraChunksWithAudioReverb(extra, baked.bytes);
    if (extra.some((chunk) => chunk.id === AUDIO_REVERB_CHUNK_ID)) {
      const saved = await this.readAssetDocument(path, "Scene");
      if (staticAudioGeometryFingerprint(normalizeScene(saved.payload)) !== fingerprint) {
        return extra.filter((chunk) => chunk.id !== AUDIO_REVERB_CHUNK_ID);
      }
    }
    return extra;
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
    if (isPluginDocumentReadOnly(this.pluginDescriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const storage = this.storageForPath(path);
    const guid = await this.guidForAsset(path);
    const extra = extraChunksWithNavmesh(await this.sceneExtraChunksForWrite(path, payload, guid), bytes);
    const existing = await this.readExistingAssetMeta(path);
    const type = existing?.type ?? "Scene";
    const encoded = await encodeAssetDocument(
      {
        type,
        name: assetName(path),
        guid,
        version: this.migrations.currentVersion(type),
        payload,
      },
      {
        blobs: this.blobsForPath(path),
        extraChunks: extra,
        parentClass: existing?.parentClass ?? null,
        dependencies: assetHeaderDependencies(type, payload, this.assetRegistry?.list()),
      },
    );
    await storage.writeBinary(path, encoded);
    await this.assetRegistry?.reindexPath(path);
  }

  /** Update only derived bytes; unsaved geometry waits for an explicit Scene save. */
  async writeSceneAudioReverbChunk(
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (isPluginDocumentReadOnly(this.pluginDescriptors, path)) {
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
      const decoded = await decodeBabasset(await storage.readBinary(currentPath), (hash) => blobs.readBlob(hash));
      const body = decoded.chunks.get(DOCUMENT_CHUNK_ID);
      const persisted = body ? JSON.parse(new TextDecoder().decode(body)) : decoded.header.payload;
      if (decoded.header.type !== "Scene") throw new Error("Audio reverb requires a Scene asset");
      this.sceneAudioReverb.set(decoded.header.guid, baked);
      if (staticAudioGeometryFingerprint(normalizeScene(persisted)) !== baked.fingerprint) return;
      // Re-encode the persisted container under the same queue as Save. Preserve
      // authored JSON, schema/header metadata, dependencies, and every other chunk.
      const chunks = decoded.header.chunks.map((entry) => ({
        id: entry.id, kind: entry.kind, mime: entry.mime, data: decoded.chunks.get(entry.id)!,
      }));
      const encoded = await encodeBabasset({
        header: decoded.header,
        chunks: extraChunksWithAudioReverb(chunks, baked.bytes),
        writeBlob: (hash, data) => blobs.writeBlob(hash, data),
      });
      await storage.writeBinary(currentPath, encoded);
      await registry?.reindexPath(currentPath);
    };
    if (asset) await registry!.withAssetWrite(asset.header.guid, write);
    else await write();
  }

  /** Add or replace an imported Audio clip chunk (`source` / `source:N`). */
  async writeAudioClipChunk(
    path: string,
    chunkId: string,
    bytes: Uint8Array,
    mime: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const extra = extraChunksWithAudioClip(await this.extraChunksFor(path), {
      id: chunkId,
      bytes,
      mime,
    });
    await this.writeAssetDocumentWithExtra(path, payload, extra);
  }

  /** Drop an extra Audio clip chunk. Never deletes the last `source`. */
  async removeAudioClipChunk(
    path: string,
    chunkId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const extra = extraChunksWithoutAudioClip(
      await this.extraChunksFor(path),
      chunkId,
    );
    await this.writeAssetDocumentWithExtra(path, payload, extra);
  }

  private async writeAssetDocumentWithExtra(
    path: string,
    payload: Record<string, unknown>,
    extra: Array<{ id: string; kind: string; mime: string; data: Uint8Array }>,
  ): Promise<void> {
    if (isPluginDocumentReadOnly(this.pluginDescriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const storage = this.storageForPath(path);
    const existing = await this.readExistingAssetMeta(path);
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
        extraChunks: extra,
        parentClass: existing?.parentClass ?? null,
        headerPayload: storeInHeader ? payload : undefined,
        headerMeta: headerMetaForSave(type, payload),
        dependencies: assetHeaderDependencies(type, payload, this.assetRegistry?.list(), existing?.parentClass),
      },
    );
    await storage.writeBinary(path, encoded);
    await this.assetRegistry?.reindexPath(path);
  }

  guidForPath(path: string): string | null {
    // The mounted registry owns identity after moves, deletions, and reindexing.
    // A former path must not lend its GUID to a new asset created there.
    if (this.assetRegistry) return this.assetRegistry.getByPath(path)?.header.guid ?? null;
    return this.assetGuids.get(path) ?? null;
  }

  private async readExistingAssetMeta(path: string): Promise<{
    type: string;
    name: string;
    parentClass: string | null;
    hasDocumentChunk: boolean;
    payload: Record<string, unknown>;
  } | null> {
    if (!(await this.storageForPath(path).exists(path))) return null;
    try {
      const header = readAssetDocumentHeader(
        await this.storageForPath(path).readBinary(path),
      );
      return {
        type: header.type,
        name: header.name,
        parentClass: header.parentClass ?? null,
        hasDocumentChunk: header.chunks.some(
          (chunk) => chunk.id === DOCUMENT_CHUNK_ID,
        ),
        payload: header.payload,
      };
    } catch {
      return null;
    }
  }

  private async extraChunksFor(path: string) {
    const storage = this.storageForPath(path);
    const blobs = this.blobsForPath(path);
    if (!(await storage.exists(path))) return [];
    try {
      const decoded = await decodeBabasset(
        await storage.readBinary(path),
        (hash) => blobs.readBlob(hash),
      );
      return extraChunksFromDecoded(decoded);
    } catch {
      return [];
    }
  }

  private async guidForAsset(path: string): Promise<string> {
    const indexed = this.assetRegistry?.getByPath(path);
    if (indexed) return indexed.header.guid;
    const storage = this.storageForPath(path);
    if (await storage.exists(path)) {
      try {
        const header = readAssetDocumentHeader(
          await storage.readBinary(path),
        );
        this.assetGuids.set(path, header.guid);
        return header.guid;
      } catch {
        /* unreadable asset: fall through to a fresh guid */
      }
    }
    const guid = newGuid();
    this.assetGuids.set(path, guid);
    return guid;
  }

  async saveProject(
    document: ProjectDocument,
    layouts: ProjectLayouts,
  ): Promise<void> {
    if (
      this.migrationPending.some((p) => p.path === PROJECT_FILE) &&
      !this.migrateOnSaveApproved
    ) {
      throw new Error(
        "Asset schema migration requires user approval before save",
      );
    }
    const now = new Date().toISOString();
    const updated: ProjectDocument = {
      ...document,
      metadata: {
        ...document.metadata,
        updatedAt: now,
      },
    };

    const payload = {
      ...updated,
      guid: this.projectGuid ?? newGuid(),
      kind: "project",
      version: this.migrations.currentVersion("Project"),
    };
    this.projectGuid = payload.guid as string;

    await this.storage.writeText(PROJECT_FILE, JSON.stringify(payload, null, 2));
    await this.storage.writeText(
      LAYOUT_FILE,
      JSON.stringify(layouts, null, 2),
    );
    this.migrationPending = this.migrationPending.filter(
      (p) => p.path !== PROJECT_FILE,
    );
  }

  async loadLayouts(mainSceneId: string): Promise<ProjectLayouts> {
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
      return parsed as unknown as ProjectLayouts;
    }

    return migrateLegacyLayout(parsed, mainSceneId);
  }

  captureLayout(api: DockviewApi): Record<string, unknown> {
    return api.toJSON() as unknown as Record<string, unknown>;
  }

  restoreLayout(api: DockviewApi, layout: Record<string, unknown> | null): void {
    if (layout) {
      api.fromJSON(layout as never);
    }
  }
}

function normalizeProjectDocument(
  raw: ProjectDocument & { name?: string },
  fallbackName: string,
): ProjectDocument {
  if (raw.metadata && raw.settings && raw.scenes && raw.graphs) {
    return {
      ...raw,
      metadata: {
        ...raw.metadata,
        appearance: normalizeProjectAppearance(raw.metadata.appearance),
      },
      settings: normalizeProjectSettings(raw.settings),
    };
  }
  const document = createEmptyProject(
    typeof raw.name === "string" ? raw.name : fallbackName,
  );
  const appearance = normalizeProjectAppearance(raw.metadata?.appearance);
  if (appearance) document.metadata.appearance = appearance;
  return document;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}
