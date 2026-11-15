import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Makes a converter's skinned meshes mean the same in glTF as in Babylon, before `GLTF2Export` writes them.
 *
 * Babylon skins in the mesh's own space: a root bone's matrix is its local matrix, and the mesh's world matrix
 * applies after skinning. glTF skins in world space: every joint's matrix includes all its ancestors, and a skinned
 * mesh's own transform is ignored. The two agree only when the mesh's world matrix is the world matrix of its
 * skeleton's parent node. An FBX file often puts them under differently scaled nodes (a Blender armature at 100
 * under a centimetre root), and its export then drew the mesh at a hundredth of its skeleton's size.
 *
 * So each skinned mesh is rebound at its current pose (the rest pose a converter loads): its vertices become their
 * skinned positions in the space of the skeleton's parent node, the mesh moves under that node with an identity
 * transform, and every bone's bind matrix becomes its current local matrix. Babylon then draws the same mesh, and
 * the exported inverse bind matrices agree with the exported joints. A skeleton whose root bones have different
 * parents, a bone without a linked node, or a mesh with morph targets is left as it is.
 */
export function rebindSkinsForGltfExport(scene: Scene): void {
  const meshesBySkeleton = new Map<Skeleton, Mesh[]>();
  for (const mesh of scene.meshes) {
    if (!(mesh instanceof Mesh) || !mesh.skeleton || mesh.getTotalVertices() === 0 || mesh.morphTargetManager) continue;
    const meshes = meshesBySkeleton.get(mesh.skeleton) ?? [];
    meshes.push(mesh);
    meshesBySkeleton.set(mesh.skeleton, meshes);
  }
  for (const [skeleton, meshes] of meshesBySkeleton) {
    const parent = skeletonParentNode(skeleton);
    if (parent === undefined) continue;
    const parentWorld = parent ? parent.computeWorldMatrix(true) : Matrix.IdentityReadOnly;
    const toParent = parentWorld.clone().invert();
    skeleton.prepare(true);
    // Skin every mesh with its current bind before the bind changes.
    const baked = meshes.map((mesh) => bakeIntoSpace(mesh, toParent));
    rebindAtCurrentPose(skeleton);
    meshes.forEach((mesh, index) => {
      const data = baked[index]!;
      mesh.makeGeometryUnique();
      mesh.setVerticesData(VertexBuffer.PositionKind, data.positions, false);
      if (data.normals) mesh.setVerticesData(VertexBuffer.NormalKind, data.normals, false);
      if (data.tangents) mesh.setVerticesData(VertexBuffer.TangentKind, data.tangents, false, 4);
      if (data.flipWinding) flipWinding(mesh);
      mesh.parent = parent;
      mesh.position.setAll(0);
      mesh.rotationQuaternion = Quaternion.Identity();
      mesh.scaling.setAll(1);
      mesh.computeWorldMatrix(true);
      mesh.refreshBoundingInfo({ applySkeleton: true });
    });
  }
}

/** The node every root bone's linked node hangs from (null for the scene root), or undefined when they differ or a bone has none. */
function skeletonParentNode(skeleton: Skeleton): TransformNode | null | undefined {
  let parent: Node | null | undefined;
  for (const bone of skeleton.bones) {
    const node = bone.getTransformNode();
    if (!node) return undefined;
    if (bone.getParent()) continue;
    const nodeParent = node.parent;
    if (parent !== undefined && parent !== nodeParent) return undefined;
    parent = nodeParent;
  }
  if (parent === undefined) return undefined;
  return parent as TransformNode | null;
}

/** The mesh's skinned positions (and directions) at the current pose, in the space `toSpace` maps world into. */
function bakeIntoSpace(mesh: Mesh, toSpace: Matrix): {
  positions: Float32Array;
  normals: Float32Array | null;
  tangents: Float32Array | null;
  flipWinding: boolean;
} {
  const transform = mesh.computeWorldMatrix(true).multiply(toSpace);
  const directions = transform.clone().invert().transpose();
  const skinned = mesh.getPositionData(true, false)!;
  const positions = new Float32Array(skinned.length);
  const point = Vector3.Zero();
  for (let index = 0; index < skinned.length; index += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(skinned[index]!, skinned[index + 1]!, skinned[index + 2]!, transform, point);
    point.toArray(positions, index);
  }
  const normalData = mesh.isVerticesDataPresent(VertexBuffer.NormalKind) ? mesh.getNormalsData(true, false) : null;
  let normals: Float32Array | null = null;
  if (normalData) {
    normals = new Float32Array(normalData.length);
    for (let index = 0; index < normalData.length; index += 3) {
      Vector3.TransformNormalFromFloatsToRef(normalData[index]!, normalData[index + 1]!, normalData[index + 2]!, directions, point);
      point.normalize().toArray(normals, index);
    }
  }
  // Tangents are not skinned here: they turn with the mesh's transform, which keeps them right at the rest pose.
  const tangentData = mesh.getVerticesData(VertexBuffer.TangentKind);
  const flip = transform.determinant() < 0;
  let tangents: Float32Array | null = null;
  if (tangentData) {
    tangents = new Float32Array(tangentData.length);
    for (let index = 0; index < tangentData.length; index += 4) {
      Vector3.TransformNormalFromFloatsToRef(tangentData[index]!, tangentData[index + 1]!, tangentData[index + 2]!, transform, point);
      point.normalize().toArray(tangents, index);
      tangents[index + 3] = flip ? -tangentData[index + 3]! : tangentData[index + 3]!;
    }
  }
  return { positions, normals, tangents, flipWinding: flip };
}

/** Every bone binds at its current local matrix, parents before children. */
function rebindAtCurrentPose(skeleton: Skeleton): void {
  const depth = (bone: (typeof skeleton.bones)[number]) => {
    let count = 0;
    for (let parent = bone.getParent(); parent; parent = parent.getParent()) count++;
    return count;
  };
  for (const bone of [...skeleton.bones].sort((a, b) => depth(a) - depth(b))) {
    bone.setBindMatrix(bone.getLocalMatrix().clone());
  }
  // The rebind is in skeleton space; a mesh pose matrix must not fold into it again.
  skeleton.needInitialSkinMatrix = false;
}

/** A transform that mirrors the vertices reverses which way each triangle winds. */
function flipWinding(mesh: Mesh): void {
  const indices = mesh.getIndices();
  if (!indices) return;
  const flipped = Array.from(indices);
  for (let index = 0; index + 2 < flipped.length; index += 3) {
    const second = flipped[index + 1]!;
    flipped[index + 1] = flipped[index + 2]!;
    flipped[index + 2] = second;
  }
  mesh.setIndices(flipped);
}
