import { useTouchUi } from "@babylonslate/editor-kit";
import { isMobilePlatform } from "@babylonslate/vfs";
import { useCallback, useSyncExternalStore } from "react";

/** Narrow windows and phone landscape; full-size iPads keep their dock layout. */
export const PHONE_LAYOUT_QUERY =
  "(max-width: 767px), (max-height: 500px) and (pointer: coarse)";

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_LAYOUT_QUERY);
}

/**
 * Phone layout sizing (44px bars, rows and controls). The phone layout itself
 * is structural; its sizes follow Compact Mode like every other touch target.
 */
export function usePhoneTouchSizing(): boolean {
  const phone = usePhoneLayout();
  return useTouchUi() && phone;
}

/** The real pointer, for gestures and drag strategy; sizing reads `useTouchUi`. */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

export function usePlatformLayoutOptions() {
  const mobile = isMobilePlatform();
  const singleWindow = usePhoneLayout();
  const touch = useCoarsePointer();
  return {
    singleWindow,
    disableFloatingGroups: mobile || singleWindow,
    /** Pointer DnD on coarse/mobile; auto (html5 + pointer) on desktop. */
    dndStrategy: mobile || touch ? ("pointer" as const) : ("auto" as const),
  };
}
