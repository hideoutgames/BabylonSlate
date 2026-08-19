import type { EditorCameraController } from "./editor-camera";
import type { RenderScheduler } from "./render-scheduler";
import { orthoPanFromCanvasDelta, type CanvasRect } from "./two-d";

export interface ViewportGestureOptions {
  /** Called for a stationary single-finger tap (selection pick). */
  onTap?: (
    canvasX: number,
    canvasY: number,
    options?: { additive?: boolean },
  ) => void;
  /** Hold ~250ms then drag in 2D mode: marquee select. Immediate drag pans. */
  onMarquee?: (rect: CanvasRect) => void;
  /** Live marquee overlay while dragging; null when the overlay should hide. */
  onMarqueeMove?: (rect: CanvasRect | null) => void;
  /**
   * When true at pointer-down, one-finger drag marquees immediately in 2D and
   * 3D (no pan/look, no hold timer). Gizmo hits do not win.
   */
  dragSelectActive?: () => boolean;
  /** Fired when an armed drag-select gesture ends (tap or marquee). */
  onDragSelectEnd?: () => void;
  scheduler?: Pick<RenderScheduler, "acquireContinuous">;
  /**
   * World units panned per pixel of three-finger drag in 3D.
   * 2D uses 1:1 frustum mapping instead.
   */
  panScale?: number;
  /** Radians of look per pixel of one-finger / left-button drag. */
  orbitScale?: number;
  /**
   * When true at pointer-down (gizmo handle hit or an active gizmo drag),
   * a one-finger drag does not look the camera.
   */
  blockLook?: (canvasX: number, canvasY: number) => boolean;
  /**
   * Prefab RTT blit canvas is not the Engine input element. Forward
   * one-finger pointers so UtilityLayer gizmos can drag.
   */
  onPointer?: (
    type: "down" | "move" | "up",
    canvasX: number,
    canvasY: number,
    pointerId: number,
  ) => void;
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

function canvasRect(from: PointerSample, to: PointerSample): CanvasRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/**
 * Gesture contract from docs/design/gestures.md: one-finger tap picks;
 * one-finger drag looks in 3D (or orbits when `pivotAroundCenter`) and pans
 * in 2D; hold then move marquees in 2D; drag-select marquees immediately in
 * both modes; pinch zooms; three fingers pan. Two-finger translation does
 * not orbit or pan.
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
  /** Gizmo hit at pointer-down; not set when Drag Select is armed (gizmo does not win). */
  let skipTap = false;
  let tapAdditive = false;
  let marqueeArmed = false;
  let dragSelectGesture = false;
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

  const clearMarqueeOverlay = () => {
    options.onMarqueeMove?.(null);
  };

  const toCanvas = (event: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const panFromPointerDelta = (dx: number, dy: number) => {
    if (controller.mode === "2d") {
      const rect = canvas.getBoundingClientRect();
      const { deltaX, deltaY } = orthoPanFromCanvasDelta(
        dx,
        dy,
        controller.camera,
        { width: rect.width, height: rect.height },
      );
      controller.pan(deltaX, deltaY);
      return;
    }
    controller.pan(-dx * panScale, dy * panScale);
  };

  const onPointerDown = (event: PointerEvent) => {
    const point = toCanvas(event);
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) {
      downPoint = point;
      lastPoint = point;
      moved = false;
      tapAdditive =
        event.ctrlKey === true ||
        event.metaKey === true ||
        event.shiftKey === true;
      dragSelectGesture = options.dragSelectActive?.() === true;
      skipTap =
        !dragSelectGesture && options.blockLook?.(point.x, point.y) === true;
      skipLook = dragSelectGesture || skipTap;
      marqueeArmed = dragSelectGesture;
      options.onPointer?.("down", point.x, point.y, event.pointerId);
      clearMarqueeTimer();
      if (!dragSelectGesture && controller.mode === "2d" && !skipLook) {
        marqueeTimer = setTimeout(() => {
          marqueeArmed = true;
        }, MARQUEE_ARM_MS);
      }
    } else {
      const samples = [...pointers.values()];
      lastMid = midpoint(samples);
      lastSpread = spread(samples);
      lastPoint = null;
      if (dragSelectGesture) {
        clearMarqueeOverlay();
        dragSelectGesture = false;
        marqueeArmed = false;
      }
      acquireLease();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, toCanvas(event));
    const samples = [...pointers.values()];

    if (samples.length === 1) {
      const point = samples[0]!;
      options.onPointer?.("move", point.x, point.y, event.pointerId);
      if (
        downPoint &&
        Math.hypot(point.x - downPoint.x, point.y - downPoint.y) >
          TAP_TOLERANCE_PX
      ) {
        moved = true;
      }
      if (moved && (dragSelectGesture || marqueeArmed) && downPoint) {
        options.onMarqueeMove?.(canvasRect(downPoint, point));
        lastPoint = point;
        return;
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
          panFromPointerDelta(dx, dy);
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
      panFromPointerDelta(dx, dy);
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
        if (point) {
          options.onPointer?.("up", point.x, point.y, event.pointerId);
        }
        downPoint = null;
        skipLook = false;
        skipTap = false;
        marqueeArmed = false;
        dragSelectGesture = false;
        tapAdditive = false;
        clearMarqueeTimer();
        clearMarqueeOverlay();
      }
      return;
    }
    clearMarqueeTimer();
    options.onPointer?.("up", point.x, point.y, event.pointerId);
    const wasDragSelect = dragSelectGesture;
    if (!moved && !skipTap) {
      options.onTap?.(point.x, point.y, { additive: tapAdditive });
    } else if (
      options.onMarquee &&
      (wasDragSelect ||
        (controller.mode === "2d" && marqueeArmed && !skipLook))
    ) {
      options.onMarquee(canvasRect(downPoint, point));
    }
    if (wasDragSelect || marqueeArmed) {
      clearMarqueeOverlay();
    }
    if (wasDragSelect) {
      options.onDragSelectEnd?.();
    }
    downPoint = null;
    moved = false;
    skipLook = false;
    skipTap = false;
    marqueeArmed = false;
    dragSelectGesture = false;
    tapAdditive = false;
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
