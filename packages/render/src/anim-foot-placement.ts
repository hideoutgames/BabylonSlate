import { Ray } from "@babylonjs/core/Culling/ray";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AnimFootPlacementChange, AnimTwoBoneIkChange } from "@haptic/core";
import {
  actorRootOf,
  composeTrs,
  ikChainOf,
  localMatrixOf,
  parentActorMatrix,
  readNodeTrs,
  storeRotation,
  turnAbout,
  twoBoneIkLocalTrs,
  TRANSLATION,
  TRS_LENGTH,
  WRITE_ROTATION,
  WRITE_TRANSLATION,
  type BoneNode,
} from "./anim-bone-modifiers";
import { isColliderVisualTree } from "./collider-visual";
import { isEditorHelperMesh } from "./helper-mesh";
import { isSkyboxMesh } from "./skybox";

/**
 * Foot Placement on posed nodes, after the clips blend. Cosmetic like the other skeletal controls: render traces each
 * foot down against the scene's drawn meshes (not the actor's own), drops the pelvis by the lowest foot's drop, puts
 * each foot at the height of its ground by Two Bone IK (keeping its rotation relative to the actor), and turns it to
 * the ground's slope. Heights are measured from the actor's own ground plane (its root's XZ plane), so a foot the
 * animation lifts stays lifted by as much above uneven ground.
 */

/** Writes a bone's solved local transform (blended with `base` by the change's alpha) on `channels`. */
export type BoneWrite = (node: BoneNode, base: Float64Array, solved: Float64Array, channels: number) => void;

const rootMatrix = new Matrix();
const worldToActor = new Matrix();
const parentMatrix = new Matrix();
const local = new Matrix();
const actorMatrix = new Matrix();
const inverse = new Matrix();
const base = new Float64Array(TRS_LENGTH);
const solved = new Float64Array(TRS_LENGTH);
const ikBases = [new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH)] as const;
const ikSolved = [new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH)] as const;
const turn = new Quaternion();

/** Whether a mesh is ground a foot can stand on: drawn, solid, not a helper and not the actor's own. */
function isGround(mesh: AbstractMesh, actorRoot: unknown): boolean {
  return mesh.isEnabled() &&
    mesh.isVisible &&
    mesh.visibility > 0 &&
    !(mesh instanceof LinesMesh) &&
    mesh.getTotalVertices() > 0 &&
    !mesh.infiniteDistance &&
    !isSkyboxMesh(mesh) &&
    !isEditorHelperMesh(mesh) &&
    !isColliderVisualTree(mesh) &&
    !mesh.isDescendantOf(actorRoot as TransformNode) &&
    mesh !== actorRoot;
}

/** A bone's place relative to the actor's root. */
function actorPosition(node: BoneNode, out: Vector3): Vector3 {
  parentActorMatrix(node, parentMatrix);
  readNodeTrs(node, base);
  composeTrs(base, local).multiplyToRef(parentMatrix, actorMatrix);
  return actorMatrix.getTranslationToRef(out);
}

interface FootTrace {
  /** The ground's height in the actor's axes, and its normal there; null where the trace hit nothing. */
  height: number | null;
  normal: Vector3;
  /** The foot's animated place, relative to the actor's root. */
  animated: Vector3;
}

/** Traces below each foot: from Trace Up above it to Trace Down below, along the actor's down axis. */
function traceFeet(scene: Scene, feet: readonly BoneNode[], change: AnimFootPlacementChange): FootTrace[] {
  const root = actorRootOf(feet[0]!);
  localMatrixOf(root, rootMatrix);
  rootMatrix.invertToRef(worldToActor);
  const up = Vector3.TransformNormal(Vector3.UpReadOnly, rootMatrix);
  if (up.lengthSquared() < 1e-12) up.copyFrom(Vector3.UpReadOnly);
  up.normalize();
  const predicate = (mesh: AbstractMesh) => isGround(mesh, root);
  return feet.map((foot) => {
    const animated = actorPosition(foot, new Vector3());
    const world = Vector3.TransformCoordinates(animated, rootMatrix);
    const origin = world.add(up.scale(change.traceUp));
    const length = change.traceUp + change.traceDown;
    const hit = length > 0 ? scene.pickWithRay(new Ray(origin, up.negate(), length), predicate, false) : null;
    if (!hit?.hit || !hit.pickedPoint) return { height: null, normal: Vector3.Up(), animated };
    const point = Vector3.TransformCoordinates(hit.pickedPoint, worldToActor);
    const normal = hit.getNormal(true, true) ?? up;
    const actorNormal = Vector3.TransformNormal(normal, worldToActor).normalize();
    // A surface facing away is the underside of something: stand on its plane all the same, upright.
    return { height: point.y, normal: actorNormal.y > 0.2 ? actorNormal : Vector3.Up(), animated };
  });
}

