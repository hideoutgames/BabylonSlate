import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedComponent,
  type SerializedScene,
} from "./scene";

export const PROJECT_FILE = "project.json";
export const LAYOUT_FILE = "layout.json";
export const MAIN_GRAPH_FILE = "assets/main.graph.babasset";
export const MAIN_CLASS_FILE = "assets/main.class.babasset";
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

/**
 * Action / axis mappings authored in Project Settings. The structural shape
 * matches `@babylonslate/input`'s `InputMappings`; normalisation lives there so
 * `core` stays free of an input dependency.
 */
export interface ProjectInputSettings {
  actions: Array<{
    name: string;
    bindings: Array<Record<string, unknown>>;
  }>;
  axes: Array<{
    name: string;
    kind?: "1d" | "2d";
    bindings: Array<Record<string, unknown>>;
  }>;
}

export interface PlayPreviewProjectSettings {
  /** When true, Play overlay fills the window (current behavior). */
  followSystem: boolean;
  /** Used when followSystem is false. Width of the letterboxed game view. */
  aspectWidth: number;
  /** Used when followSystem is false. Height of the letterboxed game view. */
  aspectHeight: number;
}

export interface FontProjectSettings {
  /** Font asset guid used when a widget omits a family. */
  defaultFontGuid: string | null;
  /** Generic CSS family appended to every compiled stack. */
  globalFallback: string;
}

export const DEFAULT_FONT_PROJECT_SETTINGS: FontProjectSettings = {
  defaultFontGuid: null,
  globalFallback: "sans-serif",
};

export interface ProjectSettings {
  touchMinTargetPx: number;
  /** Play/Preview render cap in fps. Editor viewports use Engine Settings. */
  playFrameCap: number;
  /** Recompile open graphs whenever the project is saved. */
  compileOnSave: boolean;
  /** Idle interval before dirty documents are written. */
  autoSaveIntervalMs: number;
  /** Play overlay letterbox; Preview-only, does not affect export. */
  playPreview: PlayPreviewProjectSettings;
  textures: TextureProjectSettings;
  twoD: TwoDProjectSettings;
  input: ProjectInputSettings;
  fonts: FontProjectSettings;
}

export interface ProjectDocument {
  metadata: ProjectMetadata;
  settings: ProjectSettings;
  scenes: string[];
  graphs: string[];
}

export type GraphClassMemberKind =
  | "function"
  | "variable"
  | "event"
  | "interface";

/** Lightweight Class panel rows stored on the graph until class documents exist. */
export interface GraphClassMember {
  id: string;
  kind: GraphClassMemberKind;
  name: string;
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
  members?: GraphClassMember[];
  /** Actor prefab components authored on Class documents. */
  components?: SerializedComponent[];
}


export const DEFAULT_PLAY_FRAME_CAP = 60;
export const DEFAULT_AUTO_SAVE_INTERVAL_MS = 120_000;
export const DEFAULT_PLAY_PREVIEW_ASPECT_WIDTH = 16;
export const DEFAULT_PLAY_PREVIEW_ASPECT_HEIGHT = 9;

export const DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS: PlayPreviewProjectSettings =
  {
    followSystem: true,
    aspectWidth: DEFAULT_PLAY_PREVIEW_ASPECT_WIDTH,
    aspectHeight: DEFAULT_PLAY_PREVIEW_ASPECT_HEIGHT,
  };

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

export const DEFAULT_PROJECT_INPUT_SETTINGS: ProjectInputSettings = {
  actions: [
    {
      name: "Jump",
      bindings: [
        { device: "key", code: "Space" },
        { device: "gamepadButton", code: "0:0" },
      ],
    },
    {
      name: "Confirm",
      bindings: [
        { device: "key", code: "Enter" },
        // Face button B (index 1) — Jump already owns A (0:0).
        { device: "gamepadButton", code: "0:1" },
      ],
    },
  ],
  axes: [
    {
      name: "Move",
      kind: "2d",
      bindings: [
        { device: "key", code: "KeyA", component: "x", digitalValue: -1 },
        { device: "key", code: "KeyD", component: "x", digitalValue: 1 },
        { device: "key", code: "KeyS", component: "y", digitalValue: -1 },
        { device: "key", code: "KeyW", component: "y", digitalValue: 1 },
        { device: "gamepadAxis", code: "0:0", component: "x", deadZone: 0.15 },
        {
          device: "gamepadAxis",
          code: "0:1",
          component: "y",
          deadZone: 0.15,
          invert: true,
        },
        {
          device: "touch",
          code: "joystick-x",
          component: "x",
          deadZone: 0.15,
        },
        {
          device: "touch",
          code: "joystick-y",
          component: "y",
          deadZone: 0.15,
        },
      ],
    },
    {
      name: "Look",
      kind: "1d",
      bindings: [{ device: "gamepadAxis", code: "0:2", deadZone: 0.15 }],
    },
  ],
};

