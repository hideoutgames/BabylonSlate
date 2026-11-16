import type { Scene } from "@babylonjs/core/scene";

/**
 * Update Rate (Mirrors and every-frame Render Target Captures). Only a Scene marked here honours a reduced rate: a Play
 * world (editor Play, Preview Build and the exported player, `createEngine` with `playMode`). The editor viewport,
 * previews and thumbnails draw every surface on every render they draw, so an edit always shows at once.
 */
const honouring = new WeakSet<Scene>();

export function setSceneHonoursUpdateRates(scene: Scene): void {
  honouring.add(scene);
}

export function sceneHonoursUpdateRates(scene: Scene): boolean {
  return honouring.has(scene);
}

/** Whether a surface drawing every `interval`th render, offset by `phase`, is due at its owner's render `tick`. */
export function dueAtUpdateRate(tick: number, interval: number, phase: number): boolean {
  return interval <= 1 || (tick + phase) % interval === 0;
}

/**
 * Stable phases per interval, handed out in registration order: consecutive surfaces on the same rate draw on
 * different renders instead of all on one.
 */
export class UpdateRatePhases {
  private readonly taken = new Map<number, number>();

  take(interval: number): number {
    if (interval <= 1) return 0;
    const count = this.taken.get(interval) ?? 0;
    this.taken.set(interval, count + 1);
    return count % interval;
  }
}
