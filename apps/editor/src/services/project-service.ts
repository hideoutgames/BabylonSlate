import type { DockviewApi } from "dockview";
import type {
  DocumentKind,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/shared";
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
} from "@babylonslate/shared";
import type { ProjectStorage } from "@babylonslate/shared";

export interface ProjectLoadResult {
  document: ProjectDocument;
  layouts: ProjectLayouts;
}

export class ProjectService {
  private readonly storage: ProjectStorage;

  constructor(storage: ProjectStorage) {
    this.storage = storage;
  }

  get storagePort(): ProjectStorage {
    return this.storage;
  }

  async openProject(): Promise<ProjectLoadResult> {
    await this.storage.pickProjectFolder();
    return this.loadCurrentProject();
  }

  async loadCurrentProject(): Promise<ProjectLoadResult> {
    const folder = this.storage.getCurrentFolder();
    if (!folder) {
      throw new Error("No project folder selected");
    }

    const hasProject = await this.storage.exists(PROJECT_FILE);
    if (!hasProject) {
      const document = createEmptyProject(folder.name);
      const graph = createDefaultGraph();
      const scene = createDefaultScene();
      await this.saveDocument("scene", MAIN_SCENE_FILE, scene);
      await this.saveDocument("graph", MAIN_GRAPH_FILE, graph);
      await this.saveProject(document, createEmptyLayouts());
      return { document, layouts: createEmptyLayouts() };
    }

    const document = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as ProjectDocument;

    const layouts = await this.loadLayouts(
      documentId({ kind: "scene", path: MAIN_SCENE_FILE }),
    );

    return { document, layouts };
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

    await this.storage.writeText(PROJECT_FILE, JSON.stringify(updated, null, 2));
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
