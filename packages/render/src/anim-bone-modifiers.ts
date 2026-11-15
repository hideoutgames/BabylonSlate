import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AnimBoneChannel, AnimLookAtChange, AnimTransformBoneChange, AnimTwoBoneIkChange } from "@haptic/core";

/**
 * Skeletal control changes on posed nodes. A bone is a node of the posed Model (a skinned bone's linked TransformNode,
 * or a hierarchy rig's joint), found by name. Each change applies after the clips blend, in order, then blends with
 * the bone's pose by its alpha.
 *
 * Transform Bone applies scale, then rotation, then translation, each in its own space:
 *
 * - Parent space works on the bone's own local values.
 * - Bone space works in the bone's own axes: scale and rotation apply before the bone's, translation moves along its
 *   axes (scaled by it); replacing and adding are the same there.
 * - Actor space works on the bone's transform relative to the actor's root node (the topmost ancestor, which carries
 *   the actor's placement), so its axes are the actor's.
 */

/** A posed node, read and written by position, rotation quaternion and scaling. */
export interface BoneNode {
  name: string;
  parent?: unknown;
  position: Vector3;
  rotationQuaternion: Quaternion | null;
  rotation?: Vector3;
  scaling: Vector3;
  getClassName?(): string;
  markAsDirty?(property?: string): unknown;
  isDisposed?(): boolean;
}

/** A bone's local transform as flat values: translation (0–2), rotation quaternion (3–6) and scale (7–9). */
export const TRS_LENGTH = 10;
export const TRANSLATION = 0;
export const ROTATION = 3;
export const SCALE = 7;

function parentOf(node: unknown): BoneNode | null {
  const parent = (node as { parent?: unknown } | null)?.parent;
  return parent && typeof parent === "object" && "position" in parent ? (parent as BoneNode) : null;
}

/** Reads a node's local translation, rotation and scale into `out` at `offset`. */
export function readNodeTrs(node: BoneNode, out: Float64Array, offset = 0): void {
  const p = node.position;
  out[offset] = p.x;
  out[offset + 1] = p.y;
  out[offset + 2] = p.z;
  const q = node.rotationQuaternion;
  if (q) {
    out[offset + 3] = q.x;
    out[offset + 4] = q.y;
    out[offset + 5] = q.z;
    out[offset + 6] = q.w;
  } else {
    const euler = node.rotation;
    const fromEuler = euler ? Quaternion.RotationYawPitchRoll(euler.y, euler.x, euler.z) : Quaternion.Identity();
    out[offset + 3] = fromEuler.x;
    out[offset + 4] = fromEuler.y;
    out[offset + 5] = fromEuler.z;
    out[offset + 6] = fromEuler.w;
  }
  const s = node.scaling;
  out[offset + 7] = s.x;
  out[offset + 8] = s.y;
  out[offset + 9] = s.z;
}

/** Bits of the channels a write covers. */
export const WRITE_TRANSLATION = 1;
export const WRITE_ROTATION = 2;
export const WRITE_SCALE = 4;

const setterVector = new Vector3();
const setterQuaternion = new Quaternion();

/** Writes the chosen channels of `values` to the node, as the pose evaluator writes properties. */
export function writeNodeTrs(node: BoneNode, values: Float64Array, channels: number, offset = 0): void {
  // Babylon Bones copy through their setters; their getters return values that do not recompose the bone.
  const setters = node.getClassName?.() === "Bone";
  if (channels & WRITE_TRANSLATION) {
    if (setters) node.position = setterVector.copyFromFloats(values[offset]!, values[offset + 1]!, values[offset + 2]!);
    else node.position.copyFromFloats(values[offset]!, values[offset + 1]!, values[offset + 2]!);
    node.markAsDirty?.("position");
  }
  if (channels & WRITE_ROTATION) {
    const x = values[offset + 3]!, y = values[offset + 4]!, z = values[offset + 5]!, w = values[offset + 6]!;
    if (setters) node.rotationQuaternion = setterQuaternion.copyFromFloats(x, y, z, w);
    else if (node.rotationQuaternion) node.rotationQuaternion.copyFromFloats(x, y, z, w);
    else node.rotationQuaternion = new Quaternion(x, y, z, w);
    node.markAsDirty?.("rotationQuaternion");
  }
  if (channels & WRITE_SCALE) {
    if (setters) node.scaling = setterVector.copyFromFloats(values[offset + 7]!, values[offset + 8]!, values[offset + 9]!);
    else node.scaling.copyFromFloats(values[offset + 7]!, values[offset + 8]!, values[offset + 9]!);
    node.markAsDirty?.("scaling");
  }
}

