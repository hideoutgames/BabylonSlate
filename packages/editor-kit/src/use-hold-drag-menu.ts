import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
} from "./use-context-menu";

export interface UseHoldDragMenuOptions {
  enabled?: boolean;
  onArm?: () => void;
  onDragMove?: (clientX: number, clientY: number) => void;
  onDrop?: (clientX: number, clientY: number) => void;
  onMenu?: (clientX: number, clientY: number) => void;
}

export interface UseHoldDragMenuResult {
  armed: boolean;
  dragging: boolean;
  bind: {
    onPointerDown: (event: ReactPointerEvent) => void;
    onPointerMove: (event: ReactPointerEvent) => void;
    onPointerUp: (event: ReactPointerEvent) => void;
    onPointerCancel: (event: ReactPointerEvent) => void;
  };
}

interface PressState {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  armTimer: ReturnType<typeof setTimeout> | null;
  armed: boolean;
  dragging: boolean;
  moved: boolean;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Hold ~250ms to arm a drag; move after that to drop.
 * Context menu opens only on release after a stationary ~500ms hold —
 * never while the pointer is still down.
 */
export function useHoldDragMenu(
  options: UseHoldDragMenuOptions = {},
): UseHoldDragMenuResult {
  const { enabled = true, onArm, onDragMove, onDrop, onMenu } = options;
  const pressRef = useRef<PressState | null>(null);
  const onArmRef = useRef(onArm);
  const onDragMoveRef = useRef(onDragMove);
  const onDropRef = useRef(onDrop);
  const onMenuRef = useRef(onMenu);
  onArmRef.current = onArm;
  onDragMoveRef.current = onDragMove;
  onDropRef.current = onDrop;
  onMenuRef.current = onMenu;

  const [armed, setArmed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const clearPress = useCallback((releaseCapture?: { target: EventTarget | null; pointerId: number }) => {
    const press = pressRef.current;
    if (press?.armTimer) clearTimeout(press.armTimer);
    pressRef.current = null;
    setArmed(false);
    setDragging(false);
    if (releaseCapture?.target && "releasePointerCapture" in releaseCapture.target) {
      const node = releaseCapture.target as Element;
      try {
        node.releasePointerCapture?.(releaseCapture.pointerId);
      } catch {
        /* capture may already be released */
      }
    }
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!enabled || event.pointerType === "mouse") return;
      if (pressRef.current?.armTimer) clearTimeout(pressRef.current.armTimer);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const armTimer = setTimeout(() => {
        const press = pressRef.current;
        if (!press || press.moved) return;
        press.armed = true;
        setArmed(true);
        onArmRef.current?.();
      }, DRAG_ARM_MS);
      pressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: Date.now(),
        armTimer,
        armed: false,
        dragging: false,
        moved: false,
      };
    },
    [enabled],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (
      distance(press.startX, press.startY, event.clientX, event.clientY) <=
      CONTEXT_MENU_MOVE_TOLERANCE_PX
    ) {
      return;
    }
    press.moved = true;
    if (!press.armed) {
      clearPress({ target: event.currentTarget, pointerId: event.pointerId });
      return;
    }
    if (!press.dragging) {
      press.dragging = true;
      setDragging(true);
    }
    onDragMoveRef.current?.(event.clientX, event.clientY);
  }, [clearPress]);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) {
        clearPress();
        return;
      }
      const elapsed = Date.now() - press.startedAt;
      const wasDragging = press.dragging;
      const wasMoved = press.moved;
      clearPress({ target: event.currentTarget, pointerId: event.pointerId });
      if (wasDragging) {
        onDropRef.current?.(event.clientX, event.clientY);
        return;
      }
      if (!wasMoved && elapsed >= CONTEXT_MENU_LONG_PRESS_MS) {
        onMenuRef.current?.(event.clientX, event.clientY);
      }
    },
    [clearPress],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      clearPress({ target: event.currentTarget, pointerId: event.pointerId });
    },
    [clearPress],
  );

  return {
    armed,
    dragging,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}
