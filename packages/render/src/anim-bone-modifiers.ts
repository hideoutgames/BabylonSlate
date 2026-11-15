import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AnimBoneChannel, AnimBoneModifier } from "@haptic/core";

/**
 * Transform Bone changes on posed nodes. A bone is a node of the posed Model (a skinned bone's linked TransformNode, or
 * a hierarchy rig's joint), found by name. Each change applies after the clips blend, in order: scale, then rotation,
 * then translation, each in its own space, then blends with the bone's pose by its alpha.
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
function parentActorMatrix(node: BoneNode, out: Matrix): void {
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
export function modifiedLocalTrs(node: BoneNode, modifier: AnimBoneModifier, values: Float64Array, out: Float64Array): void {
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
export function modifierChannels(modifier: AnimBoneModifier): number {
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
