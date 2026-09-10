import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
} from "@babylonslate/editor-kit";

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Stationary ~500ms hold (touch/pen) or contextmenu (mouse) reports a menu
 * coordinate. Movement beyond the editor-kit tolerance cancels the hold so
 * the parent scroller can pan.
 */
export function useLongPressMenu(options: {
  enabled?: boolean;
  suppressClickAfterHold?: boolean;
  onMenu: (clientX: number, clientY: number) => void;
}): {
  onClickCapture: (event: ReactMouseEvent) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
} {
  const { enabled = true, suppressClickAfterHold = false, onMenu } = options;
  const suppressClickRef = useRef(false);
  const onMenuRef = useRef(onMenu);
  onMenuRef.current = onMenu;
  const pressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timerId: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  } | null>(null);

  const clearPress = useCallback(() => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.timerId);
      press.cleanup();
      pressRef.current = null;
    }
  }, []);

  useEffect(() => clearPress, [clearPress]);
  useEffect(() => {
    if (!enabled) clearPress();
  }, [enabled, clearPress]);

  const onClickCapture = useCallback(
    (event: ReactMouseEvent) => {
      if (!suppressClickAfterHold || !suppressClickRef.current) return;
      suppressClickRef.current = false;
      // Keyboard activation has no pointer release click to consume.
      if (event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [suppressClickAfterHold],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      clearPress();
      suppressClickRef.current = true;
      onMenuRef.current(event.clientX, event.clientY);
    },
    [enabled, clearPress],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      suppressClickRef.current = false;
      clearPress();
      if (
        !enabled ||
        event.pointerType === "mouse" ||
        event.isPrimary === false
      )
        return;
      const { clientX, clientY, pointerId } = event;
      const timerId = setTimeout(() => {
        clearPress();
        suppressClickRef.current = true;
        onMenuRef.current(clientX, clientY);
      }, CONTEXT_MENU_LONG_PRESS_MS);
      const cancelOnMove = (next: PointerEvent) => {
        if (
          next.pointerId === pointerId &&
          distance(clientX, clientY, next.clientX, next.clientY) >
            CONTEXT_MENU_MOVE_TOLERANCE_PX
        )
          clearPress();
      };
      const cancelOnRelease = (next: PointerEvent) => {
        if (next.pointerId === pointerId) clearPress();
      };
      document.addEventListener("pointermove", cancelOnMove, true);
      document.addEventListener("pointerup", cancelOnRelease, true);
      document.addEventListener("pointercancel", cancelOnRelease, true);
      document.addEventListener("pointerdown", clearPress, true);
      document.addEventListener("scroll", clearPress, true);
      window.addEventListener("blur", clearPress);
      pressRef.current = {
        pointerId,
        startX: clientX,
        startY: clientY,
        timerId,
        cleanup: () => {
          document.removeEventListener("pointermove", cancelOnMove, true);
          document.removeEventListener("pointerup", cancelOnRelease, true);
          document.removeEventListener("pointercancel", cancelOnRelease, true);
          document.removeEventListener("pointerdown", clearPress, true);
          document.removeEventListener("scroll", clearPress, true);
          window.removeEventListener("blur", clearPress);
        },
      };
    },
    [clearPress, enabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      if (
        distance(press.startX, press.startY, event.clientX, event.clientY) >
        CONTEXT_MENU_MOVE_TOLERANCE_PX
      ) {
        clearPress();
      }
    },
    [clearPress],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      const press = pressRef.current;
      if (press && press.pointerId === event.pointerId) {
        clearPress();
      }
    },
    [clearPress],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      const press = pressRef.current;
      if (press && press.pointerId === event.pointerId) {
        clearPress();
      }
    },
    [clearPress],
  );

  return {
    onClickCapture,
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
