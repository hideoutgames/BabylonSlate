import type { AbstractMesh } from "@babylonjs/core";

/** Whether one of `mesh`'s blended draws carries a depth pre-pass (`needDepthPrePass`). */
export function drawsDepthPrePass(mesh: AbstractMesh): boolean {
  const parts = mesh.subMeshes;
  if (!parts) return false;
  for (let index = 0; index < parts.length; index += 1) {
    const material = parts[index]!.getMaterial();
    if (material?.needDepthPrePass && material.needAlphaBlendingForMesh(mesh)) return true;
  }
  return false;
}
