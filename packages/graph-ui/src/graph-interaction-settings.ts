import { createContext } from "react";

export const GraphInteractionSettingsContext = createContext({ assistantEnabled: true, assistantDistance: 48, shakeEnabled: true });

/** Detect deliberate repeated motion in screen pixels; monotonic drags never shake. */
export class NodeShakeTracker {
  private last = { x: 0, y: 0, time: 0 };
  private direction = { x: 0, y: 0 };
  private reversals = 0;
  reset(x: number, y: number, time: number): void {
    this.last = { x, y, time }; this.direction = { x: 0, y: 0 }; this.reversals = 0;
  }
  move(x: number, y: number, time: number): boolean {
    const dx = x - this.last.x, dy = y - this.last.y;
    if (time - this.last.time > 700) { this.reset(x, y, time); return false; }
    if (Math.hypot(dx, dy) < 18) return false;
    if (dx * this.direction.x + dy * this.direction.y < 0) this.reversals++;
    this.direction = { x: dx, y: dy }; this.last = { x, y, time };
    return this.reversals >= 3;
  }
}
