import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  animBranchWeight,
  parseAnimBranchFilterKey,
  type AnimBoneModifier,
  type AnimLayerBlend,
  type AnimLayerMaskRef,
} from "@haptic/core";
import {
  blendTrs,
  ikChainOf,
  lookAtLocalTrs,
  modifiedLocalTrs,
  modifierChannels,
  nodeChainNames,
  readNodeTrs,
  twoBoneIkLocalTrs,
  TRS_LENGTH,
  WRITE_ROTATION,
  WRITE_SCALE,
  WRITE_TRANSLATION,
  writeNodeTrs,
  type BoneNode,
} from "./anim-bone-modifiers";

/**
 * Haptic's pose evaluator: Play, the editor's previews and exported games pose 3D clips here, never by starting,
 * seeking or weighting Babylon AnimationGroups. A clip's channels compile once into flat key tracks, which sample like
 * Babylon's own interpolation (step, linear, spherical between quaternions, cubic-spline tangents). A slot's rig holds
 * each animated target property once: each pose blends the playing clips into it by weight, filling up to full weight
 * from the property's rest value, and writes each property at most once, skipping values it already holds.
 * Properties no clip plays return to rest. Layered Blend Per Bone weights a clip per bone (`PoseLayering.masks`), and
 * Transform Bone changes apply after the blend (`PoseLayering.modifiers`).
 */

/** Babylon `Animation.ANIMATIONTYPE_*` values a track samples. */
const FLOAT = 0;
const VECTOR3 = 1;
const QUATERNION = 2;
const COLOR3 = 4;
const VECTOR2 = 5;
const COLOR4 = 7;
/** Babylon `AnimationKeyInterpolation.STEP`. */
const STEP_INTERPOLATION = 1;

const COMPONENT_NAMES: Readonly<Record<number, readonly string[]>> = {
  [FLOAT]: [],
  [VECTOR3]: ["x", "y", "z"],
  [QUATERNION]: ["x", "y", "z", "w"],
  [COLOR3]: ["r", "g", "b"],
  [VECTOR2]: ["x", "y"],
  [COLOR4]: ["r", "g", "b", "a"],
};

/** The Babylon `Animation` a track compiles from: its value type, property path and keys. */
export interface PoseTrackSource {
  dataType: number;
  targetPropertyPath: readonly string[];
  getKeys(): ReadonlyArray<{
    frame: number;
    value: unknown;
    inTangent?: unknown;
    outTangent?: unknown;
    interpolation?: number;
  }>;
}

/** One channel's keys as flat arrays, `components` values per key. */
export interface PoseTrack {
  readonly components: number;
  readonly quaternion: boolean;
  readonly frames: Float64Array;
  readonly values: Float64Array;
  /** Cubic-spline tangents per key; null when no key has one. */
  readonly inTangents: Float64Array | null;
  readonly outTangents: Float64Array | null;
  /** Per key: bit 1 has an in-tangent, bit 2 an out-tangent. */
  readonly tangentKeys: Uint8Array | null;
  /** Per key: 1 holds its value until the next key. Null when no key steps. */
  readonly steps: Uint8Array | null;
  /** Every key holds the first key's value (and no tangent bends it): sampling copies that value. */
  readonly constant: boolean;
}

const IN_TANGENT = 1;
const OUT_TANGENT = 2;

function readComponents(value: unknown, names: readonly string[], out: Float64Array, offset: number): boolean {
  if (names.length === 0) {
    if (typeof value !== "number") return false;
    out[offset] = value;
    return true;
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (let i = 0; i < names.length; i++) {
    const component = record[names[i]!];
    if (typeof component !== "number") return false;
    out[offset + i] = component;
  }
  return true;
}

function compilePoseTrack(source: PoseTrackSource): PoseTrack | null {
  const names = COMPONENT_NAMES[source.dataType];
  if (!names) return null;
  const keys = source.getKeys();
  if (keys.length === 0) return null;
  const components = Math.max(1, names.length);
  const frames = new Float64Array(keys.length);
  const values = new Float64Array(keys.length * components);
  let inTangents: Float64Array | null = null;
  let outTangents: Float64Array | null = null;
  let tangentKeys: Uint8Array | null = null;
  let steps: Uint8Array | null = null;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k]!;
    if (!Number.isFinite(key.frame)) return null;
    frames[k] = key.frame;
    if (!readComponents(key.value, names, values, k * components)) return null;
    if (key.interpolation === STEP_INTERPOLATION) {
      steps ??= new Uint8Array(keys.length);
      steps[k] = 1;
    }
    if (key.inTangent !== undefined) {
      inTangents ??= new Float64Array(keys.length * components);
      tangentKeys ??= new Uint8Array(keys.length);
      if (!readComponents(key.inTangent, names, inTangents, k * components)) return null;
      tangentKeys[k]! |= IN_TANGENT;
    }
    if (key.outTangent !== undefined) {
      outTangents ??= new Float64Array(keys.length * components);
      tangentKeys ??= new Uint8Array(keys.length);
      if (!readComponents(key.outTangent, names, outTangents, k * components)) return null;
      tangentKeys[k]! |= OUT_TANGENT;
    }
  }
  let constant = !inTangents?.some((value) => value !== 0) && !outTangents?.some((value) => value !== 0);
  for (let i = components; constant && i < values.length; i++) constant = values[i] === values[i % components];
  return { components, quaternion: source.dataType === QUATERNION, frames, values, inTangents, outTangents, tangentKeys, steps, constant };
}

const tracks = new WeakMap<PoseTrackSource, PoseTrack | null>();

/**
 * The compiled track of a Babylon `Animation`, compiled once and shared by every clip that holds it (a Model's
 * instances share their clips' keys). Null for a value type or key the evaluator does not sample.
 */
export function poseTrackOf(source: PoseTrackSource): PoseTrack | null {
  let track = tracks.get(source);
  if (track === undefined) {
    track = compilePoseTrack(source);
    tracks.set(source, track);
  }
  return track;
}

