import { isMobilePlatform } from "@babylonslate/vfs";

export function usePlatformLayoutOptions() {
  return {
    disableFloatingGroups: isMobilePlatform(),
    disablePopout: isMobilePlatform(),
  };
}
