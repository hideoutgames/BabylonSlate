/**
 * Each Scene's water clock: real time in the editor and previews, and in Play the water time the worker's physics step
 * evaluated for each snapshot frame (`setSceneWaterTime`, `sampleSceneWaterFrame`).
 */
import type { Scene } from "@babylonjs/core";
import { isSceneGameTimePaused } from "./scene-game-time";

/**
 * A scene's water clock. Without runtime times (editor viewport, asset previews) it follows real time and stops
 * while game time is paused. Play keeps the simulated water time the worker's physics step evaluated for each
 * snapshot frame (a short history) and draws the time of the applied snapshot's frame, so the rendered water is the
 * water physics saw for the drawn actor poses.
 */
type SceneWaterClock = {
  time: number;
  runtime: boolean;
  /** Snapshot frame ids with runtime water times (ascending, newest last). */
  frames: number[];
  times: number[];
  /** The applied snapshot frame (`sampleSceneWaterFrame`). */
  frameId: number;
};
/** Runtime water times retained per scene; a render delayed by more frames draws the oldest retained time. */
const WATER_FRAME_HISTORY = 8;
const clocks = new WeakMap<Scene, SceneWaterClock>();

function sceneClock(scene: Scene): SceneWaterClock {
  let clock = clocks.get(scene);
  if (!clock) {
    clock = { time: 0, runtime: false, frames: [], times: [], frameId: NaN };
    clocks.set(scene, clock);
  }
  return clock;
}

/**
 * Sets the scene's water time; from then on it advances only through this call. With `frameId` (Play) the time is
 * the one the worker's physics step evaluated for that snapshot frame, kept for `sampleSceneWaterFrame`; a frame id
 * at or before the newest one starts the history again (a new session).
 */
export function setSceneWaterTime(scene: Scene, seconds: number, frameId?: number): void {
  if (!Number.isFinite(seconds)) return;
  const clock = sceneClock(scene);
  clock.time = seconds;
  clock.runtime = true;
  const { frames, times } = clock;
  const paired = frameId !== undefined && Number.isFinite(frameId);
  if (!paired || (frames.length && frameId <= frames[frames.length - 1]!)) frames.length = times.length = 0;
  if (!paired) return;
  frames.push(frameId); times.push(seconds);
  if (frames.length > WATER_FRAME_HISTORY) { frames.shift(); times.shift(); }
}

/** Pairs the water with the applied actor snapshot frame. */
export function sampleSceneWaterFrame(scene: Scene, frameId: number): void {
  sceneClock(scene).frameId = frameId;
}

/** The newest runtime time sent for `frameId` or an earlier frame; the oldest retained one for an older frame. */
function frameWaterTime(clock: SceneWaterClock, frameId: number): number {
  for (let i = clock.frames.length - 1; i >= 0; i--) if (clock.frames[i]! <= frameId) return clock.times[i]!;
  return clock.times[0]!;
}

/** The time the scene's water draws at now. */
export function sceneWaterTime(scene: Scene): number {
  const clock = clocks.get(scene);
  if (!clock) return 0;
  if (!clock.runtime || !clock.frames.length || !Number.isFinite(clock.frameId)) return clock.time;
  return frameWaterTime(clock, clock.frameId);
}

/**
 * Creates the scene's clock when it has none and, outside an `early` run (`settleSceneWater`), advances an editor-time
 * clock by the last frame's time (at most 0.1 s) unless game time is paused; returns the time the water draws at now.
 */
export function advanceSceneWaterClock(scene: Scene, early: boolean): number {
  const clock = sceneClock(scene);
  if (!early && !clock.runtime && !isSceneGameTimePaused(scene)) clock.time += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000 || 0);
  return sceneWaterTime(scene);
}

/** Forgets a disposed scene's clock. */
export function deleteSceneWaterClock(scene: Scene): void {
  clocks.delete(scene);
}