/** Babylon's `Quaternion.SlerpToRef`, on flat components: `out = slerp(a, b, amount)`, taking the shorter arc. */
function slerpInto(
  a: Float64Array, ai: number, b: Float64Array, bi: number, amount: number, out: Float64Array, oi: number,
): void {
  const ax = a[ai]!, ay = a[ai + 1]!, az = a[ai + 2]!, aw = a[ai + 3]!;
  const bx = b[bi]!, by = b[bi + 1]!, bz = b[bi + 2]!, bw = b[bi + 3]!;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  const flip = cos < 0;
  if (flip) cos = -cos;
  let from: number;
  let to: number;
  if (cos > 0.999999) {
    from = 1 - amount;
    to = flip ? -amount : amount;
  } else {
    const angle = Math.acos(cos);
    const inverseSin = 1 / Math.sin(angle);
    from = Math.sin((1 - amount) * angle) * inverseSin;
    to = (flip ? -Math.sin(amount * angle) : Math.sin(amount * angle)) * inverseSin;
  }
  out[oi] = from * ax + to * bx;
  out[oi + 1] = from * ay + to * by;
  out[oi + 2] = from * az + to * bz;
  out[oi + 3] = from * aw + to * bw;
}

function normalizeQuaternion(out: Float64Array, offset: number): void {
  const x = out[offset]!, y = out[offset + 1]!, z = out[offset + 2]!, w = out[offset + 3]!;
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (length === 0) return;
  const inverse = 1 / length;
  out[offset] = x * inverse;
  out[offset + 1] = y * inverse;
  out[offset + 2] = z * inverse;
  out[offset + 3] = w * inverse;
}

/**
 * Spherical interpolation between two quaternion keys without trigonometry where they are under about 90° apart: a
 * normalised lerp with its parameter corrected (zeux.io, "Approximating slerp"), within 0.005° of `slerpInto`.
 * Farther keys take the exact slerp.
 */
function interpolateKeys(values: Float64Array, a: number, b: number, t: number, out: Float64Array, o: number): void {
  const ax = values[a]!, ay = values[a + 1]!, az = values[a + 2]!, aw = values[a + 3]!;
  let bx = values[b]!, by = values[b + 1]!, bz = values[b + 2]!, bw = values[b + 3]!;
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (d < 0.7) {
    slerpInto(values, a, values, b, t, out, o);
    return;
  }
  const A = 1.0904 + d * (-3.2452 + d * (3.55645 - d * 1.43519));
  const B = 0.848013 + d * (-1.06021 + d * 0.215638);
  const k = A * (t - 0.5) * (t - 0.5) + B;
  const u = t + t * (t - 0.5) * (t - 1) * k;
  const r = 1 - u;
  const x = ax * r + bx * u, y = ay * r + by * u, z = az * r + bz * u, w = aw * r + bw * u;
  const inverse = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  out[o] = x * inverse;
  out[o + 1] = y * inverse;
  out[o + 2] = z * inverse;
  out[o + 3] = w * inverse;
}

function copyKey(track: PoseTrack, key: number, out: Float64Array, offset: number): void {
  const n = track.components;
  for (let c = 0; c < n; c++) out[offset + c] = track.values[key * n + c]!;
}

/**
 * The track's value at `frame` into `out`, as Babylon's `Animation._interpolate` computes it: held at the first and
 * last keys outside them, a stepped key held to the next, cubic-spline (Hermite) keys where both neighbours carry
 * tangents, spherical between quaternion keys (`interpolateKeys`) and linear otherwise. Easing functions are not
 * sampled; glTF has none.
 */
export function samplePoseTrack(track: PoseTrack, frame: number, out: Float64Array, offset = 0): void {
  sampleTrack(track, frame, out, offset, null, 0);
}

/**
 * `samplePoseTrack` with a key hint: `hints[hint]` holds the key the last sample started from, which a clip playing
 * forward reuses or moves past by one, so most samples skip the binary search.
 */
function sampleTrack(
  track: PoseTrack, frame: number, out: Float64Array, offset: number, hints: Int32Array | null, hint: number,
): void {
  const { frames, values, components: n } = track;
  const last = frames.length - 1;
  if (track.constant || !(frame > frames[0]!) || last === 0) {
    copyKey(track, 0, out, offset);
    return;
  }
  if (frame >= frames[last]!) {
    copyKey(track, last, out, offset);
    return;
  }
  // The last key at or before `frame`; the one after it is later than `frame`.
  let start = hints ? hints[hint]! : 0;
  if (!(start < last && frames[start]! <= frame && frame < frames[start + 1]!)) {
    if (start + 1 < last && frames[start + 1]! <= frame && frame < frames[start + 2]!) {
      start += 1;
    } else {
      let low = 0;
      let high = last;
      while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (frames[middle]! <= frame) low = middle;
        else high = middle;
      }
      start = low;
    }
    if (hints) hints[hint] = start;
  }
  const end = start + 1;
  if (track.steps?.[start]) {
    copyKey(track, start, out, offset);
    return;
  }
  const delta = frames[end]! - frames[start]!;
  const t = (frame - frames[start]!) / delta;
  const tangents = track.tangentKeys;
  if (tangents && tangents[start]! & OUT_TANGENT && tangents[end]! & IN_TANGENT) {
    const squared = t * t;
    const cubed = squared * t;
    const p1 = 2 * cubed - 3 * squared + 1;
    const p2 = -2 * cubed + 3 * squared;
    const p3 = (cubed - 2 * squared + t) * delta;
    const p4 = (cubed - squared) * delta;
    const outTangents = track.outTangents!;
    const inTangents = track.inTangents!;
    for (let c = 0; c < n; c++) {
      out[offset + c] = values[start * n + c]! * p1 + values[end * n + c]! * p2 +
        outTangents[start * n + c]! * p3 + inTangents[end * n + c]! * p4;
    }
    if (track.quaternion) normalizeQuaternion(out, offset);
    return;
  }
  if (track.quaternion) {
    interpolateKeys(values, start * 4, end * 4, t, out, offset);
    return;
  }
  for (let c = 0; c < n; c++) {
    const from = values[start * n + c]!;
    out[offset + c] = from + (values[end * n + c]! - from) * t;
  }
}

