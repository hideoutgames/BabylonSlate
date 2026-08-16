import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
  normalizeTransform,
  type SerializedComponent,
  type SerializedScene,
  type ViewportMode,
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

export interface RenderProjectSettings {
  /**
   * When false or missing, Play fills the overlay / Follow System path.
   * New projects default this on.
   */
  customResolution: boolean;
  width: number;
  height: number;
  /** When true, letterbox the WxH framebuffer; when false, stretch to fill. */
  blackBars: boolean;
}

export const DEFAULT_RENDER_WIDTH = 1920;
export const DEFAULT_RENDER_HEIGHT = 1080;

/** Missing field on existing projects — keep fill / Follow System. */
export const DEFAULT_RENDER_PROJECT_SETTINGS: RenderProjectSettings = {
  customResolution: false,
  width: DEFAULT_RENDER_WIDTH,
  height: DEFAULT_RENDER_HEIGHT,
  blackBars: false,
};

/** New projects lock Play/runtime to 1920×1080 and stretch (no black bars). */
export const NEW_PROJECT_RENDER_SETTINGS: RenderProjectSettings = {
  customResolution: true,
  width: DEFAULT_RENDER_WIDTH,
  height: DEFAULT_RENDER_HEIGHT,
  blackBars: false,
};

export interface ProjectSettings {
  touchMinTargetPx: number;
  /** Play/Preview render cap in fps. Editor viewports use Engine Settings. */
  playFrameCap: number;
  /** Recompile open graphs whenever the project is saved. */
  compileOnSave: boolean;
  /** Idle interval before dirty documents are written. */
  autoSaveIntervalMs: number;
  /** Play overlay letterbox; used when `render.customResolution` is off. */
  playPreview: PlayPreviewProjectSettings;
  /**
   * Packaged / export boot scene asset guid. Editor Play never reads this —
   * Play uses the open scene tab.
   */
  startupSceneGuid: string | null;
  textures: TextureProjectSettings;
  twoD: TwoDProjectSettings;
  input: ProjectInputSettings;
  fonts: FontProjectSettings;
  render: RenderProjectSettings;
  /** Class ids (EditorUtilityObject lineage) that run in the editor ScriptHost. */
  editorUtilityObjects: string[];
  /** Per-plugin enable overrides keyed by plugin guid (engineplan §10.4). */
  pluginOverrides: Record<string, PluginEnableOverride>;
  /** Named export presets; each may override plugin enablement (layer 3). */
  exportPresets: ExportPreset[];
  /**
   * Git LFS locking opt-in. Token is never stored here — it lives in the
   * platform secret store (engineplan §12).
   */
  sourceControl: SourceControlProjectSettings;
}

export interface SourceControlProjectSettings {
  enabled: boolean;
  repositoryUrl: string;
  branch: string;
  autoLockOnEdit: boolean;
  pollIntervalMs: number;
}

export interface PluginEnableOverride {
  enabled: boolean;
}

export const DEFAULT_EXPORT_FILE_COUNT_WARN = 800;
export const DEFAULT_EXPORT_FILE_COUNT_FAIL = 1000;

export interface ExportPreset {
  id: string;
  name: string;
  pluginOverrides: Record<string, PluginEnableOverride>;
  /** Packed `.babpack` export; default on. */
  packed: boolean;
  /** Release zip default off; Preview Build always on. */
  bundleDebugger: boolean;
  fileCountWarn: number;
  fileCountFail: number;
}

export function defaultExportPreset(
  id = "web",
  name = "Web",
): ExportPreset {
  return {
    id,
    name,
    pluginOverrides: {},
    packed: true,
    bundleDebugger: false,
    fileCountWarn: DEFAULT_EXPORT_FILE_COUNT_WARN,
    fileCountFail: DEFAULT_EXPORT_FILE_COUNT_FAIL,
  };
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
export interface GraphClassMemberPin {
  name: string;
  typeId: string;
  direction: "in" | "out";
  /** Object/class pin constraint. Missing means unconstrained BObject at pin conversion. */
  typeClassId?: string;
}

export interface GraphClassMember {
  id: string;
  kind: GraphClassMemberKind;
  name: string;
  /** Variable pin type (bool, float, …). */
  typeId?: string;
  /** Object/class variable constraint. Missing means unconstrained BObject at pin conversion. */
  typeClassId?: string;
  defaultValue?: unknown;
  /** Function and custom-event signature pins. */
  pins?: GraphClassMemberPin[];
  /** ScriptInterface asset guid. */
  assetGuid?: string;
  /** When set, this variable is local to that function member. */
  functionId?: string;
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
    type?: string;
  }>;
  members?: GraphClassMember[];
  /** Actor prefab components authored on Class documents. */
  components?: SerializedComponent[];
  /** Per-function graphs keyed by function member id. Event graph stays in nodes/edges. */
  functionGraphs?: Record<
    string,
    {
      nodes: SerializedGraph["nodes"];
      edges: SerializedGraph["edges"];
    }
  >;
}


export const DEFAULT_SOURCE_CONTROL_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_SOURCE_CONTROL_BRANCH = "main";

