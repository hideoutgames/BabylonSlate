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

/**
 * The frame both owners count rates by: the Engine's, so a Mirror and a capture of one Scene share it and their phases
 * stagger them against each other too.
 */
export function updateRateTick(scene: Scene): number {
  return scene.getEngine().frameId;
}

/** Whether a surface drawing every `interval`th frame, offset by `phase`, is due at `tick`. */
export function dueAtUpdateRate(tick: number, interval: number, phase: number): boolean {
  return interval <= 1 || (tick + phase) % interval === 0;
}

const phases = new WeakMap<Scene, Map<number, number>>();

/**
 * A stable phase for a new surface of `scene` at `interval`, handed out per interval in registration order across the
 * Scene's Mirrors and captures: consecutive surfaces on the same rate draw on different frames instead of all on one.
 */
export function takeUpdateRatePhase(scene: Scene, interval: number): number {
  if (interval <= 1) return 0;
  let taken = phases.get(scene);
  if (!taken) phases.set(scene, (taken = new Map()));
  const count = taken.get(interval) ?? 0;
  taken.set(interval, count + 1);
  return count % interval;
}