/** A clip channel: what it animates, its compiled keys and the value it rests at. */
export interface PoseClipChannel {
  /** Babylon's channel. Its `target` is read on each write: handing a node over (instance pooling) re-targets it. */
  readonly binding: { readonly target: unknown };
  readonly path: readonly string[];
  readonly track: PoseTrack;
  /** The target's value when the clip was bound, before any clip posed it. */
  readonly rest: Float64Array;
}

/** A playable 3D clip: the channels of one AnimationGroup, tagged with the Animation asset it plays. */
export interface PoseClip {
  readonly name: string;
  /** The clip's first and last frame; a layer's normalised time spans them. */
  readonly from: number;
  readonly to: number;
  readonly clipAssetGuid?: string;
  readonly channels: readonly PoseClipChannel[];
  /** Per channel: the key its last sample started from (`sampleTrack`). Each bound clip has its own. */
  readonly keyHints: Int32Array;
}

/** The AnimationGroup a clip binds: its range and channels. */
export interface PoseClipSource {
  name: string;
  from: number;
  to: number;
  targetedAnimations: ReadonlyArray<{ readonly animation: PoseTrackSource; readonly target: unknown }>;
}

function propertyHolder(target: unknown, path: readonly string[]): Record<string, unknown> | null {
  let holder: unknown = target;
  for (let i = 0; i < path.length - 1; i++) {
    if (!holder || typeof holder !== "object") return null;
    holder = (holder as Record<string, unknown>)[path[i]!];
  }
  return holder && typeof holder === "object" ? (holder as Record<string, unknown>) : null;
}

/** The target's current value of `path`, or null when it holds none of the track's type. */
function readRest(target: unknown, path: readonly string[], track: PoseTrack): Float64Array | null {
  const holder = propertyHolder(target, path);
  if (!holder) return null;
  const rest = new Float64Array(track.components);
  const value = holder[path[path.length - 1]!];
  if (track.quaternion && value == null) {
    // A node without a rotation quaternion rests at its Euler rotation, which the first write replaces.
    const euler = holder.rotation as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    const q = euler && typeof euler.x === "number" && typeof euler.y === "number" && typeof euler.z === "number"
      ? Quaternion.RotationYawPitchRoll(euler.y, euler.x, euler.z)
      : Quaternion.Identity();
    rest[0] = q.x;
    rest[1] = q.y;
    rest[2] = q.z;
    rest[3] = q.w;
    return rest;
  }
  const names = track.components === 1 ? [] : track.quaternion ? COMPONENT_NAMES[QUATERNION]! : null;
  if (names) return readComponents(value, names, rest, 0) ? rest : null;
  // Vectors and colours: whichever component names the value holds.
  for (const candidate of [COMPONENT_NAMES[VECTOR3]!, COMPONENT_NAMES[COLOR3]!, COMPONENT_NAMES[VECTOR2]!, COMPONENT_NAMES[COLOR4]!]) {
    if (candidate.length === track.components && readComponents(value, candidate, rest, 0)) return rest;
  }
  return null;
}

/**
 * Binds an AnimationGroup as a pose clip, reading each channel's rest value from its target now, before any clip
 * poses it. Channels of a value type the evaluator does not sample are left out. The group itself is never started.
 */
export function bindPoseClip<Extra extends object = object>(
  group: PoseClipSource,
  clipAssetGuid: string | undefined,
  extra?: Extra,
): PoseClip & Extra {
  const channels: PoseClipChannel[] = [];
  for (const binding of group.targetedAnimations) {
    const track = poseTrackOf(binding.animation);
    if (!track) continue;
    const path = binding.animation.targetPropertyPath;
    const rest = readRest(binding.target, path, track);
    if (!rest) continue;
    channels.push({ binding, path, track, rest });
  }
  return {
    name: group.name, from: group.from, to: group.to, clipAssetGuid, channels,
    keyHints: new Int32Array(channels.length), ...(extra as Extra),
  };
}

const WRITE_ASSIGN = 0;
const WRITE_IN_PLACE = 1;
/** Babylon Bones copy through their setters; their getters return values that do not recompose the bone. */
const WRITE_SETTER = 2;

function writeModeOf(target: unknown, track: PoseTrack): number {
  if (track.components === 1) return WRITE_ASSIGN;
  const className = (target as { getClassName?: () => string } | null)?.getClassName?.();
  return className === "Bone" ? WRITE_SETTER : WRITE_IN_PLACE;
}

const scratchVector = new Vector3();
const scratchQuaternion = new Quaternion();

/** Writes a property's value, then marks its target dirty as Babylon's own animation write does. */
function writeChannel(channel: PoseClipChannel, mode: number, values: Float64Array, offset: number): void {
  const target = channel.binding.target as { markAsDirty?: (property: string) => unknown } | null;
  const path = channel.path;
  const holder = path.length === 1 ? (target as Record<string, unknown> | null) : propertyHolder(target, path);
  if (!holder) return;
  const property = path[path.length - 1]!;
  if (mode === WRITE_ASSIGN) {
    holder[property] = values[offset];
  } else {
    // A 3-component value ignores the fourth.
    const v0 = values[offset]!, v1 = values[offset + 1]!, v2 = values[offset + 2]!, v3 = values[offset + 3] ?? 0;
    if (mode === WRITE_SETTER) {
      holder[property] = channel.track.quaternion
        ? scratchQuaternion.copyFromFloats(v0, v1, v2, v3)
        : scratchVector.copyFromFloats(v0, v1, v2);
    } else {
      const current = holder[property] as { copyFromFloats?: (a: number, b: number, c: number, d: number) => unknown } | null;
      if (current && typeof current.copyFromFloats === "function") current.copyFromFloats(v0, v1, v2, v3);
      else if (channel.track.quaternion) holder[property] = new Quaternion(v0, v1, v2, v3);
      else return;
    }
  }
  target?.markAsDirty?.(property);
}

/** Components a rig slot holds per property, whatever its type. */
const STRIDE = 4;

/**
 * A slot's animated properties, each once: the union of its clips' channels by target and property path. It keeps
 * the per-pose blend buffers, the value each property last had written, and the last pose's inputs.
 */
