import { z } from "zod";
import {
  DEFAULT_EDITOR_DROP_DISTANCE,
  DEFAULT_TRACE_BYTE_BUDGET,
  normalizeProjectAppearance,
} from "@babylonslate/core";

/** Each undo step retains a document snapshot; keep the history bounded. */
export const MAX_UNDO_HISTORY_LENGTH = 1000;
const MEBIBYTE = 1024 * 1024;
/** Per-document Undo memory limit, in bytes (Undo Memory Limit preference). */
export const DEFAULT_UNDO_BYTE_BUDGET = 16 * MEBIBYTE;
export const MIN_UNDO_BYTE_BUDGET = MEBIBYTE;
export const MAX_UNDO_BYTE_BUDGET = 1024 * MEBIBYTE;
/** Below this a visible viewport is unusably choppy. */
export const MIN_VIEWPORT_FRAME_CAP = 10;
export const MAX_VIEWPORT_FRAME_CAP = 240;
/** Hardware scaling 1 is native resolution; 4 is the quarter-scale floor rendering quality accepts. */
export const MIN_HARDWARE_SCALING_LEVEL = 1;
export const MAX_HARDWARE_SCALING_LEVEL = 4;

/**
 * Focus keep-list defaults: one key per dock document kind (plus the Scene
 * Landscape / Foliage modes and Animation Graph Object), each keeping that
 * editor's primary panel.
 */
export const DEFAULT_FOCUS_KEEP_PANELS = {
  scene: ["viewport"],
  sceneLandscape: ["viewport"],
  sceneFoliage: ["viewport"],
  "scene-layer": ["viewport"],
  graph: ["graph"],
  prefab: ["prefab-viewport"],
  enum: ["enum-members"],
  structure: ["structure-members"],
  "data-definition": ["data-definition-fields"],
  "data-tree": ["data-tree-entries"],
  "script-interface": ["script-interface-preview"],
  sprite: ["sprite-preview"],
  "sprite-animation": ["sprite-animation-preview"],
  tileset: ["tileset-preview"],
  tilemap: ["tilemap-paint"],
  material: ["material-graph"],
  "material-function": ["material-function-graph"],
  "material-instance": ["material-instance-preview"],
  "plugin-settings": ["plugin-settings-details"],
  "anim-graph": ["anim-graph-graph"],
  animGraphObject: ["anim-object-graph"],
  "behaviour-tree": ["behaviour-tree-graph"],
  audio: ["audio-preview"],
  "save-game": ["save-game-fields"],
  "audio-mixer": ["audio-mixer-details"],
  "input-action": ["input-bindings"],
  "input-axis": ["input-bindings"],
  "audio-channel": ["audio-channel-details"],
  "sound-attenuation": ["sound-attenuation-details"],
  "particle-emitter": ["particle-emitter-preview"],
  "particle-graph": ["particle-graph-canvas"],
  "particle-system": ["particle-system-preview"],
  water: ["water-preview"],
  "render-target": ["render-target-details"],
  "render-target-texture": ["render-target-texture-details"],
  model: ["model-preview"],
  skeleton: ["skeleton-preview"],
  animation: ["animation-preview"],
  "skybox-creator": ["skybox-creator-preview"],
  trace: ["trace-timeline"],
  texture: ["texture-preview"],
} as const;

type FocusKeepPanelKey = keyof typeof DEFAULT_FOCUS_KEEP_PANELS;

function mutableFocusKeepPanels(): Record<FocusKeepPanelKey, string[]> {
  return Object.fromEntries(
    Object.entries(DEFAULT_FOCUS_KEEP_PANELS).map(([key, value]) => [
      key,
      [...value],
    ]),
  ) as Record<FocusKeepPanelKey, string[]>;
}

/** Every default key is a schema key, so a new kind cannot be dropped on load. */
const focusKeepPanelsShape = Object.fromEntries(
  Object.entries(DEFAULT_FOCUS_KEEP_PANELS).map(([key, value]) => [
    key,
    z.array(z.string()).default([...value]),
  ]),
) as Record<FocusKeepPanelKey, z.ZodDefault<z.ZodArray<z.ZodString>>>;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A user-made editor theme; colors map token names (no `--`) to `#rrggbb`. */
export const customEditorThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  colors: z
    .record(z.string(), z.unknown())
    .transform((colors) =>
      Object.fromEntries(
        Object.entries(colors).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && HEX_COLOR.test(entry[1]),
        ).map(([key, value]) => [key, value.toLowerCase()]),
      ),
    ),
});

