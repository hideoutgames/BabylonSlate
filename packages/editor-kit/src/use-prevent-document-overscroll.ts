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

    let previous: { x: number; y: number } | null = null;

    const clearTouch = () => {
      previous = null;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        clearTouch();
        return;
      }
      previous = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        clearTouch();
        return;
      }
      if (!previous) return;
      const { clientX, clientY } = event.touches[0];
      const deltaX = clientX - previous.x;
      const deltaY = clientY - previous.y;
      // Use the latest direction, including reversals before the finger crosses
      // its starting point. Multi-touch stays native until a new contact starts.
      previous = { x: clientX, y: clientY };
      if (shouldPreventDocumentOverscroll(event.target, deltaX, deltaY)) {
        event.preventDefault();
      }
    };

    document.addEventListener("touchstart", onTouchStart, {
      passive: true,
      capture: true,
    });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", clearTouch, { capture: true });
    document.addEventListener("touchcancel", clearTouch, { capture: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart, {
        capture: true,
      });
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", clearTouch, { capture: true });
      document.removeEventListener("touchcancel", clearTouch, {
        capture: true,
      });
    };
  }, [enabled]);
}
