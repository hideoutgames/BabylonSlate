import { isMobilePlatform } from "@babylonslate/vfs";

export function usePlatformLayoutOptions() {
  const mobile = isMobilePlatform();
  return {
    disableFloatingGroups: mobile,
    disablePopout: mobile,
    /** Pointer DnD on coarse/mobile; auto (html5 + pointer) on desktop. */
    dndStrategy: mobile ? ("pointer" as const) : ("auto" as const),
  };
}
