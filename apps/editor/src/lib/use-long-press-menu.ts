import {
  useCallback,
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
  onMenu: (clientX: number, clientY: number) => void;
}): {
  onContextMenu: (event: ReactMouseEvent) => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
} {
  const { enabled = true, onMenu } = options;
  const onMenuRef = useRef(onMenu);
  onMenuRef.current = onMenu;
  const pressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timerId: ReturnType<typeof setTimeout>;
  } | null>(null);

  const clearPress = useCallback(() => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.timerId);
      pressRef.current = null;
    }
  }, []);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      onMenuRef.current(event.clientX, event.clientY);
    },
    [enabled],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      if (!enabled || event.pointerType === "mouse") return;
      clearPress();
      const { clientX, clientY, pointerId } = event;
      const timerId = setTimeout(() => {
        pressRef.current = null;
        onMenuRef.current(clientX, clientY);
      }, CONTEXT_MENU_LONG_PRESS_MS);
      pressRef.current = {
        pointerId,
        startX: clientX,
        startY: clientY,
        timerId,
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
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