const position = new Vector3();
const scale = new Vector3();
const rotation = new Quaternion();
const channelRotation = new Quaternion();
const local = new Matrix();
const parentActor = new Matrix();
const inverseParent = new Matrix();
const actor = new Matrix();
const chainMatrix = new Matrix();
const chain: BoneNode[] = [];

function localMatrixOf(node: BoneNode, out: Matrix): void {
  const q = node.rotationQuaternion ?? (node.rotation
    ? Quaternion.RotationYawPitchRoll(node.rotation.y, node.rotation.x, node.rotation.z)
    : Quaternion.Identity());
  Matrix.ComposeToRef(node.scaling, q, node.position, out);
}

/** The bone's parent relative to the actor's root node: every ancestor's local transform below the topmost. */
export function parentActorMatrix(node: BoneNode, out: Matrix): void {
  chain.length = 0;
  for (let parent = parentOf(node); parent && parentOf(parent); parent = parentOf(parent)) chain.push(parent);
  out.copyFrom(Matrix.IdentityReadOnly);
  for (const ancestor of chain) {
    localMatrixOf(ancestor, chainMatrix);
    out.multiplyToRef(chainMatrix, out);
  }
  chain.length = 0;
}

function loadTrs(values: Float64Array): void {
  position.set(values[TRANSLATION]!, values[TRANSLATION + 1]!, values[TRANSLATION + 2]!);
  rotation.set(values[ROTATION]!, values[ROTATION + 1]!, values[ROTATION + 2]!, values[ROTATION + 3]!);
  scale.set(values[SCALE]!, values[SCALE + 1]!, values[SCALE + 2]!);
}

function storeTrs(values: Float64Array): void {
  values[TRANSLATION] = position.x;
  values[TRANSLATION + 1] = position.y;
  values[TRANSLATION + 2] = position.z;
  values[ROTATION] = rotation.x;
  values[ROTATION + 1] = rotation.y;
  values[ROTATION + 2] = rotation.z;
  values[ROTATION + 3] = rotation.w;
  values[SCALE] = scale.x;
  values[SCALE + 1] = scale.y;
  values[SCALE + 2] = scale.z;
}

type ChannelName = "translation" | "rotation" | "scale";

/** One channel's change to `position`, `rotation` and `scale` (the transform in the channel's space). */
function changeChannel(name: ChannelName, channel: AnimBoneChannel, keepSigns: boolean): void {
  const v = channel.value;
  const replace = channel.mode === "replace";
  if (name === "scale") {
    const x = v[0] ?? 1, y = v[1] ?? 1, z = v[2] ?? 1;
    if (replace) {
      // An actor-space transform keeps the mirror its rig carries (a negative axis) when its scale is replaced.
      scale.set(
        keepSigns && scale.x < 0 ? -Math.abs(x) : x,
        keepSigns && scale.y < 0 ? -Math.abs(y) : y,
        keepSigns && scale.z < 0 ? -Math.abs(z) : z,
      );
    } else {
      scale.set(scale.x * x, scale.y * y, scale.z * z);
    }
  } else if (name === "rotation") {
    channelRotation.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
    if (replace) rotation.copyFrom(channelRotation);
    // Added in the space's axes: the bone's rotation, then this one.
    else channelRotation.multiplyToRef(rotation, rotation);
  } else if (replace) {
    position.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  } else {
    position.set(position.x + (v[0] ?? 0), position.y + (v[1] ?? 0), position.z + (v[2] ?? 0));
  }
}

