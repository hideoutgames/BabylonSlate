import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

/**
 * How a view's cull tests a mesh. Babylon's default asks only whether the bounding sphere touches the frustum, and a
 * long or flat mesh (a wall, a floor, a beam) has a sphere far larger than itself: it is submitted, with every pass
 * that draws the culled list, long after it has left the view. This strategy accepts a mesh whose centre is in the
 * frustum at once, which is most of what a view shows, and tests any other by its sphere and then its box, so a draw
 * is spent only on what can show. The tests a draw costs are a few dot products.
 */
const STRATEGY = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

const scenes = new WeakSet<Scene>();

/**
 * Culls `scene`'s meshes, those it has and those added later, by their boxes where their spheres alone would pass
 * (`mesh.isInFrustum`: the view's cull, mirror and capture lists). Once per Scene.
 */
export function cullSceneByBoxes(scene: Scene): void {
  if (scenes.has(scene)) return;
  scenes.add(scene);
  for (const mesh of scene.meshes) mesh.cullingStrategy = STRATEGY;
  // Babylon announces a new mesh on a later task: until then it is culled by its sphere, which only keeps more.
  scene.onNewMeshAddedObservable.add((mesh) => { mesh.cullingStrategy = STRATEGY; });
}
