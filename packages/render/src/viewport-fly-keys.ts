import type { EditorCameraController } from "./editor-camera";
import type { RenderScheduler } from "./render-scheduler";

/** World units per second at full WASD deflection. */
export const DEFAULT_FLY_SPEED = 8;
/** Radians per second at full joystick deflection in Pivot Around Center. */
export const DEFAULT_ORBIT_SPEED = 1.5;

/**
 * Convert dt-scaled fly units from `ViewportJoystick` into look deltas.
 * Stick-right matches one-finger drag-right (negative yaw); stick-up pitches
 * the same way as dragging up.
 */
export function lookDeltaFromFlyDelta(
  forward: number,
  right: number,
): { deltaYaw: number; deltaPitch: number } {
  const scale = DEFAULT_ORBIT_SPEED / DEFAULT_FLY_SPEED;
  return {
    deltaYaw: -right * scale,
    deltaPitch: forward * scale,
  };
}

/**
 * Joystick analog: fly, or orbit around the target when Pivot Around Center
 * is on in 3D. WASD keeps calling `fly` so the center can still be translated.
 */
export function applyViewportJoystickSteer(
  controller: Pick<
    EditorCameraController,
    "mode" | "pivotAroundCenter" | "look" | "fly"
  >,
  forward: number,
  right: number,
): void {
  if (controller.pivotAroundCenter && controller.mode === "3d") {
    const { deltaYaw, deltaPitch } = lookDeltaFromFlyDelta(forward, right);
    controller.look(deltaYaw, deltaPitch);
    return;
  }
  controller.fly(forward, right);
}

const FLY_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

export interface ViewportFlyKeyOptions {
  scheduler?: Pick<RenderScheduler, "acquireContinuous">;
  speed?: number | (() => number);
  /** When false, keys are ignored (Play overlay, inactive document). */
  isEnabled?: () => boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

export interface ViewportFlyKeyHandle {
  dispose: () => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
  };
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

function flyAxis(keys: ReadonlySet<string>): { forward: number; right: number } {
  let forward = 0;
  let right = 0;
  if (keys.has("KeyW")) forward += 1;
  if (keys.has("KeyS")) forward -= 1;
  if (keys.has("KeyD")) right += 1;
  if (keys.has("KeyA")) right -= 1;
  const length = Math.hypot(forward, right);
  if (length > 1) {
    forward /= length;
    right /= length;
  }
  return { forward, right };
}

/**
 * WASD flies the editor camera. Listeners sit on `target` (usually `window`)
 * so the canvas does not need focus; text fields, a hidden canvas, and an
 * `isEnabled` gate keep the keys from stealing typing or Play input.
 */
export function attachViewportFlyKeys(
  target: EventTarget,
  controller: Pick<EditorCameraController, "fly">,
  canvas: Pick<HTMLCanvasElement, "clientWidth">,
  options: ViewportFlyKeyOptions = {},
): ViewportFlyKeyHandle {
  const resolveSpeed = () => {
    const raw =
      typeof options.speed === "function" ? options.speed() : options.speed;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_FLY_SPEED;
  };
  const requestFrame =
    options.requestFrame ??
    ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));

  const keys = new Set<string>();
  let frameId = 0;
  let lastTime = 0;
  let hasLastTime = false;
  let releaseLease: (() => void) | null = null;

  const enabled = () => {
    if (canvas.clientWidth === 0) return false;
    return options.isEnabled?.() ?? true;
  };

  const acquireLease = () => {
    if (!releaseLease && options.scheduler) {
      releaseLease = options.scheduler.acquireContinuous("viewport-fly");
    }
  };

  const dropLease = () => {
    releaseLease?.();
    releaseLease = null;
  };

  const stopLoop = () => {
    if (frameId !== 0) {
      cancelFrame(frameId);
      frameId = 0;
    }
    lastTime = 0;
    hasLastTime = false;
    dropLease();
  };

  const tick = (time: number) => {
    frameId = 0;
    if (!enabled() || keys.size === 0) {
      keys.clear();
      stopLoop();
      return;
    }
    let dt = 0;
    if (hasLastTime) {
      dt = Math.min(0.05, Math.max(0, (time - lastTime) / 1000));
    }
    lastTime = time;
    hasLastTime = true;
    const { forward, right } = flyAxis(keys);
    if (forward !== 0 || right !== 0) {
      acquireLease();
      const speed = resolveSpeed();
      controller.fly(forward * speed * dt, right * speed * dt);
    }
    frameId = requestFrame(tick);
  };

  const ensureLoop = () => {
    if (frameId !== 0) return;
    lastTime = 0;
    hasLastTime = false;
    frameId = requestFrame(tick);
  };

  const onKeyDown = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    if (!FLY_CODES.has(keyboard.code)) return;
    if (isEditableTarget(keyboard.target)) return;
    if (!enabled()) return;
    keys.add(keyboard.code);
    ensureLoop();
  };

  const onKeyUp = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    keys.delete(keyboard.code);
    if (keys.size === 0) stopLoop();
  };

  const onBlur = () => {
    keys.clear();
    stopLoop();
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return {
    dispose: () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
      keys.clear();
      stopLoop();
    },
  };
}
