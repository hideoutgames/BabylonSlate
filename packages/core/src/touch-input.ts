/**
 * A touch as game scripts see it: the `engine:Touch` struct, with the
 * `engine:TouchPhase` and `engine:TouchType` members stored by name.
 */
export const TOUCH_PHASES = ["Began", "Moved", "Stationary", "Ended", "Cancelled"] as const;
export type TouchPhase = (typeof TOUCH_PHASES)[number];

/** A finger, a pen tip or the left mouse button: each is one contact. */
export const TOUCH_TYPES = ["Finger", "Pen", "Mouse"] as const;
export type TouchType = (typeof TOUCH_TYPES)[number];

export interface TouchInput {
  /** Lowest free slot when the contact began; kept until it lifts. */
  Finger: number;
  /** Game view CSS pixels from the top-left corner, like the cursor. */
  Position: { x: number; y: number };
  /** Movement this tick, or since the press for a contact that began this tick. */
  Delta: { x: number; y: number };
  /** Pixels per second, smoothed over the last few ticks; a flick's speed at its lift. */
  Velocity: { x: number; y: number };
  StartPosition: { x: number; y: number };
  /** 0 to 1; 0.5 on hardware without pressure. Kept from the last sample when the contact lifts. */
  Pressure: number;
  Phase: TouchPhase;
  Type: TouchType;
}