const offset = new Vector3();

/** One channel in the bone's own axes: scale and rotation before the bone's, translation along its axes. */
function changeInBoneSpace(name: ChannelName, channel: AnimBoneChannel): void {
  const v = channel.value;
  if (name === "scale") {
    scale.set(scale.x * (v[0] ?? 1), scale.y * (v[1] ?? 1), scale.z * (v[2] ?? 1));
  } else if (name === "rotation") {
    channelRotation.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
    rotation.multiplyToRef(channelRotation, rotation);
  } else {
    offset.set((v[0] ?? 0) * scale.x, (v[1] ?? 0) * scale.y, (v[2] ?? 0) * scale.z);
    offset.applyRotationQuaternionInPlace(rotation);
    position.addInPlace(offset);
  }
}

const CHANNELS: readonly ChannelName[] = ["scale", "rotation", "translation"];

/**
 * The bone's local transform after the modifier's channels (scale, rotation, translation), from `values` (its pose
 * now) into `out`, not yet blended by alpha.
 */
export function modifiedLocalTrs(node: BoneNode, modifier: AnimTransformBoneChange, values: Float64Array, out: Float64Array): void {
  out.set(values.subarray(0, TRS_LENGTH));
  for (const name of CHANNELS) {
    const channel = modifier[name];
    if (!channel) continue;
    loadTrs(out);
    if (channel.space === "parent") {
      changeChannel(name, channel, false);
    } else if (channel.space === "bone") {
      changeInBoneSpace(name, channel);
    } else {
      // Actor space: the bone relative to the actor's root, changed there, then back under its parent.
      parentActorMatrix(node, parentActor);
      Matrix.ComposeToRef(scale, rotation, position, local);
      local.multiplyToRef(parentActor, actor);
      actor.decompose(scale, rotation, position);
      changeChannel(name, channel, true);
      Matrix.ComposeToRef(scale, rotation, position, actor);
      parentActor.invertToRef(inverseParent);
      actor.multiplyToRef(inverseParent, local);
      local.decompose(scale, rotation, position);
    }
    storeTrs(out);
  }
}

/** `out = a + (b - a) * t` on a transform: translation and scale linearly, rotation by the shorter arc. */
export function blendTrs(a: Float64Array, b: Float64Array, t: number, out: Float64Array): void {
  for (const at of [TRANSLATION, SCALE]) {
    for (let c = 0; c < 3; c++) out[at + c] = a[at + c]! + (b[at + c]! - a[at + c]!) * t;
  }
  Quaternion.SlerpToRef(
    rotation.set(a[ROTATION]!, a[ROTATION + 1]!, a[ROTATION + 2]!, a[ROTATION + 3]!),
    channelRotation.set(b[ROTATION]!, b[ROTATION + 1]!, b[ROTATION + 2]!, b[ROTATION + 3]!),
    t,
    rotation,
  );
  out[ROTATION] = rotation.x;
  out[ROTATION + 1] = rotation.y;
  out[ROTATION + 2] = rotation.z;
  out[ROTATION + 3] = rotation.w;
}

/** The channels a modifier writes. */
export function modifierChannels(modifier: AnimTransformBoneChange): number {
  return (modifier.translation ? WRITE_TRANSLATION : 0) | (modifier.rotation ? WRITE_ROTATION : 0) | (modifier.scale ? WRITE_SCALE : 0);
}