/** Lowers `pelvis` by `drop` along the actor's up axis, through its parent's axes. */
function dropPelvis(pelvis: BoneNode, drop: number, write: BoneWrite): void {
  parentActorMatrix(pelvis, parentMatrix);
  parentMatrix.invertToRef(inverse);
  const shift = Vector3.TransformNormal(new Vector3(0, drop, 0), inverse);
  readNodeTrs(pelvis, base);
  solved.set(base);
  solved[TRANSLATION] = base[TRANSLATION]! + shift.x;
  solved[TRANSLATION + 1] = base[TRANSLATION + 1]! + shift.y;
  solved[TRANSLATION + 2] = base[TRANSLATION + 2]! + shift.z;
  write(pelvis, base, solved, WRITE_TRANSLATION);
}

/** Turns a placed foot so its up axis (in the actor's axes) follows the ground's normal. */
function alignFoot(foot: BoneNode, normal: Vector3, write: BoneWrite): void {
  parentActorMatrix(foot, parentMatrix);
  readNodeTrs(foot, base);
  composeTrs(base, local).multiplyToRef(parentMatrix, actorMatrix);
  Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, normal, turn);
  turnAbout(actorMatrix, turn, actorMatrix.getTranslation(), actorMatrix);
  parentMatrix.invertToRef(inverse);
  actorMatrix.multiplyToRef(inverse, local);
  storeRotation(local, base, solved);
  write(foot, base, solved, WRITE_ROTATION);
}

/**
 * Places the feet of `change` on the ground of `scene`. `boneOf` finds a bone by name; `write` blends and writes each
 * bone's change. Feet whose leg is not two bones under a parent, or that the rig lacks, are left as posed.
 */
export function applyFootPlacement(scene: Scene, change: AnimFootPlacementChange, boneOf: (name: string) => BoneNode | null, write: BoneWrite): void {
  const feet = change.feet.map(boneOf).filter((foot): foot is BoneNode => foot !== null && ikChainOf(foot) !== null);
  if (feet.length === 0) return;
  const traces = traceFeet(scene, feet, change);
  const lowest = Math.min(0, ...traces.map((trace) => trace.height ?? 0));
  const pelvis = change.pelvisBone ? boneOf(change.pelvisBone) : null;
  if (pelvis && lowest < 0) dropPelvis(pelvis, lowest, write);
  feet.forEach((foot, index) => {
    const trace = traces[index]!;
    const height = trace.height ?? 0;
    const chain = ikChainOf(foot)!;
    const bones = [chain.root, chain.joint, chain.end] as const;
    bones.forEach((bone, i) => readNodeTrs(bone, ikBases[i]!));
    const effector = trace.animated.add(new Vector3(0, height, 0));
    const ik: AnimTwoBoneIkChange = {
      kind: "twoBoneIk", bone: foot.name, alpha: 1, effector: [effector.x, effector.y, effector.z], effectorSpace: "actor",
      jointTargetSpace: "actor", maxStretch: 1, keepEffectorRotation: true,
    };
    const writes = twoBoneIkLocalTrs(chain, ik, ikBases, ikSolved);
    if (writes) bones.forEach((bone, i) => write(bone, ikBases[i]!, ikSolved[i]!, writes[i]!));
    if (change.alignToGround && trace.height !== null && trace.normal.y < 0.9999) alignFoot(foot, trace.normal, write);
  });
}

/** The scene a posed node is in, for its traces. */
export function sceneOfNode(node: BoneNode): Scene | null {
  const scene = (node as unknown as { getScene?: () => Scene }).getScene?.();
  return scene ?? null;
}
