import type { AppSettingsStore } from "./app-settings";
import { isMobilePlatform } from "./platform";
import { PreferencesAppSettingsStore } from "./preferences-app-settings";
import { WebAppSettingsStore } from "./web-app-settings";

export function createAppSettingsStore(): AppSettingsStore {
  if (isMobilePlatform()) {
    return new PreferencesAppSettingsStore();
  }
  return new WebAppSettingsStore();
}
