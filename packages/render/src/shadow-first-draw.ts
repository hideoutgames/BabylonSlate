import type { Scene, ShadowGenerator } from "@babylonjs/core";

/**
 * Shadow maps that have not drawn since they were allocated, moved to another light or resumed from standby
 * (`SceneShadowController`). Each samples neutrally (lit) until its last face draws, so a world view's steady frames
 * keep drawing while its casters' depth variants compile, and it draws on the first frame they are ready. A leaf
 * module: readiness probes (`scene-perf`), the graph's shadow task and Render Target captures read it without
 * importing the controller.
 */
const awaiting = new WeakSet<ShadowGenerator>();
/** Maps inside a warm render (`shadow-map-warm.ts`), made only to create their casters' render pipelines. */
const warming = new WeakSet<ShadowGenerator>();
/** Maps awaiting their first draw that a steady frame held back for their casters' pipelines (`shadow-map-warm.ts`). */
const held = new WeakSet<ShadowGenerator>();
/** Scenes whose current frame publishes a manual Render Target capture: their maps draw without that wait. */
const urgent = new WeakSet<Scene>();

export function awaitsFirstDraw(generator: ShadowGenerator): boolean {
  return awaiting.has(generator);
}

/** Starts or ends a map's wait for its first draw; either ends any hold of that draw. */
export function setAwaitingFirstDraw(generator: ShadowGenerator, value: boolean): void {
  held.delete(generator);
  if (value) awaiting.add(generator);
  else awaiting.delete(generator);
}

/**
 * Whether `generator`'s map is rendering only to create its casters' render pipelines: that pass is no first draw, so
 * the map still awaits one and samples neutrally.
 */
export function isWarmShadowRender(generator: ShadowGenerator): boolean {
  return warming.has(generator);
}

/** Runs `render`, a warm render of `generator`'s map (`isWarmShadowRender`). */
export function withWarmShadowRender(generator: ShadowGenerator, render: () => void): void {
  warming.add(generator);
  try {
    render();
  } finally {
    warming.delete(generator);
  }
}

/**
 * Whether `generator`'s map awaits a first draw that a steady frame held back for its casters' pipelines, although
 * its casters were ready (a map without this wait would have drawn).
 */
export function isFirstDrawHeld(generator: ShadowGenerator): boolean {
  return held.has(generator) && awaiting.has(generator);
}

export function setFirstDrawHeld(generator: ShadowGenerator, value: boolean): void {
  if (value && awaiting.has(generator)) held.add(generator);
  else held.delete(generator);
}

/**
 * Whether `scene`'s current frame publishes a manual Render Target capture, set by the captures before its graph
 * runs: a map awaiting its first draw then draws once its casters are ready, and a drawn map that left out casters new
 * to it draws again with them (`shadow-caster-warm.ts`), creating any missing pipeline synchronously, since a capture
 * published while a map samples neutrally or lacks a caster would keep that image.
 */
export function firstDrawsUrgent(scene: Scene): boolean {
  return urgent.has(scene);
}

export function setFirstDrawsUrgent(scene: Scene, value: boolean): void {
  if (value) urgent.add(scene);
  else urgent.delete(scene);
}
