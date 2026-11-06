import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { SmartArray } from "@babylonjs/core/Misc/smartArray";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import type { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";

/**
 * Draw batching's hook into a Scene's sorted passes, a leaf the passes read without importing the batcher
 * (`overlay-draw-batcher.ts`, which Scene Layers turn on with `setSceneDrawBatching`).
 */
export interface SceneDrawBatcher {
  /**
   * Draws `count` submeshes of one pass in `sorted`'s order, as `drawOne` draws each, merging draws whose output cannot
   * differ from drawing them one by one.
   */
  draw(sorted: readonly SubMesh[], count: number, transparent: boolean, drawOne: (subMesh: SubMesh) => void): void;
  dispose(): void;
}

const batchers = new WeakMap<Scene, SceneDrawBatcher>();

/** The batcher drawing `scene`'s sorted passes, if it batches. */
export function sceneDrawBatcher(scene: Scene): SceneDrawBatcher | undefined {
  return batchers.get(scene);
}

/** Sets or clears the batcher of `scene`'s sorted passes; the previous one is disposed. */
export function setSceneDrawBatcher(scene: Scene, batcher: SceneDrawBatcher | null): void {
  const previous = batchers.get(scene);
  if (previous === batcher) return;
  previous?.dispose();
  if (batcher) {
    installSortedRender();
    batchers.set(scene, batcher);
  } else {
    batchers.delete(scene);
  }
}

type SortCompare = (a: SubMesh, b: SubMesh) => number;
/** Babylon 9.29's `RenderingGroup._RenderSorted`, which every sorted opaque and alpha-tested list of a group draws through. */
type RenderSorted = (
  subMeshes: SmartArray<SubMesh>, sortCompareFn: Nullable<SortCompare>, camera: Nullable<Camera>, transparent: boolean, disableDepthPrePass?: boolean,
) => void;

const renderOpaque = (subMesh: SubMesh): void => { subMesh.render(false); };
let installed = false;

/**
 * Routes the opaque and alpha-tested lists of a batching Scene through its batcher: the same sort as Babylon's
 * (`_RenderSorted`, in place when the list fills its array), then the batcher draws them. Blended lists draw through
 * the objects pass's own sorted loop (`TransparentDepthPrePass`), which asks the batcher itself; every other Scene, a
 * blended list and a Scene whose active meshes are frozen keep Babylon's loop.
 */
function installSortedRender(): void {
  if (installed) return;
  installed = true;
  const groups = RenderingGroup as unknown as { _RenderSorted: RenderSorted };
  const renderSorted = groups._RenderSorted;
  groups._RenderSorted = (subMeshes, sortCompareFn, camera, transparent, disableDepthPrePass) => {
    const count = subMeshes.length;
    const scene = !transparent && count > 1 ? subMeshes.data[0]!.getMesh().getScene() : undefined;
    const batcher = scene && !scene._activeMeshesFrozenButKeepClipping ? batchers.get(scene) : undefined;
    if (!batcher) {
      renderSorted(subMeshes, sortCompareFn, camera, transparent, disableDepthPrePass);
      return;
    }
    const sorted = count === subMeshes.data.length ? subMeshes.data : subMeshes.data.slice(0, count);
    if (sortCompareFn) sorted.sort(sortCompareFn);
    batcher.draw(sorted, count, false, renderOpaque);
  };
}
