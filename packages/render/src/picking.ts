import type { Scene } from "@babylonjs/core";
import { PickingInfo, Vector3 } from "@babylonjs/core";
import { EDITOR_ACTOR_MESH_PREFIX } from "./scene-loader";

const scratchOrigin = new Vector3();
const scratchDir = new Vector3();

/** Resolve an imported part through its named actor ancestor. */
export function actorMeshName(mesh: { name: string; parent: unknown }): string {
  let node: { name: string; parent: unknown } | null = mesh;
  while (node) {
    if (
      /^actor-\d+$/.test(node.name) ||
      node.name.startsWith(EDITOR_ACTOR_MESH_PREFIX)
    ) {
      return node.name;
    }
    node = (node.parent as { name: string; parent: unknown } | null) ?? null;
  }
  return mesh.name;
}

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
  const meshName = actorMeshName(pick.pickedMesh);
  const match = /^actor-(\d+)$/.exec(meshName);
  return {
    meshName,
    slotId: match ? Number(match[1]) : null,
    hit: pick,
  };
}

/** Expose scratch vectors for tests without allocating in hot paths. */
export function _pickingScratch(): { origin: Vector3; dir: Vector3 } {
  return { origin: scratchOrigin, dir: scratchDir };
}
