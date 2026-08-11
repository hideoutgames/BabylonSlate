import type { Scene } from "@babylonjs/core";
import { PickingInfo, Vector3 } from "@babylonjs/core";

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
  const pick = scene.pick(canvasX, canvasY, undefined, false);
  if (!pick?.hit || !pick.pickedMesh) {
    return null;
  }
  const name = pick.pickedMesh.name;
  const match = /^actor-(\d+)$/.exec(name);
  return {
    meshName: name,
    slotId: match ? Number(match[1]) : null,
    hit: pick,
  };
}

/** Expose scratch vectors for tests without allocating in hot paths. */
export function _pickingScratch(): { origin: Vector3; dir: Vector3 } {
  return { origin: scratchOrigin, dir: scratchDir };
}
