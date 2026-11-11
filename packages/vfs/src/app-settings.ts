import { z } from "zod";
import {
  DEFAULT_EDITOR_DROP_DISTANCE,
  DEFAULT_TRACE_BYTE_BUDGET,
  DEFAULT_TRACES_KEPT,
  MAX_TRACES_KEPT,
  normalizeProjectAppearance,
} from "@haptic/core";

/** Each undo step retains a document snapshot; keep the history bounded. */
export const MAX_UNDO_HISTORY_LENGTH = 1000;
/** Placement trace reach for new actors; short, so far surfaces do not grab them. */
const DEFAULT_EDITOR_PLACEMENT_DISTANCE = 25;

const MEBIBYTE = 1024 * 1024;
/** Per-document Undo memory limit, in bytes (Undo Memory Limit preference). */
export const DEFAULT_UNDO_BYTE_BUDGET = 16 * MEBIBYTE;
export const MIN_UNDO_BYTE_BUDGET = MEBIBYTE;
export const MAX_UNDO_BYTE_BUDGET = 1024 * MEBIBYTE;
/** Below this a visible viewport is unusably choppy. */
export const MIN_VIEWPORT_FRAME_CAP = 10;
export const MAX_VIEWPORT_FRAME_CAP = 240;
/** Selected camera and capture lens previews; at most the rate a 60 Hz viewport presents. */
export const MIN_CAMERA_PREVIEW_FRAME_RATE = 1;
export const MAX_CAMERA_PREVIEW_FRAME_RATE = 60;
export const DEFAULT_CAMERA_PREVIEW_FRAME_RATE = 30;
/** Hardware scaling 1 is native resolution; 4 is the quarter-scale floor rendering quality accepts. */
export const MIN_HARDWARE_SCALING_LEVEL = 1;
export const MAX_HARDWARE_SCALING_LEVEL = 4;
/** Large Pins: graph pin glyph, hit-area and wire scale, in tenths. */
export const MIN_GRAPH_PIN_SCALE = 1;
export const MAX_GRAPH_PIN_SCALE = 2;
export const GRAPH_PIN_SCALE_STEP = 0.1;
/** Touch Target Size: multiplies the 44px touch target, in quarter steps. */
export const MIN_TOUCH_TARGET_SCALE = 1;
export const MAX_TOUCH_TARGET_SCALE = 2;
export const TOUCH_TARGET_SCALE_STEP = 0.25;
/** Text Size: the root font size as a percentage, in steps of 10. */
export const MIN_TEXT_SIZE_PERCENT = 50;
export const MAX_TEXT_SIZE_PERCENT = 150;
export const TEXT_SIZE_PERCENT_STEP = 10;
/** Hold Time: how long a stationary press takes to open a menu; drags arm at half of it. */
export const MIN_HOLD_TIME_MS = 300;
export const MAX_HOLD_TIME_MS = 1500;
export const HOLD_TIME_MS_STEP = 100;
export const DEFAULT_HOLD_TIME_MS = 500;
/** Double-Tap Time: the longest gap between the taps of a double-tap. */
export const MIN_DOUBLE_TAP_TIME_MS = 200;
export const MAX_DOUBLE_TAP_TIME_MS = 1000;
export const DOUBLE_TAP_TIME_MS_STEP = 50;
export const DEFAULT_DOUBLE_TAP_TIME_MS = 350;
/** Snapped Nodes: the grid a released graph node lands on, in graph units (pixels at 100% zoom). */
export const MIN_GRAPH_SNAP_GRID_SIZE = 1;
export const MAX_GRAPH_SNAP_GRID_SIZE = 200;
export const DEFAULT_GRAPH_SNAP_GRID_SIZE = 32;
/** Number Snap Strength: 0 Off, 1 Light, 2 Normal, 3 Strong. */
export const MAX_NUMBER_SNAP_STRENGTH = 3;
export const DEFAULT_NUMBER_SNAP_STRENGTH = 2;

/** A stepped number setting: rounds to its step and clamps to its range. */
function steppedNumber(min: number, max: number, step: number, fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    const stepped = Math.round((value - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(6))));
  }, z.number().min(min).max(max).default(fallback));
}
/** Linked Inspector Scale fields remembered on this device; linking another forgets the oldest. */
const MAX_LINKED_SCALE_KEYS = 1000;

