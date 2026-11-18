import type { EditorCameraController } from "./editor-camera";
import type { RenderScheduler } from "./render-scheduler";

/** Zoom factor of one tap of a viewport zoom button. */
export const VIEWPORT_ZOOM_TAP_FACTOR = 1.2;
/** Zoom factor per second while a viewport zoom button is held. */
export const VIEWPORT_ZOOM_RATE_PER_SECOND = 3;

/** 1 zooms in, -1 zooms out. */
export type ViewportZoomDirection = 1 | -1;

export interface ViewportZoomDriveOptions {
  scheduler?: Pick<RenderScheduler, "acquireContinuous">;
  /** When false, start and step do nothing and a running zoom ends. */
  isEnabled?: () => boolean;
  /** True applies a tap's whole step at once instead of gliding (Reduce Motion). */
  instantStep?: () => boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

export interface ViewportZoomDrive {
  /** A zoom button went down: zoom continuously in `direction` until `stop`. */
  start: (direction: ViewportZoomDirection) => void;
  /** The button was released: a press shorter than one tap step glides on to complete it, then ends. */
  stop: () => void;
  /** One whole tap step (keyboard activation): `start` then `stop`. */
  step: (direction: ViewportZoomDirection) => void;
  dispose: () => void;
}

const TAP_LOG = Math.log(VIEWPORT_ZOOM_TAP_FACTOR);
const RATE_LOG_PER_SECOND = Math.log(VIEWPORT_ZOOM_RATE_PER_SECOND);

/**
 * Frame-driven zoom for the viewport zoom buttons, in log-zoom space: a hold
 * zooms at a constant rate, and a release before one tap step glides on at
 * that rate until the press totals exactly one tap factor. Zooms about the
 * view centre (no pivot).
 */
export function createViewportZoomDrive(
  controller: Pick<EditorCameraController, "zoom">,
  options: ViewportZoomDriveOptions = {},
): ViewportZoomDrive {
  const requestFrame =
    options.requestFrame ??
    ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));
  const enabled = () => options.isEnabled?.() ?? true;

  let disposed = false;
  let active = false;
  let direction: ViewportZoomDirection = 1;
  let held = false;
  let elapsed = 0;
  let applied = 0;
  let frameId = 0;
  let lastTime = 0;
  let hasLastTime = false;
  let releaseLease: (() => void) | null = null;

  const end = () => {
    active = false;
    held = false;
    if (frameId !== 0) {
      cancelFrame(frameId);
      frameId = 0;
    }
    releaseLease?.();
    releaseLease = null;
  };

  const tick = (time: number) => {
    frameId = 0;
    if (!active) return;
    if (!enabled()) {
      end();
      return;
    }
    let dt = 0;
    if (hasLastTime) {
      const raw = (time - lastTime) / 1000;
      dt = Number.isFinite(raw) ? Math.min(0.05, Math.max(0, raw)) : 0;
    }
    lastTime = time;
    hasLastTime = true;
    elapsed += dt;
    let target = elapsed * RATE_LOG_PER_SECOND;
    if (!held && target > TAP_LOG) target = TAP_LOG;
    const delta = target - applied;
    if (delta > 0) {
      controller.zoom(Math.exp(direction * delta));
      applied = target;
    }
    if (!held && applied >= TAP_LOG) {
      end();
      return;
    }
    frameId = requestFrame(tick);
  };

  const start = (next: ViewportZoomDirection) => {
    if (disposed || !enabled()) return;
    if (frameId !== 0) {
      cancelFrame(frameId);
      frameId = 0;
    }
    active = true;
    direction = next;
    held = true;
    elapsed = 0;
    applied = 0;
    lastTime = 0;
    hasLastTime = false;
    if (!releaseLease && options.scheduler) {
      releaseLease = options.scheduler.acquireContinuous("viewport-zoom");
    }
    if (options.instantStep?.() === true) {
      controller.zoom(Math.exp(direction * TAP_LOG));
      applied = TAP_LOG;
    }
    frameId = requestFrame(tick);
  };

  const stop = () => {
    if (!active || !held) return;
    held = false;
    if (applied >= TAP_LOG) end();
  };

  return {
    start,
    stop,
    step: (next) => {
      start(next);
      stop();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      end();
    },
  };
}
