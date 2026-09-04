import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type AppSettingsMutation,
  type EngineSettings,
  runSerializedAppSettingsUpdate,
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

  update(mutate: AppSettingsMutation): Promise<EngineSettings> {
    return runSerializedAppSettingsUpdate(
      () => this.load(),
      (settings) => this.save(settings),
      mutate,
    );
  }
}
