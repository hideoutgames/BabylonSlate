import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DEFAULT_PAN_ZOOM_LIMITS,
  centeredView,
  fitScale,
  panView,
  pinchView,
  viewToContent,
  zoomViewAbout,
  type PanZoomLimits,
  type PanZoomSize,
  type PanZoomView,
  type PinchOrigin,
} from "./pan-zoom-model";

/** Where the view rests until the user pans or zooms: fitted inside the surface, or at 1:1. */
export type PanZoomBase = "fit" | "actual";

/** Movement before a one-finger or mouse drag pans, so taps and clicks still reach the content. */
const PAN_THRESHOLD_PX = 4;

export interface PanZoomSurfaceOptions {
  /** Content size in content units (image pixels); null until known. */
  content: PanZoomSize | null;
  base: PanZoomBase;
  /** Surface pixels kept clear around fitted content. */
  inset?: number;
  limits?: PanZoomLimits;
  enabled?: boolean;
}

export interface PanZoomSurface {
  /** Attach to the element that receives gestures and clips the content. */
  surfaceRef: (element: HTMLDivElement | null) => void;
  surfaceSize: PanZoomSize;
  /** Null until both the content and the surface have a size. */
  view: PanZoomView | null;
  /** True once the user panned or zoomed away from the base view. */
  adjusted: boolean;
  /** Returns to the base view. */
  reset: () => void;
  /** Applies a view chosen by the host (zoom buttons, framing). */
  setView: (view: PanZoomView) => void;
  /** Spread on the surface element. */
  surfaceProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  /** Client point → content coordinates under the current view. */
  toContent: (clientX: number, clientY: number) => { x: number; y: number } | null;
}

/**
 * Drag to pan, pinch or wheel to zoom about the pointer, over flat content
 * such as a texture or an artboard. One finger or the mouse pans after a few
 * pixels so taps on the content still land; children that own a drag (resize
 * handles) stop propagation on pointer down.
 */
export function usePanZoomSurface({
  content,
  base,
  inset = 0,
  limits = DEFAULT_PAN_ZOOM_LIMITS,
  enabled = true,
}: PanZoomSurfaceOptions): PanZoomSurface {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [surfaceSize, setSurfaceSize] = useState<PanZoomSize>({ width: 0, height: 0 });
  const [userView, setUserView] = useState<PanZoomView | null>(null);

  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSurfaceSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  const contentWidth = content?.width ?? 0;
  const contentHeight = content?.height ?? 0;
  // A new base or new content starts from the base view again.
  useEffect(() => setUserView(null), [base, contentWidth, contentHeight]);

  const hasSize = contentWidth > 0 && contentHeight > 0 && surfaceSize.width > 0 && surfaceSize.height > 0;
  const baseView = hasSize
    ? centeredView(
        { width: contentWidth, height: contentHeight },
        surfaceSize,
        base === "fit" ? fitScale({ width: contentWidth, height: contentHeight }, surfaceSize, inset) : 1,
      )
    : null;
  const view = hasSize ? (userView ?? baseView) : null;
  const viewRef = useRef(view);
  viewRef.current = view;
  const baseViewRef = useRef(baseView);
  baseViewRef.current = baseView;
  /** Moves arriving before the next render build on each other, not on a stale view. */
  const updateView = (change: (from: PanZoomView) => PanZoomView) =>
    setUserView((prev) => {
      const from = prev ?? baseViewRef.current;
      return from ? change(from) : prev;
    });

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number; panning: boolean } | null>(null);
  const pinch = useRef<PinchOrigin | null>(null);
  const gestured = useRef(false);

  const surfacePoint = (clientX: number, clientY: number) => {
    const rect = element?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY };
  };

  const startPinch = () => {
    const current = viewRef.current;
    const [a, b] = [...pointers.current.values()];
    if (!current || !a || !b) return;
    drag.current = null;
    gestured.current = true;
    pinch.current = {
      view: current,
      mid: surfacePoint((a.x + b.x) / 2, (a.y + b.y) / 2),
      spread: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      gestured.current = false;
      drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, panning: false };
    } else if (pointers.current.size === 2) {
      event.preventDefault();
      startPinch();
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      event.preventDefault();
      setUserView(pinchView(pinch.current, surfacePoint((a!.x + b!.x) / 2, (a!.y + b!.y) / 2), Math.hypot(a!.x - b!.x, a!.y - b!.y), limits));
      return;
    }
    const current = drag.current;
    if (!current || current.id !== event.pointerId || !viewRef.current) return;
    if (!current.panning) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < PAN_THRESHOLD_PX) return;
      current.panning = true;
      gestured.current = true;
      try {
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic pointers (jsdom, Playwright) have no active pointer to capture.
      }
    }
    event.preventDefault();
    const dx = event.clientX - current.lastX;
    const dy = event.clientY - current.lastY;
    updateView((from) => panView(from, dx, dy));
    current.lastX = event.clientX;
    current.lastY = event.clientY;
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    pinch.current = null;
    const [remaining] = [...pointers.current.entries()];
    // The finger left after a pinch keeps panning from where it is, without a jump.
    drag.current = remaining
      ? { id: remaining[0], startX: remaining[1].x, startY: remaining[1].y, lastX: remaining[1].x, lastY: remaining[1].y, panning: true }
      : null;
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!gestured.current) return;
    gestured.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  // React wheel listeners are passive and cannot prevent page zoom or scroll.
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = (event) => {
    if (!enabled || !viewRef.current || event.deltaY === 0) return;
    event.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
    const pivot = surfacePoint(event.clientX, event.clientY);
    updateView((from) => zoomViewAbout(from, factor, pivot, limits));
  };
  useEffect(() => {
    if (!element) return;
    const listener = (event: WheelEvent) => wheel.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [element]);

  const reset = useCallback(() => setUserView(null), []);
  const setView = useCallback((next: PanZoomView) => setUserView(next), []);

  return {
    surfaceRef: setElement,
    surfaceSize,
    view,
    adjusted: userView !== null,
    reset,
    setView,
    surfaceProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onClickCapture,
    },
    toContent: (clientX, clientY) => (view ? viewToContent(view, surfacePoint(clientX, clientY)) : null),
  };
}
