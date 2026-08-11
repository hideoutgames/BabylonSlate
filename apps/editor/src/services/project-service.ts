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
  createProjectFromTemplate,
  exportProjectZip,
  loadPayloadWithMigration,
  defaultRegistry,
  readProjectTree,
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

export class ProjectService {
  private readonly storage: ProjectStorage;
  private projectGuid: string | null = null;
  private migrationPending: MigrationPending[] = [];
  private migrateOnSaveApproved = false;
  private readonly migrations = defaultRegistry();

  constructor(storage: ProjectStorage) {
    this.storage = storage;
  }

  get storagePort(): ProjectStorage {
    return this.storage;
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

    const layouts = await this.loadLayouts(
      documentId({ kind: "scene", path: MAIN_SCENE_FILE }),
    );

    return {
      document,
      layouts,
      migrationPending: this.pendingMigrations,
    };
  }

  private async scaffoldNewProject(name: string): Promise<ProjectLoadResult> {
    const document = createEmptyProject(name);
    this.projectGuid = newGuid();
    const graph = createDefaultGraph();
    const scene = createDefaultScene();
    await this.storage.mkdir("assets/.blobs", true);
    await this.storage.mkdir("plugins", true);
    await this.storage.mkdir("scenes", true);
    await this.storage.mkdir("graphs", true);
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
    const raw = JSON.parse(await this.storage.readText(path)) as Record<
      string,
      unknown
    > & { version?: number };
    const type = kind === "scene" ? "Scene" : "Graph";
    const version =
      typeof raw.version === "number"
        ? raw.version
        : this.migrations.currentVersion(type);
    const migrated = loadPayloadWithMigration(this.migrations, {
      type,
      version,
      payload: raw,
      path,
    });
    if (migrated.pending) {
      this.migrationPending.push(migrated.pending);
    }
    const { version: _v, ...content } = migrated.payload as typeof raw & {
      version?: number;
    };
    void _v;
    if (kind === "scene") {
      return content as unknown as SerializedScene;
    }
    return content as unknown as SerializedGraph;
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
    const dir = kind === "scene" ? "scenes" : "graphs";
    await this.storage.mkdir(dir, true);
    const type = kind === "scene" ? "Scene" : "Graph";
    const payload = {
      ...content,
      version: this.migrations.currentVersion(type),
    };
    await this.storage.writeText(path, JSON.stringify(payload, null, 2));
    this.migrationPending = this.migrationPending.filter((p) => p.path !== path);
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
    return raw;
  }
  return createEmptyProject(
    typeof raw.name === "string" ? raw.name : fallbackName,
  );
}
