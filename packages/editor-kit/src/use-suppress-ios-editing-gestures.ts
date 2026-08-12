import { useEffect } from "react";
import {
  shouldSuppressIosEditingGesture,
  shouldSuppressIosHistoryInput,
} from "./ios-editing-gestures";

/**
 * Stops iOS standalone/PWA three-finger undo/redo from stealing viewport
 * pans. Text fields and SelectableText keep the system editing gestures.
 */
export function useSuppressIosEditingGestures(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onTouch = (event: TouchEvent) => {
      if (!shouldSuppressIosEditingGesture(event.touches.length, event.target)) {
        return;
      }
      event.preventDefault();
    };

    const onBeforeInput = (event: Event) => {
      const inputType =
        event instanceof InputEvent
          ? event.inputType
          : (event as { inputType?: string }).inputType;
      if (
        typeof inputType !== "string" ||
        !shouldSuppressIosHistoryInput(inputType, event.target)
      ) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("touchstart", onTouch, { passive: false });
    document.addEventListener("touchmove", onTouch, { passive: false });
    document.addEventListener("beforeinput", onBeforeInput);
    return () => {
      document.removeEventListener("touchstart", onTouch);
      document.removeEventListener("touchmove", onTouch);
      document.removeEventListener("beforeinput", onBeforeInput);
    };
  }, [enabled]);
}
