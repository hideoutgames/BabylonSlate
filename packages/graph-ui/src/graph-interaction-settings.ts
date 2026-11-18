import { createContext } from "react";

export interface GraphInteractionSettings {
  assistantEnabled: boolean;
  assistantDistance: number;
  shakeEnabled: boolean;
  readOnlyPinDefaults?: boolean;
  /** Learn Add Node picks from dragged pins; unset (previews, tests) is off. */
  addNodeHistoryEnabled?: boolean;
  /** Tap one pin, then a pin on the other side, to connect them; unset is off. */
  tapToConnectEnabled?: boolean;
  /** Multiplies pin glyphs, their hit areas and wires (Large Pins); unset is 1. */
  pinScale?: number;
  /** Draws a type letter inside data pins (B for Boolean); unset is off. */
  pinTypeLetters?: boolean;
  /** Snapped Nodes: a released node drag rounds positions to this grid (flow units); unset or 0 is off. */
  nodeSnapGrid?: number;
  /** Cut Links turns itself off after its first cut; unset keeps it on until turned off. */
  cutToolOneShot?: boolean;
}

/** A position rounded to `grid` flow units; a grid of 0 or less leaves it as it is. */
export function snapPositionToGrid(
  position: { x: number; y: number },
  grid: number | undefined,
): { x: number; y: number } {
  if (!grid || grid <= 0) return position;
  return { x: Math.round(position.x / grid) * grid, y: Math.round(position.y / grid) * grid };
}

export const GraphInteractionSettingsContext = createContext<GraphInteractionSettings>({
  assistantEnabled: true, assistantDistance: 48, shakeEnabled: true, readOnlyPinDefaults: false,
});

/** Side of the screen-pixel square a shake must stay inside; travel beyond it re-anchors the tracker. */
export const SHAKE_AREA_PX = 160;
const SHAKE_STEP_PX = 18;
const SHAKE_TIMEOUT_MS = 700;
const SHAKE_REVERSALS = 3;
/** cos(120°): consecutive steps must turn by more than 120° to count as a reversal. */
const SHAKE_REVERSAL_COS = -0.5;

/**
 * Detect deliberate repeated motion in screen pixels: three sharp reversals whose whole motion
 * stays inside a `SHAKE_AREA_PX` square. Monotonic drags never shake, and long drags with wobble
 * never accumulate into one because leaving the area re-anchors the tracker at the node.
 * Plain numeric fields only: `move` runs on every drag tick and allocates nothing.
 */
export class NodeShakeTracker {
  private lastX = 0;
  private lastY = 0;
  private lastTime = 0;
  private directionX = 0;
  private directionY = 0;
  private reversals = 0;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  reset(x: number, y: number, time: number): void {
    this.lastX = x; this.lastY = y; this.lastTime = time;
    this.directionX = 0; this.directionY = 0; this.reversals = 0;
    this.minX = x; this.maxX = x; this.minY = y; this.maxY = y;
  }
  move(x: number, y: number, time: number): boolean {
    if (time - this.lastTime > SHAKE_TIMEOUT_MS) { this.reset(x, y, time); return false; }
    const dx = x - this.lastX, dy = y - this.lastY;
    const length = Math.hypot(dx, dy);
    if (length < SHAKE_STEP_PX) return false;
    const minX = Math.min(this.minX, x), maxX = Math.max(this.maxX, x);
    const minY = Math.min(this.minY, y), maxY = Math.max(this.maxY, y);
    if (maxX - minX > SHAKE_AREA_PX || maxY - minY > SHAKE_AREA_PX) { this.reset(x, y, time); return false; }
    this.minX = minX; this.maxX = maxX; this.minY = minY; this.maxY = maxY;
    const previousLength = Math.hypot(this.directionX, this.directionY);
    if (previousLength > 0 && dx * this.directionX + dy * this.directionY < SHAKE_REVERSAL_COS * length * previousLength) {
      this.reversals++;
    }
    this.directionX = dx; this.directionY = dy;
    this.lastX = x; this.lastY = y; this.lastTime = time;
    return this.reversals >= SHAKE_REVERSALS;
  }
}
