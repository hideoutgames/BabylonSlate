import type { AbstractMesh, Scene } from "@babylonjs/core";

/**
 * Meshes a world view does not draw yet: each has no ready variant to draw (a spawned mesh, or one whose Material
 * changed) and a tolerant probe found its first variant still compiling (`isMeshFrameReady`). Every pass leaves it
 * out (the camera cull's output, shadow caster lists, picking) until a probe finds it ready, so it never shows as a
 * depth, shadow or pick ghost and the frame never waits for it. Gameplay, physics and its own visibility flags are
 * untouched. A leaf module: probes, passes and the shadow controller read it without importing each other.
 */
const pending = new WeakSet<AbstractMesh>();
const revealListeners = new WeakMap<Scene, Set<(mesh: AbstractMesh) => void>>();

export function isRevealPending(mesh: AbstractMesh): boolean {
  return pending.has(mesh);
}

export function hideUntilReady(mesh: AbstractMesh): void {
  pending.add(mesh);
}

/** Draws the mesh again from this frame on, and tells the Scene's listeners (its shadow maps redraw with it). */
export function revealMesh(mesh: AbstractMesh): void {
  if (!pending.delete(mesh)) return;
  for (const listener of revealListeners.get(mesh.getScene()) ?? []) listener(mesh);
}

export function onMeshRevealed(scene: Scene, listener: (mesh: AbstractMesh) => void): () => void {
  let listeners = revealListeners.get(scene);
  if (!listeners) revealListeners.set(scene, (listeners = new Set()));
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
