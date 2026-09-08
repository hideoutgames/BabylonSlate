import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";

interface PreviewJoint {
  position: Vector3;
  parent: number;
  readPosition: (position: Vector3) => void;
}

// Six vertices form an octahedron: two endpoints and a four-vertex ring.
const OCTAHEDRON_INDICES = [
  0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2, 1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5,
];

function isPreviewJoint(node: Node): node is TransformNode {
  return (
    node instanceof TransformNode &&
    !["__root__", "__importScale", "materialPreviewMesh"].includes(node.name) &&
    !node.name.endsWith("_overlay") &&
    !/Camera|Light/.test(node.getClassName())
  );
}

function createGlyphMesh(
  name: string,
  count: number,
  color: Color3,
  parent: Mesh,
): Mesh {
  const mesh = new Mesh(name, parent.getScene());
  mesh.parent = parent;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  const material = new StandardMaterial(`${name}-material`, parent.getScene());
  material.disableLighting = true;
  material.emissiveColor = color;
  material.backFaceCulling = false;
  mesh.material = material;
  mesh.setVerticesData(
    VertexBuffer.PositionKind,
    new Float32Array(count * 18),
    true,
  );
  mesh.setIndices(
    Array.from({ length: count }, (_, index) =>
      OCTAHEDRON_INDICES.map((vertex) => vertex + index * 6),
    ).flat(),
  );
  return mesh;
}

function writeOffsetVertex(
  positions: Float32Array,
  offset: number,
  center: Vector3,
  direction: Vector3,
  sign: number,
): void {
  positions[offset] = center.x + direction.x * sign;
  positions[offset + 1] = center.y + direction.y * sign;
  positions[offset + 2] = center.z + direction.z * sign;
}

function writeGlyph(
  positions: Float32Array,
  offset: number,
  start: Vector3,
  end: Vector3,
  center: Vector3,
  side: Vector3,
  up: Vector3,
): void {
  start.toArray(positions, offset);
  end.toArray(positions, offset + 3);
  writeOffsetVertex(positions, offset + 6, center, side, 1);
  writeOffsetVertex(positions, offset + 9, center, up, 1);
  writeOffsetVertex(positions, offset + 12, center, side, -1);
  writeOffsetVertex(positions, offset + 15, center, up, -1);
}

/** Shows only the rig, keeping hidden source transforms and animation alive. */
export function attachSkeletonPreview(
  root: TransformNode,
  scene: Scene,
  kind: "skin" | "hierarchy",
): { boneCount: number; dispose: () => void } {
  const meshes = [
    ...(root instanceof AbstractMesh ? [root] : []),
    ...root.getChildMeshes(false),
  ];
  const joints: PreviewJoint[] = [];
  const skins = new Map<Skeleton, AbstractMesh>();
  if (kind === "skin") {
    for (const mesh of meshes) {
      if (!mesh.skeleton || skins.has(mesh.skeleton)) continue;
      const skeleton = mesh.skeleton;
      skins.set(skeleton, mesh);
      const offset = joints.length;
      for (const bone of skeleton.bones) {
        const parent = bone.getParent();
        joints.push({
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
      isPreviewJoint,
    );
    const indexByNode = new Map<Node, number>(
      nodes.map((node, index) => [node, index]),
    );
    for (const node of nodes) {
      let parent = node.parent;
      while (parent && !indexByNode.has(parent)) parent = parent.parent;
      joints.push({
        position: Vector3.Zero(),
        parent: parent ? indexByNode.get(parent)! : -1,
        readPosition: (position) => {
          node.computeWorldMatrix(true);
          position.copyFrom(node.getAbsolutePosition());
        },
      });
    }
  }
  if (joints.length === 0) return { boneCount: 0, dispose: () => {} };

  const overlay = new Mesh(`${root.name}_skeleton_overlay`, scene);
  overlay.parent = root;
  overlay.isPickable = false;
  const links = joints.filter((joint) => joint.parent >= 0);
  const markers = createGlyphMesh(
    "skeleton-joints",
    joints.length,
    Color3.White(),
    overlay,
  );
  const connectors =
    links.length === 0
      ? null
      : createGlyphMesh(
          "skeleton-bones",
          links.length,
          new Color3(0.05, 0.8, 1),
          overlay,
        );
  const markerPositions = new Float32Array(joints.length * 18);
  const connectorPositions = new Float32Array(links.length * 18);
  const inverseRoot = Matrix.Identity();
  const axis = Vector3.Zero();
  const side = Vector3.Zero();
  const up = Vector3.Zero();
  const center = Vector3.Zero();
  const start = Vector3.Zero();
  const end = Vector3.Zero();
  let radius = 0;
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
    for (const joint of joints) {
      joint.readPosition(joint.position);
      Vector3.TransformCoordinatesToRef(
        joint.position,
        inverseRoot,
        joint.position,
      );
    }
    if (radius === 0) {
      const minimum = joints[0]!.position.clone();
      const maximum = minimum.clone();
      for (const joint of joints) {
        minimum.minimizeInPlace(joint.position);
        maximum.maximizeInPlace(joint.position);
      }
      radius = Math.max(maximum.subtract(minimum).length() * 0.009, 0.005);
    }
    side.set(radius, 0, 0);
    up.set(0, 0, radius);
    for (let index = 0; index < joints.length; index++) {
      const position = joints[index]!.position;
      start.copyFromFloats(position.x, position.y + radius, position.z);
      end.copyFromFloats(position.x, position.y - radius, position.z);
      writeGlyph(markerPositions, index * 18, start, end, position, side, up);
    }
    for (let index = 0; index < links.length; index++) {
      const joint = links[index]!;
      const parent = joints[joint.parent]!.position;
      joint.position.subtractToRef(parent, axis);
      const length = axis.length();
      axis.normalize();
      Vector3.CrossToRef(
        axis,
        Math.abs(axis.y) < 0.9 ? Vector3.UpReadOnly : Vector3.RightReadOnly,
        side,
      );
      side.normalize().scaleInPlace(Math.min(radius * 1.8, length * 0.12));
      Vector3.CrossToRef(axis, side, up);
      Vector3.LerpToRef(parent, joint.position, 0.2, center);
      writeGlyph(
        connectorPositions,
        index * 18,
        parent,
        joint.position,
        center,
        side,
        up,
      );
    }
    markers.updateVerticesData(
      VertexBuffer.PositionKind,
      markerPositions,
      true,
    );
    connectors?.updateVerticesData(
      VertexBuffer.PositionKind,
      connectorPositions,
      true,
    );
  };
  update();
  const observer = scene.onBeforeRenderObservable.add(update);
  const visibility = meshes.map((mesh) => [mesh, mesh.isVisible] as const);
  for (const mesh of meshes) mesh.isVisible = false;
  let disposed = false;
  return {
    boneCount: joints.length,
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