export interface PoseRig {
  readonly members: readonly PoseClip[];
  /** Per property: the first clip channel that animates it, whose target, path and rest the rig writes with. */
  readonly properties: readonly PoseClipChannel[];
  readonly modes: Uint8Array;
  readonly components: Uint8Array;
  readonly quaternions: Uint8Array;
  /** Per property: 1 for a scale, which an additive clip multiplies rather than adds to. */
  readonly scales: Uint8Array;
  /** Per clip: its channels' property indices, -1 for a channel that repeats another of the same clip. */
  readonly clipProperties: ReadonlyMap<PoseClip, Int32Array>;
  /** Per property: the pose that last blended into it (`generation`), and the weight it has so far. */
  readonly stamps: Uint32Array;
  readonly weights: Float64Array;
  readonly blended: Float64Array;
  /** Per property: the value last written, valid where `written` is 1. A property off its rest has `posed` 1. */
  readonly last: Float64Array;
  readonly written: Uint8Array;
  readonly posed: Uint8Array;
  generation: number;
  /** The last pose's layers, so an unchanged pose writes nothing; `lastCount` -1 when it must be posed again. */
  lastCount: number;
  readonly lastClips: (PoseClip | undefined)[];
  readonly lastFrames: number[];
  readonly lastWeights: number[];
  /** The last pose's layering (`layeringSignature`), "" for none. */
  lastLayering: string;
  /** Per branch filter key: each property's weight under it, worked out from its target's chain of names once. */
  readonly branchWeights: Map<string, Float64Array>;
  /** Per-pose scratch: each blend's summed input weight per property, and each layer's weight per property. */
  readonly blendSums: Float64Array[];
  readonly layerFactors: Float64Array[];
  /** Transform Bone targets by name (null: none), and the bones changed, with their unanimated channels' rest. */
  readonly bones: Map<string, BoneNode | null>;
  readonly changed: Map<BoneNode, ChangedBone>;
}

/** A bone a Transform Bone changed: the channels changed so far, their rest where no clip animates them, the last pose to change it. */
interface ChangedBone {
  readonly rest: Float64Array;
  touched: number;
  generation: number;
}

function buildPoseRig(clips: readonly PoseClip[]): PoseRig {
  const byTarget = new Map<unknown, Map<string, number>>();
  const properties: PoseClipChannel[] = [];
  /** Per property: the ordinal of the last clip that mapped a channel to it, so a clip maps each property once. */
  const lastClip: number[] = [];
  const clipProperties = new Map<PoseClip, Int32Array>();
  for (let ordinal = 0; ordinal < clips.length; ordinal++) {
    const clip = clips[ordinal]!;
    if (clipProperties.has(clip)) continue;
    const indices = new Int32Array(clip.channels.length);
    for (let i = 0; i < clip.channels.length; i++) {
      const channel = clip.channels[i]!;
      let paths = byTarget.get(channel.binding.target);
      if (!paths) {
        paths = new Map();
        byTarget.set(channel.binding.target, paths);
      }
      const key = channel.path.length === 1 ? channel.path[0]! : channel.path.join(".");
      let index = paths.get(key);
      if (index === undefined) {
        index = properties.length;
        properties.push(channel);
        lastClip.push(-1);
        paths.set(key, index);
      }
      const repeats = lastClip[index] === ordinal || properties[index]!.track.components !== channel.track.components;
      indices[i] = repeats ? -1 : index;
      lastClip[index] = ordinal;
    }
    clipProperties.set(clip, indices);
  }
  const count = properties.length;
  const modes = new Uint8Array(count);
  const components = new Uint8Array(count);
  const quaternions = new Uint8Array(count);
  const scales = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const property = properties[i]!;
    modes[i] = writeModeOf(property.binding.target, property.track);
    components[i] = property.track.components;
    quaternions[i] = property.track.quaternion ? 1 : 0;
    scales[i] = property.path[property.path.length - 1] === "scaling" ? 1 : 0;
  }
  return {
    members: clips.slice(),
    properties,
    modes,
    components,
    quaternions,
    scales,
    clipProperties,
    stamps: new Uint32Array(count),
    weights: new Float64Array(count),
    blended: new Float64Array(count * STRIDE),
    last: new Float64Array(count * STRIDE),
    written: new Uint8Array(count),
    // A fresh rig rests every property its first pose leaves out.
    posed: new Uint8Array(count).fill(1),
    generation: 0,
    lastCount: -1,
    lastClips: [],
    lastFrames: [],
    lastWeights: [],
    lastLayering: "",
    branchWeights: new Map(),
    blendSums: [],
    layerFactors: [],
    bones: new Map(),
    changed: new Map(),
  };
}

function rigMatches(rig: PoseRig, clips: readonly PoseClip[]): boolean {
  if (rig.members.length !== clips.length) return false;
  for (let i = 0; i < clips.length; i++) if (rig.members[i] !== clips[i]) return false;
  return true;
}

const rigs = new WeakMap<readonly PoseClip[], PoseRig>();

/**
 * The rig of a slot's clip list, built once per list. A list edited in place rebuilds it; a rebuilt rig rests every
 * property its first pose does not play.
 */
export function poseRigFor(clips: readonly PoseClip[]): PoseRig {
  let rig = rigs.get(clips);
  if (!rig || !rigMatches(rig, clips)) {
    rig = buildPoseRig(clips);
    rigs.set(clips, rig);
  }
  return rig;
}

/**
 * Forgets what the slot's rig last wrote, so its next pose writes every property again: for when something other
 * than the evaluator moved the nodes (a ragdoll handing the pose back).
 */
export function invalidatePoseRig(clips: readonly PoseClip[] | undefined): void {
  const rig = clips ? rigs.get(clips) : undefined;
  if (!rig) return;
  rig.written.fill(0);
  rig.posed.fill(1);
  rig.lastCount = -1;
  rig.lastLayering = "";
}

/**
 * What a pose blends besides its clips: the Layered Blend Per Bone inputs each clip plays under (`masks[i]` for
 * `clips[i]`, the blends they index in `blends`), and Transform Bone changes, applied in order after the blend.
 */
