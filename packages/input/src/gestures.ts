import type { TouchInput } from "@babylonslate/core";

/**
 * Touch gestures as `touch` binding codes. Pulses are 1 for the tick that
 * recognizes them; the others hold their value for as long as the gesture
 * continues. Thresholds are CSS pixels and simulated seconds.
 */
export const TOUCH_GESTURE_CODES = {
  tap: "tap",
  doubleTap: "double-tap",
  longPress: "long-press",
  swipeUp: "swipe-up",
  swipeDown: "swipe-down",
  swipeLeft: "swipe-left",
  swipeRight: "swipe-right",
  pinch: "pinch",
  rotate: "two-finger-rotate",
  dragX: "two-finger-drag-x",
  dragY: "two-finger-drag-y",
} as const;

const C = TOUCH_GESTURE_CODES;

/** Codes that last one tick; the resolver releases them before the next tick samples. */
export const TOUCH_PULSE_GESTURES: readonly string[] = [C.tap, C.doubleTap, C.swipeUp, C.swipeDown, C.swipeLeft, C.swipeRight];

/** Movement a tap or a long press tolerates; the editor's long-press slop. */
export const GESTURE_SLOP_PX = 8;
/** Hold time that turns a press into a long press, and the longest a tap may last. */
export const LONG_PRESS_SECONDS = 0.5;
/** Longest gap from one tap's lift to the next tap's press for a double tap. */
export const DOUBLE_TAP_SECONDS = 0.3;
/** Farthest the second tap of a double tap may land from the first. */
export const DOUBLE_TAP_DISTANCE_PX = 32;
/** Shortest distance, from press to lift, of a swipe. */
export const SWIPE_MIN_DISTANCE_PX = 48;
/** Longest press-to-lift time of a swipe; a slower move is a drag. */
export const SWIPE_MAX_SECONDS = 0.5;

interface ContactGesture {
  startTime: number;
  startX: number;
  startY: number;
  /** Farthest the contact has been from where it began. */
  maxDistance: number;
  /** No other contact was down at any point of its life. */
  alone: boolean;
  longPress: boolean;
}

interface Pair {
  a: number;
  b: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const distance = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

/** Angle change wrapped to (-π, π]. */
function turn(from: number, to: number): number {
  let delta = to - from;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  return delta;
}

/**
 * Recognizes gestures from the resolver's touch records, one tick at a time.
 * Pure: the same records and tick lengths always give the same gestures.
 */
export class GestureRecognizer {
  private time = 0;
  private readonly contacts = new Map<number, ContactGesture>();
  private lastTap: { time: number; x: number; y: number } | null = null;
  private pair: Pair | null = null;
  private viewShortSide = 0;

  /** The game view's CSS size; two-finger drags are measured in its shorter side. */
  setViewSize(width: number, height: number): void {
    const side = Math.min(width, height);
    this.viewShortSide = Number.isFinite(side) && side > 0 ? side : 0;
  }

  reset(): void {
    this.time = 0;
    this.contacts.clear();
    this.lastTap = null;
    this.pair = null;
  }

  /**
   * `events` are this tick's Began, Moved and Ended or Cancelled records in
   * input order; `touches` every contact down during the tick.
   */
  step(events: readonly TouchInput[], touches: readonly TouchInput[], deltaSeconds: number): Map<string, number> {
    const values = new Map<string, number>();
    for (const record of events) this.apply(record, values);
    this.time += deltaSeconds;
    let longPress = false;
    for (const contact of this.contacts.values()) {
      if (!contact.longPress && contact.alone && contact.maxDistance <= GESTURE_SLOP_PX && this.time - contact.startTime >= LONG_PRESS_SECONDS) {
        contact.longPress = true;
      }
      longPress ||= contact.longPress;
    }
    if (longPress) values.set(C.longPress, 1);
    this.twoFinger(touches, values);
    return values;
  }

  private apply(record: TouchInput, values: Map<string, number>): void {
    const { x, y } = record.Position;
    if (record.Phase === "Began") {
      const alone = this.contacts.size === 0;
      if (!alone) for (const other of this.contacts.values()) other.alone = false;
      this.contacts.set(record.Finger, { startTime: this.time, startX: x, startY: y, maxDistance: 0, alone, longPress: false });
      return;
    }
    const contact = this.contacts.get(record.Finger);
    if (!contact) return;
    contact.maxDistance = Math.max(contact.maxDistance, distance(contact.startX, contact.startY, x, y));
    if (record.Phase === "Moved") return;
    this.contacts.delete(record.Finger);
    if (record.Phase !== "Ended" || !contact.alone || contact.longPress) return;
    const duration = this.time - contact.startTime;
    if (contact.maxDistance <= GESTURE_SLOP_PX && duration < LONG_PRESS_SECONDS) {
      values.set(C.tap, 1);
      const last = this.lastTap;
      if (last && contact.startTime - last.time <= DOUBLE_TAP_SECONDS && distance(last.x, last.y, contact.startX, contact.startY) <= DOUBLE_TAP_DISTANCE_PX) {
        values.set(C.doubleTap, 1);
        this.lastTap = null;
      } else {
        this.lastTap = { time: this.time, x, y };
      }
      return;
    }
    const dx = x - contact.startX;
    const dy = y - contact.startY;
    if (Math.hypot(dx, dy) < SWIPE_MIN_DISTANCE_PX || duration > SWIPE_MAX_SECONDS) return;
    // The view's y grows downward.
    values.set(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? C.swipeRight : C.swipeLeft) : (dy > 0 ? C.swipeDown : C.swipeUp), 1);
  }

  /**
   * The two lowest fingers this tick, against where the same two were at the
   * end of the last tick. A new pair, or one with a finger that just began
   * (perhaps in a slot freed by another), only sets the baseline.
   */
  private twoFinger(touches: readonly TouchInput[], values: Map<string, number>): void {
    const [first, second] = touches;
    if (!first || !second) {
      this.pair = null;
      return;
    }
    const now: Pair = {
      a: first.Finger, b: second.Finger,
      ax: first.Position.x, ay: first.Position.y, bx: second.Position.x, by: second.Position.y,
    };
    const before = this.pair;
    this.pair = now;
    if (!before || before.a !== now.a || before.b !== now.b || first.Phase === "Began" || second.Phase === "Began") return;
    const spreadBefore = distance(before.ax, before.ay, before.bx, before.by);
    const spreadNow = distance(now.ax, now.ay, now.bx, now.by);
    if (spreadBefore > 0) setNonZero(values, C.pinch, spreadNow / spreadBefore - 1);
    if (spreadBefore > 0 && spreadNow > 0) {
      // Positive is clockwise on screen.
      setNonZero(values, C.rotate, turn(Math.atan2(before.by - before.ay, before.bx - before.ax), Math.atan2(now.by - now.ay, now.bx - now.ax)));
    }
    if (this.viewShortSide > 0) {
      setNonZero(values, C.dragX, ((now.ax + now.bx) - (before.ax + before.bx)) / 2 / this.viewShortSide);
      // Up is positive, like a joystick.
      setNonZero(values, C.dragY, ((before.ay + before.by) - (now.ay + now.by)) / 2 / this.viewShortSide);
    }
  }
}

function setNonZero(values: Map<string, number>, code: string, value: number): void {
  if (value !== 0 && Number.isFinite(value)) values.set(code, value);
}
