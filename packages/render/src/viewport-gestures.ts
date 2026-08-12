import type { EditorCameraController } from "./editor-camera";
import type { RenderScheduler } from "./render-scheduler";

export interface ViewportGestureOptions {
  /** Called for a stationary single-finger tap (selection pick). */
  onTap?: (canvasX: number, canvasY: number) => void;
  /** Hold ~250ms then drag in 2D mode: marquee select. Immediate drag pans. */
  onMarquee?: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  scheduler?: Pick<RenderScheduler, "acquireContinuous">;
  /** World units panned per pixel of three-finger drag. */
  panScale?: number;
  /** Radians of look per pixel of one-finger / left-button drag. */
  orbitScale?: number;
  /**
   * When true at pointer-down (gizmo handle hit or an active gizmo drag),
   * a one-finger drag does not look the camera.
   */
  blockLook?: (canvasX: number, canvasY: number) => boolean;
}

export interface ViewportGestureHandle {
  dispose: () => void;
}

interface PointerSample {
  x: number;
  y: number;
}

const TAP_TOLERANCE_PX = 8;
/** Hold before a 2D one-finger drag becomes a marquee (matches editor-kit DRAG_ARM_MS). */
const MARQUEE_ARM_MS = 250;

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
 * Gesture contract from docs/design/gestures.md: one-finger tap picks;
 * one-finger drag looks in 3D and pans in 2D; hold then move marquees in 2D;
 * pinch zooms; three fingers pan. Two-finger translation does not orbit or pan.
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
  let lastPoint: PointerSample | null = null;
  let downPoint: PointerSample | null = null;
  let moved = false;
  let skipLook = false;
  let marqueeArmed = false;
  let marqueeTimer: ReturnType<typeof setTimeout> | null = null;
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

  const clearMarqueeTimer = () => {
    if (marqueeTimer !== null) {
      clearTimeout(marqueeTimer);
      marqueeTimer = null;
    }
  };

  const toCanvas = (event: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    const point = toCanvas(event);
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) {
      downPoint = point;
      lastPoint = point;
      moved = false;
      skipLook = options.blockLook?.(point.x, point.y) === true;
      marqueeArmed = false;
      clearMarqueeTimer();
      if (controller.mode === "2d" && !skipLook) {
        marqueeTimer = setTimeout(() => {
          marqueeArmed = true;
        }, MARQUEE_ARM_MS);
      }
    } else {
      const samples = [...pointers.values()];
      lastMid = midpoint(samples);
      lastSpread = spread(samples);
      lastPoint = null;
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
      if (
        controller.mode === "3d" &&
        moved &&
        !skipLook &&
        lastPoint
      ) {
        const dx = point.x - lastPoint.x;
        const dy = point.y - lastPoint.y;
        if (dx !== 0 || dy !== 0) {
          acquireLease();
          controller.look(-dx * orbitScale, -dy * orbitScale);
        }
      } else if (
        controller.mode === "2d" &&
        moved &&
        !skipLook &&
        !marqueeArmed &&
        lastPoint
      ) {
        const dx = point.x - lastPoint.x;
        const dy = point.y - lastPoint.y;
        if (dx !== 0 || dy !== 0) {
          acquireLease();
          controller.pan(-dx * panScale, dy * panScale);
          clearMarqueeTimer();
        }
      }
      lastPoint = point;
      return;
    }

    const mid = midpoint(samples);
    const currentSpread = spread(samples);
    if (samples.length >= 3 && lastMid) {
      const dx = mid.x - lastMid.x;
      const dy = mid.y - lastMid.y;
      controller.pan(-dx * panScale, dy * panScale);
    }
    if (samples.length === 2 && lastSpread > 0 && currentSpread > 0) {
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
    if (pointers.size === 1) {
      lastPoint = [...pointers.values()][0]!;
      lastMid = null;
      lastSpread = 0;
      dropLease();
    } else if (pointers.size === 0) {
      lastMid = null;
      lastSpread = 0;
      lastPoint = null;
      dropLease();
    } else {
      const samples = [...pointers.values()];
      lastMid = midpoint(samples);
      lastSpread = spread(samples);
    }
    if (pointers.size > 0 || !point || !downPoint) {
      if (pointers.size === 0) {
        downPoint = null;
        skipLook = false;
        marqueeArmed = false;
        clearMarqueeTimer();
      }
      return;
    }
    clearMarqueeTimer();
    if (!moved) {
      options.onTap?.(point.x, point.y);
    } else if (
      controller.mode === "2d" &&
      marqueeArmed &&
      !skipLook &&
      options.onMarquee
    ) {
      options.onMarquee({
        x: Math.min(downPoint.x, point.x),
        y: Math.min(downPoint.y, point.y),
        width: Math.abs(point.x - downPoint.x),
        height: Math.abs(point.y - downPoint.y),
      });
    }
    downPoint = null;
    moved = false;
    skipLook = false;
    marqueeArmed = false;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    controller.zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  const onTouch = (event: TouchEvent) => {
    event.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchstart", onTouch, { passive: false });
  canvas.addEventListener("touchmove", onTouch, { passive: false });

  return {
    dispose: () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouch);
      canvas.removeEventListener("touchmove", onTouch);
      clearMarqueeTimer();
      dropLease();
      pointers.clear();
    },
  };
}
