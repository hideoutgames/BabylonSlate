import type { Scene } from "@babylonjs/core";

/**
 * Render pass ids of the scene effects' geometry passes (`SpatialEffectsGraph`), whose buffers feed ambient occlusion,
 * Real-Time Reflections, volumetric lighting and Screen-Space Shadows. A Material that draws differently there
 * (water) asks by the pass being drawn. The authored post-process chain's geometry pass is not one of them.
 */
const registries = new WeakMap<Scene, Set<number>>();

/** Registered when the geometry task is constructed, before its pass's first readiness probe. */
export function registerSpatialGeometryPass(scene: Scene, renderPassId: number): void {
  let passes = registries.get(scene);
  if (!passes) registries.set(scene, (passes = new Set()));
  passes.add(renderPassId);
}

export function unregisterSpatialGeometryPass(scene: Scene, renderPassId: number): void {
  registries.get(scene)?.delete(renderPassId);
}

/** Whether `renderPassId` is a scene effects' geometry pass. */
export function isSpatialGeometryPass(scene: Scene, renderPassId: number): boolean {
  return registries.get(scene)?.has(renderPassId) ?? false;
}
