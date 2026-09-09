import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { CONTEXT_MENU_MOVE_TOLERANCE_PX } from "@babylonslate/editor-kit";

/** Native scrolling owns movement; only an uninterrupted contact may activate a card. */
export function useHomepageCardTouch(enabled: boolean) {
  const blocked = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    blocked.current = true;
    release.current?.();
  }, []);

  useEffect(() => {
    if (!enabled) cancel();
    return () => release.current?.();
  }, [enabled, cancel]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    release.current?.();
    blocked.current = !enabled;
    if (!enabled) return false;
    if (event.pointerType === "mouse") return true;
    const target = event.currentTarget;
    if (!event.isPrimary || target.closest('[data-scrolling="true"]')) {
      blocked.current = true;
      return false;
    }
    const { pointerId, clientX, clientY } = event;
    target.dataset.touchPressed = "true";
    const move = (next: globalThis.PointerEvent) => {
      if (
        next.pointerId === pointerId &&
        Math.hypot(next.clientX - clientX, next.clientY - clientY) >
          CONTEXT_MENU_MOVE_TOLERANCE_PX
      )
        cancel();
    };
    const end = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      release.current?.();
    };
    const interrupted = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) cancel();
    };
    const secondPointer = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) cancel();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("pointerdown", secondPointer, true);
    document.addEventListener("pointermove", move, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", interrupted, true);
    document.addEventListener("lostpointercapture", interrupted, true);
    document.addEventListener("scroll", cancel, {
      capture: true,
      passive: true,
    });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", cancel);
    release.current = () => {
      delete target.dataset.touchPressed;
      document.removeEventListener("pointerdown", secondPointer, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", interrupted, true);
      document.removeEventListener("lostpointercapture", interrupted, true);
      document.removeEventListener("scroll", cancel, true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", cancel);
      release.current = null;
    };
    return true;
  };

  return {
    onPointerDown,
    // Keep keyboard/assistive activation independent of the previous touch.
    shouldActivate: (event: MouseEvent) =>
      enabled && (event.detail === 0 || !blocked.current),
  };
}
