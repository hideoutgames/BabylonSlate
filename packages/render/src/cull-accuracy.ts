import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { posedBeyondBounds } from "./play-view-culling";
import { followPose, updatePoseBounds } from "./pose-bounds";

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
 * A skinned mesh's bounds follow its skeleton where they can (`followPose`), so it is culled like any mesh. A mesh a
 * pose moves on the GPU with no bounds to follow it (`posedBeyondBounds`) is drawn whatever the view: culled by its
 * bounds, it would vanish at the screen's edge while its pose still reached into the view, or stay hidden where its
 * rest pose stands away from its vertices as authored. Play's own cull keeps the same meshes
 * (`keepsDrawingOutsideView`).
 */
function settle(mesh: AbstractMesh): void {
  mesh.cullingStrategy = STRATEGY;
  followPose(mesh);
  if (posedBeyondBounds(mesh)) mesh.alwaysSelectAsActiveMesh = true;
}

/**
 * Culls `scene`'s meshes, those it has and those added later, by what of them can show: by their boxes where their
 * spheres alone would pass (`mesh.isInFrustum`: the view's cull, mirror and capture lists), and never one whose
 * bounds its pose has left. Once per Scene.
 */
export function cullSceneByWhatShows(scene: Scene): void {
  if (scenes.has(scene)) return;
  scenes.add(scene);
  for (const mesh of scene.meshes) settle(mesh);
  // Posed meshes' bounds follow their skeletons before anything of the frame culls by them: first of the Scene's
  // before-render work, where mirror, capture and probe lists are built, and so before the view's and the shadows'.
  scene.onBeforeRenderObservable.add(() => updatePoseBounds(scene), undefined, true);
  // Babylon announces a new mesh on a later task, when a loader has given it its skeleton: until then it is culled
  // by its sphere, which only keeps more.
  scene.onNewMeshAddedObservable.add(settle);
}
