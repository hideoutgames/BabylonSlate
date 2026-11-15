import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateCapsule } from "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreatePolyhedron } from "@babylonjs/core/Meshes/Builders/polyhedronBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { animBoneAxisVector, type AnimBoneModifier, type AnimSpringCollider } from "@haptic/core";
import { actorRootOf, worldPoint, type BoneNode } from "./anim-bone-modifiers";
import { isRigJointNode } from "./skeleton-preview";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

const MARKER_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "preview" };
/** Look At targets and Two Bone IK effectors. */
const TARGET_COLOR: [number, number, number] = [1, 0.55, 0.15];
const JOINT_TARGET_COLOR: [number, number, number] = [0.75, 0.45, 1];
/** Spring Bones colliders, drawn see-through. */
const COLLIDER_COLOR: [number, number, number] = [0.3, 0.85, 1];
const COLLIDER_ALPHA = 0.3;
/** A target marker spans this share of the rig's rest extent; a plane collider is drawn this many times wider. */
const MARKER_SHARE = 0.03;
const PLANE_SHARE = 0.4;

/** What an Animation Graph Preview draws over its Model for its skeletal controls. */
export interface SkeletalControlPreviewHandle {
  /**
   * Places a marker at each Look At target, Two Bone IK effector and Joint Target, and each Spring Bones collider, the
   * changes name; hides the rest.
   */
  update(changes: readonly AnimBoneModifier[]): void;
  /** How many target markers show. */
  readonly targetCount: number;
  /** How many colliders show. */
  readonly colliderCount: number;
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

/** A collider's shape as a key: a pooled mesh is rebuilt only when its shape changes. */
function shapeKey(collider: AnimSpringCollider, scale: number): string {
  return `${collider.kind}:${collider.radius * scale}:${collider.length * scale}`;
}

/** Markers for the skeletal controls of each evaluation, in the scene's (world) space. */
export function attachSkeletalControlPreview(root: TransformNode, scene: Scene): SkeletalControlPreviewHandle {
  const extent = rigExtent(root);
  const size = extent * MARKER_SHARE;
  const targets: Mesh[] = [];
  const colliders: Array<{ mesh: Mesh; key: string }> = [];
  const bones = new Map<string, TransformNode | null>();
  let targetCount = 0;
  let colliderCount = 0;
  const target = (index: number, color: [number, number, number]): Mesh => {
    let mesh = targets[index];
    if (!mesh) {
      mesh = CreatePolyhedron(`ik_target_${index}`, { type: 1, size: 1 }, scene);
      mesh.scaling.setAll(size);
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      targets.push(mesh);
    }
    setUnlitMaterial(mesh, MARKER_MATERIAL, { texture: null, color, alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: true });
    mesh.setEnabled(true);
    return mesh;
  };
  const colliderMesh = (index: number, collider: AnimSpringCollider, scale: number): Mesh => {
    const key = shapeKey(collider, scale);
    let entry = colliders[index];
    if (!entry || entry.key !== key) {
      entry?.mesh.dispose(false, true);
      const name = `spring_collider_${index}`;
      const radius = Math.max(1e-4, collider.radius * scale);
      const mesh = collider.kind === "sphere"
        ? CreateSphere(name, { diameter: radius * 2, segments: 12 }, scene)
        : collider.kind === "capsule"
          ? CreateCapsule(name, { radius, height: collider.length * scale + radius * 2, tessellation: 12, subdivisions: 1 }, scene)
          : CreateDisc(name, { radius: extent * PLANE_SHARE, tessellation: 24 }, scene);
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.rotationQuaternion = Quaternion.Identity();
      setUnlitMaterial(mesh, MARKER_MATERIAL, {
        texture: null, color: COLLIDER_COLOR, alpha: COLLIDER_ALPHA, cutoff: 0, blend: true, textureAlpha: false, twoSided: true,
      });
      entry = { mesh, key };
      colliders[index] = entry;
    }
    entry.mesh.setEnabled(true);
    return entry.mesh;
  };
  const boneOf = (name: string) => {
    if (!bones.has(name)) bones.set(name, boneNodeOf(root, name));
    return bones.get(name) ?? null;
  };
  const axis = new Vector3();
  return {
    update(changes) {
      let usedTargets = 0;
      let usedColliders = 0;
      const place = (node: TransformNode, value: readonly number[], space: "actor" | "world", color: [number, number, number]) => {
        worldPoint(node as unknown as BoneNode, value, space, target(usedTargets++, color).position);
      };
      for (const change of changes) {
        if (change.kind === "transform") continue;
        const node = boneOf(change.bone);
        if (!node) continue;
        if (change.kind === "lookAt") {
          place(node, change.target, change.targetSpace, TARGET_COLOR);
        } else if (change.kind === "twoBoneIk") {
          place(node, change.effector, change.effectorSpace, TARGET_COLOR);
          if (change.jointTarget) place(node, change.jointTarget, change.jointTargetSpace, JOINT_TARGET_COLOR);
        } else {
          // Colliders sit on their bones; their sizes are in actor units, scaled as the actor root scales.
          const scale = Math.abs((actorRootOf(node as unknown as BoneNode).scaling.x)) || 1;
          for (const collider of change.settings.colliders) {
            const bone = boneOf(collider.bone);
            if (!bone) continue;
            const world = bone.computeWorldMatrix(true);
            const mesh = colliderMesh(usedColliders++, collider, scale);
            Vector3.TransformCoordinatesToRef(Vector3.FromArray(collider.offset), world, mesh.position);
            Vector3.TransformNormalToRef(Vector3.FromArray(animBoneAxisVector(collider.axis, "y")), world, axis);
            if (axis.lengthSquared() < 1e-12) axis.copyFrom(Vector3.UpReadOnly);
            // Capsules run along their axis (Y as built); a plane's disc faces along its normal (-Z as built).
            const built = collider.kind === "plane" ? Vector3.Backward() : Vector3.Up();
            Quaternion.FromUnitVectorsToRef(built, axis.normalize(), mesh.rotationQuaternion!);
          }
        }
      }
      for (let index = usedTargets; index < targets.length; index++) targets[index]!.setEnabled(false);
      for (let index = usedColliders; index < colliders.length; index++) colliders[index]!.mesh.setEnabled(false);
      targetCount = usedTargets;
      colliderCount = usedColliders;
    },
    get targetCount() {
      return targetCount;
    },
    get colliderCount() {
      return colliderCount;
    },
    dispose() {
      for (const mesh of targets) mesh.dispose(false, true);
      for (const entry of colliders) entry.mesh.dispose(false, true);
      targets.length = 0;
      colliders.length = 0;
      bones.clear();
      targetCount = 0;
      colliderCount = 0;
    },
  };
}
