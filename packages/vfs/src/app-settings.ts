import { z } from "zod";

function clampMin(value: unknown, min: number): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return Math.max(min, value);
}

export const DEFAULT_FOCUS_KEEP_PANELS = {
  scene: ["viewport"],
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
  ui: ["ui-design"],
  uiLogic: ["graph"],
  "plugin-settings": ["plugin-settings-details"],
  "anim-graph": ["anim-graph-graph"],
  animGraphObject: ["anim-object-graph"],
  "behaviour-tree": ["behaviour-tree-graph"],
  audio: ["audio-preview"],
  "audio-mixer": ["audio-mixer-details"],
  "audio-channel": ["audio-channel-details"],
  "sound-attenuation": ["sound-attenuation-details"],
  "particle-emitter": ["particle-emitter-preview"],
  "particle-system": ["particle-system-preview"],
  "skybox-creator": ["skybox-creator-preview"],
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
  templatesFolder: z.string().nullable().default(null),
  defaultProjectLocation: z.string().nullable().default(null),
  recents: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        tier: z.enum(["documents", "external", "opfs"]),
        lastOpenedAt: z.string(),
        createdAt: z.string().optional(),
        bookmark: z.string().nullable().optional(),
      }),
    )
    .default([]),
  appearance: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      coarsePointerTargetScale: z.number().default(1),
    })
    .default({ theme: "system", coarsePointerTargetScale: 1 }),
  undoHistoryLength: z.number().int().positive().default(50),
  viewportFrameCap: z.number().positive().default(30),
  hardwareScalingLevel: z.number().positive().default(1),
  postProcessingEnabled: z.boolean().default(true),
  thumbnailsEnabled: z.boolean().default(true),
  graphDefaultZoom: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(1.5, Math.max(0.1, value));
  }, z.number().min(0.1).max(1.5).default(0.5)),
  debuggerDefaults: z
    .object({
      showFps: z.boolean().default(false),
      logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn"),
      previewBuild: z.boolean().default(false),
      overlayStats: z.boolean().default(true),
      overlayConsole: z.boolean().default(true),
      overlayInspector: z.boolean().default(true),
      pauseOnPlay: z.boolean().default(false),
    })
    .default({
      showFps: false,
      logLevel: "warn",
      previewBuild: false,
      overlayStats: true,
      overlayConsole: true,
      overlayInspector: true,
      pauseOnPlay: false,
    }),
  focusKeepPanels: z
    .object({
      scene: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.scene),
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
      ui: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.ui),
      uiLogic: focusKeepPanelList(DEFAULT_FOCUS_KEEP_PANELS.uiLogic),
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
      "audio-channel": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["audio-channel"],
      ),
      "sound-attenuation": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["sound-attenuation"],
      ),
      "particle-emitter": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["particle-emitter"],
      ),
      "particle-system": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["particle-system"],
      ),
      "skybox-creator": focusKeepPanelList(
        DEFAULT_FOCUS_KEEP_PANELS["skybox-creator"],
      ),
    })
    .default(mutableFocusKeepPanels),
  uiDesignerPresets: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        width: z.preprocess((value) => clampMin(value, 1), z.number().min(1)),
        height: z.preprocess((value) => clampMin(value, 1), z.number().min(1)),
        safeArea: z
          .object({
            left: z.preprocess((value) => clampMin(value, 0), z.number().min(0).default(0)),
            right: z.preprocess((value) => clampMin(value, 0), z.number().min(0).default(0)),
            top: z.preprocess((value) => clampMin(value, 0), z.number().min(0).default(0)),
            bottom: z.preprocess(
              (value) => clampMin(value, 0),
              z.number().min(0).default(0),
            ),
          })
          .default({ left: 0, right: 0, top: 0, bottom: 0 }),
      }),
    )
    .default([]),
});

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export function defaultEngineSettings(): EngineSettings {
  return engineSettingsSchema.parse({});
}

export interface AppSettingsStore {
  load(): Promise<EngineSettings>;
  save(settings: EngineSettings): Promise<void>;
}