export interface PoseLayering {
  readonly masks: ArrayLike<readonly AnimLayerMaskRef[] | undefined>;
  readonly blends: readonly AnimLayerBlend[];
  readonly modifiers: readonly AnimBoneModifier[];
  /** Per clip: present when it plays additively (Apply Additive), with the pose its change is from. */
  readonly additive?: ArrayLike<PoseAdditive | undefined>;
}

/**
 * An additive clip's base pose: a clip at a frame (its own first frame, or another clip's), or null for the rest
 * pose. The clip adds its change from that pose to the pose blended beneath it.
 */
export interface PoseAdditive {
  readonly reference: PoseClip | null;
  readonly frame: number;
}

/** The layering as one string, so a pose whose clips and layering are unchanged writes nothing. */
function layeringSignature(count: number, layering: PoseLayering | null | undefined): string {
  if (!layering) return "";
  const additive: Array<string | null> = [];
  let anyAdditive = false;
  for (let l = 0; l < count; l++) {
    const entry = layering.additive?.[l];
    anyAdditive ||= entry !== undefined;
    additive.push(entry ? `${entry.reference?.clipAssetGuid ?? ""}\0${entry.reference?.name ?? ""}\0${entry.frame}` : null);
  }
  if (layering.blends.length === 0 && layering.modifiers.length === 0 && !anyAdditive) return "";
  const masks: Array<readonly AnimLayerMaskRef[] | null> = [];
  for (let l = 0; l < count; l++) masks.push(layering.masks[l] ?? null);
  return JSON.stringify([masks, layering.blends, layering.modifiers, additive]);
}

/** Whether the pose's layers are the last pose's, which then still stands. Records them otherwise. */
function samePose(
  rig: PoseRig, count: number, clips: ArrayLike<PoseClip | undefined>, frames: ArrayLike<number>, weights: ArrayLike<number>,
  layering: string,
): boolean {
  let same = rig.lastCount === count && rig.lastLayering === layering;
  rig.lastLayering = layering;
  for (let l = 0; same && l < count; l++) {
    same = rig.lastClips[l] === clips[l] && rig.lastFrames[l] === frames[l] && rig.lastWeights[l] === weights[l];
  }
  if (same) return true;
  rig.lastCount = count;
  rig.lastClips.length = count;
  rig.lastFrames.length = count;
  rig.lastWeights.length = count;
  for (let l = 0; l < count; l++) {
    rig.lastClips[l] = clips[l];
    rig.lastFrames[l] = frames[l]!;
    rig.lastWeights[l] = weights[l]!;
  }
  return false;
}

