import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type EngineSettings,
} from "./app-settings";

/**
 * In-memory app settings for tests.
 */
export class MemoryAppSettingsStore implements AppSettingsStore {
  private settings = defaultEngineSettings();

  async load(): Promise<EngineSettings> {
    return engineSettingsSchema.parse(this.settings);
  }

  async save(settings: EngineSettings): Promise<void> {
    this.settings = engineSettingsSchema.parse(settings);
  }
}
