import type { DockviewApi } from "dockview";
import type { SerializedGraph, SerializedScene } from "@babylonslate/shared";
import {
  createDefaultGraph,
  createDefaultScene,
  createEmptyProject,
  LAYOUT_FILE,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  type ProjectDocument,
} from "@babylonslate/shared";
import type { ProjectStorage } from "@babylonslate/shared";

export interface ProjectState {
  document: ProjectDocument;
  layout: Record<string, unknown> | null;
  graph: SerializedGraph;
  scene: SerializedScene;
}

export class ProjectService {
  private readonly storage: ProjectStorage;

  constructor(storage: ProjectStorage) {
    this.storage = storage;
  }

  get storagePort(): ProjectStorage {
    return this.storage;
  }

  async openProject(): Promise<ProjectState> {
    await this.storage.pickProjectFolder();
    return this.loadCurrentProject();
  }

  async loadCurrentProject(): Promise<ProjectState> {
    const folder = this.storage.getCurrentFolder();
    if (!folder) {
      throw new Error("No project folder selected");
    }

    const hasProject = await this.storage.exists(PROJECT_FILE);
    if (!hasProject) {
      const document = createEmptyProject(folder.name);
      const graph = createDefaultGraph();
      const scene = createDefaultScene();
      await this.saveProject({ document, layout: null, graph, scene });
      return { document, layout: null, graph, scene };
    }

    const document = JSON.parse(
      await this.storage.readText(PROJECT_FILE),
    ) as ProjectDocument;

    const graph = JSON.parse(
      await this.storage.readText(MAIN_GRAPH_FILE),
    ) as SerializedGraph;

    const scene = JSON.parse(
      await this.storage.readText(MAIN_SCENE_FILE),
    ) as SerializedScene;

    let layout: Record<string, unknown> | null = null;
    if (await this.storage.exists(LAYOUT_FILE)) {
      layout = JSON.parse(await this.storage.readText(LAYOUT_FILE)) as Record<
        string,
        unknown
      >;
    }

    return { document, layout, graph, scene };
  }

  async saveProject(state: ProjectState): Promise<void> {
    const now = new Date().toISOString();
    const document: ProjectDocument = {
      ...state.document,
      metadata: {
        ...state.document.metadata,
        updatedAt: now,
      },
    };

    await this.storage.mkdir("graphs", true);
    await this.storage.mkdir("scenes", true);

    await this.storage.writeText(PROJECT_FILE, JSON.stringify(document, null, 2));
    await this.storage.writeText(
      MAIN_GRAPH_FILE,
      JSON.stringify(state.graph, null, 2),
    );
    await this.storage.writeText(
      MAIN_SCENE_FILE,
      JSON.stringify(state.scene, null, 2),
    );

    if (state.layout) {
      await this.storage.writeText(
        LAYOUT_FILE,
        JSON.stringify(state.layout, null, 2),
      );
    }
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
