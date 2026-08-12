import type { EditorCameraController } from "./editor-camera";
import type { RenderScheduler } from "./render-scheduler";

export interface ViewportGestureOptions {
  /** Called for a stationary single-finger tap (selection pick). */
  onTap?: (canvasX: number, canvasY: number) => void;
  /** Single-finger drag in 2D mode: marquee select. */
  onMarquee?: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  scheduler?: Pick<RenderScheduler, "acquireContinuous">;
  /** World units panned per pixel of two-finger drag. */
  panScale?: number;
  orbitScale?: number;
}

export interface ViewportGestureHandle {
  dispose: () => void;
}

interface PointerSample {
  x: number;
  y: number;
}

const TAP_TOLERANCE_PX = 8;

function midpoint(points: PointerSample[]): PointerSample {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function spread(points: PointerSample[]): number {
  if (points.length < 2) return 0;
  return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
}

/**
 * Gesture contract from docs/design/gestures.md: one finger manipulates
 * content (tap to select, drag to marquee in 2D), two fingers orbit and pan,
 * pinch zooms. Orbit is suppressed in 2D by the camera controller.
 */
export function attachViewportGestures(
  canvas: HTMLCanvasElement,
  controller: EditorCameraController,
  options: ViewportGestureOptions = {},
): ViewportGestureHandle {
  const { panScale = 0.01, orbitScale = 0.005 } = options;
  const pointers = new Map<number, PointerSample>();
  let lastMid: PointerSample | null = null;
  let lastSpread = 0;
  let downPoint: PointerSample | null = null;
  let moved = false;
  let releaseLease: (() => void) | null = null;

  const acquireLease = () => {
    if (!releaseLease && options.scheduler) {
      releaseLease = options.scheduler.acquireContinuous("viewport-gesture");
    }
  };

  const dropLease = () => {
    releaseLease?.();
    releaseLease = null;
  };

  const toCanvas = (event: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    pointers.set(event.pointerId, toCanvas(event));
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) {
      downPoint = toCanvas(event);
      moved = false;
    } else {
      const samples = [...pointers.values()];
      lastMid = midpoint(samples);
      lastSpread = spread(samples);
      acquireLease();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, toCanvas(event));
    const samples = [...pointers.values()];

    if (samples.length === 1) {
      const point = samples[0]!;
      if (
        downPoint &&
        Math.hypot(point.x - downPoint.x, point.y - downPoint.y) >
          TAP_TOLERANCE_PX
      ) {
        moved = true;
      }
      return;
    }

    const mid = midpoint(samples);
    const currentSpread = spread(samples);
    if (lastMid) {
      const dx = mid.x - lastMid.x;
      const dy = mid.y - lastMid.y;
      if (controller.mode === "3d" && samples.length === 2 && currentSpread > 0) {
        // Two-finger drag orbits in 3D; panning uses the same drag in 2D where
        // orbit does not exist.
        controller.orbit(-dx * orbitScale, -dy * orbitScale);
      } else {
        controller.pan(-dx * panScale, dy * panScale);
      }
    }
    if (lastSpread > 0 && currentSpread > 0) {
      const factor = currentSpread / lastSpread;
      if (Math.abs(factor - 1) > 0.001) {
        controller.zoom(factor);
      }
    }
    lastMid = mid;
    lastSpread = currentSpread;
  };

  const endPointer = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (pointers.size < 2) {
      lastMid = null;
      lastSpread = 0;
      dropLease();
    }
    if (pointers.size > 0 || !point || !downPoint) {
      if (pointers.size === 0) downPoint = null;
      return;
    }
    if (!moved) {
      options.onTap?.(point.x, point.y);
    } else if (controller.mode === "2d" && options.onMarquee) {
      options.onMarquee({
        x: Math.min(downPoint.x, point.x),
        y: Math.min(downPoint.y, point.y),
        width: Math.abs(point.x - downPoint.x),
        height: Math.abs(point.y - downPoint.y),
      });
    }
    downPoint = null;
    moved = false;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    controller.zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    dispose: () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("wheel", onWheel);
      dropLease();
      pointers.clear();
    },
  };
}
