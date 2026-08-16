import { useEffect } from "react";
import {
  isCoarsePointerEnvironment,
  shouldPreventDocumentOverscroll,
} from "./prevent-document-overscroll";

/**
 * Blocks iOS Safari document rubber-band overscroll on coarse pointers while
 * allowing designated scroll regions (content browser, tab bar, homepage) to
 * scroll normally. CSS `overflow: hidden` on the shell is the primary lock;
 * this hook is the touch-event fallback for WebKit edge cases.
 */
export function usePreventDocumentOverscroll(enabled = true): void {
  useEffect(() => {
    if (!enabled || !isCoarsePointerEnvironment()) return;

    let startX = 0;
    let startY = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const deltaX = event.touches[0].clientX - startX;
      const deltaY = event.touches[0].clientY - startY;
      if (
        shouldPreventDocumentOverscroll(event.target, deltaX, deltaY)
      ) {
        event.preventDefault();
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, [enabled]);
}
