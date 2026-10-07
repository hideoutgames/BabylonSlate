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

export const DEFAULT_FOCUS_KEEP_PANELS = {
  scene: ["viewport"],
  sceneLandscape: ["viewport"],
  sceneFoliage: ["viewport"],
  "scene-layer": ["viewport"],
  graph: ["graph"],
  enum: ["enum-members"],
  structure: ["structure-members"],
  "script-interface": ["script-interface-preview"],
  sprite: ["sprite-preview"],
  "sprite-animation": ["sprite-animation-preview"],
  tileset: ["tileset-preview"],
  tilemap: ["tilemap-paint"],
  material: ["material-graph"],
  "material-function": ["material-function-graph"],
  "plugin-settings": ["plugin-settings-details"],
  "anim-graph": ["anim-graph-graph"],
  animGraphObject: ["anim-object-graph"],
  "behaviour-tree": ["behaviour-tree-graph"],
  audio: ["audio-preview"],
  "audio-mixer": ["audio-mixer-details"],
  "input-action": ["input-bindings"],
  "input-axis": ["input-bindings"],
  "audio-channel": ["audio-channel-details"],
  "sound-attenuation": ["sound-attenuation-details"],
  "particle-emitter": ["particle-emitter-preview"],
  "particle-graph": ["particle-graph-canvas"],
  "particle-system": ["particle-system-preview"],
  model: ["model-preview"],
  skeleton: ["skeleton-preview"],
  animation: ["animation-preview"],
  "skybox-creator": ["skybox-creator-preview"],
  trace: ["trace-timeline"],
  texture: ["texture-preview"],
} as const;

function mutableFocusKeepPanels(): {
  [K in keyof typeof DEFAULT_FOCUS_KEEP_PANELS]: string[];
} {
  return Object.fromEntries(
    Object.entries(DEFAULT_FOCUS_KEEP_PANELS).map(([key, value]) => [
      key,
      [...value],
    ]),
  ) as { [K in keyof typeof DEFAULT_FOCUS_KEEP_PANELS]: string[] };
}

const focusKeepPanelList = (fallback: readonly string[]) =>
  z.array(z.string()).default([...fallback]);

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
  hardwareScalingLevel: z.number().positive().default(1),
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
  viewportSnapTranslate: z.number().finite().positive().optional(),
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
      playFromScene: z.boolean().default(true),
      overlayStats: z.boolean().default(true),
      overlayConsole: z.boolean().default(false),
      overlayInspector: z.boolean().default(false),
      overlayProfiler: z.boolean().default(false),
      pauseOnPlay: z.boolean().default(false),
      keepSimulationChanges: z.boolean().default(false),
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
      playFromScene: true,
      overlayStats: true,
      overlayConsole: false,
      overlayInspector: false,
      overlayProfiler: false,
      pauseOnPlay: false,
      keepSimulationChanges: false,
      profileDurationSeconds: 10,
      profileByteBudget: 16 * 1024 * 1024,
      profileGpuTiming: false,
    }),
  focusKeepPanels: z
    .object({
      scene: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.scene),
      sceneLandscape: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.sceneLandscape),
      sceneFoliage: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.sceneFoliage),
      "scene-layer": focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS["scene-layer"]),
      graph: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.graph),
      enum: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.enum),
      structure: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.structure),
      "script-interface": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["script-interface"],
      ),
      sprite: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.sprite),
      "sprite-animation": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["sprite-animation"],
      ),
      tileset: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.tileset),
      tilemap: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.tilemap),
      material: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.material),
      "material-function": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["material-function"],
      ),
      "plugin-settings": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["plugin-settings"],
      ),
      "anim-graph": focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS["anim-graph"]),
      animGraphObject: focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS.animGraphObject,
      ),
      "behaviour-tree": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["behaviour-tree"],
      ),
      audio: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.audio),
      "audio-mixer": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["audio-mixer"],
      ),
      "input-action": focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS["input-action"]),
      "input-axis": focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS["input-axis"]),
      "audio-channel": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["audio-channel"],
      ),
      "sound-attenuation": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["sound-attenuation"],
      ),
      "particle-emitter": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["particle-emitter"],
      ),
      "particle-graph": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["particle-graph"],
      ),
      "particle-system": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["particle-system"],
      ),
      model: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.model),
      skeleton: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.skeleton),
      animation: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.animation),
      "skybox-creator": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["skybox-creator"],
      ),
      trace: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.trace),
      texture: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.texture),
    })
    .default(mutableFocusKeepPanels),
}).transform((settings) => ({
  ...settings,
  // Older Prefab preferences used the grid spacing for movement snapping.
  // Materialize that value on load so later grid edits cannot change it.
  viewportSnapTranslate: settings.viewportSnapTranslate ?? settings.viewportGridSize,
}));

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