/** The node and its parents' names, the node's own first: what branch filters match against. */
export function nodeChainNames(node: unknown): string[] {
  const names: string[] = [];
  let current = node as { name?: unknown; parent?: unknown; getParent?: () => unknown } | null;
  for (let depth = 0; current && depth < 256; depth++) {
    if (typeof current.name === "string") names.push(current.name);
    current = (current.parent ?? current.getParent?.() ?? null) as typeof current;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Look At and Two Bone IK. Both solve in actor space (the bone relative to the actor's root node, as Transform Bone's
// Actor Space), through matrices, so a rig that mirrors an axis (a glTF root) solves the same as one that does not.

const IDENTITY_QUATERNION = Quaternion.Identity();
const EPSILON = 1e-6;
const rootMatrix = new Matrix();
const worldToActor = new Matrix();
const turn = new Matrix();
const shift = new Matrix();
const unshift = new Matrix();
const pivot = new Matrix();
const inverse = new Matrix();
const solved = new Matrix();
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const q1 = new Quaternion();
const q2 = new Quaternion();

/** The actor's root node a bone poses under: its topmost ancestor, whose placement is the actor's. */
function actorRootOf(node: BoneNode): BoneNode {
  let root: BoneNode = node;
  for (let parent = parentOf(root); parent; parent = parentOf(parent)) root = parent;
  return root;
}

/** A point given in actor or world space, in the world: actor space goes through the actor's root node. */
export function worldPoint(node: BoneNode, value: readonly number[], space: "actor" | "world", out: Vector3): Vector3 {
  out.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  if (space === "world") return out;
  localMatrixOf(actorRootOf(node), rootMatrix);
  return Vector3.TransformCoordinatesToRef(out, rootMatrix, out);
}

/** A point given in actor or world space, in actor space. World space goes through the actor's root node. */
function actorPoint(node: BoneNode, value: readonly number[], space: "actor" | "world", out: Vector3): Vector3 {
  out.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  if (space === "actor") return out;
  localMatrixOf(actorRootOf(node), rootMatrix);
  rootMatrix.invertToRef(worldToActor);
  return Vector3.TransformCoordinatesToRef(out, worldToActor, out);
}

/** `matrix` turned by `rotation` about `point`, both in the space `matrix` maps into, into `out`. */
function turnAbout(matrix: Matrix, rotation: Quaternion, point: Vector3, out: Matrix): void {
  Matrix.TranslationToRef(-point.x, -point.y, -point.z, shift);
  rotation.toRotationMatrix(turn);
  Matrix.TranslationToRef(point.x, point.y, point.z, unshift);
  shift.multiplyToRef(turn, pivot);
  pivot.multiplyToRef(unshift, pivot);
  matrix.multiplyToRef(pivot, out);
}

/** The rotation of `local` (a bone's new local matrix) into `out`'s rotation, keeping `base`'s translation and scale. */
function storeRotation(local: Matrix, base: Float64Array, out: Float64Array): void {
  local.decompose(scale, rotation, position);
  out.set(base.subarray(0, TRS_LENGTH));
  out[ROTATION] = rotation.x;
  out[ROTATION + 1] = rotation.y;
  out[ROTATION + 2] = rotation.z;
  out[ROTATION + 3] = rotation.w;
}

function composeTrs(values: Float64Array, out: Matrix): Matrix {
  loadTrs(values);
  return Matrix.ComposeToRef(scale, rotation, position, out);
}

/** The shortest turn from direction `from` to `to` (neither need be unit length), into `out`. */
function turnBetween(from: Vector3, to: Vector3, out: Quaternion): Quaternion {
  const a = from.normalizeToNew();
  const b = to.normalizeToNew();
  return Quaternion.FromUnitVectorsToRef(a, b, out);
}

const lookMatrix = new Matrix();
const lookParent = new Matrix();
const lookActor = new Matrix();

/**
 * The bone's local transform with Look At's turn, from `values` (its pose now) into `out`, not yet blended by alpha:
 * its Aim Axis turned onto the target about the bone's origin, by no more than the limit, then, with an Up Axis,
 * rolled about the aim so that axis leans toward the actor's up. Unchanged when the target is at the bone.
 */
export function lookAtLocalTrs(node: BoneNode, change: AnimLookAtChange, values: Float64Array, out: Float64Array): void {
  out.set(values.subarray(0, TRS_LENGTH));
  parentActorMatrix(node, lookParent);
  composeTrs(values, lookMatrix).multiplyToRef(lookParent, lookActor);
  const origin = lookActor.getTranslationToRef(v1);
  const toward = actorPoint(node, change.target, change.targetSpace, v2).subtractInPlace(origin);
  if (toward.lengthSquared() < EPSILON * EPSILON) return;
  const aim = Vector3.TransformNormalToRef(Vector3.FromArrayToRef(change.aimAxis, 0, v3), lookActor, v3);
  if (aim.lengthSquared() < EPSILON * EPSILON) return;
  turnBetween(aim, toward, q1);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q1.w)));
  const limit = (Math.max(0, change.limitDegrees) * Math.PI) / 180;
  if (angle > limit && angle > EPSILON) Quaternion.SlerpToRef(IDENTITY_QUATERNION, q1, limit / angle, q1);
  if (change.upAxis) {
    const aimed = aim.normalizeToNew().applyRotationQuaternionInPlace(q1);
    const up = Vector3.TransformNormal(Vector3.FromArray(change.upAxis), lookActor).normalize().applyRotationQuaternionInPlace(q1);
    const along = (value: Vector3) => value.subtract(aimed.scale(Vector3.Dot(value, aimed)));
    const current = along(up);
    const wanted = along(Vector3.UpReadOnly);
    if (current.lengthSquared() > EPSILON && wanted.lengthSquared() > EPSILON) {
      const roll = Math.atan2(Vector3.Dot(Vector3.Cross(current, wanted), aimed), Vector3.Dot(current, wanted));
      Quaternion.RotationAxisToRef(aimed, roll, q2);
      // The roll after the aim.
      q2.multiplyToRef(q1, q1);
    }
  }
  turnAbout(lookActor, q1, origin, solved);
  lookParent.invertToRef(inverse);
  solved.multiplyToRef(inverse, lookMatrix);
  storeRotation(lookMatrix, values, out);
}

