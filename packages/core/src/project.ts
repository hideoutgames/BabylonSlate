import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedScene,
} from "./scene";

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

export interface TwoDProjectSettings {
  /** Texture pixels per world unit; the 2D authoring scale. */
  pixelsPerUnit: number;
  /**
   * Derive orthographic bounds from the canvas pixel size, sample textures
   * nearest with mipmaps off and snap the camera to the pixel grid.
   */
  pixelPerfect: boolean;
  /** Restrict zoom to integer pixel scales, which keeps sprites crisp. */
  integerZoomSteps: boolean;
  /**
   * Ordered sorting layers, back to front. The index in this list is the
   * coarse half of the 2D sort key.
   */
  sortingLayers: string[];
}

export interface ProjectSettings {
  touchMinTargetPx: number;
  textures: TextureProjectSettings;
  twoD: TwoDProjectSettings;
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


export const DEFAULT_TEXTURE_PROJECT_SETTINGS: TextureProjectSettings = {
  maxTextureDimension: 2048,
  autoRequeueUncompressed: true,
};

export const DEFAULT_SORTING_LAYERS = [
  "Background",
  "Default",
  "Foreground",
  "UI",
] as const;

export const DEFAULT_TWO_D_PROJECT_SETTINGS: TwoDProjectSettings = {
  pixelsPerUnit: 100,
  pixelPerfect: false,
  integerZoomSteps: false,
  sortingLayers: [...DEFAULT_SORTING_LAYERS],
};

function normalizeSortingLayers(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SORTING_LAYERS];
  const seen = new Set<string>();
  const layers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    // Duplicate names would make a sort key ambiguous.
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    layers.push(name);
  }
  return layers.length > 0 ? layers : [...DEFAULT_SORTING_LAYERS];
}

export function normalizeProjectSettings(
  settings: Partial<ProjectSettings> | undefined,
): ProjectSettings {
  const twoD = settings?.twoD;
  return {
    touchMinTargetPx: settings?.touchMinTargetPx ?? 44,
    twoD: {
      pixelsPerUnit:
        typeof twoD?.pixelsPerUnit === "number" && twoD.pixelsPerUnit > 0
          ? twoD.pixelsPerUnit
          : DEFAULT_TWO_D_PROJECT_SETTINGS.pixelsPerUnit,
      pixelPerfect: twoD?.pixelPerfect === true,
      integerZoomSteps: twoD?.integerZoomSteps === true,
      sortingLayers: normalizeSortingLayers(twoD?.sortingLayers),
    },
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
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    actors: [
      createActor("actor-1", "Cube", {
        components: [createMeshComponent("component-1", "box")],
      }),
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