export type CustomEditorTheme = z.infer<typeof customEditorThemeSchema>;

export const engineSettingsSchema = z.object({
  automaticUpdatesEnabled: z.boolean().default(true),
  seenReleaseVersions: z.array(z.string()).catch([]).default([]),
  recents: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        tier: z.enum(["documents", "external", "opfs"]),
        lastOpenedAt: z.string(),
        createdAt: z.string().optional(),
        bookmark: z.string().nullable().optional(),
        appearance: z.unknown().transform(normalizeProjectAppearance).optional(),
        /** Cached `settings.sourceControl.enabled` so Homepage need not open the folder. */
        sourceControl: z.boolean().optional().catch(undefined),
      }),
    )
    .default([]),
  appearance: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      coarsePointerTargetScale: z.number().default(1),
    })
    .default({ theme: "system", coarsePointerTargetScale: 1 }),
  /**
   * Compact desktop density instead of the touch layout. Unset follows the
   * platform: on except on iOS and Android (`resolveCompactMode`).
   */
  compactMode: z.boolean().optional().catch(undefined),
  /** Active editor theme: a built-in theme id or a `customEditorThemes` id. */
  editorTheme: z.string().min(1).catch("default").default("default"),
  /** Invalid entries are dropped one by one so one bad theme keeps the rest. */
  customEditorThemes: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((themes) =>
      themes.flatMap((theme) => {
        const parsed = customEditorThemeSchema.safeParse(theme);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  undoHistoryLength: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_UNDO_HISTORY_LENGTH, Math.max(1, Math.round(value)));
  }, z.number().int().min(1).max(MAX_UNDO_HISTORY_LENGTH).default(50)),
  undoByteBudget: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_UNDO_BYTE_BUDGET, Math.max(MIN_UNDO_BYTE_BUDGET, Math.round(value)));
  }, z.number().int().min(MIN_UNDO_BYTE_BUDGET).max(MAX_UNDO_BYTE_BUDGET).default(DEFAULT_UNDO_BYTE_BUDGET)),
  traceByteBudget: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    // Leave headroom for whole-file JSON and native storage's base64 strings.
    return Math.min(256 * 1024 * 1024, Math.max(1024 * 1024, Math.round(value)));
  }, z.number().int().min(1024 * 1024).max(256 * 1024 * 1024).default(DEFAULT_TRACE_BYTE_BUDGET)),
  viewportFrameCap: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_VIEWPORT_FRAME_CAP, Math.max(MIN_VIEWPORT_FRAME_CAP, value));
  }, z.number().min(MIN_VIEWPORT_FRAME_CAP).max(MAX_VIEWPORT_FRAME_CAP).default(30)),
  viewportDropDistance: z.number().finite().positive().default(DEFAULT_EDITOR_DROP_DISTANCE),
  renderingOverridesEnabled: z.boolean().default(false),
  /** Shows developer diagnostics: the Feature Test starter, its device check, and Copy Error on load failures. */
  debugMode: z.boolean().default(false),
  /** Debug Mode only: check every WebGL call so load reports name the failing one. Slow. */
  traceGraphicsErrors: z.boolean().default(false),
  hardwareScalingLevel: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_HARDWARE_SCALING_LEVEL, Math.max(MIN_HARDWARE_SCALING_LEVEL, value));
  }, z.number().min(MIN_HARDWARE_SCALING_LEVEL).max(MAX_HARDWARE_SCALING_LEVEL).default(1)),
  modelImportDefaultScale: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.max(0.0001, value);
  }, z.number().positive().default(1)),
  viewportFlySpeed: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.max(0.0001, value);
  }, z.number().positive().default(8)),
  viewportGridSize: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.max(0.0001, value);
  }, z.number().positive().default(1)),
  viewportSnapRotateDeg: z.number().finite().positive().default(15),
  viewportSnapTranslate: z.number().finite().positive().default(1),
  viewportSnapScale: z.number().finite().positive().default(0.25),
  postProcessingEnabled: z.boolean().default(true),
  editorTextureLodEnabled: z.boolean().default(false),
  editorTextureLodQuality: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(1, Math.max(0.25, value));
  }, z.number().min(0.25).max(1).default(0.5)),
  textureBudgetEnabled: z.boolean().default(true),
  textureByteCeiling: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      8 * 1024 * 1024 * 1024,
      Math.max(256 * 1024 * 1024, value),
    );
  }, z.number().min(256 * 1024 * 1024).max(8 * 1024 * 1024 * 1024).default(2 * 1024 * 1024 * 1024)),
  audioBudgetEnabled: z.boolean().default(true),
  audioByteCeiling: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      2 * 1024 * 1024 * 1024,
      Math.max(32 * 1024 * 1024, value),
    );
  }, z.number().min(32 * 1024 * 1024).max(2 * 1024 * 1024 * 1024).default(256 * 1024 * 1024)),
  audioMaxVoices: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(128, Math.max(8, Math.round(value)));
  }, z.number().int().min(8).max(128).default(32)),
  thumbnailsEnabled: z.boolean().default(true),
  graphAssistantEnabled: z.boolean().default(true),
  graphShakeEnabled: z.boolean().default(true),
  readOnlyPinDefaults: z.boolean().default(false),
  graphAssistantDistance: z.number().min(8).max(200).default(48),
  graphDefaultZoom: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(1.5, Math.max(0.1, value));
  }, z.number().min(0.1).max(1.5).default(0.5)),
  /**
   * Editor command id → chords that replace its defaults. An empty list
   * unassigns the command; commands without an entry keep their defaults.
   */
  keybinds: z
    .record(z.string(), z.array(z.string()))
    .catch({})
    .default({}),
  debuggerDefaults: z
    .object({
      previewBuild: z.boolean().default(false),
      /** Play starts Simulate; Preview Build is ignored while this is set. */
      simulate: z.boolean().default(false),
      playFromScene: z.boolean().default(true),
      overlayStats: z.boolean().default(true),
      overlayConsole: z.boolean().default(false),
      overlayInspector: z.boolean().default(false),
      overlayProfiler: z.boolean().default(false),
      pauseOnPlay: z.boolean().default(false),
      keepSimulationChanges: z.boolean().default(false),
      /** Simulation pauses the first time each node reports an error. */
      pauseSimulationOnErrors: z.boolean().default(true),
      profileDurationSeconds: z.preprocess((value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return value;
        return Math.min(60, Math.max(1, Math.round(value)));
      }, z.number().int().min(1).max(60).default(10)),
      profileByteBudget: z.preprocess((value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return value;
        return Math.min(64 * 1024 * 1024, Math.max(4 * 1024 * 1024, Math.round(value)));
      }, z.number().int().min(4 * 1024 * 1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024)),
      profileGpuTiming: z.boolean().default(false),
    })
    .default({
      previewBuild: false,
      simulate: false,
      playFromScene: true,
      overlayStats: true,
      overlayConsole: false,
      overlayInspector: false,
      overlayProfiler: false,
      pauseOnPlay: false,
      keepSimulationChanges: false,
      pauseSimulationOnErrors: true,
      profileDurationSeconds: 10,
      profileByteBudget: 16 * 1024 * 1024,
      profileGpuTiming: false,
    }),
  focusKeepPanels: z
    .object(focusKeepPanelsShape)
    .default(mutableFocusKeepPanels),
});

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export const ENGINE_SETTINGS_CHANGED_EVENT = "babylonslate:engine-settings";
export type AppSettingsMutation = (settings: EngineSettings) => void;

