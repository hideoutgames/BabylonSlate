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
import { exportProjectZip } from "@babylonslate/assets";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "@babylonslate/vfs";

export interface ProjectLoadResult {
  document: ProjectDocument;
  layouts: ProjectLayouts;
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

  constructor(storage: ProjectStorage) {
    this.storage = storage;
  }

  get storagePort(): ProjectStorage {
    return this.storage;
  }

  get guid(): string | null {
    return this.projectGuid;
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
    // Force create fresh scaffold
    if (await this.storage.exists(PROJECT_FILE)) {
      return this.loadCurrentProject();
    }
    return this.scaffoldNewProject(projectName);
  }

  async openListedProject(handle: ProjectFolderHandle): Promise<ProjectLoadResult> {
    if (handle.tier === "documents" || handle.tier === "opfs") {
      await this.storage.openDocumentsProject(handle.name);
    } else {
      await this.storage.pickProjectFolder();
    }
    return this.loadCurrentProject();
  }

  async closeProject(): Promise<void> {
    await this.storage.releaseFolder();
    this.projectGuid = null;
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

  async loadCurrentProject(): Promise<ProjectLoadResult> {
    const folder = this.storage.getCurrentFolder();
    if (!folder) {
      throw new Error("No project folder selected");
    }

    const hasProject = await this.storage.exists(PROJECT_FILE);
    if (!hasProject) {
      return this.scaffoldNewProject(folder.name);
    }

    const raw = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as ProjectDocument & { guid?: string; kind?: string };
    const document = normalizeProjectDocument(raw, folder.name);
    this.projectGuid = (raw as { guid?: string }).guid ?? newGuid();

    const layouts = await this.loadLayouts(
      documentId({ kind: "scene", path: MAIN_SCENE_FILE }),
    );

    return { document, layouts };
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
    // Persist guid alongside legacy ProjectDocument shape
    const stored = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as Record<string, unknown>;
    stored.guid = this.projectGuid;
    stored.kind = "project";
    await this.storage.writeText(PROJECT_FILE, JSON.stringify(stored, null, 2));
    return { document, layouts: createEmptyLayouts() };
  }

  async loadDocument(
    kind: Exclude<DocumentKind, "content-browser">,
    path: string,
  ): Promise<SerializedScene | SerializedGraph> {
    if (kind === "scene") {
      return JSON.parse(await this.storage.readText(path)) as SerializedScene;
    }
    return JSON.parse(await this.storage.readText(path)) as SerializedGraph;
  }

  async saveDocument(
    kind: Exclude<DocumentKind, "content-browser">,
    path: string,
    content: SerializedScene | SerializedGraph,
  ): Promise<void> {
    const dir = kind === "scene" ? "scenes" : "graphs";
    await this.storage.mkdir(dir, true);
    await this.storage.writeText(path, JSON.stringify(content, null, 2));
  }

  async saveProject(
    document: ProjectDocument,
    layouts: ProjectLayouts,
  ): Promise<void> {
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
    };
    this.projectGuid = payload.guid as string;

    await this.storage.writeText(PROJECT_FILE, JSON.stringify(payload, null, 2));
    await this.storage.writeText(
      LAYOUT_FILE,
      JSON.stringify(layouts, null, 2),
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
  // Manifest-style project.json from createEmptyProjectFiles
  return createEmptyProject(
    typeof raw.name === "string" ? raw.name : fallbackName,
  );
}