/** The bones a Two Bone IK turns: the end bone's grandparent (root) and parent (joint), and the end bone. */
export interface IkChain {
  root: BoneNode;
  joint: BoneNode;
  end: BoneNode;
}

/** The chain ending at `end`, or null when it has no parent and grandparent. */
export function ikChainOf(end: BoneNode): IkChain | null {
  const joint = parentOf(end);
  const root = joint ? parentOf(joint) : null;
  return joint && root ? { root, joint, end } : null;
}

const rootParent = new Matrix();
const rootLocal = new Matrix();
const jointLocal = new Matrix();
const endLocal = new Matrix();
const rootActor = new Matrix();
const jointActor = new Matrix();
const endActor = new Matrix();
const rootSolved = new Matrix();
const jointSolved = new Matrix();
const endSolved = new Matrix();
const pointA = new Vector3();
const pointB = new Vector3();
const pointC = new Vector3();
const goal = new Vector3();
const pole = new Vector3();

function chainMatrices(bases: readonly Float64Array[]): void {
  composeTrs(bases[0]!, rootLocal).multiplyToRef(rootParent, rootActor);
  composeTrs(bases[1]!, jointLocal).multiplyToRef(rootActor, jointActor);
  composeTrs(bases[2]!, endLocal).multiplyToRef(jointActor, endActor);
  rootActor.getTranslationToRef(pointA);
  jointActor.getTranslationToRef(pointB);
  endActor.getTranslationToRef(pointC);
}

/** Bits of each chain bone's channels a solve writes: root, joint and end. */
export type IkWrites = [number, number, number];

/**
 * Two Bone IK on `chain`, from `bases` (root, joint and end's poses now) into `outs`, not yet blended by alpha: the
 * end bone's origin reaches the effector (as near as the chain's length allows, stretched up to Max Stretch), the
 * joint bending toward the Joint Target, else the way it bends already. Returns the channels each bone changes, or
 * null when the chain has no length or the effector sits on its root.
 */
