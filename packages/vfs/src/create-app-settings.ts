import type { AppSettingsStore } from "./app-settings";
import { ElectronAppSettingsStore } from "./electron-app-settings";
import { getElectronUserDataBridge, isMobilePlatform } from "./platform";
import { PreferencesAppSettingsStore } from "./preferences-app-settings";
import { WebAppSettingsStore } from "./web-app-settings";

export function createAppSettingsStore(): AppSettingsStore {
  if (isMobilePlatform()) {
    return new PreferencesAppSettingsStore();
  }
  const electronUserData = getElectronUserDataBridge();
  if (electronUserData) {
    return new ElectronAppSettingsStore(electronUserData);
  }
  return new WebAppSettingsStore();
}
