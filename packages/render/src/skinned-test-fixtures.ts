import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

/** Test fixture: a skeleton of a root and an arm bound two units up it. Move a bone by setting its `position`. */
export function skinnedRig(scene: Scene): { skeleton: Skeleton; root: Bone; arm: Bone } {
  const skeleton = new Skeleton("rig", "rig", scene);
  const root = new Bone("root", skeleton, null, Matrix.Identity());
  const arm = new Bone("arm", skeleton, root, Matrix.Translation(0, 2, 0));
  return { skeleton, root, arm };
}

/**
 * Test fixture: a strip a unit wide skinned by `skinnedRig`'s skeleton, its lower edge (y = 0) moved by the root alone
 * and its upper edge (y = 2) by the arm alone, with its vertex data held as a loaded model's is. `positions` replaces
 * its four vertices.
 */
export function skinnedStrip(scene: Scene, skeleton: Skeleton, name = "strip", positions = [0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0]): Mesh {
  const mesh = new Mesh(name, scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.NormalKind, [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
  mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  mesh.setIndices([0, 1, 2, 1, 3, 2]);
  mesh.skeleton = skeleton;
  return mesh;
}
