import { Preferences } from "@capacitor/preferences";
import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type AppSettingsMutation,
  type EngineSettings,
  runSerializedAppSettingsUpdate,
} from "./app-settings";

const KEY = "babylonslate:engine-settings";

/**
 * Capacitor Preferences-backed Engine Settings (iPad / Android).
 */
export class PreferencesAppSettingsStore implements AppSettingsStore {
  async load(): Promise<EngineSettings> {
    const { value } = await Preferences.get({ key: KEY });
    if (!value) return defaultEngineSettings();
    return engineSettingsSchema.parse(JSON.parse(value));
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    await Preferences.set({ key: KEY, value: JSON.stringify(parsed) });
  }

  update(mutate: AppSettingsMutation): Promise<EngineSettings> {
    return runSerializedAppSettingsUpdate(
      () => this.load(),
      (settings) => this.save(settings),
      mutate,
    );
  }
}
