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
import {
  RIG_JOINT_HIDDEN,
  rigPreviewLayout,
  rigPreviewTopology,
  writeRigPreview,
  type RigJointRest,
} from "./rig-preview-geometry";

/** The preview's bones and joints: vertex-coloured, shaded in the colours, drawn from both sides. */
const SKELETON_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "preview" };

/** The loader roots a converted model's armature object can sit under. */
const IMPORT_ROOTS: ReadonlySet<string> = new Set(["__root__", "__fbx_root__"]);

interface PreviewJoint extends RigJointRest {
  name: string;
  position: Vector3;
  readPosition: (position: Vector3) => void;
  /** Its world matrix, whose bone axis a guessed tail runs along. */
  readWorld: () => Matrix;
  /** A rigid-part rig's mesh part: its world bounds' corners, which its bone runs through. */
  readPartCorners?: () => readonly Vector3[];
}

/** A guessed tail runs this share of the bone before it, or of the rig's size for a joint with no parent. */
const GUESSED_TAIL_OF_PARENT = 0.5;
const GUESSED_TAIL_OF_SIZE = 0.05;

/** The bone indices any vertex of `meshes` is weighted to. */
function weightedBones(meshes: readonly AbstractMesh[]): Set<number> {
  const weighted = new Set<number>();
  const kinds = [
    [VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind],
    [VertexBuffer.MatricesIndicesExtraKind, VertexBuffer.MatricesWeightsExtraKind],
  ] as const;
  for (const mesh of meshes) {
    for (const [indexKind, weightKind] of kinds) {
      const indices = mesh.getVerticesData(indexKind);
      const weights = mesh.getVerticesData(weightKind);
      if (!indices || !weights) continue;
      for (let i = 0; i < indices.length; i++) if (weights[i]! > 0) weighted.add(indices[i]!);
    }
  }
  return weighted;
}

/** The rig drawn over (or instead of) a previewed model. */
export interface SkeletonPreviewHandle {
  boneCount: number;
  /**
   * Draws the named joint and its bone in the selection colour; an end marker lights the bone that ends at it. Null,
   * an unknown name or a joint drawn not at all clears it.
   */
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
 * Shows only the rig, keeping hidden source transforms and animation alive, lit from the camera: one octahedral bone
 * per joint, running to the child that continues it, a thin line to each other child, and a ball at every drawn joint
 * ([rig-preview-geometry.ts](./rig-preview-geometry.ts)). What each joint draws is worked out once, from the rest
 * pose; only the guessed tails follow the pose.
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
  let connect = true;
  if (kind === "skin" && !animationLibrary) {
    for (const mesh of meshes) {
      if (!mesh.skeleton || skins.has(mesh.skeleton)) continue;
      const skeleton = mesh.skeleton;
      skins.set(skeleton, mesh);
      const weighted = weightedBones(meshes.filter((candidate) => candidate.skeleton === skeleton));
      const offset = joints.length;
      skeleton.bones.forEach((bone, index) => {
        const parent = bone.getParent();
        const linked = bone.getTransformNode();
        const world = Matrix.Identity();
        joints.push({
          name: bone.name,
          position: Vector3.Zero(),
          parent: parent ? offset + skeleton.bones.indexOf(parent) : -1,
          local: bone.getRestMatrix().getTranslation().asArray() as [number, number, number],
          // No weights to read (CPU vertex data released) says nothing: every joint deforms.
          deforms: weighted.size === 0 || weighted.has(index),
          underImportRoot: !parent && !!linked?.parent && IMPORT_ROOTS.has(linked.parent.name),
          readPosition: (position) => {
            if (linked) {
              linked.computeWorldMatrix(true);
              position.copyFrom(linked.getAbsolutePosition());
            } else {
              bone.getAbsolutePositionToRef(mesh, position);
            }
          },
          readWorld: () => linked
            ? linked.computeWorldMatrix(true)
            : (bone.getAbsoluteMatrix().multiplyToRef(mesh.computeWorldMatrix(true), world), world),
        });
      });
    }
  } else {
    const nodes = [root, ...root.getChildTransformNodes(false)].filter(
      isRigJointNode,
    );
    const indexByNode = new Map<Node, number>(
      nodes.map((node, index) => [node, index]),
    );
    const parts = nodes.map((node) => (node instanceof AbstractMesh && node.getTotalVertices() > 0 ? node : null));
    // A rig of mesh parts draws each part's bone through its part; a bare joint hierarchy draws bones along its axis.
    connect = parts.every((part) => !part);
    nodes.forEach((node, index) => {
      let parent = node.parent;
      while (parent && !indexByNode.has(parent)) parent = parent.parent;
      const part = parts[index];
      const underImportRoot = !!node.parent && IMPORT_ROOTS.has(node.parent.name);
      joints.push({
        name: node.name,
        position: Vector3.Zero(),
        parent: parent ? indexByNode.get(parent)! : -1,
        local: node.position.asArray() as [number, number, number],
        // A bare hierarchy's joints all move something, but the armature object above them.
        deforms: connect ? !(underImportRoot && !parent) : !!part,
        underImportRoot,
        readPosition: (position) => {
          node.computeWorldMatrix(true);
          position.copyFrom(node.getAbsolutePosition());
        },
        readWorld: () => node.computeWorldMatrix(true),
        ...(part ? {
          readPartCorners: () => {
            part.computeWorldMatrix(true);
            return part.getBoundingInfo().boundingBox.vectorsWorld;
          },
        } : {}),
      });
    });
  }
  if (joints.length === 0) return { boneCount: 0, setSelectedBone: () => {}, dispose: () => {} };

