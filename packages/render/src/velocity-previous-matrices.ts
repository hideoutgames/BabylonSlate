import { Scene } from "@babylonjs/core";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";

/**
 * Babylon advances a regular instance's previous world matrix in every instanced draw while
 * `scene.needsPreviousWorldMatrices` holds, which a frame graph with a velocity task sets for the whole graph. A frame's
 * shadow maps and object passes draw before its geometry pass, so that pass would find each moving instance's previous
 * matrix already equal to its current one and write zero velocity: TAA would smear it. While a velocity renderer is
 * scoped here, the Scene answers true only inside such a renderer's draws, so only those advance it. Only Babylon's
 * instanced and thin-instance draw paths read the flag (`mesh.pure.js`, `thinInstanceMesh.pure.js`).
 */

interface ScopedScene {
  /** Velocity draws in progress. */
  depth: number;
  /** Scoped velocity renderers. */
  renderers: number;
}

const scoped = new WeakMap<Scene, ScopedScene>();

/** Babylon's own accessor, which the scope answers through. */
function sceneAccessor(): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(Scene.prototype, "needsPreviousWorldMatrices");
  if (!descriptor?.get || !descriptor.set) throw new Error("Unsupported Babylon Scene.needsPreviousWorldMatrices layout");
  return descriptor;
}

/** Scopes `scene`'s previous world matrices to `renderer`'s draws (a velocity geometry pass); returns the release. */
export function scopePreviousWorldMatricesToVelocity(scene: Scene, renderer: ObjectRenderer): () => void {
  const accessor = sceneAccessor();
  let state = scoped.get(scene);
  if (!state) {
    const created: ScopedScene = state = { depth: 0, renderers: 0 };
    scoped.set(scene, created);
    Object.defineProperty(scene, "needsPreviousWorldMatrices", {
      configurable: true,
      get(this: Scene) {
        return created.depth > 0 && (accessor.get!.call(this) as boolean);
      },
      set(this: Scene, value: boolean) {
        accessor.set!.call(this, value);
      },
    });
  }
  const scope = state;
  scope.renderers += 1;
  const before = renderer.onBeforeRenderingManagerRenderObservable.add(() => { scope.depth += 1; });
  const after = renderer.onAfterRenderingManagerRenderObservable.add(() => { scope.depth = Math.max(0, scope.depth - 1); });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    renderer.onBeforeRenderingManagerRenderObservable.remove(before);
    renderer.onAfterRenderingManagerRenderObservable.remove(after);
    scope.renderers -= 1;
    if (scope.renderers > 0) return;
    scoped.delete(scene);
    delete (scene as unknown as Record<string, unknown>).needsPreviousWorldMatrices;
  };
}