function normalizePositiveAspect(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

function normalizePlayPreview(
  value: Partial<PlayPreviewProjectSettings> | undefined,
): PlayPreviewProjectSettings {
  return {
    followSystem: value?.followSystem !== false,
    aspectWidth: normalizePositiveAspect(
      value?.aspectWidth,
      DEFAULT_PLAY_PREVIEW_ASPECT_WIDTH,
    ),
    aspectHeight: normalizePositiveAspect(
      value?.aspectHeight,
      DEFAULT_PLAY_PREVIEW_ASPECT_HEIGHT,
    ),
  };
}

function normalizeProjectInput(value: unknown): ProjectInputSettings {
  const source = (value ?? {}) as Record<string, unknown>;
  const hasActions = Array.isArray(source.actions) && source.actions.length > 0;
  const hasAxes = Array.isArray(source.axes) && source.axes.length > 0;
  if (!hasActions && !hasAxes) {
    return structuredClone(DEFAULT_PROJECT_INPUT_SETTINGS);
  }
  // Full validation (device enums, dead zones) runs in `@babylonslate/input`.
  return {
    actions: hasActions
      ? (source.actions as ProjectInputSettings["actions"])
      : [],
    axes: hasAxes ? (source.axes as ProjectInputSettings["axes"]) : [],
  };
}

export function normalizeProjectSettings(
  settings: Partial<ProjectSettings> | undefined,
): ProjectSettings {
  const twoD = settings?.twoD;
  return {
    touchMinTargetPx: settings?.touchMinTargetPx ?? 44,
    playFrameCap:
      typeof settings?.playFrameCap === "number" && settings.playFrameCap > 0
        ? settings.playFrameCap
        : DEFAULT_PLAY_FRAME_CAP,
    compileOnSave: settings?.compileOnSave !== false,
    autoSaveIntervalMs:
      typeof settings?.autoSaveIntervalMs === "number" &&
      settings.autoSaveIntervalMs > 0
        ? settings.autoSaveIntervalMs
        : DEFAULT_AUTO_SAVE_INTERVAL_MS,
    playPreview: normalizePlayPreview(settings?.playPreview),
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
    input: normalizeProjectInput(settings?.input),
    fonts: {
      defaultFontGuid:
        typeof settings?.fonts?.defaultFontGuid === "string" &&
        settings.fonts.defaultFontGuid !== ""
          ? settings.fonts.defaultFontGuid
          : DEFAULT_FONT_PROJECT_SETTINGS.defaultFontGuid,
      globalFallback:
        typeof settings?.fonts?.globalFallback === "string" &&
        settings.fonts.globalFallback.trim() !== ""
          ? settings.fonts.globalFallback.trim()
          : DEFAULT_FONT_PROJECT_SETTINGS.globalFallback,
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
    graphs: [MAIN_CLASS_FILE],
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

const MEMBER_KINDS = new Set<GraphClassMemberKind>([
  "function",
  "variable",
  "event",
  "interface",
]);

export function normalizeGraphMembers(value: unknown): GraphClassMember[] {
  if (!Array.isArray(value)) return [];
  const members: GraphClassMember[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const kind = row.kind;
    if (!id || !name) continue;
    if (
      kind !== "function" &&
      kind !== "variable" &&
      kind !== "event" &&
      kind !== "interface"
    ) {
      continue;
    }
    if (!MEMBER_KINDS.has(kind)) continue;
    members.push({ id, kind, name });
  }
  return members;
}

export function normalizeGraphComponents(value: unknown): SerializedComponent[] {
  if (!Array.isArray(value)) return [];
  const components: SerializedComponent[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const classId = typeof row.classId === "string" ? row.classId.trim() : "";
    if (!id || !classId) continue;
    const properties =
      row.properties && typeof row.properties === "object"
        ? { ...(row.properties as Record<string, unknown>) }
        : {};
    components.push({ id, classId, properties });
  }
  return components;
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