  const topology = rigPreviewTopology(joints, { connect, topMarkers: connect && skins.size === 0 });
  const layout = rigPreviewLayout(topology);
  const tails = new Float32Array(joints.length * 3).fill(Number.NaN);
  const axisWorld = Vector3.Zero();
  const axisLocal = Vector3.Zero();
  const corner = Vector3.Zero();
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
  /** A joint drawn as its parent's tail selects that parent's bone; one drawn not at all selects nothing. */
  const drawnJoint = (index: number): number => {
    if (index < 0 || topology.kinds[index] !== RIG_JOINT_HIDDEN) return index;
    const parent = joints[index]!.parent;
    return parent >= 0 && topology.connected[parent] === index ? parent : -1;
  };
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
    for (const index of layout.bones) {
      const joint = joints[index]!;
      const at = index * 3;
      const child = topology.connected[index]!;
      if (child >= 0) {
        joints[child]!.position.toArray(tails, at);
        continue;
      }
      const corners = joint.readPartCorners?.();
      if (corners) {
        // A part's bone runs from its pivot through its centre to the far side of its bounds.
        partCenter.setAll(0);
        let reach = 0;
        const local = corners.map((point) => Vector3.TransformCoordinates(point, inverseRoot));
        for (const point of local) partCenter.addInPlace(point);
        partCenter.scaleInPlace(1 / local.length).subtractInPlace(joint.position);
        const centerDistance = partCenter.length();
        if (centerDistance < 1e-6) {
          tails.fill(Number.NaN, at, at + 3);
          continue;
        }
        partCenter.scaleInPlace(1 / centerDistance);
        for (const point of local) reach = Math.max(reach, Vector3.Dot(point.subtractToRef(joint.position, corner), partCenter));
        tails[at] = joint.position.x + partCenter.x * reach;
        tails[at + 1] = joint.position.y + partCenter.y * reach;
        tails[at + 2] = joint.position.z + partCenter.z * reach;
        continue;
      }
      // No child continues it: a tail along its own bone axis, half the bone before it long.
      Vector3.TransformNormalToRef(Vector3.FromArrayToRef(topology.axis, 0, axisWorld), joint.readWorld(), axisWorld);
      Vector3.TransformNormalToRef(axisWorld, inverseRoot, axisLocal);
      const axisLength = axisLocal.length();
      if (axisLength < 1e-9) {
        tails.fill(Number.NaN, at, at + 3);
        continue;
      }
      const parent = joint.parent >= 0 && topology.kinds[joint.parent] !== RIG_JOINT_HIDDEN ? joints[joint.parent]! : null;
      const length = parent
        ? Vector3.Distance(parent.position, joint.position) * GUESSED_TAIL_OF_PARENT
        : size * GUESSED_TAIL_OF_SIZE;
      tails[at] = joint.position.x + (axisLocal.x / axisLength) * length;
      tails[at + 1] = joint.position.y + (axisLocal.y / axisLength) * length;
      tails[at + 2] = joint.position.z + (axisLocal.z / axisLength) * length;
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
    writeRigPreview({ joints: jointPositions, tails, layout, size, light, selected, positions, colors });
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
      selected = name === null ? -1 : drawnJoint(indexByName.get(name) ?? -1);
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
