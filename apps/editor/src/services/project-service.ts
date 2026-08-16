import type { DockviewApi } from "dockview-react";
import type {
  DocumentKind,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import {
  assetTypeForDocumentKind,
  assetTypeForDocumentSave,
  createDefaultScene,
  createEmptyLayouts,
  createEmptyProject,
  normalizeProjectSettings,
  migrateGameInstanceClassFromScenes,
  normalizeScene,
  classHeaderMeta,
  documentId,
  isAssetDocumentKind,
  LAYOUT_FILE,
  MAIN_CLASS_FILE,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  migrateLegacyLayout,
  PROJECT_FILE,
  type ProjectDocument,
  type RenderProjectSettings,
} from "@babylonslate/core";
import type { ProjectFolderHandle, ProjectStorage } from "@babylonslate/core";
import {
  AssetRegistry,
  canUseWorkerEncode,
  createProjectFromTemplate,
  createVfsBlobStore,
  createWorkerEncodeFn,
  decodeAssetDocument,
  decodeBabasset,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  DOCUMENT_CHUNK_ID,
  EncodeQueue,
  encodeAssetDocument,
  extraChunksFromDecoded,
  exportProjectZip,
  isAssetDocumentPath,
  loadPayloadWithMigration,
  defaultRegistry,
  projectContentRoot,
  readAssetDocumentHeader,
  readProjectTree,
  writeThumbnail,
  ProjectSearchIndex,
  type BlobStore,
  type EncodeFn,
  type MigrationPending,
  type PluginDescriptor,
  type PluginDiagnostic,
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
  type InspectedBabplugin,
  type PluginImportPlan,
} from "@babylonslate/assets";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "@babylonslate/vfs";
import { extraChunksWithNavmesh } from "@babylonslate/navigation";
import {
  materialAssetDependencies,
  materialHeaderMeta,
} from "../lib/content-browser-helpers";
import {
  SEARCH_CATALOG_CLASS_IDS,
  SEARCH_NODE_TITLES,
} from "../lib/search-catalog";
import { uniquePluginFolderName, pluginRootId, isPluginDocumentReadOnly } from "../lib/plugin-ui";
import { createDefaultLogicGraphSerialized, hydrateClassDocumentPayload } from "./graph-validation";

function headerMetaForSave(
  type: string,
  content: SerializedScene | SerializedGraph | Record<string, unknown>,
): Record<string, unknown> | undefined {
  const materialMeta = materialHeaderMeta(
    type,
    content as Record<string, unknown>,
  );
  if (materialMeta) return materialMeta;
  if (type === "EditorUtilityInterface") {
    return {
      dockKind:
        typeof (content as { dockKind?: unknown }).dockKind === "string"
          ? (content as { dockKind: string }).dockKind
          : "scene",
    };
  }
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
  return undefined;
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

export class ProjectService {
  private readonly storage: ProjectStorage;
  private projectGuid: string | null = null;
  private migrationPending: MigrationPending[] = [];
  private migrateOnSaveApproved = false;
  private readonly migrations = defaultRegistry();
  private readonly blobs: BlobStore;
  private assetRegistry: AssetRegistry | null = null;
  private projectSearchIndex: ProjectSearchIndex | null = null;
  private readonly encodeQueue: EncodeQueue;
  private readonly workerEncode:
    | (EncodeFn & { dispose: () => void; recycleCount: () => number })
    | null;
  private visibilityBound = false;
  private transcoderAvailable = true;
  private derivedStorage: ProjectStorage | null = null;
  private enginePluginStorage: ProjectStorage | null = null;
  private pluginDescriptors: PluginDescriptor[] = [];
  private pluginDiagnostics: PluginDiagnostic[] = [];
  private pluginOverrides: Record<string, { enabled: boolean }> = {};
  /** Asset guids stay stable across saves so references survive a rewrite. */
  private readonly assetGuids = new Map<string, string>();
  private readonly registryListeners = new Set<() => void>();

  constructor(storage: ProjectStorage) {
    this.storage = storage;
    this.blobs = createVfsBlobStore(storage);
    this.workerEncode = canUseWorkerEncode()
      ? createWorkerEncodeFn({ workerUrl: "/basis/encode-worker.js" })
      : null;
    this.encodeQueue = new EncodeQueue({
      encode: this.workerEncode ?? undefined,
      onState: (guid, state) => {
        // `compressed` is written with the KTX2 chunk in onComplete.
        if (state === "compressed") return;
        void this.assetRegistry
          ?.setCompressionState(guid, state)
          .then(() => this.emitRegistryChange());
      },
      onComplete: async (result) => {
        await this.assetRegistry?.commitCompressedTexture(result);
        this.emitRegistryChange();
      },
      onError: (guid) => {
        void this.assetRegistry
          ?.setCompressionState(guid, "encode_failed")
          .then(() => this.emitRegistryChange());
      },
    });
    this.bindEncodeQueueVisibility();
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

  /** Pause encode jobs while Preview runs (engineplan §3.5). */
  pauseTextureEncodeQueue(): void {
    this.encodeQueue.pause();
  }

  resumeTextureEncodeQueue(): void {
    this.encodeQueue.resume();
  }

  async retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean },
  ): Promise<boolean> {
    return (
      (await this.assetRegistry?.retryTextureEncoding(guid, options)) ?? false
    );
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

  get plugins(): PluginDescriptor[] {
    return this.pluginDescriptors;
  }

  get pluginGraphDiagnostics(): PluginDiagnostic[] {
    return this.pluginDiagnostics;
  }

  setEnginePluginStorage(storage: ProjectStorage | null): void {
    this.enginePluginStorage = storage;
  }

  private async installEnginePluginDefaultsIfNeeded(): Promise<void> {
    if (!this.enginePluginStorage) return;
    await installEnginePluginDefaults(this.storage, this.enginePluginStorage);
  }

  setPluginOverrides(
    overrides: Record<string, { enabled: boolean }>,
  ): void {
    this.pluginOverrides = overrides;
  }

  get searchIndex(): ProjectSearchIndex | null {
    return this.projectSearchIndex;
  }

  indexOpenDocument(
    path: string,
    content: SerializedScene | SerializedGraph | Record<string, unknown>,
  ): void {
    const indexed = this.assetRegistry?.list().find((asset) => asset.path === path);
    if (!indexed || !this.projectSearchIndex) return;
    this.projectSearchIndex.upsertDocument(
      indexed,
      content as unknown as Record<string, unknown>,
    );
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
    return this.storage.listProjects();
  }

  async openProject(): Promise<ProjectLoadResult> {
    await this.storage.pickProjectFolder();
    return this.loadCurrentProject();
  }

  async createEmptyProject(
    name?: string,
    options?: {
      pickFolder?: boolean;
      kind?: "empty" | "2d";
      renderWidth?: number;
      renderHeight?: number;
      blackBars?: boolean;
    },
  ): Promise<ProjectLoadResult> {
    const projectName =
      name && name.trim()
        ? name.endsWith(".babproject")
          ? name
          : `${name}.babproject`
        : isTestModeEnabled()
          ? TEST_PROJECT_NAME
          : "MyGame.babproject";
    if (options?.pickFolder) {
      await this.storage.pickProjectFolder();
      if (await this.storage.exists(PROJECT_FILE)) {
        return this.loadCurrentProject();
      }
      return this.scaffoldNewProject(projectName, options.kind, options);
    }
    await this.storage.openDocumentsProject(projectName);
    if (await this.storage.exists(PROJECT_FILE)) {
      throw new Error("Name already exists.");
    }
    return this.scaffoldNewProject(projectName, options?.kind, options);
  }

  async createFromTemplate(options: {
    templateFiles: ProjectTreeFile[];
    name: string;
    pickFolder?: boolean;
  }): Promise<ProjectLoadResult> {
    const projectName = options.name.endsWith(".babproject")
      ? options.name
      : `${options.name}.babproject`;
    if (options.pickFolder) {
      await this.storage.pickProjectFolder();
    } else {
      await this.storage.openDocumentsProject(projectName);
    }
    const guid = newGuid();
    await createProjectFromTemplate({
      templateFiles: options.templateFiles,
      destination: this.storage,
      guid,
      name: projectName,
    });
    this.projectGuid = guid;
    await this.installEnginePluginDefaultsIfNeeded();
    return this.loadCurrentProject();
  }

  async openListedProject(handle: ProjectFolderHandle): Promise<ProjectLoadResult> {
    await this.storage.openKnownFolder(handle);
    return this.loadCurrentProject();
  }

  async closeProject(): Promise<void> {
    await this.storage.releaseFolder();
    this.projectGuid = null;
    this.migrationPending = [];
    this.migrateOnSaveApproved = false;
    this.assetGuids.clear();
    this.assetRegistry = null;
    this.projectSearchIndex?.clear();
    this.projectSearchIndex = null;
    this.pluginDescriptors = [];
    this.pluginDiagnostics = [];
    this.pluginOverrides = {};
  }

  /** Display-name only: writes `metadata.name` when the folder can be opened. */
  async renameListedProjectDisplayName(
    handle: ProjectFolderHandle,
    displayName: string,
  ): Promise<void> {
    const name = displayName.trim();
    if (!name) return;
    await this.storage.openKnownFolder(handle);
    try {
      if (!(await this.storage.exists(PROJECT_FILE))) return;
      const raw = JSON.parse(await this.storage.readText(PROJECT_FILE)) as {
        metadata?: { name?: string; updatedAt?: string };
      };
      if (!raw.metadata) return;
      raw.metadata.name = name;
      raw.metadata.updatedAt = new Date().toISOString();
      await this.storage.writeText(PROJECT_FILE, JSON.stringify(raw, null, 2));
    } finally {
      await this.storage.releaseFolder();
    }
  }

  async exportZip(): Promise<Uint8Array> {
    return exportProjectZip(this.storage);
  }

  async needsReconnect(): Promise<boolean> {
    return (await this.storage.needsReconnect?.()) ?? false;
  }

  async reconnect(): Promise<ProjectLoadResult> {
    await this.storage.reconnectFolder!();
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
    const registry = new AssetRegistry(this.storage, { blobs: this.blobs });
    registry.setEncodePipeline(this.encodeQueue, {
      ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
      maxDimension,
    });
    await registry.mountRoot(projectContentRoot());
    this.assetRegistry = registry;
    await this.syncPlugins();
    this.projectSearchIndex = new ProjectSearchIndex(this.storage, {
      blobs: this.blobs,
      catalogClassIds: SEARCH_CATALOG_CLASS_IDS,
      nodeTitles: SEARCH_NODE_TITLES,
    });
    await this.projectSearchIndex.rebuild(registry);
    this.bindThumbnailWriter();
    const auto = this.loadedTextureSettings?.autoRequeueUncompressed ?? true;
    if (auto) {
      await registry.requeueUncompressedTextures();
    }
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
      storageFor: (plugin) =>
        plugin.source === "engine"
          ? (this.enginePluginStorage ?? undefined)
          : undefined,
    });
    const { diagnostics } = resolvePluginGraph(this.pluginDescriptors);
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
    overrides: Record<string, { enabled: boolean }>,
  ): Promise<void> {
    this.pluginOverrides = overrides;
    await this.syncPlugins();
    if (this.projectSearchIndex && this.assetRegistry) {
      await this.projectSearchIndex.rebuild(this.assetRegistry);
    }
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
    if (this.projectSearchIndex && this.assetRegistry) {
      await this.projectSearchIndex.rebuild(this.assetRegistry);
    }
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
    if (this.projectSearchIndex && this.assetRegistry) {
      await this.projectSearchIndex.rebuild(this.assetRegistry);
    }
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
    if (this.projectSearchIndex && this.assetRegistry) {
      await this.projectSearchIndex.rebuild(this.assetRegistry);
    }
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

  private storageForPath(path: string): ProjectStorage {
    const indexed = this.assetRegistry
      ?.list()
      .find((asset) => asset.path === path);
    if (indexed && this.assetRegistry) {
      return this.assetRegistry.storageFor(indexed.rootId);
    }
    const plugin = this.pluginDescriptors.find(
      (entry) =>
        path === entry.settingsPath ||
        path.startsWith(`${entry.folderPath}/`),
    );
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
    return this.blobs;
  }

  private bindEncodeQueueVisibility(): void {
    if (this.visibilityBound) return;
    this.visibilityBound = true;
    // Play + visibility publish reasons via encode-queue-pause; this service owns
    // the queue and applies the merged paused state (engineplan §2.4 / §3.5).
    void import("./encode-queue-pause").then(({ onEncodeQueuePause }) => {
      onEncodeQueuePause((paused) => {
        if (paused) this.encodeQueue.pause();
        else this.encodeQueue.resume();
      });
    });
  }

  /** Re-scan project assets after registry file operations (import, create, delete). */
  async remountRegistry(): Promise<AssetRegistry> {
    const registry = await this.mountAssetRegistry();
    if (!this.transcoderAvailable) {
      await this.markCompressedTexturesFallback();
    }
    return registry;
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
    kind: "empty" | "2d" = "empty",
    renderOptions?: {
      renderWidth?: number;
      renderHeight?: number;
      blackBars?: boolean;
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
    const document = createEmptyProject(name, { kind, render });
    this.projectGuid = newGuid();
    this.loadedTextureSettings = document.settings.textures;
    this.pluginOverrides = document.settings.pluginOverrides ?? {};
    const graph = createDefaultLogicGraphSerialized();
    const scene = createDefaultScene(kind === "2d" ? "2d" : "3d");
    await this.storage.mkdir("assets/.blobs", true);
    await this.storage.mkdir("plugins", true);
    await this.saveDocument("scene", MAIN_SCENE_FILE, scene);
    await this.saveDocument("graph", MAIN_CLASS_FILE, graph);
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
    return {
      document,
      layouts: createEmptyLayouts(),
      migrationPending: [],
    };
  }

  async loadDocument(
    kind: Exclude<DocumentKind, "content-browser">,
    path: string,
  ): Promise<SerializedScene | SerializedGraph | Record<string, unknown>> {
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
      this.migrationPending.push(migrated.pending);
    }
    const { version: _v, ...content } = migrated.payload as Record<
      string,
      unknown
    > & { version?: number };
    void _v;
    if (kind === "scene") {
      return normalizeScene(content);
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
    try {
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
    } catch (error) {
      if (fallbackType === "Class") {
        return {
          type: "Class",
          version: this.migrations.currentVersion("Class"),
          payload: {},
        };
      }
      throw error;
    }
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
    content: SerializedScene | SerializedGraph | Record<string, unknown>,
  ): Promise<void> {
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
    const version = this.migrations.currentVersion(type);
    const parentClass =
      existing?.parentClass ?? (type === "Class" ? "Actor" : null);
    const storeInHeader =
      kind === "asset-settings" &&
      existing !== null &&
      !existing.hasDocumentChunk;

    if (isAssetDocumentPath(path)) {
      const extraChunks = await this.extraChunksFor(path);
      const bytes = await encodeAssetDocument(
        {
          type,
          name:
            type === "PluginSettings" &&
            typeof (content as { displayName?: unknown }).displayName ===
              "string" &&
            (content as { displayName: string }).displayName.trim() !== ""
              ? (content as { displayName: string }).displayName.trim()
              : assetName(path),
          guid: await this.guidForAsset(path),
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
          dependencies: materialAssetDependencies(
            type,
            content as unknown as Record<string, unknown>,
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
    if (this.projectSearchIndex && this.assetRegistry) {
      const indexed = this.assetRegistry.list().find((asset) => asset.path === path);
      if (indexed) {
        this.projectSearchIndex.upsertDocument(
          indexed,
          content as unknown as Record<string, unknown>,
        );
      } else {
        await this.projectSearchIndex.upsertAsset(this.assetRegistry, path);
      }
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

  /** Persist Recast `exportNavMesh` bytes as the Scene `navmesh` extra chunk. */
  async writeSceneNavmeshChunk(
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (isPluginDocumentReadOnly(this.pluginDescriptors, path)) {
      throw new Error("Engine plugin assets are read-only");
    }
    const storage = this.storageForPath(path);
    const extra = extraChunksWithNavmesh(await this.extraChunksFor(path), bytes);
    const existing = await this.readExistingAssetMeta(path);
    const type = existing?.type ?? "Scene";
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
      },
    );
    await storage.writeBinary(path, encoded);
  }

  guidForPath(path: string): string | null {
    const cached = this.assetGuids.get(path);
    if (cached) return cached;
    const indexed = this.assetRegistry?.list().find((asset) => asset.path === path);
    return indexed?.header.guid ?? null;
  }

  private async readExistingAssetMeta(path: string): Promise<{
    type: string;
    parentClass: string | null;
    hasDocumentChunk: boolean;
  } | null> {
    if (!(await this.storageForPath(path).exists(path))) return null;
    try {
      const header = readAssetDocumentHeader(
        await this.storageForPath(path).readBinary(path),
      );
      return {
        type: header.type,
        parentClass: header.parentClass ?? null,
        hasDocumentChunk: header.chunks.some(
          (chunk) => chunk.id === DOCUMENT_CHUNK_ID,
        ),
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
    const cached = this.assetGuids.get(path);
    if (cached) return cached;
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
      settings: normalizeProjectSettings(raw.settings),
    };
  }
  return createEmptyProject(
    typeof raw.name === "string" ? raw.name : fallbackName,
  );
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}