/** Writes a property's value unless it already holds it (`last`), which spares Babylon recomputing the node. */
function writeIfChanged(rig: PoseRig, index: number, values: Float64Array, offset: number): void {
  const at = index * STRIDE;
  const n = rig.components[index]!;
  const last = rig.last;
  if (rig.written[index]) {
    let same = true;
    for (let c = 0; c < n; c++) {
      if (last[at + c] !== values[offset + c]) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  for (let c = 0; c < n; c++) last[at + c] = values[offset + c]!;
  rig.written[index] = 1;
  writeChannel(rig.properties[index]!, rig.modes[index]!, values, offset);
}

const sample = new Float64Array(STRIDE);

/**
 * Poses the rig from `count` weighted clips (`clips[i]` at `frames[i]`, weight `weights[i]`), writing each property
 * at most once. Clips blend by weighted sum, in any order alike: vectors, colours and numbers as they are, and
 * quaternions on one hemisphere, then normalised (the normalised lerp game engines blend bones with). A property's
 * total weight below 1 takes the rest value for the remainder, and a total above 1 normalises. A property no clip plays (total 0) returns to rest. A
 * property already holding its value is not written, and a pose whose layers equal the last pose's writes nothing.
 * Clips not on the rig are skipped. `layering` weights clips per bone under Layered Blend Per Bone inputs, and changes
 * bones after the blend (Transform Bone).
 */
export function applyPose(
  rig: PoseRig,
  count: number,
  clips: ArrayLike<PoseClip | undefined>,
  frames: ArrayLike<number>,
  weights: ArrayLike<number>,
  layering?: PoseLayering | null,
): void {
  // A change toward a world-space target follows the actor as it moves, so it poses again every time.
  if (layering?.modifiers.some(followsWorld)) rig.lastLayering = "";
  if (samePose(rig, count, clips, frames, weights, layeringSignature(count, layering))) return;
  const { properties, stamps, weights: totals, blended, posed, quaternions, components, clipProperties } = rig;
  // Stamps mark the properties this pose blends; a wrapped counter clears them.
  rig.generation = (rig.generation + 1) >>> 0;
  if (rig.generation === 0) {
    stamps.fill(0);
    rig.generation = 1;
  }
  const generation = rig.generation;
  const blends = layering?.blends ?? NO_BLENDS;
  if (blends.length > 0) sumBlends(rig, blends);
  const additive = layering?.additive;
  let additiveLayers = 0;
  for (let l = 0; l < count; l++) {
    const clip = clips[l]!;
    const weight = weights[l]!;
    const indices = clipProperties.get(clip);
    if (!indices || !(weight > 0)) continue;
    // Additive clips add to the blended pose afterwards.
    if (additive?.[l]) {
      additiveLayers++;
      continue;
    }
    const factors = blends.length > 0 ? layerFactors(rig, l, indices, layering!.masks[l], blends) : null;
    const frame = frames[l]!;
    const channels = clip.channels;
    const hints = clip.keyHints;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!;
      if (index < 0) continue;
      // Under a Layered Blend Per Bone, the clip's weight on this bone.
      const w = factors ? weight * factors[index]! : weight;
      if (!(w > 0)) continue;
      const at = index * STRIDE;
      const n = components[index]!;
      if (stamps[index] !== generation) {
        // The first clip on this property samples straight into it.
        stamps[index] = generation;
        totals[index] = w;
        sampleTrack(channels[i]!.track, frame, blended, at, hints, i);
        if (w !== 1) for (let c = 0; c < n; c++) blended[at + c]! *= w;
        continue;
      }
      sampleTrack(channels[i]!.track, frame, sample, 0, hints, i);
      totals[index]! += w;
      // A quaternion joins on the sum's hemisphere: q and -q are one rotation.
      const signed = quaternions[index] && dot4(blended, at, sample, 0) < 0 ? -w : w;
      for (let c = 0; c < n; c++) blended[at + c]! += sample[c]! * signed;
    }
  }
  for (let index = 0; index < properties.length; index++) {
    if (stamps[index] !== generation) continue;
    const at = index * STRIDE;
    const total = totals[index]!;
    const n = components[index]!;
    if (total < 1) {
      // Rest takes the weight the clips leave.
      const rest = properties[index]!.rest;
      const restWeight = quaternions[index] && dot4(blended, at, rest, 0) < 0 ? total - 1 : 1 - total;
      for (let c = 0; c < n; c++) blended[at + c]! += rest[c]! * restWeight;
    }
    if (quaternions[index]) {
      const length = Math.sqrt(dot4(blended, at, blended, at));
      if (length > 1e-12) for (let c = 0; c < 4; c++) blended[at + c]! /= length;
      else for (let c = 0; c < 4; c++) blended[at + c] = properties[index]!.rest[c]!;
    } else if (total > 1) {
      for (let c = 0; c < n; c++) blended[at + c]! /= total;
    }
  }
  if (additiveLayers > 0) {
    for (let l = 0; l < count; l++) {
      const entry = additive![l];
      const clip = clips[l]!;
      const indices = clipProperties.get(clip);
      if (!entry || !indices || !(weights[l]! > 0)) continue;
      const factors = blends.length > 0 ? layerFactors(rig, l, indices, layering!.masks[l], blends) : null;
      addAdditiveClip(rig, clip, indices, frames[l]!, weights[l]!, factors, entry, generation);
    }
  }
  for (let index = 0; index < properties.length; index++) {
    if (stamps[index] !== generation) {
      if (!posed[index]) continue;
      posed[index] = 0;
      writeIfChanged(rig, index, properties[index]!.rest, 0);
      continue;
    }
    posed[index] = 1;
    writeIfChanged(rig, index, blended, index * STRIDE);
  }
  const modifiers = layering?.modifiers ?? NO_MODIFIERS;
  if (modifiers.length > 0 || rig.changed.size > 0) applyBoneModifiers(rig, modifiers, blends, generation);
}

const NO_BLENDS: readonly AnimLayerBlend[] = [];

function followsWorld(change: AnimBoneModifier): boolean {
  if (change.kind === "lookAt") return change.targetSpace === "world";
  if (change.kind === "twoBoneIk") return change.effectorSpace === "world" || (!!change.jointTarget && change.jointTargetSpace === "world");
  return false;
}

/** Per additive clip: its channels' base values for each base pose it has been played from. */
const additiveReferences = new WeakMap<PoseClip, Array<{ reference: PoseClip | null; frame: number; values: Float64Array }>>();

/**
 * The base values an additive clip's channels change from: each channel's value in the base clip at its frame (the
 * channel with the same target and property), else its rest. Worked out once per clip and base.
 */
function additiveReference(clip: PoseClip, base: PoseAdditive): Float64Array {
  let list = additiveReferences.get(clip);
  if (!list) {
    list = [];
    additiveReferences.set(clip, list);
  }
  for (const entry of list) if (entry.reference === base.reference && entry.frame === base.frame) return entry.values;
  const values = new Float64Array(clip.channels.length * STRIDE);
  clip.channels.forEach((channel, i) => {
    const source = base.reference === clip
      ? channel
      : base.reference?.channels.find((candidate) =>
        candidate.binding.target === channel.binding.target &&
        candidate.track.components === channel.track.components &&
        candidate.path.join(".") === channel.path.join("."));
    if (source) samplePoseTrack(source.track, base.frame, values, i * STRIDE);
    else values.set(channel.rest.subarray(0, channel.track.components), i * STRIDE);
  });
  if (list.length >= 8) list.shift();
  list.push({ reference: base.reference, frame: base.frame, values });
  return values;
}

/**
 * Adds an additive clip's change from its base pose, at `weight`, to the blended pose: translations and other values
 * add the difference, scales multiply by the ratio, rotations turn by the difference (blended from no turn by the
 * weight) before the pose's own rotation. A property no other clip plays starts from rest.
 */
function addAdditiveClip(
  rig: PoseRig,
  clip: PoseClip,
  indices: Int32Array,
  frame: number,
  weight: number,
  factors: Float64Array | null,
  base: PoseAdditive,
  generation: number,
): void {
  const { properties, stamps, weights: totals, blended, quaternions, scales, components } = rig;
  const reference = additiveReference(clip, base);
  const channels = clip.channels;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]!;
    if (index < 0) continue;
    const w = factors ? weight * factors[index]! : weight;
    if (!(w > 0)) continue;
    const at = index * STRIDE;
    const n = components[index]!;
    if (stamps[index] !== generation) {
      stamps[index] = generation;
      totals[index] = 1;
      const rest = properties[index]!.rest;
      for (let c = 0; c < n; c++) blended[at + c] = rest[c]!;
    }
    sampleTrack(channels[i]!.track, frame, sample, 0, clip.keyHints, i);
    const r = i * STRIDE;
    if (quaternions[index]) {
      // The turn from the base: sample × base⁻¹, on the identity's hemisphere, scaled by the weight from no turn.
      const bx = -reference[r]!, by = -reference[r + 1]!, bz = -reference[r + 2]!, bw = reference[r + 3]!;
      const sx = sample[0]!, sy = sample[1]!, sz = sample[2]!, sw = sample[3]!;
      let dx = sw * bx + sx * bw + sy * bz - sz * by;
      let dy = sw * by - sx * bz + sy * bw + sz * bx;
      let dz = sw * bz + sx * by - sy * bx + sz * bw;
      let dw = sw * bw - sx * bx - sy * by - sz * bz;
      if (dw < 0) {
        dx = -dx;
        dy = -dy;
        dz = -dz;
        dw = -dw;
      }
      dx *= w;
      dy *= w;
      dz *= w;
      dw = 1 - w + dw * w;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
      if (length < 1e-12) continue;
      dx /= length;
      dy /= length;
      dz /= length;
      dw /= length;
      const qx = blended[at]!, qy = blended[at + 1]!, qz = blended[at + 2]!, qw = blended[at + 3]!;
      const x = dw * qx + dx * qw + dy * qz - dz * qy;
      const y = dw * qy - dx * qz + dy * qw + dz * qx;
      const z = dw * qz + dx * qy - dy * qx + dz * qw;
      const qwOut = dw * qw - dx * qx - dy * qy - dz * qz;
      const total = Math.sqrt(x * x + y * y + z * z + qwOut * qwOut) || 1;
      blended[at] = x / total;
      blended[at + 1] = y / total;
      blended[at + 2] = z / total;
      blended[at + 3] = qwOut / total;
    } else if (scales[index]) {
      for (let c = 0; c < n; c++) {
        const from = reference[r + c]!;
        const ratio = from !== 0 ? sample[c]! / from : 1;
        blended[at + c]! *= 1 + (ratio - 1) * w;
      }
    } else {
      for (let c = 0; c < n; c++) blended[at + c]! += (sample[c]! - reference[r + c]!) * w;
    }
  }
}
const NO_MODIFIERS: readonly AnimBoneModifier[] = [];

