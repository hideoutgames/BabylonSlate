import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type EngineSettings,
} from "./app-settings";

export const ENGINE_SETTINGS_STORAGE_KEY = "babylonslate:engine-settings";
const KEY = ENGINE_SETTINGS_STORAGE_KEY;

/**
 * Web app-settings backend. Prefers localStorage; falls back to in-memory.
 */
export class WebAppSettingsStore implements AppSettingsStore {
  private memory: EngineSettings | null = null;

  async load(): Promise<EngineSettings> {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        return engineSettingsSchema.parse(JSON.parse(raw));
      }
    } catch {
      /* ignore */
    }
    if (this.memory) return this.memory;
    return defaultEngineSettings();
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    this.memory = parsed;
    try {
      localStorage.setItem(KEY, JSON.stringify(parsed));
    } catch {
      /* memory-only fallback */
    }
  }
}
