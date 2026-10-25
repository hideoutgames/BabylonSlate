import type { ShadowGenerator } from "@babylonjs/core";

/**
 * Shadow maps that have not drawn since they were allocated, moved to another light or resumed from standby
 * (`SceneShadowController`). Each samples neutrally (lit) until its last face draws, so a world view's steady frames
 * keep drawing while its casters' depth variants compile, and it draws on the first frame they are ready. A leaf
 * module: readiness probes (`scene-perf`) and the graph's shadow task read it without importing the controller.
 */
const awaiting = new WeakSet<ShadowGenerator>();
/** Maps inside a warm render (`shadow-map-warm.ts`), made only to create their casters' render pipelines. */
const warming = new WeakSet<ShadowGenerator>();

export function awaitsFirstDraw(generator: ShadowGenerator): boolean {
  return awaiting.has(generator);
}

export function setAwaitingFirstDraw(generator: ShadowGenerator, value: boolean): void {
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
