import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

/** Matches dockview's own long-press drag timing so the two never disagree. */
export const CONTEXT_MENU_LONG_PRESS_MS = 500;

/** Matches dockview's press tolerance, so arming a panel drag cancels the menu. */
export const CONTEXT_MENU_MOVE_TOLERANCE_PX = 8;

export interface ContextMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

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
  openMenuAt: (clientX: number, clientY: number) => void;
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
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Long-press (~500 ms stationary) and contextmenu (mouse) open the same menu.
 * Cancels when the pointer moves beyond the movement threshold or on scroll.
 */
export function useContextMenu(
  options: UseContextMenuOptions,
): UseContextMenuResult {
  const { items, enabled = true, longPressMs = CONTEXT_MENU_LONG_PRESS_MS } =
    options;
  const pressRef = useRef<PressState | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const clearPress = useCallback(() => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.timerId);
      pressRef.current = null;
    }
  }, []);

  const openAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!enabled || items.length === 0) return;
      setMenu({ open: true, x: clientX, y: clientY, items });
    },
    [enabled, items],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
      openAt(event.clientX, event.clientY);
    },
    [enabled, openAt],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === "mouse") return;
      clearPress();
      const timerId = setTimeout(() => {
        pressRef.current = null;
        openAt(event.clientX, event.clientY);
      }, longPressMs);
      pressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        timerId,
      };
    },
    [clearPress, enabled, longPressMs, openAt],
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

    const onScroll = () => {
      clearPress();
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
