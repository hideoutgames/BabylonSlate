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
 * stay in memory for this session, and a failed read falls back to the
 * settings this store last saved or loaded.
 */
export class WebAppSettingsStore implements AppSettingsStore {
  /** The last save localStorage refused; newer than anything it holds. */
  private unsaved: EngineSettings | null = null;
  /** The settings this store last wrote to or read from localStorage. */
  private lastKnown: EngineSettings | null = null;

  async load(): Promise<EngineSettings> {
    if (this.unsaved) return this.unsaved;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        this.lastKnown = engineSettingsSchema.parse(JSON.parse(raw));
        return this.lastKnown;
      }
    } catch {
      /* fall back below */
    }
    return this.lastKnown ?? defaultEngineSettings();
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    try {
      localStorage.setItem(KEY, JSON.stringify(parsed));
      this.unsaved = null;
      this.lastKnown = parsed;
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
