import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
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
  /**
   * The meshes the last Engine frame that drew any pass drew with: each batch's mesh and each draw made on its own (a
   * mesh once per draw). Read before this frame's first pass, it is the previous frame's.
   */
  outputs(): readonly AbstractMesh[];
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

/**
 * Sorted lists put in place already in draw order (a Scene Layer's retained draw list, `layer-draw-list.ts`): their pass
 * draws them as they are, without sorting again.
 */
const presorted = new WeakSet<object>();

/** Marks or unmarks `list` (a rendering group's `SmartArray`) as already in draw order. */
export function setPresortedPass(list: object, sorted: boolean): void {
  if (sorted) presorted.add(list);
  else presorted.delete(list);
}

/** Whether `list` was put in place already in draw order (`setPresortedPass`). */
export function isPresortedPass(list: object): boolean {
  return presorted.has(list);
}

/** Hears each sorted list a batching Scene's passes hand its batcher, by the rendering group array it came from. */
export type SortedPassObserver = (list: object, sorted: readonly SubMesh[], count: number) => void;
const sortedObservers = new WeakMap<Scene, SortedPassObserver>();

/** Sets or clears what hears `scene`'s sorted lists (`noteSortedPass`). */
export function observeSortedPasses(scene: Scene, observer: SortedPassObserver | null): void {
  if (observer) sortedObservers.set(scene, observer);
  else sortedObservers.delete(scene);
}

/** A batching Scene's pass is about to hand `count` entries of `sorted`, from the group array `list`, to its batcher. */
export function noteSortedPass(scene: Scene, list: object, sorted: readonly SubMesh[], count: number): void {
  sortedObservers.get(scene)?.(list, sorted, count);
}

type SortCompare = (a: SubMesh, b: SubMesh) => number;
/** Babylon 9.29's `RenderingGroup._RenderSorted`, which every sorted opaque and alpha-tested list of a group draws through. */
type RenderSorted = (
  subMeshes: SmartArray<SubMesh>, sortCompareFn: Nullable<SortCompare>, camera: Nullable<Camera>, transparent: boolean, disableDepthPrePass?: boolean,
) => void;

const renderOpaque = (subMesh: SubMesh): void => { subMesh.render(false); };
let installed = false;

/**
 * Routes the opaque and alpha-tested lists of a batching Scene through its batcher (a list of one too, which the
 * batcher counts): the same sort as Babylon's (`_RenderSorted`, in place when the list fills its array), unless the list
 * was put in place in draw order (`setPresortedPass`), then the batcher draws them. Blended lists draw through
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
    const scene = !transparent && count > 0 ? subMeshes.data[0]!.getMesh().getScene() : undefined;
    const batcher = scene && !scene._activeMeshesFrozenButKeepClipping ? batchers.get(scene) : undefined;
    if (!batcher) {
      renderSorted(subMeshes, sortCompareFn, camera, transparent, disableDepthPrePass);
      return;
    }
    // A list of one needs no sort, so no copy either: the batcher reads `count` entries.
    const sorted = count === 1 || count === subMeshes.data.length ? subMeshes.data : subMeshes.data.slice(0, count);
    if (sortCompareFn && count > 1 && !presorted.has(subMeshes)) sorted.sort(sortCompareFn);
    noteSortedPass(scene!, subMeshes, sorted, count);
    batcher.draw(sorted, count, false, renderOpaque);
  };
}
