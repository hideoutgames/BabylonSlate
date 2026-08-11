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
  debuggerDefaults: z
    .object({
      showFps: z.boolean().default(false),
      logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn"),
    })
    .default({ showFps: false, logLevel: "warn" }),
});

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export function defaultEngineSettings(): EngineSettings {
  return engineSettingsSchema.parse({});
}

export interface AppSettingsStore {
  load(): Promise<EngineSettings>;
  save(settings: EngineSettings): Promise<void>;
}