export const DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS: SourceControlProjectSettings =
  {
    enabled: false,
    repositoryUrl: "",
    branch: DEFAULT_SOURCE_CONTROL_BRANCH,
    autoLockOnEdit: true,
    pollIntervalMs: DEFAULT_SOURCE_CONTROL_POLL_INTERVAL_MS,
  };

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
        { device: "touch", code: "Jump" },
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
        {
          device: "touch",
          code: "dpad-x",
          component: "x",
          deadZone: 0.15,
        },
        {
          device: "touch",
          code: "dpad-y",
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

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function normalizeRender(
  value: Partial<RenderProjectSettings> | undefined,
): RenderProjectSettings {
  return {
    customResolution: value?.customResolution === true,
    width: normalizePositiveInt(value?.width, DEFAULT_RENDER_WIDTH),
    height: normalizePositiveInt(value?.height, DEFAULT_RENDER_HEIGHT),
    blackBars: value?.blackBars === true,
  };
}

function normalizeStartupSceneGuid(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizePluginOverrides(value: unknown): Record<string, PluginEnableOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, PluginEnableOverride> = {};
  for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const guid = rawKey.trim();
    if (!guid) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const enabled = (raw as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") continue;
    out[guid] = { enabled };
  }
  return out;
}

function normalizeCountThreshold(
  value: unknown,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeExportPresets(value: unknown): ExportPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: ExportPreset[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof record.name === "string" && record.name.trim() !== ""
        ? record.name.trim()
        : id;
    presets.push({
      id,
      name,
      pluginOverrides: normalizePluginOverrides(record.pluginOverrides),
      packed: record.packed !== false,
      bundleDebugger: record.bundleDebugger === true,
      fileCountWarn: normalizeCountThreshold(
        record.fileCountWarn,
        DEFAULT_EXPORT_FILE_COUNT_WARN,
      ),
      fileCountFail: normalizeCountThreshold(
        record.fileCountFail,
        DEFAULT_EXPORT_FILE_COUNT_FAIL,
      ),
    });
  }
  return presets;
}

function normalizeEditorUtilityObjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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
    startupSceneGuid: normalizeStartupSceneGuid(settings?.startupSceneGuid),
    render: normalizeRender(settings?.render),
    editorUtilityObjects: normalizeEditorUtilityObjects(
      settings?.editorUtilityObjects,
    ),
    pluginOverrides: normalizePluginOverrides(settings?.pluginOverrides),
    exportPresets: normalizeExportPresets(settings?.exportPresets),
    sourceControl: normalizeSourceControl(settings?.sourceControl),
  };
}

function normalizeSourceControl(
  value: Partial<SourceControlProjectSettings> | undefined,
): SourceControlProjectSettings {
  const poll =
    typeof value?.pollIntervalMs === "number" &&
    Number.isFinite(value.pollIntervalMs) &&
    value.pollIntervalMs >= 1_000
      ? Math.round(value.pollIntervalMs)
      : DEFAULT_SOURCE_CONTROL_POLL_INTERVAL_MS;
  const branch =
    typeof value?.branch === "string" && value.branch.trim() !== ""
      ? value.branch.trim()
      : DEFAULT_SOURCE_CONTROL_BRANCH;
  return {
    enabled: value?.enabled === true,
    repositoryUrl:
      typeof value?.repositoryUrl === "string" ? value.repositoryUrl.trim() : "",
    branch,
    autoLockOnEdit: value?.autoLockOnEdit !== false,
    pollIntervalMs: poll,
  };
}

export function createEmptyProject(
  name: string,
  options?: {
    kind?: "empty" | "2d";
    render?: Partial<RenderProjectSettings>;
  },
): ProjectDocument {
  const now = new Date().toISOString();
  const twoD =
    options?.kind === "2d"
      ? {
          ...DEFAULT_TWO_D_PROJECT_SETTINGS,
          pixelPerfect: true,
          integerZoomSteps: true,
        }
      : undefined;
  return {
    metadata: {
      name,
      version: "1.0.0",
      createdAt: now,
      updatedAt: now,
    },
    settings: normalizeProjectSettings({
      ...(twoD ? { twoD } : {}),
      render: {
        ...NEW_PROJECT_RENDER_SETTINGS,
        ...options?.render,
        customResolution: options?.render?.customResolution ?? true,
      },
    }),
    scenes: [MAIN_SCENE_FILE],
    graphs: [MAIN_CLASS_FILE],
  };
}

export function createDefaultScene(
  viewportMode: ViewportMode = "3d",
): SerializedScene {
  return {
    name: "Main",
    viewportMode,
    settings: createDefaultSceneSettings(viewportMode),
    folders: [],
    actors:
      viewportMode === "2d"
        ? []
        : [
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

function optionalTypeClassId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMemberPins(value: unknown): GraphClassMemberPin[] {
  if (!Array.isArray(value)) return [];
  const pins: GraphClassMemberPin[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const pin: GraphClassMemberPin = {
      name,
      typeId: typeof row.typeId === "string" && row.typeId.trim()
        ? row.typeId.trim()
        : "float",
      direction: row.direction === "out" ? "out" : "in",
    };
    const typeClassId = optionalTypeClassId(row.typeClassId);
    if (typeClassId) pin.typeClassId = typeClassId;
    pins.push(pin);
  }
  return pins;
}

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
    const member: GraphClassMember = { id, kind, name };
    if (kind === "variable") {
      member.typeId =
        typeof row.typeId === "string" && row.typeId.trim()
          ? row.typeId.trim()
          : "float";
      const typeClassId = optionalTypeClassId(row.typeClassId);
      if (typeClassId) member.typeClassId = typeClassId;
      if ("defaultValue" in row) member.defaultValue = row.defaultValue;
      if (typeof row.functionId === "string" && row.functionId.trim()) {
        member.functionId = row.functionId.trim();
      }
    } else if (kind === "function" || kind === "event") {
      member.pins = normalizeMemberPins(row.pins);
    } else if (kind === "interface") {
      member.assetGuid =
        typeof row.assetGuid === "string" ? row.assetGuid.trim() : "";
    }
    members.push(member);
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
    components.push({
      id,
      classId,
      properties,
      parentId: typeof row.parentId === "string" ? row.parentId : null,
      transform: normalizeTransform(row.transform),
    });
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
