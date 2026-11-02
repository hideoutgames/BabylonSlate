import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
} from "@haptic/editor-kit";

export type DragOutGestureHandlers = {
  /** False keeps presses from starting a drag; holds still open the menu. */
  dragEnabled: boolean;
  onDragMove: (id: string, clientX: number, clientY: number) => void;
  onDrop: (id: string, clientX: number, clientY: number) => void;
  onDragEnd: () => void;
  /** Touch or pen held in place. Mouse right-click is the item's own `contextmenu`. */
  onLongPress: (id: string, clientX: number, clientY: number) => void;
};

type Session = {
  pointerId: number;
  pointerType: string;
  id: string;
  startX: number;
  startY: number;
  canDrag: boolean;
  armed: boolean;
  moved: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
  detach: () => void;
};

/**
 * Swallow the click that the release ending a drag dispatches right after
 * it; the listener goes away with the current task, so a later click counts.
 */
function suppressReleaseClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * Drag-out gestures for items that are picked with ordinary clicks, such as
 * Assets panel cards; the List view gets the same rules from `TreeView`.
 * A mouse drags after 8px; touch and pen hold for 250ms first so early
 * movement scrolls, and a 500ms hold in place opens the menu. A second
 * pointer, a scroll of the container, focus loss or a hidden page cancels.
 * `containerRef` is the scroll container: after the hold it stops native
 * panning so the finger drags instead.
 */
export function useDragOutGestures(
  containerRef: RefObject<HTMLElement | null>,
  handlers: DragOutGestureHandlers,
): {
  /** `onPointerDown` for the item `id`. */
  pointerDown: (id: string, event: ReactPointerEvent) => void;
  /** Cancels a press that has not started dragging, e.g. when the container scrolls. */
  cancelPending: () => void;
} {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const sessionRef = useRef<Session | null>(null);

  const finish = useCallback((session: Session) => {
    if (sessionRef.current !== session) return;
    sessionRef.current = null;
    for (const timer of session.timers) clearTimeout(timer);
    session.detach();
    if (session.armed) handlersRef.current.onDragEnd();
  }, []);

  const pointerDown = useCallback(
    (id: string, event: ReactPointerEvent) => {
      const current = sessionRef.current;
      if (current) {
        // A second finger cancels, as in the Outliner.
        finish(current);
        return;
      }
      if (event.button !== 0 || event.isPrimary === false) return;
      const mouse = event.pointerType === "mouse";
      const session: Session = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        id,
        startX: event.clientX,
        startY: event.clientY,
        canDrag: mouse && handlersRef.current.dragEnabled,
        armed: false,
        moved: false,
        timers: [],
        detach: () => {},
      };
      if (!mouse) {
        if (handlersRef.current.dragEnabled) {
          session.timers.push(setTimeout(() => {
            if (!session.moved) session.canDrag = true;
          }, DRAG_ARM_MS));
        }
        session.timers.push(setTimeout(() => {
          if (session.moved || session.armed) return;
          // The menu overlay swallows the click the lifting finger delivers.
          finish(session);
          handlersRef.current.onLongPress(id, session.startX, session.startY);
        }, CONTEXT_MENU_LONG_PRESS_MS));
      }
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== session.pointerId) return;
        if (!session.armed) {
          const distance = Math.hypot(move.clientX - session.startX, move.clientY - session.startY);
          if (distance <= CONTEXT_MENU_MOVE_TOLERANCE_PX) return;
          session.moved = true;
          if (!session.canDrag) {
            // Moved before the hold: a scroll or a stray press, not a drag.
            finish(session);
            return;
          }
          session.armed = true;
        }
        handlersRef.current.onDragMove(session.id, move.clientX, move.clientY);
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== session.pointerId) return;
        if (session.armed) {
          handlersRef.current.onDrop(session.id, up.clientX, up.clientY);
          suppressReleaseClick();
        }
        finish(session);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === session.pointerId) finish(session);
      };
      const onOtherDown = (down: PointerEvent) => {
        if (down.pointerId !== session.pointerId) finish(session);
      };
      const onEnd = () => finish(session);
      const onVisibility = () => {
        if (document.hidden) finish(session);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("pointerdown", onOtherDown, true);
      window.addEventListener("blur", onEnd);
      document.addEventListener("visibilitychange", onVisibility);
      session.detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("pointerdown", onOtherDown, true);
        window.removeEventListener("blur", onEnd);
        document.removeEventListener("visibilitychange", onVisibility);
      };
      sessionRef.current = session;
    },
    [finish],
  );

  const cancelPending = useCallback(() => {
    const session = sessionRef.current;
    if (session && !session.armed) finish(session);
  }, [finish]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onTouchMove = (event: TouchEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerType !== "touch") return;
      if (event.touches.length !== 1) {
        finish(session);
        return;
      }
      if (!session.canDrag) return;
      // Pointer capture cannot stop native iOS panning: cancel the first
      // touchmove after the hold, as the Outliner tree does.
      if (event.cancelable) event.preventDefault();
      else finish(session);
    };
    // Installed before any touchstart, so WebKit allows synchronous cancellation.
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      element.removeEventListener("touchmove", onTouchMove);
      const session = sessionRef.current;
      if (session) finish(session);
    };
  }, [containerRef, finish]);

  return { pointerDown, cancelPending };
}