/** Branch filters by key, parsed once. */
const parsedFilters = new Map<string, Map<string, number>>();

function branchFilter(key: string): Map<string, number> {
  let filter = parsedFilters.get(key);
  if (!filter) {
    if (parsedFilters.size >= 256) parsedFilters.clear();
    filter = parseAnimBranchFilterKey(key);
    parsedFilters.set(key, filter);
  }
  return filter;
}

/** Each property's weight under a branch filter, from its target's chain of names; worked out once per rig. */
function branchWeights(rig: PoseRig, key: string): Float64Array {
  let weights = rig.branchWeights.get(key);
  if (!weights) {
    const filter = branchFilter(key);
    weights = new Float64Array(rig.properties.length);
    for (let index = 0; index < weights.length; index++) {
      weights[index] = animBranchWeight(filter, nodeChainNames(rig.properties[index]!.binding.target));
    }
    rig.branchWeights.set(key, weights);
  }
  return weights;
}

/** Per blend, each property's summed input weight: the inputs' Blend Weights times their branch weights. */
function sumBlends(rig: PoseRig, blends: readonly AnimLayerBlend[]): void {
  const count = rig.properties.length;
  for (let b = 0; b < blends.length; b++) {
    const blend = blends[b]!;
    let sums = rig.blendSums[b];
    if (!sums || sums.length !== count) sums = rig.blendSums[b] = new Float64Array(count);
    sums.fill(0);
    for (let input = 0; input < blend.filters.length; input++) {
      const weight = blend.weights[input] ?? 0;
      if (!(weight > 0)) continue;
      const branch = branchWeights(rig, blend.filters[input]!);
      for (let index = 0; index < count; index++) sums[index]! += weight * branch[index]!;
    }
  }
}

/**
 * A layer input's share of a property under one blend: the Base Pose takes what the inputs leave, an input its branch
 * weight (its layers already carry its Blend Weight), the inputs sharing 1 when they sum above it.
 */
function maskFactor(sum: number, input: number, branch: number): number {
  if (input < 0) return 1 - Math.min(1, sum);
  return sum > 1 ? branch / sum : branch;
}

/** The clip's weight factor per property under its Layered Blend inputs, or null when it plays under none. */
function layerFactors(
  rig: PoseRig,
  layer: number,
  indices: Int32Array,
  masks: readonly AnimLayerMaskRef[] | undefined,
  blends: readonly AnimLayerBlend[],
): Float64Array | null {
  if (!masks || masks.length === 0) return null;
  let factors = rig.layerFactors[layer];
  if (!factors || factors.length !== rig.properties.length) factors = rig.layerFactors[layer] = new Float64Array(rig.properties.length);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]!;
    if (index < 0) continue;
    let factor = 1;
    for (const ref of masks) {
      const blend = blends[ref.blend];
      const sums = rig.blendSums[ref.blend];
      if (!blend || !sums) continue;
      const branch = ref.input < 0 ? 0 : branchWeights(rig, blend.filters[ref.input] ?? "[]")[index]!;
      factor *= maskFactor(sums[index]!, ref.input, branch);
    }
    factors[index] = factor;
  }
  return factors;
}

/** A bone's weight under its Layered Blend inputs, from its chain of names. */
function nodeMaskFactor(node: BoneNode, masks: readonly AnimLayerMaskRef[], blends: readonly AnimLayerBlend[]): number {
  const chain = nodeChainNames(node);
  let factor = 1;
  for (const ref of masks) {
    const blend = blends[ref.blend];
    if (!blend) continue;
    let sum = 0;
    let own = 0;
    for (let input = 0; input < blend.filters.length; input++) {
      const branch = animBranchWeight(branchFilter(blend.filters[input]!), chain);
      sum += (blend.weights[input] ?? 0) * branch;
      if (input === ref.input) own = branch;
    }
    factor *= maskFactor(sum, ref.input, own);
  }
  return factor;
}

function isBoneNode(value: unknown): value is BoneNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<BoneNode>;
  return typeof node.name === "string" && node.position instanceof Vector3 && node.scaling instanceof Vector3;
}

/** The posed node named `name`: an animated target, else a node under the same root. Null when the rig has none. */
function boneNodeOf(rig: PoseRig, name: string): BoneNode | null {
  const cached = rig.bones.get(name);
  if (cached !== undefined && !cached?.isDisposed?.()) return cached;
  let found: BoneNode | null = null;
  let anyTarget: unknown = null;
  for (const property of rig.properties) {
    const target = property.binding.target;
    if (!isBoneNode(target)) continue;
    anyTarget ??= target;
    if (target.name === name) {
      found = target;
      break;
    }
  }
  if (!found && anyTarget) {
    let root = anyTarget as { parent?: unknown };
    while (root.parent && typeof root.parent === "object") root = root.parent as { parent?: unknown };
    const descendants = (root as { getDescendants?: (direct?: boolean) => unknown[] }).getDescendants?.(false) ?? [];
    found = (descendants.find((node) => isBoneNode(node) && node.name === name) as BoneNode | undefined) ?? null;
  }
  rig.bones.set(name, found);
  return found;
}

