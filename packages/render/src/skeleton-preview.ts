import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Axis } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";
import { rigPreviewLayout, writeRigPreview } from "./rig-preview-geometry";

/** The preview's bones and joints: vertex-coloured, shaded in the colours, drawn from both sides. */
const SKELETON_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "preview" };

interface PreviewJoint {
  name: string;
  position: Vector3;
  parent: number;
  readPosition: (position: Vector3) => void;
  /** A hierarchy rig's mesh part: the world centre of its bounds, which a childless joint's tail points through. */
  readPartCenter?: (center: Vector3) => void;
}

/** A childless skinned joint's tail continues its parent bone by this fraction of that bone's length. */
const LEAF_TAIL_OF_PARENT = 0.5;

/** The rig drawn over (or instead of) a previewed model. */
export interface SkeletonPreviewHandle {
  boneCount: number;
  /** Draws the named joint, and the bones it heads, in the selection colour; null or an unknown name clears it. */
  setSelectedBone(name: string | null): void;
  dispose(): void;
}

/** Rig joints exclude loader/import wrappers, preview helpers, overlays, cameras and lights. */
export function isRigJointNode(node: Node): node is TransformNode {
  return (
    node instanceof TransformNode &&
    !["__root__", "__fbx_root__", "__importScale", "materialPreviewMesh"].includes(node.name) &&
    !node.name.endsWith("_overlay") &&
    !/Camera|Light/.test(node.getClassName())
  );
}

/**
 * Shows only the rig, keeping hidden source transforms and animation alive: an octahedral bone from each joint to
 * each of its children and a ball at every joint, lit from the camera ([rig-preview-geometry.ts](./rig-preview-geometry.ts)).
 */
