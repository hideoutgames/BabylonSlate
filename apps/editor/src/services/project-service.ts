import type { DockviewApi } from "dockview-react";
import type {
  DocumentKind,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import {
  createDefaultGraph,
  createDefaultScene,
  createEmptyLayouts,
  createEmptyProject,
  normalizeProjectSettings,
  documentId,
  LAYOUT_FILE,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  migrateLegacyLayout,
  PROJECT_FILE,
  type ProjectDocument,
} from "@babylonslate/core";
import type { ProjectFolderHandle, ProjectStorage } from "@babylonslate/core";
import {
  AssetRegistry,
  createProjectFromTemplate,
  createVfsBlobStore,
  decodeAssetDocument,
  encodeAssetDocument,
  exportProjectZip,
  isAssetDocumentPath,
  loadPayloadWithMigration,
  defaultRegistry,
  projectContentRoot,
  readAssetDocumentHeader,
  readProjectTree,
  type BlobStore,
  type MigrationPending,
  type ProjectTreeFile,
} from "@babylonslate/assets";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "@babylonslate/vfs";

export interface ProjectLoadResult {
  document: ProjectDocument;
  layouts: ProjectLayouts;
  migrationPending: MigrationPending[];
}

function newGuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assetName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.babasset$/, "");
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
  /** Asset guids stay stable across saves so references survive a rewrite. */
  private readonly assetGuids = new Map<string, string>();

  constructor(storage: ProjectStorage) {
    this.storage = storage;
    this.blobs = createVfsBlobStore(storage);
  }

  get storagePort(): ProjectStorage {
    return this.storage;
  }

  get registry(): AssetRegistry | null {
    return this.assetRegistry;
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

  async createEmptyProject(name?: string): Promise<ProjectLoadResult> {
    const projectName =
      name ??
      (isTestModeEnabled() ? TEST_PROJECT_NAME : "MyGame.babproject");
    await this.storage.openDocumentsProject(projectName);
    if (await this.storage.exists(PROJECT_FILE)) {
      return this.loadCurrentProject();
    }
    return this.scaffoldNewProject(projectName);
  }

  async createFromTemplate(options: {
    templateFiles: ProjectTreeFile[];
    name: string;
  }): Promise<ProjectLoadResult> {
    const projectName = options.name.endsWith(".babproject")
      ? options.name
      : `${options.name}.babproject`;
    await this.storage.openDocumentsProject(projectName);
    const guid = newGuid();
    await createProjectFromTemplate({
      templateFiles: options.templateFiles,
      destination: this.storage,
      guid,
      name: projectName,
    });
    this.projectGuid = guid;
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
    const layouts = await this.loadLayouts(
      documentId({
        kind: "scene",
        path: withDocuments.scenes[0] ?? MAIN_SCENE_FILE,
      }),
    );

    return {
      document: withDocuments,
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
    const found = this.assetRegistry!.listDocumentPaths();
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
      await this.saveDocument("graph", MAIN_GRAPH_FILE, createDefaultGraph());
      graphs.push(MAIN_GRAPH_FILE);
    }
    await this.mountAssetRegistry();
    return { ...document, scenes, graphs };
  }

  private async mountAssetRegistry(): Promise<AssetRegistry> {
    const registry = new AssetRegistry(this.storage, { blobs: this.blobs });
    await registry.mountRoot(projectContentRoot());
    this.assetRegistry = registry;
    return registry;
  }

  /** Re-scan project assets after registry file operations (import, create, delete). */
  async remountRegistry(): Promise<AssetRegistry> {
    return this.mountAssetRegistry();
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

  private async scaffoldNewProject(name: string): Promise<ProjectLoadResult> {
    const document = createEmptyProject(name);
    this.projectGuid = newGuid();
    const graph = createDefaultGraph();
    const scene = createDefaultScene();
    await this.storage.mkdir("assets/.blobs", true);
    await this.storage.mkdir("plugins", true);
    await this.saveDocument("scene", MAIN_SCENE_FILE, scene);
    await this.saveDocument("graph", MAIN_GRAPH_FILE, graph);
    await this.saveProject(document, createEmptyLayouts());
    const stored = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as Record<string, unknown>;
    stored.guid = this.projectGuid;
    stored.kind = "project";
    stored.version = this.migrations.currentVersion("Project");
    await this.storage.writeText(PROJECT_FILE, JSON.stringify(stored, null, 2));
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
  ): Promise<SerializedScene | SerializedGraph> {
    const fallbackType = kind === "scene" ? "Scene" : "Graph";
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
      return content as unknown as SerializedScene;
    }
    return content as unknown as SerializedGraph;
  }

  private async readAssetDocument(
    path: string,
    fallbackType: string,
  ): Promise<{ type: string; version: number; payload: Record<string, unknown> }> {
    const decoded = await decodeAssetDocument(
      await this.storage.readBinary(path),
      { blobs: this.blobs },
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
    content: SerializedScene | SerializedGraph,
  ): Promise<void> {
    if (this.migrationPending.some((p) => p.path === path) && !this.migrateOnSaveApproved) {
      throw new Error(
        "Asset schema migration requires user approval before save",
      );
    }
    const dir = parentDir(path);
    if (dir) {
      await this.storage.mkdir(dir, true);
    }
    const type = kind === "scene" ? "Scene" : "Graph";
    const version = this.migrations.currentVersion(type);

    if (isAssetDocumentPath(path)) {
      const bytes = await encodeAssetDocument(
        {
          type,
          name: assetName(path),
          guid: await this.guidForAsset(path),
          version,
          payload: content as unknown as Record<string, unknown>,
        },
        { blobs: this.blobs },
      );
      await this.storage.writeBinary(path, bytes);
    } else {
      await this.storage.writeText(
        path,
        JSON.stringify({ ...content, version }, null, 2),
      );
    }
    this.migrationPending = this.migrationPending.filter((p) => p.path !== path);
  }

  private async guidForAsset(path: string): Promise<string> {
    const cached = this.assetGuids.get(path);
    if (cached) return cached;
    if (await this.storage.exists(path)) {
      try {
        const header = readAssetDocumentHeader(
          await this.storage.readBinary(path),
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
