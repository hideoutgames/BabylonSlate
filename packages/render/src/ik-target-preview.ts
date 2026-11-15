import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePolyhedron } from "@babylonjs/core/Meshes/Builders/polyhedronBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AnimBoneModifier } from "@haptic/core";
import { worldPoint, type BoneNode } from "./anim-bone-modifiers";
import { isRigJointNode } from "./skeleton-preview";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

const MARKER_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "preview" };
/** Look At targets and Two Bone IK effectors. */
const TARGET_COLOR: [number, number, number] = [1, 0.55, 0.15];
const JOINT_TARGET_COLOR: [number, number, number] = [0.75, 0.45, 1];
/** A marker spans this share of the rig's rest extent. */
const MARKER_SHARE = 0.03;

/** The IK targets an Animation Graph Preview draws over its Model. */
export interface IkTargetPreviewHandle {
  /** Places a marker at each Look At target, Two Bone IK effector and Joint Target the changes name; hides the rest. */
  update(changes: readonly AnimBoneModifier[]): void;
  /** How many markers show. */
  readonly count: number;
  dispose(): void;
}

function boneNodeOf(root: TransformNode, name: string): TransformNode | null {
  for (const mesh of root.getChildMeshes(false)) {
    const linked = mesh.skeleton?.bones.find((bone) => bone.name === name)?.getTransformNode();
    if (linked) return linked;
  }
  return root.getChildTransformNodes(false).find((node) => node.name === name && isRigJointNode(node)) ?? null;
}

function rigExtent(root: TransformNode): number {
  const { min, max } = root.getHierarchyBoundingVectors(true);
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  return Number.isFinite(extent) && extent > 0 ? extent : 1;
}

/** Markers for the Look At and Two Bone IK targets of each evaluation, in the scene's (world) space. */
export function attachIkTargetPreview(root: TransformNode, scene: Scene): IkTargetPreviewHandle {
  const size = rigExtent(root) * MARKER_SHARE;
  const markers: Mesh[] = [];
  const bones = new Map<string, TransformNode | null>();
  let shown = 0;
  const marker = (index: number, color: [number, number, number]): Mesh => {
    let mesh = markers[index];
    if (!mesh) {
      mesh = CreatePolyhedron(`ik_target_${index}`, { type: 1, size: 1 }, scene);
      mesh.scaling.setAll(size);
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      markers.push(mesh);
    }
    setUnlitMaterial(mesh, MARKER_MATERIAL, {
      texture: null, color, alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: true,
    });
    mesh.setEnabled(true);
    return mesh;
  };
  const boneOf = (name: string) => {
    if (!bones.has(name)) bones.set(name, boneNodeOf(root, name));
    return bones.get(name) ?? null;
  };
  return {
    update(changes) {
      let used = 0;
      const place = (node: TransformNode, value: readonly number[], space: "actor" | "world", color: [number, number, number]) => {
        const mesh = marker(used++, color);
        worldPoint(node as unknown as BoneNode, value, space, mesh.position);
      };
      for (const change of changes) {
        if (change.kind === "transform") continue;
        const node = boneOf(change.bone);
        if (!node) continue;
        if (change.kind === "lookAt") {
          place(node, change.target, change.targetSpace, TARGET_COLOR);
        } else {
          place(node, change.effector, change.effectorSpace, TARGET_COLOR);
          if (change.jointTarget) place(node, change.jointTarget, change.jointTargetSpace, JOINT_TARGET_COLOR);
        }
      }
      for (let index = used; index < markers.length; index++) markers[index]!.setEnabled(false);
      shown = used;
    },
    get count() {
      return shown;
    },
    dispose() {
      for (const mesh of markers) mesh.dispose(false, true);
      markers.length = 0;
      bones.clear();
      shown = 0;
    },
  };
}
