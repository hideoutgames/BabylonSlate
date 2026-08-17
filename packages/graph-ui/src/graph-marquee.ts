import {
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
} from "@babylonslate/editor-kit";

export const MARQUEE_FALLBACK_WIDTH = 220;
export const MARQUEE_FALLBACK_HEIGHT = 88;

export type MarqueeNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
};

export type FlowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PaneMarqueePhase = "pending" | "pan" | "armed" | "marquee";

export function resolvePaneMarqueePhase(options: {
  elapsedMs: number;
  moved: boolean;
  armed?: boolean;
  dragArmMs?: number;
}): PaneMarqueePhase {
  const dragArmMs = options.dragArmMs ?? DRAG_ARM_MS;
  if (options.armed) {
    return options.moved ? "marquee" : "armed";
  }
  if (options.moved) return "pan";
  if (options.elapsedMs >= dragArmMs) return "armed";
  return "pending";
}

export function pointerMovedPastTolerance(
  from: { x: number; y: number },
  to: { x: number; y: number },
  tolerancePx = CONTEXT_MENU_MOVE_TOLERANCE_PX,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > tolerancePx;
}

export function flowRectFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): FlowRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function nodeMarqueeBox(node: MarqueeNode): FlowRect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? node.measured?.width ?? MARQUEE_FALLBACK_WIDTH,
    height: node.height ?? node.measured?.height ?? MARQUEE_FALLBACK_HEIGHT,
  };
}

function rectsIntersect(a: FlowRect, b: FlowRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function nodesIntersectingMarquee(
  nodes: readonly MarqueeNode[],
  rect: FlowRect,
): string[] {
  if (rect.width === 0 && rect.height === 0) return [];
  return nodes
    .filter((node) => rectsIntersect(nodeMarqueeBox(node), rect))
    .map((node) => node.id);
}

export type ScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GraphMarqueeGestureHandle = {
  dispose: () => void;
};

function pointerIdOf(event: Event): number {
  const id = (event as PointerEvent).pointerId;
  return typeof id === "number" ? id : 1;
}

function finitePoint(x: unknown, y: unknown): { x: number; y: number } | null {
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function touchSample(event: Event): { clientX: number; clientY: number } | undefined {
  const touchEvent = event as TouchEvent;
  return touchEvent.changedTouches?.[0] ?? touchEvent.touches?.[0];
}

/** Client coordinates from pointer/mouse events, or touches[0] on TouchEvent. */
export function clientPointFromEvent(
  event: Event,
): { x: number; y: number } | null {
  const touch = touchSample(event);
  if (touch) {
    return finitePoint(touch.clientX, touch.clientY);
  }
  return finitePoint(
    (event as PointerEvent).clientX,
    (event as PointerEvent).clientY,
  );
}

export function screenRectRelativeTo(
  start: { x: number; y: number },
  end: { x: number; y: number },
  origin: { left: number; top: number },
): ScreenRect {
  return {
    x: Math.min(start.x, end.x) - origin.left,
    y: Math.min(start.y, end.y) - origin.top,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function isEmptyPaneTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (!target.closest(".react-flow__pane")) return false;
  return !target.closest(
    ".react-flow__node, .react-flow__handle, .react-flow__edge",
  );
}

/**
 * Hold empty pane ~250ms then move to marquee. Immediate move pans (React Flow).
 * Once armed, window-capture mouse/touch/pointer moves are swallowed so d3-zoom
 * cannot pan under the overlay. XYFlow `selectionOnDrag` is not used.
 */
export function attachGraphPaneMarquee(
  wrapper: HTMLElement,
  options: {
    onMarqueeRect: (rect: ScreenRect | null) => void;
    onMarqueeEnd: (
      startClient: { x: number; y: number },
      endClient: { x: number; y: number },
    ) => void;
    onArmedChange?: (armed: boolean) => void;
  },
): GraphMarqueeGestureHandle {
  let gesture: {
    timer: ReturnType<typeof setTimeout> | null;
    pointerId: number;
    startClient: { x: number; y: number };
    startTime: number;
    armed: boolean;
    moved: boolean;
    captured: boolean;
  } | null = null;

  const clearGesture = () => {
    if (gesture?.timer) clearTimeout(gesture.timer);
    if (gesture?.armed) options.onArmedChange?.(false);
    gesture = null;
    options.onMarqueeRect(null);
  };

  const captureIfArmed = () => {
    if (!gesture?.armed || gesture.captured) return;
    try {
      wrapper.setPointerCapture?.(gesture.pointerId);
      gesture.captured = true;
    } catch {
      // jsdom may not implement setPointerCapture.
    }
  };

  const onDown = (event: Event) => {
    const target = event.target as Node | null;
    if (!target || !wrapper.contains(target)) return;
    if (!isEmptyPaneTarget(event.target)) return;
    if (gesture?.timer) clearTimeout(gesture.timer);
    const startClient = clientPointFromEvent(event);
    if (!startClient) return;
    const next = {
      timer: null as ReturnType<typeof setTimeout> | null,
      pointerId: pointerIdOf(event),
      startClient,
      startTime: Date.now(),
      armed: false,
      moved: false,
      captured: false,
    };
    next.timer = setTimeout(() => {
      if (!gesture || gesture.moved) return;
      gesture.armed = true;
      options.onArmedChange?.(true);
    }, DRAG_ARM_MS);
    gesture = next;
  };

  const onMove = (event: Event) => {
    if (!gesture) return;
    if (
      event.type === "pointermove" &&
      pointerIdOf(event) !== gesture.pointerId
    ) {
      return;
    }
    captureIfArmed();
    if (gesture.armed) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    const point = clientPointFromEvent(event);
    if (!point) return;
    if (pointerMovedPastTolerance(gesture.startClient, point)) {
      gesture.moved = true;
    }
    const phase = resolvePaneMarqueePhase({
      elapsedMs: Date.now() - gesture.startTime,
      moved: gesture.moved,
      armed: gesture.armed,
    });
    if (phase === "pan") {
      if (gesture.timer) {
        clearTimeout(gesture.timer);
        gesture.timer = null;
      }
      return;
    }
    if (phase !== "marquee") return;
    options.onMarqueeRect(
      screenRectRelativeTo(
        gesture.startClient,
        point,
        wrapper.getBoundingClientRect(),
      ),
    );
  };

  const onUp = (event: Event) => {
    if (!gesture || pointerIdOf(event) !== gesture.pointerId) return;
    const point = clientPointFromEvent(event) ?? gesture.startClient;
    if (pointerMovedPastTolerance(gesture.startClient, point)) {
      gesture.moved = true;
    }
    const phase = resolvePaneMarqueePhase({
      elapsedMs: Date.now() - gesture.startTime,
      moved: gesture.moved,
      armed: gesture.armed,
    });
    const start = gesture.startClient;
    if (phase === "marquee") {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.onMarqueeEnd(start, point);
    }
    try {
      if (wrapper.hasPointerCapture?.(gesture.pointerId)) {
        wrapper.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // jsdom may not implement releasePointerCapture.
    }
    clearGesture();
  };

  const touchMoveOptions: AddEventListenerOptions = {
    capture: true,
    passive: false,
  };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("touchmove", onMove, touchMoveOptions);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  return {
    dispose: () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("touchmove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (gesture?.timer) clearTimeout(gesture.timer);
      gesture = null;
    },
  };
}
