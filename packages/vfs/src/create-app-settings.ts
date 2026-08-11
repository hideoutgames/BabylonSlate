import type { AppSettingsStore } from "./app-settings";
import { ElectronAppSettingsStore } from "./electron-app-settings";
import { isElectronHost, isMobilePlatform } from "./platform";
import { PreferencesAppSettingsStore } from "./preferences-app-settings";
import { WebAppSettingsStore } from "./web-app-settings";

export function createAppSettingsStore(): AppSettingsStore {
  if (isMobilePlatform()) {
    return new PreferencesAppSettingsStore();
  }
  if (isElectronHost()) {
    return new ElectronAppSettingsStore();
  }
  return new WebAppSettingsStore();
}
