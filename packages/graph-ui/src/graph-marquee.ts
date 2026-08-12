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

function clientOf(event: Event): { x: number; y: number } {
  return {
    x: (event as PointerEvent).clientX,
    y: (event as PointerEvent).clientY,
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
 * Listens on window capture so XYFlow cannot swallow the gesture.
 */
export function attachGraphPaneMarquee(
  wrapper: HTMLElement,
  options: {
    onMarqueeRect: (rect: ScreenRect | null) => void;
    onMarqueeEnd: (
      startClient: { x: number; y: number },
      endClient: { x: number; y: number },
    ) => void;
  },
): GraphMarqueeGestureHandle {
  let gesture: {
    timer: ReturnType<typeof setTimeout> | null;
    pointerId: number;
    startClient: { x: number; y: number };
    startTime: number;
    armed: boolean;
    moved: boolean;
  } | null = null;

  const clearGesture = () => {
    if (gesture?.timer) clearTimeout(gesture.timer);
    gesture = null;
    options.onMarqueeRect(null);
  };

  const onDown = (event: Event) => {
    const target = event.target as Node | null;
    if (!target || !wrapper.contains(target)) return;
    if (!isEmptyPaneTarget(event.target)) return;
    if (gesture?.timer) clearTimeout(gesture.timer);
    const startClient = clientOf(event);
    const next = {
      timer: null as ReturnType<typeof setTimeout> | null,
      pointerId: pointerIdOf(event),
      startClient,
      startTime: Date.now(),
      armed: false,
      moved: false,
    };
    next.timer = setTimeout(() => {
      if (!gesture || gesture.moved) return;
      gesture.armed = true;
      try {
        wrapper.setPointerCapture?.(gesture.pointerId);
      } catch {
        // jsdom may not implement setPointerCapture.
      }
    }, DRAG_ARM_MS);
    gesture = next;
  };

  const onMove = (event: Event) => {
    if (!gesture || pointerIdOf(event) !== gesture.pointerId) return;
    const point = clientOf(event);
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
    event.stopPropagation();
    const box = wrapper.getBoundingClientRect();
    options.onMarqueeRect({
      x: Math.min(gesture.startClient.x, point.x) - box.left,
      y: Math.min(gesture.startClient.y, point.y) - box.top,
      width: Math.abs(point.x - gesture.startClient.x),
      height: Math.abs(point.y - gesture.startClient.y),
    });
  };

  const onUp = (event: Event) => {
    if (!gesture || pointerIdOf(event) !== gesture.pointerId) return;
    const point = clientOf(event);
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
      event.stopPropagation();
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

  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  return {
    dispose: () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (gesture?.timer) clearTimeout(gesture.timer);
      gesture = null;
    },
  };
}
