import { Capacitor } from "@capacitor/core";

export function isMobilePlatform(): boolean {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android";
}

export function usePlatformLayoutOptions() {
  return {
    disableFloatingGroups: isMobilePlatform(),
    disablePopout: isMobilePlatform(),
  };
}