/**
 * Focus keep-list defaults: one key per dock document kind (plus the Scene
 * Landscape / Foliage modes and Animation Graph Object), each keeping that
 * editor's primary panel.
 */
const DEFAULT_FOCUS_KEEP_PANELS = {
  scene: ["viewport"],
  sceneLandscape: ["viewport"],
  sceneFoliage: ["viewport"],
  sceneScript: ["graph"],
  sceneTimeline: ["viewport", "scene-timeline"],
  "scene-layer": ["viewport"],
  sceneLayerScript: ["graph"],
  sceneLayerTimeline: ["viewport", "scene-timeline"],
  graph: ["graph"],
  prefab: ["prefab-viewport"],
  enum: ["enum-members"],
  structure: ["structure-members"],
  "data-definition": ["data-definition-fields"],
  "data-tree": ["data-tree-entries"],
  "float-curve": ["curve-asset-editor"],
  timeline: ["timeline-asset-clips"],
  "timeline-clip-2d": ["timeline-clip-viewport", "timeline-clip-proxies", "timeline-clip-timeline"],
  "timeline-clip-3d": ["timeline-clip-viewport", "timeline-clip-proxies", "timeline-clip-timeline"],
  "vector-curve": ["curve-asset-editor"],
  "color-curve": ["curve-asset-editor"],
  "global-parameter-collection": ["global-parameter-collection"],
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
  "camera-shake": ["camera-shake-details"],
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
  "extension-asset": ["extension-asset-details"],
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
const customEditorThemeSchema = z.object({
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

/** Where Stack New 2D Actors applies: no host, 2D Scenes, Scene Layers, or both. */
export const STACK_NEW_ACTORS_2D_MODES = ["disabled", "scenes", "sceneLayers", "both"] as const;
export type StackNewActors2D = (typeof STACK_NEW_ACTORS_2D_MODES)[number];

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
    })
    .default({ theme: "system" }),
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
  /** Recorded traces kept per project on this device; recording another deletes the oldest beyond it. */
  tracesKept: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_TRACES_KEPT, Math.max(1, Math.round(value)));
  }, z.number().int().min(1).max(MAX_TRACES_KEPT).default(DEFAULT_TRACES_KEPT)),
  viewportFrameCap: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_VIEWPORT_FRAME_CAP, Math.max(MIN_VIEWPORT_FRAME_CAP, value));
  }, z.number().min(MIN_VIEWPORT_FRAME_CAP).max(MAX_VIEWPORT_FRAME_CAP).default(60)),
  cameraPreviewFrameRate: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(MAX_CAMERA_PREVIEW_FRAME_RATE, Math.max(MIN_CAMERA_PREVIEW_FRAME_RATE, value));
  }, z.number().min(MIN_CAMERA_PREVIEW_FRAME_RATE).max(MAX_CAMERA_PREVIEW_FRAME_RATE).default(DEFAULT_CAMERA_PREVIEW_FRAME_RATE)),
  viewportDropDistance: z.number().finite().positive().default(DEFAULT_EDITOR_DROP_DISTANCE),
  /** New actors placed into the 3D viewport land on the surface a trace from the camera hits. */
  viewportPlaceOnSurfaces: z.boolean().default(true),
  /** How far that trace reaches, in world units; a miss places the actor at its end. */
  viewportPlacementDistance: z.number().finite().positive().default(DEFAULT_EDITOR_PLACEMENT_DISTANCE),
  /** The viewport View menu's Show FPS: editor viewports show their rendered frames per second under the toolbar. */
  viewportShowFps: z.boolean().default(false),
  /**
   * Which 2D hosts stack new actors: an actor placed, dragged in, pasted or
   * duplicated there goes one Z-Order above the highest actor that draws.
   * Elsewhere placed actors take Z-Order 0 and copies keep theirs.
   */
  viewportStackNewActors2D: z.enum(STACK_NEW_ACTORS_2D_MODES).catch("disabled").default("disabled"),
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
  /** Largest cube face for `.hdr` panoramas imported from now on; each Texture can change its own. */
  hdrImportFaceSize: z.union([z.literal(128), z.literal(256), z.literal(512)]).catch(256).default(256),
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
  /** Inspector Scale fields whose axes are linked, by owner key, newest last; the rest start unlinked. */
  linkedScaleKeys: z
    .array(z.string())
    .catch([])
    .default([])
    .transform((keys) => keys.slice(-MAX_LINKED_SCALE_KEYS)),
  /** Project and Engine Settings sub-categories collapsed on this device, as `scope:category:section`; the rest start open. */
  collapsedSettingsSections: z.array(z.string()).catch([]).default([]),
  postProcessingEnabled: z.boolean().default(true),
  /** Scene viewports skip what solid shapes hide, as Play does with the project's Occlusion Culling on. */
  viewportOcclusionCulling: z.boolean().default(true),
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
  /** Rank Add Node picks from a dragged pin by past choices; off keeps the saved history. */
  graphAddNodeHistoryEnabled: z.boolean().default(true),
  readOnlyPinDefaults: z.boolean().default(false),
  /** Accessibility: tap one graph pin, then one on the other side, to connect them. */
  graphTapToConnect: z.boolean().default(false),
  /** Accessibility (Large Pins): multiplies graph pin glyphs, their hit areas and wires. */
  graphPinScale: steppedNumber(MIN_GRAPH_PIN_SCALE, MAX_GRAPH_PIN_SCALE, GRAPH_PIN_SCALE_STEP, MIN_GRAPH_PIN_SCALE),
  /** Accessibility: a type letter (B for Boolean) inside every graph data pin. */
  graphPinTypeLetters: z.boolean().default(false),
  /** Accessibility (Snapped Nodes): a released graph node drag lands on the `graphSnapGridSize` grid. */
  graphSnapNodes: z.boolean().default(false),
  graphSnapGridSize: steppedNumber(MIN_GRAPH_SNAP_GRID_SIZE, MAX_GRAPH_SNAP_GRID_SIZE, 1, DEFAULT_GRAPH_SNAP_GRID_SIZE),
  /** Accessibility: multiplies the touch target (44px) of controls, rows and pins. */
  touchTargetScale: steppedNumber(MIN_TOUCH_TARGET_SCALE, MAX_TOUCH_TARGET_SCALE, TOUCH_TARGET_SCALE_STEP, MIN_TOUCH_TARGET_SCALE),
  /** Accessibility: the editor's root font size, as a percentage. */
  textSizePercent: steppedNumber(MIN_TEXT_SIZE_PERCENT, MAX_TEXT_SIZE_PERCENT, TEXT_SIZE_PERCENT_STEP, 100),
  /** Accessibility: `system` follows the device's reduced-motion setting. */
  reduceMotion: z.enum(["system", "on", "off"]).catch("system").default("system"),
  /** Accessibility: hold before a press opens a menu; hold-to-drag arms at half of it. */
  holdTimeMs: steppedNumber(MIN_HOLD_TIME_MS, MAX_HOLD_TIME_MS, HOLD_TIME_MS_STEP, DEFAULT_HOLD_TIME_MS),
  /** Accessibility: the longest gap between the two taps of a double-tap. */
  doubleTapTimeMs: steppedNumber(MIN_DOUBLE_TAP_TIME_MS, MAX_DOUBLE_TAP_TIME_MS, DOUBLE_TAP_TIME_MS_STEP, DEFAULT_DOUBLE_TAP_TIME_MS),
  /** Accessibility: how long number field scrubs hold on round values. */
  numberSnapStrength: steppedNumber(0, MAX_NUMBER_SNAP_STRENGTH, 1, DEFAULT_NUMBER_SNAP_STRENGTH),
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
  /**
   * How the desktop app on a Mac signs packaged macOS games: a Developer ID
   * identity from this Mac's keychain (null signs ad-hoc, for local testing)
   * and the name of a notarytool keychain profile (empty skips notarization).
   * Per computer, as the keychain is; never credentials themselves.
   */
  macSigning: z
    .object({
      identity: z.string().min(1).max(256).nullable().catch(null).default(null),
      notaryProfile: z.string().max(128).regex(/^[A-Za-z0-9._-]*$/).catch("").default(""),
    })
    .catch({ identity: null, notaryProfile: "" })
    .default({ identity: null, notaryProfile: "" }),
  /**
   * How the desktop app on a Mac signs packaged iOS games: the Apple
   * Developer team Xcode's automatic signing uses, with the Apple account
   * signed into Xcode. Per computer; empty until set.
   */
  iosSigning: z
    .object({
      teamId: z.string().regex(/^(?:[A-Z0-9]{10})?$/).catch("").default(""),
    })
    .catch({ teamId: "" })
    .default({ teamId: "" }),
});

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export const ENGINE_SETTINGS_CHANGED_EVENT = "haptic:engine-settings";
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
