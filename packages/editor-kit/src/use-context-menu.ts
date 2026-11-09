import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { NestedMenuItem } from "./nested-menu";
import { keepsNativeMenu } from "./use-suppress-native-context-menu";
import { holdDelayMs } from "./gesture-timing";

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
  /**
   * The menu items, or a function evaluated each time the menu opens, for
   * items that depend on state the gesture itself changes (a selection).
   */
  items: ContextMenuItem[] | (() => ContextMenuItem[]);
  enabled?: boolean;
  /** Fixed hold; unset follows the Hold Time setting (`holdDelayMs`). */
  longPressMs?: number;
}

export interface ContextMenuGestureBind {
  onContextMenu: (event: ReactMouseEvent) => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
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
  bind: ContextMenuGestureBind;
}

export interface UseContextMenuGestureOptions {
  /** Called with the menu's viewport coordinates when a hold or `contextmenu` asks for a menu. */
  onMenu: (clientX: number, clientY: number) => void;
  enabled?: boolean;
  /** Fixed hold; unset follows the Hold Time setting (`holdDelayMs`). */
  longPressMs?: number;
  /** Consume the click that follows a menu request, so a button bound to it does not also run its action. */
  suppressClickAfterHold?: boolean;
  /**
   * Keep presses and `contextmenu` on the bound surface from reaching its
   * ancestors, so a surface nested in another with its own menu (a Content
   * Browser tile in the grid) opens only its own.
   */
  exclusive?: boolean;
}

export interface UseContextMenuGestureResult extends ContextMenuGestureBind {
  /** Consumes the release click after a menu request when `suppressClickAfterHold` is on. */
  onClickCapture: (event: ReactMouseEvent) => void;
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

const claimedEvents = new WeakSet<Event>();

/**
 * Marks a press or contextmenu event as opening an inner surface's own menu
 * (a PropertyGrid row inside a list row), so menus bound on its ancestors
 * stay closed for it.
 */
export function claimContextMenuEvent(event: { nativeEvent: Event }): void {
  claimedEvents.add(event.nativeEvent);
}

function isClaimed(event: { nativeEvent: Event }): boolean {
  return claimedEvents.has(event.nativeEvent);
}

/**
 * The context menu gesture without menu state: a stationary touch or pen hold
 * (~500 ms) or `contextmenu` (mouse) reports where the menu opens. The hold
 * cancels on movement past the tolerance, scroll, release, a second pointer,
 * lost capture, focus loss or a hidden document. A right-button press reports
 * only on a stationary release, so a right-drag never opens a menu.
 */
export function useContextMenuGesture(
  options: UseContextMenuGestureOptions,
): UseContextMenuGestureResult {
  const {
    onMenu,
    enabled = true,
    longPressMs,
    suppressClickAfterHold = false,
    exclusive = false,
  } = options;
  const pressRef = useRef<PressState | null>(null);
  const onMenuRef = useRef(onMenu);
  useLayoutEffect(() => {
    onMenuRef.current = onMenu;
  });
  const suppressClickRef = useRef(false);
  // Right mouse press: a drag (viewport orbit) must not end in a menu, and
  // platforms that fire contextmenu on press defer it to the release.
  const rightPressRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    pending: boolean;
    cleanup: () => void;
  } | null>(null);

  const clearPress = useCallback(() => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.timerId);
      pressRef.current = null;
      press.cleanup();
    }
  }, []);

  const requestMenu = useCallback((clientX: number, clientY: number) => {
    suppressClickRef.current = true;
    onMenuRef.current(clientX, clientY);
  }, []);

  const clearRightPress = useCallback(() => {
    rightPressRef.current?.cleanup();
    rightPressRef.current = null;
  }, []);

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
      if (exclusive) event.stopPropagation();
      if (!eventTargetIsInside(event) || isClaimed(event)) {
        // Stopping propagation also keeps the event from the app-wide
        // suppression (`useSuppressNativeContextMenu`), so apply its rule here.
        if (exclusive && !keepsNativeMenu(event.target)) event.preventDefault();
        return;
      }
      event.preventDefault();
      const right = rightPressRef.current;
      if (right?.moved) return;
      if (right && (event.buttons & 2) !== 0) {
        right.pending = true;
        return;
      }
      // A touch hold can also fire contextmenu; open once.
      clearPress();
      requestMenu(event.clientX, event.clientY);
    },
    [clearPress, enabled, exclusive, requestMenu],
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
        if (right?.pending && !right.moved) requestMenu(right.x, right.y);
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
    [clearRightPress, requestMenu],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (exclusive) event.stopPropagation();
      suppressClickRef.current = false;
      if (isClaimed(event)) return;
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
      // second contact or release outside the bound tile, including portals,
      // and scroll, which does not bubble, from any nested scroller.
      document.addEventListener("pointerdown", onOtherPointer, true);
      document.addEventListener("pointermove", onDocumentMove, true);
      document.addEventListener("pointerup", onPointerEnd, true);
      document.addEventListener("pointercancel", onPointerEnd, true);
      document.addEventListener("lostpointercapture", onPointerEnd, true);
      document.addEventListener("scroll", clearPress, { capture: true, passive: true });
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", clearPress);
      const timerId = setTimeout(() => {
        clearPress();
        requestMenu(clientX, clientY);
      }, longPressMs ?? holdDelayMs());
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
          document.removeEventListener("scroll", clearPress, { capture: true });
          document.removeEventListener("visibilitychange", onVisibilityChange);
          window.removeEventListener("blur", clearPress);
        },
      };
    },
    [beginRightPress, clearPress, enabled, exclusive, longPressMs, requestMenu],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (exclusive) event.stopPropagation();
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      if (
        distance(press.startX, press.startY, event.clientX, event.clientY) >
        CONTEXT_MENU_MOVE_TOLERANCE_PX
      ) {
        clearPress();
      }
    },
    [clearPress, exclusive],
  );

  const onPointerEnd = useCallback(
    (event: React.PointerEvent) => {
      if (exclusive) event.stopPropagation();
      const press = pressRef.current;
      if (press && press.pointerId === event.pointerId) {
        clearPress();
      }
    },
    [clearPress, exclusive],
  );

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
    onClickCapture,
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
  };
}

/**
 * Long-press (~500 ms stationary) and contextmenu (mouse) open the same menu
 * (`useContextMenuGesture`). A scroll of the surface under an open menu closes it.
 */
export function useContextMenu(
  options: UseContextMenuOptions,
): UseContextMenuResult {
  const {
    items,
    enabled = true,
    longPressMs,
  } = options;
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  });
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const openAt = useCallback(
    (clientX: number, clientY: number, itemsOverride?: ContextMenuItem[]) => {
      if (!enabled) return;
      const source = itemsOverride ?? itemsRef.current;
      const nextItems = typeof source === "function" ? source() : source;
      if (nextItems.length === 0) return;
      setMenu({ open: true, x: clientX, y: clientY, items: nextItems });
    },
    [enabled],
  );

  const gesture = useContextMenuGesture({ enabled, longPressMs, onMenu: openAt });

  useEffect(() => {
    if (!enabled) return;

    const onScroll = (event: Event) => {
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
  }, [closeMenu, enabled]);

  return {
    menu,
    closeMenu,
    openMenuAt: openAt,
    bind: {
      onContextMenu: gesture.onContextMenu,
      onPointerDown: gesture.onPointerDown,
      onPointerMove: gesture.onPointerMove,
      onPointerUp: gesture.onPointerUp,
      onPointerCancel: gesture.onPointerCancel,
    },
  };
}
