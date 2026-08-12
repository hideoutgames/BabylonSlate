import { z } from "zod";

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
  viewportFrameCap: z.number().positive().default(60),
  hardwareScalingLevel: z.number().positive().default(1),
  thumbnailsEnabled: z.boolean().default(true),
  graphDefaultZoom: z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(1.5, Math.max(0.1, value));
  }, z.number().min(0.1).max(1.5).default(0.5)),
  debuggerDefaults: z
    .object({
      showFps: z.boolean().default(false),
      logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn"),
    })
    .default({ showFps: false, logLevel: "warn" }),
  focusKeepPanels: z
    .object({
      scene: z.array(z.string()).default(["viewport"]),
      graph: z.array(z.string()).default(["graph"]),
    })
    .default({ scene: ["viewport"], graph: ["graph"] }),
});

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export function defaultEngineSettings(): EngineSettings {
  return engineSettingsSchema.parse({});
}

export interface AppSettingsStore {
  load(): Promise<EngineSettings>;
  save(settings: EngineSettings): Promise<void>;
}
