import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { VisibilityCheck, sameList } from "./visibility-check";
import { PlaneQuery } from "./visibility-index";

/** What the cull reads of Babylon 9.29 beyond its public API. */
type CullCamera = Camera & { _updateFrustumPlanes(): void; _frustumPlanes: Plane[] };
type CullPass = { _executeFunc: (context: unknown) => void; setExecuteFunc(func: (context: unknown) => void): void };

/**
 * A camera's frustum cull as Babylon's cull task makes it (`FrameGraphCullObjectsTask`, 9.29), with the one call that
 * walks a mesh's bounds, `mesh.isInFrustum(planes)`, answered by the visibility index (`PlaneQuery.holds`: the same
 * arithmetic on the same doubles). Every flag is read from the mesh in the task's own order, so the list is the
 * task's: the same meshes in the same order, in a new array as the task makes one.
 */
export function cullByVisibilityIndex(
  scene: Scene, camera: Camera, meshes: readonly AbstractMesh[], query: PlaneQuery,
): AbstractMesh[] {
  const view = camera as CullCamera;
  view._updateFrustumPlanes();
  query.set(view._frustumPlanes);
  const listed: AbstractMesh[] = [];
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]!;
    if (mesh.isBlocked || !mesh.isReady() || !mesh.isEnabled() || mesh.scaling.hasAZeroComponent) continue;
    if (mesh.isVisible && mesh.visibility > 0 && (mesh.layerMask & camera.layerMask) !== 0 &&
      (scene.skipFrustumClipping || mesh.alwaysSelectAsActiveMesh || query.holds(mesh))) listed.push(mesh);
  }
  return listed;
}

/**
 * Has `task`, just recorded, cull by the visibility index: its pass keeps Babylon's own function for the cases the
 * index does not answer (frozen active meshes) and for the checks, on every 32nd cull and on every cull while
 * verifying (`VisibilityCheck`), where Babylon's list is the one used and a list that differs is counted. Call after
 * each `record()`: the task's observers, debug group and disabled pass are untouched.
 */
export function cullTaskByVisibilityIndex(task: FrameGraphCullObjectsTask, scene: Scene): void {
  const pass = (task as unknown as { _passes: CullPass[] })._passes[0]!;
  const full = pass._executeFunc;
  const query = new PlaneQuery();
  const check = new VisibilityCheck("main");
  pass.setExecuteFunc((context) => {
    if (scene._activeMeshesFrozen) {
      full(context);
      return;
    }
    const started = performance.now();
    const listed = cullByVisibilityIndex(scene, task.camera, task.objectList.meshes || scene.meshes, query);
    const indexed = performance.now();
    if (check.due()) {
      full(context);
      check.checked(sameList(listed, task.outputObjectList.meshes), performance.now() - indexed);
      return;
    }
    // As the task's own function leaves its output.
    task.outputObjectList.particleSystems = task.objectList.particleSystems;
    task.outputObjectList.spriteManagers = task.objectList.spriteManagers;
    task.outputObjectList.meshes = listed;
    check.queried(indexed - started);
  });
}