export function defaultEngineSettings(): EngineSettings {
  return engineSettingsSchema.parse({});
}

export interface AppSettingsStore {
  load(): Promise<EngineSettings>;
  save(settings: EngineSettings): Promise<void>;
  update(mutate: AppSettingsMutation): Promise<EngineSettings>;
}

let settingsUpdateQueue: Promise<void> = Promise.resolve();

/** Serialize latest-read, mutation, validation, and persistence across stores. */
export function runSerializedAppSettingsUpdate(
  load: () => Promise<EngineSettings>,
  save: (settings: EngineSettings) => Promise<void>,
  mutate: AppSettingsMutation,
): Promise<EngineSettings> {
  const operation = settingsUpdateQueue.then(async () => {
    const next = engineSettingsSchema.parse(await load());
    mutate(next);
    const validated = engineSettingsSchema.parse(next);
    await save(validated);
    if (
      typeof globalThis.dispatchEvent === "function" &&
      typeof globalThis.CustomEvent === "function"
    ) {
      globalThis.dispatchEvent(
        new CustomEvent(ENGINE_SETTINGS_CHANGED_EVENT, {
          detail: {
            ...validated,
            theme: validated.appearance.theme,
          },
        }),
      );
    }
    return validated;
  });
  settingsUpdateQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
