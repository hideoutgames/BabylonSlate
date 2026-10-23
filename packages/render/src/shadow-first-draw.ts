import type { ShadowGenerator } from "@babylonjs/core";

/**
 * Shadow maps that have not drawn since they were allocated, moved to another light or resumed from standby
 * (`SceneShadowController`). Each samples neutrally (lit) until its last face draws, so a world view's steady frames
 * keep drawing while its casters' depth variants compile, and it draws on the first frame they are ready. A leaf
 * module: readiness probes (`scene-perf`) and the graph's shadow task read it without importing the controller.
 */
const awaiting = new WeakSet<ShadowGenerator>();

export function awaitsFirstDraw(generator: ShadowGenerator): boolean {
  return awaiting.has(generator);
}

export function setAwaitingFirstDraw(generator: ShadowGenerator, value: boolean): void {
  if (value) awaiting.add(generator);
  else awaiting.delete(generator);
}
