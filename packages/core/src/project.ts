export const PROJECT_FILE = "project.json";
export const LAYOUT_FILE = "layout.json";
export const MAIN_GRAPH_FILE = "assets/main.graph.babasset";
export const MAIN_SCENE_FILE = "assets/main.scene.babasset";

export interface ProjectMetadata {
  name: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface TextureProjectSettings {
  /** Max imported texture dimension (default 2048 for A16 baseline). */
  maxTextureDimension: number;
  /** When true, missing KTX2 chunks are re-queued once transcoder is available. */
  autoRequeueUncompressed: boolean;
}

export interface ProjectSettings {
  touchMinTargetPx: number;
  textures: TextureProjectSettings;
}

export interface ProjectDocument {
  metadata: ProjectMetadata;
  settings: ProjectSettings;
  scenes: string[];
  graphs: string[];
}

export interface SerializedGraph {
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
}

export interface SerializedScene {
  name: string;
  meshes: Array<{
    id: string;
    type: string;
    position: [number, number, number];
  }>;
}

export const DEFAULT_TEXTURE_PROJECT_SETTINGS: TextureProjectSettings = {
  maxTextureDimension: 2048,
  autoRequeueUncompressed: true,
};

export function normalizeProjectSettings(
  settings: Partial<ProjectSettings> | undefined,
): ProjectSettings {
  return {
    touchMinTargetPx: settings?.touchMinTargetPx ?? 44,
    textures: {
      maxTextureDimension:
        settings?.textures?.maxTextureDimension ??
        DEFAULT_TEXTURE_PROJECT_SETTINGS.maxTextureDimension,
      autoRequeueUncompressed:
        settings?.textures?.autoRequeueUncompressed ??
        DEFAULT_TEXTURE_PROJECT_SETTINGS.autoRequeueUncompressed,
    },
  };
}

export function createEmptyProject(name: string): ProjectDocument {
  const now = new Date().toISOString();
  return {
    metadata: {
      name,
      version: "1.0.0",
      createdAt: now,
      updatedAt: now,
    },
    settings: normalizeProjectSettings(undefined),
    scenes: [MAIN_SCENE_FILE],
    graphs: [MAIN_GRAPH_FILE],
  };
}

export function createDefaultScene(): SerializedScene {
  return {
    name: "Main",
    meshes: [
      {
        id: "cube",
        type: "box",
        position: [0, 0, 0],
      },
    ],
  };
}

export function createDefaultGraph(): SerializedGraph {
  return {
    nodes: [
      {
        id: "log-1",
        type: "logMessage",
        position: { x: 120, y: 120 },
        data: { message: "Hello from BabylonSlate" },
      },
    ],
    edges: [],
  };
}
