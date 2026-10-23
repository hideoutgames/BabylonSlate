import { idleDeviceMotion, type DeviceMotionState } from "@haptic/core";
import type { InputMappings } from "./mappings";
import type { RawInputEvent } from "./ring-buffer";

type MotionEvent = Extract<RawInputEvent, { kind: "motion" }>;

/** Device motion as `touch` binding codes: tilt axes hold their value, Shake is a one-tick pulse. */
export const MOTION_CODES = {
  tiltX: "tilt-x",
  tiltY: "tilt-y",
  shake: "shake",
} as const;

/** Tilt from the calibrated pose that reads as a full axis (1). */
export const TILT_FULL_DEGREES = 30;
/** Acceleration, without gravity, that counts toward a shake. */
export const SHAKE_ACCELERATION = 12;
/** Readings at or above the shake acceleration, within the window, that make a shake. */
export const SHAKE_READINGS = 3;
export const SHAKE_WINDOW_SECONDS = 0.5;
/** No second shake until this long after one. */
export const SHAKE_COOLDOWN_SECONDS = 0.75;

/** Whether any binding reads device motion, so the host must start it. */
export function mappingsUseDeviceMotion(mappings: InputMappings): boolean {
  const codes = new Set<string>(Object.values(MOTION_CODES));
  return [...mappings.actions, ...mappings.axes].some((mapping) =>
    mapping.bindings.some((binding) => binding.device === "touch" && codes.has(binding.code)));
}

/** Difference in degrees, wrapped to (-180, 180]. */
function angleBetween(from: number, to: number): number {
  let delta = to - from;
  while (delta <= -180) delta += 360;
  while (delta > 180) delta -= 360;
  return delta;
}

/** A device-axis vector in screen axes: the screen is the device turned by `degrees`. */
function toScreen(x: number, y: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * Interprets motion samples: tilt from the calibrated pose, turned into the
 * screen's axes, and shakes. Pure: the same samples and tick lengths always
 * give the same values. Calibration survives `reset`, which only forgets the
 * current reading.
 */
export class MotionInput {
  private reading: MotionEvent | null = null;
  private zero = { beta: 0, gamma: 0 };
  private time = 0;
  private readonly jolts: number[] = [];
  private calmUntil = Number.NEGATIVE_INFINITY;
  private shaken = false;

  apply(event: MotionEvent): void {
    if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) {
      this.reading = null;
      this.jolts.length = 0;
      return;
    }
    this.reading = event;
    if (!(event.peakAcceleration >= SHAKE_ACCELERATION) || this.time < this.calmUntil) return;
    this.jolts.push(this.time);
    while (this.jolts.length > 0 && this.time - this.jolts[0]! > SHAKE_WINDOW_SECONDS) this.jolts.shift();
    if (this.jolts.length < SHAKE_READINGS) return;
    this.shaken = true;
    this.jolts.length = 0;
    this.calmUntil = this.time + SHAKE_COOLDOWN_SECONDS;
  }

  /** The current pose becomes zero tilt. Without a reading, it stays as it was. */
  calibrate(): void {
    if (this.reading) this.zero = { beta: this.reading.beta, gamma: this.reading.gamma };
  }

  reset(): void {
    this.reading = null;
    this.jolts.length = 0;
    this.shaken = false;
  }

  /** Ends the tick: its binding values, a shake included once. */
  step(deltaSeconds: number): Map<string, number> {
    this.time += deltaSeconds;
    const values = new Map<string, number>();
    const tilt = this.rawTilt();
    if (tilt.x !== 0) values.set(MOTION_CODES.tiltX, tilt.x);
    if (tilt.y !== 0) values.set(MOTION_CODES.tiltY, tilt.y);
    if (this.shaken) values.set(MOTION_CODES.shake, 1);
    this.shaken = false;
    return values;
  }

  state(): DeviceMotionState {
    const reading = this.reading;
    if (!reading) return idleDeviceMotion();
    const tilt = this.rawTilt();
    const acceleration = toScreen(reading.accelerationX, reading.accelerationY, reading.screenAngle);
    const rotation = toScreen(reading.rotationX, reading.rotationY, reading.screenAngle);
    return {
      available: true,
      tilt: { x: clampUnit(tilt.x), y: clampUnit(tilt.y) },
      acceleration: { x: acceleration.x, y: acceleration.y, z: reading.accelerationZ },
      rotationRate: { x: rotation.x, y: rotation.y, z: reading.rotationZ },
    };
  }

  /** Unclamped tilt in full-axis units; bindings clamp after their scale. */
  private rawTilt(): { x: number; y: number } {
    const reading = this.reading;
    if (!reading) return { x: 0, y: 0 };
    // Gamma grows as the right side goes down; beta shrinks as the top edge tips away.
    const right = angleBetween(this.zero.gamma, reading.gamma);
    const away = -angleBetween(this.zero.beta, reading.beta);
    const screen = toScreen(right, away, reading.screenAngle);
    return { x: screen.x / TILT_FULL_DEGREES, y: screen.y / TILT_FULL_DEGREES };
  }
}