export function attachSkeletonPreview(
  root: TransformNode,
  scene: Scene,
  kind: "skin" | "hierarchy",
): SkeletonPreviewHandle {
  const meshes = [
    ...(root instanceof AbstractMesh ? [root] : []),
    ...root.getChildMeshes(false),
  ];
  const joints: PreviewJoint[] = [];
  const skins = new Map<Skeleton, AbstractMesh>();
  // A Skeleton shared with skinned Models may preview an animation library: nothing to draw, so its rig is its nodes.
  const animationLibrary = meshes.every((mesh) => !mesh.skeleton && mesh.getTotalVertices() === 0);
  if (kind === "skin" && !animationLibrary) {
    for (const mesh of meshes) {
      if (!mesh.skeleton || skins.has(mesh.skeleton)) continue;
      const skeleton = mesh.skeleton;
      skins.set(skeleton, mesh);
      const offset = joints.length;
      for (const bone of skeleton.bones) {
        const parent = bone.getParent();
        joints.push({
          name: bone.name,
          position: Vector3.Zero(),
          parent: parent ? offset + skeleton.bones.indexOf(parent) : -1,
          readPosition: (position) => {
            const linkedNode = bone.getTransformNode();
            if (linkedNode) {
              linkedNode.computeWorldMatrix(true);
              position.copyFrom(linkedNode.getAbsolutePosition());
            } else {
              bone.getAbsolutePositionToRef(mesh, position);
            }
          },
        });
      }
    }
  } else {
    const nodes = [root, ...root.getChildTransformNodes(false)].filter(
      isRigJointNode,
    );
    const indexByNode = new Map<Node, number>(
      nodes.map((node, index) => [node, index]),
    );
    for (const node of nodes) {
      let parent = node.parent;
      while (parent && !indexByNode.has(parent)) parent = parent.parent;
      const part = node instanceof AbstractMesh && node.getTotalVertices() > 0 ? node : null;
      joints.push({
        name: node.name,
        position: Vector3.Zero(),
        parent: parent ? indexByNode.get(parent)! : -1,
        readPosition: (position) => {
          node.computeWorldMatrix(true);
          position.copyFrom(node.getAbsolutePosition());
        },
        ...(part ? {
          readPartCenter: (center: Vector3) => {
            Vector3.TransformCoordinatesToRef(part.getBoundingInfo().boundingBox.center, part.computeWorldMatrix(true), center);
          },
        } : {}),
      });
    }
  }
  if (joints.length === 0) return { boneCount: 0, setSelectedBone: () => {}, dispose: () => {} };

  const parents = joints.map((joint) => joint.parent);
  // A limb's last joint draws a tail so its direction shows: through its mesh part, or on along its parent bone.
  const layout = rigPreviewLayout(parents, (joint) => Boolean(joints[joint]!.readPartCenter) || parents[joint]! >= 0);
  const tails = new Float32Array(joints.length * 3).fill(Number.NaN);
  const partCenter = Vector3.Zero();
  const positions = new Float32Array(layout.vertexCount * 3);
  const colors = new Float32Array(layout.vertexCount * 4);
  const jointPositions = new Float32Array(joints.length * 3);
  const overlay = new Mesh(`${root.name}_skeleton_overlay`, scene);
  overlay.parent = root;
  overlay.isPickable = false;
  overlay.alwaysSelectAsActiveMesh = true;
  setUnlitMaterial(overlay, SKELETON_MATERIAL, {
    texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: true,
  });
  overlay.setVerticesData(VertexBuffer.PositionKind, positions, true);
  overlay.setVerticesData(VertexBuffer.ColorKind, colors, true, 4);
  const indices = layout.vertexCount > 65535 ? new Uint32Array(layout.vertexCount) : new Uint16Array(layout.vertexCount);
  for (let index = 0; index < indices.length; index++) indices[index] = index;
  overlay.setIndices(indices);
  const inverseRoot = Matrix.Identity();
  const lightWorld = Vector3.Zero();
  const lightLocal = Vector3.Zero();
  const light: [number, number, number] = [0, 1, 0];
  const indexByName = new Map<string, number>();
  for (let index = joints.length - 1; index >= 0; index--) indexByName.set(joints[index]!.name, index);
  let selected = -1;
  let size = 0;
  const update = () => {
    root.computeWorldMatrix(true).invertToRef(inverseRoot);
    for (const [skeleton, mesh] of skins) {
      mesh.computeWorldMatrix(true);
      // Hidden skins are absent from Babylon's active mesh preparation.
      skeleton.prepare(true);
      for (const bone of skeleton.bones) {
        if (!bone.getParent()) bone.computeAbsoluteMatrices();
      }
    }
    for (let index = 0; index < joints.length; index++) {
      const joint = joints[index]!;
      joint.readPosition(joint.position);
      Vector3.TransformCoordinatesToRef(joint.position, inverseRoot, joint.position);
      joint.position.toArray(jointPositions, index * 3);
    }
    for (const index of layout.tails) {
      const joint = joints[index]!;
      if (joint.readPartCenter) {
        // The part reaches about twice as far from its pivot as its centre does (an arm hangs from the shoulder).
        joint.readPartCenter(partCenter);
        Vector3.TransformCoordinatesToRef(partCenter, inverseRoot, partCenter);
        tails[index * 3] = joint.position.x + (partCenter.x - joint.position.x) * 2;
        tails[index * 3 + 1] = joint.position.y + (partCenter.y - joint.position.y) * 2;
        tails[index * 3 + 2] = joint.position.z + (partCenter.z - joint.position.z) * 2;
      } else {
        const parent = joints[joint.parent]!.position;
        tails[index * 3] = joint.position.x + (joint.position.x - parent.x) * LEAF_TAIL_OF_PARENT;
        tails[index * 3 + 1] = joint.position.y + (joint.position.y - parent.y) * LEAF_TAIL_OF_PARENT;
        tails[index * 3 + 2] = joint.position.z + (joint.position.z - parent.z) * LEAF_TAIL_OF_PARENT;
      }
    }
    if (size === 0) {
      // The rest pose's extent sets the width limits once, so bones keep their size while the rig animates.
      const minimum = joints[0]!.position.clone();
      const maximum = minimum.clone();
      for (const joint of joints) {
        minimum.minimizeInPlace(joint.position);
        maximum.maximizeInPlace(joint.position);
      }
      size = Math.max(maximum.subtract(minimum).length(), 0.05);
    }
    // A headlight from slightly above the camera, in the overlay's space.
    const camera = scene.activeCamera;
    if (camera) {
      camera.getDirectionToRef(Axis.Z, lightWorld);
      lightWorld.scaleInPlace(-1).addInPlaceFromFloats(0, 0.35, 0);
    } else {
      lightWorld.set(0.3, 0.8, -0.5);
    }
    Vector3.TransformNormalToRef(lightWorld, inverseRoot, lightLocal);
    lightLocal.normalize();
    light[0] = lightLocal.x; light[1] = lightLocal.y; light[2] = lightLocal.z;
    writeRigPreview({ joints: jointPositions, tails, parents, layout, size, light, selected, positions, colors });
    overlay.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
    overlay.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
    overlay.refreshBoundingInfo();
  };
  update();
  const observer = scene.onBeforeRenderObservable.add(update);
  const visibility = meshes.map((mesh) => [mesh, mesh.isVisible] as const);
  for (const mesh of meshes) mesh.isVisible = false;
  let disposed = false;
  return {
    boneCount: joints.length,
    setSelectedBone: (name) => {
      selected = name === null ? -1 : (indexByName.get(name) ?? -1);
      if (!disposed) update();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      scene.onBeforeRenderObservable.remove(observer);
      overlay.dispose(false, true);
      for (const [mesh, wasVisible] of visibility) {
        if (!mesh.isDisposed()) mesh.isVisible = wasVisible;
      }
    },
  };
}