const PATH_CHANNEL: Readonly<Record<string, number>> = { position: 0, rotationQuaternion: 1, scaling: 2 };
const nodeIndices = new Int32Array(3);

/** The rig's property indices of a node's translation, rotation and scale; -1 where no clip animates it. */
function nodePropertyIndices(rig: PoseRig, node: BoneNode): Int32Array {
  nodeIndices.fill(-1);
  for (let index = 0; index < rig.properties.length; index++) {
    const property = rig.properties[index]!;
    if (property.binding.target !== node || property.path.length !== 1) continue;
    const channel = PATH_CHANNEL[property.path[0]!];
    if (channel !== undefined) nodeIndices[channel] = index;
  }
  return nodeIndices;
}

const CHANNEL_BITS = [WRITE_TRANSLATION, WRITE_ROTATION, WRITE_SCALE] as const;
const trsBase = new Float64Array(TRS_LENGTH);
const trsChanged = new Float64Array(TRS_LENGTH);
const trsOut = new Float64Array(TRS_LENGTH);

const ikBases = [new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH)] as const;
const ikSolved = [new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH), new Float64Array(TRS_LENGTH)] as const;

/**
 * Writes a change to one bone: `solved` (its local transform after the change) blended with `base` (its pose before)
 * by `alpha`, on `channels`. A changed channel a clip animates is written again by the next pose.
 */
function writeBoneChange(
  rig: PoseRig, node: BoneNode, base: Float64Array, solved: Float64Array, alpha: number, channels: number, generation: number,
): void {
  if (!(alpha > 0) || channels === 0) return;
  let changed = rig.changed.get(node);
  if (!changed) {
    // Its pose now: a clip's value, or its rest where no clip and no change has set it.
    const rest = new Float64Array(TRS_LENGTH);
    readNodeTrs(node, rest);
    changed = { rest, touched: 0, generation };
    rig.changed.set(node, changed);
  }
  changed.generation = generation;
  blendTrs(base, solved, alpha, trsOut);
  writeNodeTrs(node, trsOut, channels);
  changed.touched |= channels;
  const indices = nodePropertyIndices(rig, node);
  for (let c = 0; c < 3; c++) {
    const index = indices[c]!;
    if (index < 0 || !(channels & CHANNEL_BITS[c]!)) continue;
    // The node no longer holds the blended value: the next pose writes it again, or rests it.
    rig.written[index] = 0;
    rig.posed[index] = 1;
  }
}

function changeAlpha(node: BoneNode, change: AnimBoneModifier, blends: readonly AnimLayerBlend[]): number {
  return Math.min(1, change.alpha) * (change.masks?.length ? nodeMaskFactor(node, change.masks, blends) : 1);
}

/**
 * Applies skeletal control changes (Transform Bone, Look At, Two Bone IK) in order on the posed nodes. Each starts
 * from the bones' pose: the blended value where a clip animates a channel, else its rest, so a channel a change set
 * last pose and no clip animates returns to rest first. A bone no change touches any more stays at rest.
 */
function applyBoneModifiers(
  rig: PoseRig,
  modifiers: readonly AnimBoneModifier[],
  blends: readonly AnimLayerBlend[],
  generation: number,
): void {
  for (const [node, changed] of rig.changed) {
    if (node.isDisposed?.()) {
      rig.changed.delete(node);
      continue;
    }
    const indices = nodePropertyIndices(rig, node);
    let restore = 0;
    for (let c = 0; c < 3; c++) if (indices[c]! < 0) restore |= changed.touched & CHANNEL_BITS[c]!;
    if (restore) writeNodeTrs(node, changed.rest, restore);
    changed.touched = 0;
  }
  for (const modifier of modifiers) {
    const node = boneNodeOf(rig, modifier.bone);
    if (!node) continue;
    if (modifier.kind === "twoBoneIk") {
      const chain = ikChainOf(node);
      if (!chain) continue;
      const bones = [chain.root, chain.joint, chain.end] as const;
      bones.forEach((bone, i) => readNodeTrs(bone, ikBases[i]!));
      const writes = twoBoneIkLocalTrs(chain, modifier, ikBases, ikSolved);
      if (!writes) continue;
      bones.forEach((bone, i) => writeBoneChange(rig, bone, ikBases[i]!, ikSolved[i]!, changeAlpha(bone, modifier, blends), writes[i]!, generation));
      continue;
    }
    readNodeTrs(node, trsBase);
    if (modifier.kind === "lookAt") {
      lookAtLocalTrs(node, modifier, trsBase, trsChanged);
      writeBoneChange(rig, node, trsBase, trsChanged, changeAlpha(node, modifier, blends), WRITE_ROTATION, generation);
      continue;
    }
    modifiedLocalTrs(node, modifier, trsBase, trsChanged);
    writeBoneChange(rig, node, trsBase, trsChanged, changeAlpha(node, modifier, blends), modifierChannels(modifier), generation);
  }
  for (const [node, changed] of rig.changed) {
    if (changed.generation !== generation) rig.changed.delete(node);
  }
}

function dot4(a: Float64Array, ai: number, b: Float64Array, bi: number): number {
  return a[ai]! * b[bi]! + a[ai + 1]! * b[bi + 1]! + a[ai + 2]! * b[bi + 2]! + a[ai + 3]! * b[bi + 3]!;
}

const one = [1];
const oneClip: (PoseClip | undefined)[] = [undefined];
const oneFrame = [0];

/** Poses the rig from one clip at `frame`, at full weight; the rig's other properties rest. */
export function applyPoseClip(rig: PoseRig, clip: PoseClip, frame: number): void {
  oneClip[0] = clip;
  oneFrame[0] = frame;
  try {
    applyPose(rig, 1, oneClip, oneFrame, one);
  } finally {
    oneClip[0] = undefined;
  }
}
