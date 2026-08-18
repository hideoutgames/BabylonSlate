import { AnimatorAvatar } from "@babylonjs/core/Animations/animatorAvatar";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { SkeletonViewer } from "@babylonjs/core/Debug/skeletonViewer";
import { Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";

export function ensureNodeRotationQuaternion(node: TransformNode): void {
  if (!node.rotationQuaternion) {
    node.rotationQuaternion = Quaternion.FromEulerVector(node.rotation);
  }
}

function isCameraOrLight(node: Node): boolean {
  const className = node.getClassName();
  return className.includes("Camera") || className.includes("Light");
}

function isRigTransform(node: Node): node is TransformNode {
  return node instanceof TransformNode && !isCameraOrLight(node);
}

export interface LinkedSkeletonFromNodeRigOptions {
  name?: string;
  createMesh?: boolean;
  boneMeshSize?: number;
}

export interface LinkedSkeletonFromNodeRigResult {
  skeleton: Skeleton;
  overlay: Mesh | null;
}

/**
 * Linked skeleton for hierarchy rigs. Includes Mesh nodes (Mannequin parts).
 * Dummy overlay is only for SkeletonViewer — character meshes stay unskinned.
 */
export function createLinkedSkeletonFromNodeRig(
  root: TransformNode,
  options: LinkedSkeletonFromNodeRigOptions = {},
): LinkedSkeletonFromNodeRigResult {
  const scene = root.getScene();
  const name = options.name || `${root.name}_skeleton`;
  const skeleton = new Skeleton(name, name, scene);
  const nodes: TransformNode[] = [];
  if (isRigTransform(root)) nodes.push(root);
  for (const child of root.getChildTransformNodes(false)) {
    if (!isRigTransform(child)) continue;
    if (child.name.endsWith("_overlay")) continue;
    nodes.push(child);
  }

  let overlay: Mesh | null = null;
  if (options.createMesh) {
    overlay = new Mesh(`${name}_overlay`, scene);
    overlay.parent = root;
    overlay.isPickable = false;
    overlay.skeleton = skeleton;
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const boneIndices: number[] = [];
  const boneWeights: number[] = [];
  const boneMesh = options.createMesh
    ? MeshBuilder.CreateSphere(
        "dummy",
        { diameter: options.boneMeshSize || 0.08, segments: 8 },
        scene,
      )
    : null;
  const boneMeshNumVertices = boneMesh?.getTotalVertices() || 0;
  const boneMeshPositions = boneMesh?.getVerticesData(VertexBuffer.PositionKind);
  const boneMeshIndices = boneMesh?.getIndices();
  const boneMeshNormals = boneMesh?.getVerticesData(VertexBuffer.NormalKind);
  const mapNameToBone: Record<string, Bone> = {};

  for (const node of nodes) {
    ensureNodeRotationQuaternion(node);
    if (!node.rotationQuaternion) continue;
    const currentVertexIndex = positions.length / 3;
    if (boneMeshPositions) {
      for (let i = 0; i < boneMeshPositions.length; i++) {
        positions.push(boneMeshPositions[i]!);
      }
    }
    if (boneMeshNormals) {
      for (let i = 0; i < boneMeshNormals.length; i++) {
        normals.push(boneMeshNormals[i]!);
      }
    }
    const boneIndex = skeleton.bones.length;
    if (boneMesh) {
      for (let i = 0; i < boneMeshNumVertices; i++) {
        boneIndices.push(boneIndex, -1, -1, -1);
        boneWeights.push(1, 0, 0, 0);
      }
    }
    if (boneMeshIndices) {
      for (let i = 0; i < boneMeshIndices.length; i++) {
        indices.push(currentVertexIndex + boneMeshIndices[i]!);
      }
    }
    const parentName = node.parent?.name;
    const parentBone =
      node.parent && parentName ? (mapNameToBone[parentName] ?? null) : null;
    const bone = new Bone(
      node.name,
      skeleton,
      parentBone,
      Matrix.Compose(node.scaling, node.rotationQuaternion, node.position),
      undefined,
      Matrix.Identity(),
    );
    bone.linkTransformNode(node);
    mapNameToBone[node.name] = bone;
  }

  overlay?.setVerticesData(VertexBuffer.PositionKind, positions);
  overlay?.setVerticesData(VertexBuffer.NormalKind, normals);
  overlay?.setVerticesData(VertexBuffer.MatricesIndicesKind, boneIndices);
  overlay?.setVerticesData(VertexBuffer.MatricesWeightsKind, boneWeights);
  overlay?.setIndices(indices);
  overlay?.refreshBoundingInfo(true, false);
  boneMesh?.dispose();
  return { skeleton, overlay };
}

function isExactTransformNode(target: { getClassName?: () => string }): boolean {
  return target.getClassName?.() === "TransformNode";
}

/** Clone a group so Mesh (and InstancedMesh) targets become same-name TransformNode proxies. */
export function withTransformNodeAnimationTargets(group: AnimationGroup): {
  group: AnimationGroup;
  dispose: () => void;
} {
  const proxies: TransformNode[] = [];
  const cloned = group.clone(
    `${group.name}__tn`,
    (oldTarget) => {
      if (!oldTarget || isExactTransformNode(oldTarget)) return oldTarget;
      if (!(oldTarget instanceof TransformNode)) return oldTarget;
      const proxy = new TransformNode(oldTarget.name, oldTarget.getScene());
      proxy.parent = oldTarget.parent;
      proxy.position.copyFrom(oldTarget.position);
      proxy.scaling.copyFrom(oldTarget.scaling);
      ensureNodeRotationQuaternion(oldTarget);
      proxy.rotationQuaternion = oldTarget.rotationQuaternion!.clone();
      proxies.push(proxy);
      return proxy;
    },
    true,
    true,
  );
  return {
    group: cloned,
    dispose: () => {
      cloned.dispose();
      for (const proxy of proxies) proxy.dispose();
    },
  };
}

/** Name-match retarget that first proxies Mesh clip targets for AnimatorAvatar. */
export function retargetAnimationGroupWithMeshProxy(
  source: AnimationGroup,
  targetRoot: TransformNode,
  options?: Parameters<AnimatorAvatar["retargetAnimationGroup"]>[1],
): AnimationGroup | null {
  const { group: proxied, dispose } = withTransformNodeAnimationTargets(source);
  const avatar = new AnimatorAvatar("retarget-avatar", targetRoot, false, false);
  avatar.showWarnings = false;
  try {
    const retargeted = avatar.retargetAnimationGroup(proxied, {
      fixRootPosition: false,
      fixGroundReference: false,
      ...options,
    });
    if (retargeted.targetedAnimations.length === 0) {
      retargeted.dispose();
      return null;
    }
    return retargeted;
  } finally {
    dispose();
    avatar.dispose();
  }
}

export function findSkinnedMesh(root: TransformNode): AbstractMesh | null {
  if ("skeleton" in root && (root as AbstractMesh).skeleton) {
    return root as AbstractMesh;
  }
  return root.getChildMeshes(false).find((mesh) => mesh.skeleton) ?? null;
}

/** Skin viewer on a real skinned mesh, or a dummy overlay for hierarchy rigs. */
export function attachSkeletonPreview(
  root: TransformNode,
  scene: Scene,
  kind: "skin" | "hierarchy",
): { dispose: () => void } {
  const extra: Array<{ dispose: () => void }> = [];
  let mesh: AbstractMesh | null = null;
  let skeleton: Skeleton | null = null;
  if (kind === "skin") {
    mesh = findSkinnedMesh(root);
    skeleton = mesh?.skeleton ?? null;
  } else {
    const linked = createLinkedSkeletonFromNodeRig(root, { createMesh: true });
    mesh = linked.overlay;
    skeleton = linked.skeleton;
    extra.push({
      dispose: () => {
        linked.overlay?.dispose();
        linked.skeleton.dispose();
      },
    });
  }
  if (mesh && skeleton) {
    try {
      const viewer = new SkeletonViewer(skeleton, mesh, scene, true, 1, {
        displayMode: SkeletonViewer.DISPLAY_LINES,
      });
      extra.unshift({ dispose: () => viewer.dispose() });
    } catch {
      // NullEngine / missing utility layer — overlay still exists for tests.
    }
  }
  return {
    dispose: () => {
      for (const entry of extra) entry.dispose();
    },
  };
}
