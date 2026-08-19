import type { Scene } from "@babylonjs/core";
import { PickingInfo, Vector3 } from "@babylonjs/core";
import { EDITOR_ACTOR_MESH_PREFIX } from "./scene-loader";

const scratchOrigin = new Vector3();
const scratchDir = new Vector3();

/**
 * Explicit tap pick — used because skipPointerMovePicking is true (no hover).
 * Returns the mesh name / actor slot id when the pick hits an actor-* mesh.
 */
export function pickAtCanvas(
  scene: Scene,
  canvasX: number,
  canvasY: number,
): { meshName: string; slotId: number | null; hit: PickingInfo } | null {
  scene.updateTransformMatrix();
  const camera = scene.activeCamera;
  if (camera) {
    for (const mesh of scene.meshes) {
      if (mesh.isWorldMatrixCameraDependent()) {
        mesh.computeWorldMatrix(true, camera);
      }
    }
  }
  const pick = scene.pick(canvasX, canvasY, undefined, false);
  if (!pick?.hit || !pick.pickedMesh) {
    return null;
  }
  let mesh: { name: string; parent: unknown } | null = pick.pickedMesh;
  while (mesh) {
    const match = /^actor-(\d+)$/.exec(mesh.name);
    if (match) {
      return {
        meshName: mesh.name,
        slotId: Number(match[1]),
        hit: pick,
      };
    }
    if (mesh.name.startsWith(EDITOR_ACTOR_MESH_PREFIX)) {
      return {
        meshName: mesh.name,
        slotId: null,
        hit: pick,
      };
    }
    mesh = (mesh.parent as { name: string; parent: unknown } | null) ?? null;
  }
  return {
    meshName: pick.pickedMesh.name,
    slotId: null,
    hit: pick,
  };
}

/** Expose scratch vectors for tests without allocating in hot paths. */
export function _pickingScratch(): { origin: Vector3; dir: Vector3 } {
  return { origin: scratchOrigin, dir: scratchDir };
}
