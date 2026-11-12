import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

/**
 * A secondary pass of a Scene (a mirror's or water's reflection, a Render Target capture) tells which meshes it is
 * about to draw. The Scene's captures listen: a capture whose image one of those meshes shows keeps drawing
 * (`render-target-capture.ts`). A leaf module, so the passes need not import the captures.
 */
const listeners = new WeakMap<Scene, (meshes: readonly AbstractMesh[], capture?: string) => void>();

/** The one listener of `scene`'s pass lists; returns its release. */
export function onPassListed(scene: Scene, listener: (meshes: readonly AbstractMesh[], capture?: string) => void): () => void {
  listeners.set(scene, listener);
  return () => {
    if (listeners.get(scene) === listener) listeners.delete(scene);
  };
}

/** A pass of `scene` draws `meshes` now; `capture` names the Render Target a capture's pass draws into. */
export function notePassListed(scene: Scene, meshes: readonly AbstractMesh[], capture?: string): void {
  listeners.get(scene)?.(meshes, capture);
}
