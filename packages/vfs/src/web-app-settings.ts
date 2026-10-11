import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type AppSettingsMutation,
  type EngineSettings,
  runSerializedAppSettingsUpdate,
} from "./app-settings";

export const ENGINE_SETTINGS_STORAGE_KEY = "babylonslate:engine-settings";
const KEY = ENGINE_SETTINGS_STORAGE_KEY;

/**
 * Web app-settings backend. Prefers localStorage; settings whose save fails
 * stay in memory for this session.
 */
export class WebAppSettingsStore implements AppSettingsStore {
  /** The last save localStorage refused; newer than anything it holds. */
  private unsaved: EngineSettings | null = null;

  async load(): Promise<EngineSettings> {
    if (this.unsaved) return this.unsaved;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        return engineSettingsSchema.parse(JSON.parse(raw));
      }
    } catch {
      /* ignore */
    }
    return defaultEngineSettings();
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    try {
      localStorage.setItem(KEY, JSON.stringify(parsed));
      this.unsaved = null;
    } catch {
      this.unsaved = parsed;
    }
  }

  update(mutate: AppSettingsMutation): Promise<EngineSettings> {
    return runSerializedAppSettingsUpdate(
      () => this.load(),
      (settings) => this.save(settings),
      mutate,
    );
  }
}