export function twoBoneIkLocalTrs(
  chain: IkChain,
  change: AnimTwoBoneIkChange,
  bases: readonly [Float64Array, Float64Array, Float64Array],
  outs: readonly [Float64Array, Float64Array, Float64Array],
): IkWrites | null {
  for (let i = 0; i < 3; i++) outs[i]!.set(bases[i]!.subarray(0, TRS_LENGTH));
  parentActorMatrix(chain.root, rootParent);
  chainMatrices(bases);
  actorPoint(chain.end, change.effector, change.effectorSpace, goal);
  let upper = Vector3.Distance(pointA, pointB);
  let lower = Vector3.Distance(pointB, pointC);
  const reach = Vector3.Distance(pointA, goal);
  if (upper < EPSILON || lower < EPSILON || reach < EPSILON) return null;
  const writes: IkWrites = [WRITE_ROTATION, WRITE_ROTATION, 0];
  // Out of reach, the chain stretches: the joint and end move along their parents' axes.
  const stretch = Math.min(Math.max(1, change.maxStretch), reach / (upper + lower));
  if (stretch > 1) {
    for (const out of [outs[1], outs[2]]) for (let c = 0; c < 3; c++) out[TRANSLATION + c]! *= stretch;
    writes[1] |= WRITE_TRANSLATION;
    writes[2] |= WRITE_TRANSLATION;
    chainMatrices(outs);
    upper *= stretch;
    lower *= stretch;
  }
  const direction = goal.subtract(pointA).scaleInPlace(1 / reach);
  // The joint bends toward the Joint Target, else the way it bends now, else any way.
  const bendFrom = (point: Vector3) => {
    const offset = point.subtract(pointA);
    return offset.subtractInPlace(direction.scale(Vector3.Dot(offset, direction)));
  };
  let bend = change.jointTarget ? bendFrom(actorPoint(chain.end, change.jointTarget, change.jointTargetSpace, pole)) : bendFrom(pointB);
  if (bend.lengthSquared() < EPSILON * EPSILON) bend = bendFrom(pointB);
  if (bend.lengthSquared() < EPSILON * EPSILON) {
    bend = Vector3.Cross(direction, Math.abs(direction.y) < 0.9 ? Vector3.UpReadOnly : Vector3.RightReadOnly);
  }
  bend.normalize();
  const span = Math.min(upper + lower - EPSILON, Math.max(Math.abs(upper - lower) + EPSILON, reach));
  const along = (upper * upper - lower * lower + span * span) / (2 * span);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const jointGoal = pointA.add(direction.scale(along)).addInPlace(bend.scale(height));
  const endGoal = pointA.add(direction.scale(span));
  // The root turns the joint onto its goal, then the joint turns the end onto its own.
  turnBetween(pointB.subtract(pointA), jointGoal.subtract(pointA), q1);
  turnAbout(rootActor, q1, pointA, rootSolved);
  jointLocal.multiplyToRef(rootSolved, jointSolved);
  const jointAt = jointSolved.getTranslation();
  endLocal.multiplyToRef(jointSolved, endSolved);
  turnBetween(endSolved.getTranslation().subtractInPlace(jointAt), endGoal.subtract(jointAt), q2);
  turnAbout(jointSolved, q2, jointAt, jointSolved);
  rootParent.invertToRef(inverse);
  rootSolved.multiplyToRef(inverse, rootLocal);
  storeRotation(rootLocal, outs[0], outs[0]);
  rootSolved.invertToRef(inverse);
  jointSolved.multiplyToRef(inverse, jointLocal);
  storeRotation(jointLocal, outs[1], outs[1]);
  if (change.keepEffectorRotation) {
    // The end keeps its turn relative to the actor: its pose's actor rotation, at its new origin.
    endLocal.multiplyToRef(jointSolved, endSolved);
    const at = endSolved.getTranslation();
    endActor.setTranslation(at);
    jointSolved.invertToRef(inverse);
    endActor.multiplyToRef(inverse, endLocal);
    storeRotation(endLocal, outs[2], outs[2]);
    writes[2] |= WRITE_ROTATION;
  }
  return writes;
}
