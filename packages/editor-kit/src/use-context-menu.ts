import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { NestedMenuItem } from "./nested-menu";

/** Matches dockview's own long-press drag timing so the two never disagree. */
export const CONTEXT_MENU_LONG_PRESS_MS = 500;

/** Hold this long before a pointer-down can become a reorder drag. */
export const DRAG_ARM_MS = 250;

/** Matches dockview's press tolerance, so arming a panel drag cancels the menu. */
export const CONTEXT_MENU_MOVE_TOLERANCE_PX = 8;

export type ContextMenuItem = NestedMenuItem;

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface UseContextMenuOptions {
  items: ContextMenuItem[];
  enabled?: boolean;
  longPressMs?: number;
}

export interface UseContextMenuResult {
  menu: ContextMenuState | null;
  closeMenu: () => void;
  /** Open the menu at viewport coordinates (e.g. after tile long-press). */
  openMenuAt: (
    clientX: number,
    clientY: number,
    itemsOverride?: ContextMenuItem[],
  ) => void;
  bind: {
    onContextMenu: (event: ReactMouseEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
  };
}

interface PressState {
  pointerId: number;
  startX: number;
  startY: number;
  timerId: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Portaled descendants, such as a dialog scrim, are React children of the bound
 * surface but live outside its DOM. A hold there belongs to the portal.
 */
function eventTargetIsInside(event: {
  currentTarget: EventTarget | null;
  target: EventTarget | null;
}): boolean {
  const current = event.currentTarget;
  const target = event.target;
  return (
    current instanceof Element &&
    target instanceof Node &&
    current.contains(target)
  );
}

/**
 * Long-press (~500 ms stationary) and contextmenu (mouse) open the same menu.
 * Cancels when the pointer moves beyond the movement threshold or on scroll.
 */
export function useContextMenu(
  options: UseContextMenuOptions,
): UseContextMenuResult {
  const {
    items,
    enabled = true,
    longPressMs = CONTEXT_MENU_LONG_PRESS_MS,
  } = options;
  const pressRef = useRef<PressState | null>(null);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  });
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Right mouse press: a drag (viewport orbit) must not end in a menu, and
  // platforms that fire contextmenu on press defer it to the release.
  const rightPressRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    pending: boolean;
    cleanup: () => void;
  } | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const clearPress = useCallback(() => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.timerId);
      pressRef.current = null;
      press.cleanup();
    }
  }, []);

  const openAt = useCallback(
    (clientX: number, clientY: number, itemsOverride?: ContextMenuItem[]) => {
      if (!enabled) return;
      const nextItems = itemsOverride ?? itemsRef.current;
      if (nextItems.length === 0) return;
      setMenu({ open: true, x: clientX, y: clientY, items: nextItems });
    },
    [enabled],
  );

  const clearRightPress = useCallback(() => {
    rightPressRef.current?.cleanup();
    rightPressRef.current = null;
  }, []);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!enabled || !eventTargetIsInside(event)) return;
      event.preventDefault();
      const right = rightPressRef.current;
      if (right?.moved) return;
      if (right && (event.buttons & 2) !== 0) {
        right.pending = true;
        return;
      }
      openAt(event.clientX, event.clientY);
    },
    [enabled, openAt],
  );

  const beginRightPress = useCallback(
    (event: React.PointerEvent) => {
      clearRightPress();
      const { pointerId } = event;
      const onMove = (next: PointerEvent) => {
        const right = rightPressRef.current;
        if (
          right &&
          next.pointerId === pointerId &&
          distance(right.x, right.y, next.clientX, next.clientY) >
            CONTEXT_MENU_MOVE_TOLERANCE_PX
        ) {
          right.moved = true;
        }
      };
      const onUp = (next: PointerEvent) => {
        if (next.pointerId !== pointerId || (next.buttons & 2) !== 0) return;
        const right = rightPressRef.current;
        // Windows fires contextmenu after this release; keep a drag flagged
        // until then so the menu stays closed.
        if (right?.pending && !right.moved) openAt(right.x, right.y);
        setTimeout(() => {
          if (rightPressRef.current === right) clearRightPress();
        }, 0);
      };
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("pointercancel", onUp, true);
      rightPressRef.current = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        pending: false,
        cleanup: () => {
          document.removeEventListener("pointermove", onMove, true);
          document.removeEventListener("pointerup", onUp, true);
          document.removeEventListener("pointercancel", onUp, true);
        },
      };
    },
    [clearRightPress, openAt],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (
        enabled &&
        event.pointerType === "mouse" &&
        event.button === 2 &&
        eventTargetIsInside(event)
      ) {
        beginRightPress(event);
        return;
      }
      if (!enabled || event.pointerType === "mouse" || !eventTargetIsInside(event))
        return;
      clearPress();
      if (!event.isPrimary) return;
      const { pointerId, clientX, clientY } = event;
      const onOtherPointer = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) clearPress();
      };
      const onPointerEnd = (next: PointerEvent) => {
        if (next.pointerId === pointerId) clearPress();
      };
      const onDocumentMove = (next: PointerEvent) => {
        if (
          next.pointerId === pointerId &&
          distance(clientX, clientY, next.clientX, next.clientY) >
            CONTEXT_MENU_MOVE_TOLERANCE_PX
        ) {
          clearPress();
        }
      };
      const onVisibilityChange = () => {
        if (document.hidden) clearPress();
      };
      // Only the active hold owns document listeners. Capture also catches a
      // second contact or release outside the bound tile, including portals.
      document.addEventListener("pointerdown", onOtherPointer, true);
      document.addEventListener("pointermove", onDocumentMove, true);
      document.addEventListener("pointerup", onPointerEnd, true);
      document.addEventListener("pointercancel", onPointerEnd, true);
      document.addEventListener("lostpointercapture", onPointerEnd, true);
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", clearPress);
      const timerId = setTimeout(() => {
        clearPress();
        openAt(clientX, clientY);
      }, longPressMs);
      pressRef.current = {
        pointerId,
        startX: clientX,
        startY: clientY,
        timerId,
        cleanup: () => {
          document.removeEventListener("pointerdown", onOtherPointer, true);
          document.removeEventListener("pointermove", onDocumentMove, true);
          document.removeEventListener("pointerup", onPointerEnd, true);
          document.removeEventListener("pointercancel", onPointerEnd, true);
          document.removeEventListener("lostpointercapture", onPointerEnd, true);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          window.removeEventListener("blur", clearPress);
        },
      };
    },
    [beginRightPress, clearPress, enabled, longPressMs, openAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
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
    (event: React.PointerEvent) => {
      const press = pressRef.current;
      if (press && press.pointerId === event.pointerId) {
        clearPress();
      }
    },
    [clearPress],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      const press = pressRef.current;
      if (press && press.pointerId === event.pointerId) {
        clearPress();
      }
    },
    [clearPress],
  );

  useEffect(() => {
    if (!enabled) return;

    const onScroll = (event: Event) => {
      clearPress();
      // A short viewport can make the menu itself scroll; only movement of the
      // underlying surface invalidates its anchor and dismisses it.
      if (
        event.target instanceof Element &&
        event.target.closest(".context-menu-panel")
      ) {
        return;
      }
      closeMenu();
    };

    // Scroll does not bubble, so capture on document to catch nested scrollers.
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, [clearPress, closeMenu, enabled]);

  useEffect(() => {
    if (!enabled) {
      clearPress();
      clearRightPress();
    }
    return () => {
      clearPress();
      clearRightPress();
    };
  }, [enabled, clearPress, clearRightPress]);

  return {
    menu,
    closeMenu,
    openMenuAt: openAt,
    bind: {
      onContextMenu,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}
