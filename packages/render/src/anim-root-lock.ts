import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { PoseClip, PoseTrack } from "./anim-pose";

/** Samples a track at a frame into `out` (the pose evaluator's `samplePoseTrack`). */
type TrackSampler = (track: PoseTrack, frame: number, out: Float64Array) => void;

/**
 * Root motion in render: a clip that moves its actor by root motion holds its root bone where its first frame has it
 * across the ground, keeping only the bone's rise and fall, and holds its turn about the up axis there too. The worker
 * moves the actor by the same travel and turn instead (the Animation's root motion track).
 *
 * The ground is the Model's own XZ plane: the bone's travel is taken into the Model's axes through its parents' rest
 * rotations (up to the glTF root the loader adds), held there, and taken back.
 */
export interface RootLock {
  /** The bone's translation and rotation channels in the clip, or -1. */
  readonly position: number;
  readonly rotation: number;
  readonly firstPosition: Vector3;
  readonly firstRotation: Quaternion;
  /** The parents' rotation into the Model's axes, and back. */
  readonly parent: Quaternion;
  readonly parentInverse: Quaternion;
}

const LOADER_ROOTS: ReadonlySet<string> = new Set(["__root__", "__fbx_root__"]);
const locks = new WeakMap<PoseClip, Map<string, RootLock | null>>();

interface NamedNode {
  name?: unknown;
  parent?: unknown;
  rotationQuaternion?: Quaternion | null;
}

/** The parents' rest rotation of a bone, into the Model's axes. */
function parentRotation(node: NamedNode): Quaternion {
  const out = Quaternion.Identity();
  for (let parent = node.parent as NamedNode | null | undefined; parent && typeof parent === "object"; parent = parent.parent as NamedNode | null) {
    if (typeof parent.name === "string" && LOADER_ROOTS.has(parent.name)) break;
    const q = parent.rotationQuaternion;
    if (q) q.multiplyToRef(out, out);
  }
  return out;
}

/** The lock of `bone` in `clip`, worked out once per clip and bone; null when the clip does not move the bone. */
export function rootLockOf(clip: PoseClip, bone: string, samplePoseTrack: TrackSampler): RootLock | null {
  let byBone = locks.get(clip);
  if (!byBone) {
    byBone = new Map();
    locks.set(clip, byBone);
  }
  if (byBone.has(bone)) return byBone.get(bone)!;
  let position = -1;
  let rotation = -1;
  let target: NamedNode | null = null;
  clip.channels.forEach((channel, i) => {
    const node = channel.binding.target as NamedNode | null;
    if (!node || node.name !== bone || channel.path.length !== 1) return;
    if (channel.path[0] === "position" && channel.track.components === 3) position = i;
    if (channel.path[0] === "rotationQuaternion" && channel.track.quaternion) rotation = i;
    target = node;
  });
  if (!target || (position < 0 && rotation < 0)) {
    byBone.set(bone, null);
    return null;
  }
  const first = new Float64Array(4);
  const firstPosition = Vector3.Zero();
  const firstRotation = Quaternion.Identity();
  if (position >= 0) {
    const track = clip.channels[position]!.track;
    samplePoseTrack(track, track.frames[0] ?? clip.from, first);
    firstPosition.set(first[0]!, first[1]!, first[2]!);
  }
  if (rotation >= 0) {
    const track = clip.channels[rotation]!.track;
    samplePoseTrack(track, track.frames[0] ?? clip.from, first);
    firstRotation.set(first[0]!, first[1]!, first[2]!, first[3]!).normalize();
  }
  const parent = parentRotation(target);
  const lock: RootLock = { position, rotation, firstPosition, firstRotation, parent, parentInverse: Quaternion.Inverse(parent) };
  byBone.set(bone, lock);
  return lock;
}

const travel = new Vector3();
const model = new Quaternion();
const firstModel = new Quaternion();
const delta = new Quaternion();
const twist = new Quaternion();

/**
 * Holds a sampled value of the lock's channel `channel` (at `values[offset]`): a translation keeps its travel off the
 * ground plane only, a rotation drops its turn about the up axis since the first frame. Other channels are untouched.
 */
export function holdRoot(lock: RootLock, channel: number, values: Float64Array, offset: number): void {
  if (channel === lock.position) {
    travel.set(values[offset]! - lock.firstPosition.x, values[offset + 1]! - lock.firstPosition.y, values[offset + 2]! - lock.firstPosition.z);
    travel.applyRotationQuaternionInPlace(lock.parent);
    travel.x = 0;
    travel.z = 0;
    travel.applyRotationQuaternionInPlace(lock.parentInverse);
    values[offset] = lock.firstPosition.x + travel.x;
    values[offset + 1] = lock.firstPosition.y + travel.y;
    values[offset + 2] = lock.firstPosition.z + travel.z;
    return;
  }
  if (channel !== lock.rotation) return;
  model.set(values[offset]!, values[offset + 1]!, values[offset + 2]!, values[offset + 3]!);
  lock.parent.multiplyToRef(model, model);
  lock.parent.multiplyToRef(lock.firstRotation, firstModel);
  model.multiplyToRef(Quaternion.Inverse(firstModel), delta);
  twist.set(0, delta.y, 0, delta.w);
  if (twist.lengthSquared() < 1e-12) return;
  twist.normalize();
  Quaternion.Inverse(twist).multiplyToRef(model, model);
  lock.parentInverse.multiplyToRef(model, model);
  values[offset] = model.x;
  values[offset + 1] = model.y;
  values[offset + 2] = model.z;
  values[offset + 3] = model.w;
}
