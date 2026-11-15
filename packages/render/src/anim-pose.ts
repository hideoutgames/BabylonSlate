import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Haptic's pose evaluator: Play, the editor's previews and exported games pose 3D clips here, never by starting,
 * seeking or weighting Babylon AnimationGroups. A clip's channels compile once into flat key tracks, which sample like
 * Babylon's own interpolation (step, linear with spherical quaternions, and cubic-spline tangents). A slot's rig holds
 * each animated target property once: every frame the playing clips blend into it by weight, filling up to full weight
 * from the property's rest value, and each property is written once. Properties no clip plays return to rest.
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
  return { components, quaternion: source.dataType === QUATERNION, frames, values, inTangents, outTangents, tangentKeys, steps };
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

function copyKey(track: PoseTrack, key: number, out: Float64Array, offset: number): void {
  const n = track.components;
  for (let c = 0; c < n; c++) out[offset + c] = track.values[key * n + c]!;
}

/**
 * The track's value at `frame` into `out`, as Babylon's `Animation._interpolate` computes it: held at the first and
 * last keys outside them, a stepped key held to the next, cubic-spline (Hermite) keys where both neighbours carry
 * tangents, spherical between quaternion keys and linear otherwise. Easing functions are not sampled; glTF has none.
 */
export function samplePoseTrack(track: PoseTrack, frame: number, out: Float64Array, offset = 0): void {
  const { frames, values, components: n } = track;
  const last = frames.length - 1;
  if (!(frame > frames[0]!) || last === 0) {
    copyKey(track, 0, out, offset);
    return;
  }
  if (frame >= frames[last]!) {
    copyKey(track, last, out, offset);
    return;
  }
  // The last key at or before `frame`; the one after it is later than `frame`.
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle]! <= frame) low = middle;
    else high = middle;
  }
  const start = low;
  const end = low + 1;
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
    slerpInto(values, start * 4, values, end * 4, t, out, offset);
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
  return { name: group.name, from: group.from, to: group.to, clipAssetGuid, channels, ...(extra as Extra) };
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
  const holder = propertyHolder(target, channel.path);
  if (!holder) return;
  const property = channel.path[channel.path.length - 1]!;
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
 * the per-frame blend buffers and which properties the last pose moved off their rest values.
 */
export interface PoseRig {
  readonly members: readonly PoseClip[];
  /** Per property: the first clip channel that animates it, whose target, path and rest the rig writes with. */
  readonly properties: readonly PoseClipChannel[];
  readonly modes: Uint8Array;
  /** Per clip: its channels' property indices, -1 for a channel that repeats another of the same clip. */
  readonly clipProperties: ReadonlyMap<PoseClip, Int32Array>;
  readonly totals: Float64Array;
  readonly blended: Float64Array;
  readonly accumulated: Float64Array;
  /** 1 while the property is off its rest value; a fresh rig starts with all set, so it rests what it does not play. */
  readonly posed: Uint8Array;
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
      const key = channel.path.join(".");
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
  for (let i = 0; i < count; i++) modes[i] = writeModeOf(properties[i]!.binding.target, properties[i]!.track);
  return {
    members: clips.slice(),
    properties,
    modes,
    clipProperties,
    totals: new Float64Array(count),
    blended: new Float64Array(count * STRIDE),
    accumulated: new Float64Array(count),
    posed: new Uint8Array(count).fill(1),
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

const sample = new Float64Array(STRIDE);

/**
 * Poses the rig from `count` weighted clips (`clips[i]` at `frames[i]`, weight `weights[i]`), writing each property
 * once. A property's weights sum to its total: below 1 its rest value fills the rest, above 1 they are normalised.
 * Vectors, colours and numbers blend linearly; quaternions by successive spherical steps, as Babylon blends weighted
 * animations. A property no clip plays (total 0) returns to rest. Clips not on the rig are skipped.
 */
export function applyPose(
  rig: PoseRig,
  count: number,
  clips: ArrayLike<PoseClip | undefined>,
  frames: ArrayLike<number>,
  weights: ArrayLike<number>,
): void {
  const { properties, totals, blended, accumulated, posed, modes, clipProperties } = rig;
  totals.fill(0);
  accumulated.fill(0);
  for (let l = 0; l < count; l++) {
    const weight = weights[l]!;
    const indices = clipProperties.get(clips[l]!);
    if (!indices || !(weight > 0)) continue;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!;
      if (index >= 0) totals[index] += weight;
    }
  }
  for (let l = 0; l < count; l++) {
    const clip = clips[l]!;
    const weight = weights[l]!;
    const indices = clipProperties.get(clip);
    if (!indices || !(weight > 0)) continue;
    const frame = frames[l]!;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!;
      if (index < 0) continue;
      const channel = clip.channels[i]!;
      const track = channel.track;
      samplePoseTrack(track, frame, sample, 0);
      const total = totals[index]!;
      const at = index * STRIDE;
      const n = track.components;
      if (track.quaternion) {
        if (accumulated[index] === 0) {
          if (total < 1) {
            // Rest takes the weight the clips leave: rest, then each clip in turn.
            const rest = properties[index]!.rest;
            for (let c = 0; c < 4; c++) blended[at + c] = rest[c]!;
            accumulated[index] = 1 - total + weight;
            slerpInto(blended, at, sample, 0, weight / accumulated[index]!, blended, at);
          } else {
            for (let c = 0; c < 4; c++) blended[at + c] = sample[c]!;
            accumulated[index] = weight;
          }
          continue;
        }
        accumulated[index] += weight;
        slerpInto(blended, at, sample, 0, weight / accumulated[index]!, blended, at);
        continue;
      }
      const share = total < 1 ? weight : weight / total;
      if (accumulated[index] === 0) {
        const restShare = total < 1 ? 1 - total : 0;
        const rest = properties[index]!.rest;
        for (let c = 0; c < n; c++) blended[at + c] = rest[c]! * restShare + sample[c]! * share;
        accumulated[index] = weight;
        continue;
      }
      accumulated[index] += weight;
      for (let c = 0; c < n; c++) blended[at + c] += sample[c]! * share;
    }
  }
  for (let index = 0; index < properties.length; index++) {
    const property = properties[index]!;
    if (totals[index]! > 0) {
      writeChannel(property, modes[index]!, blended, index * STRIDE);
      posed[index] = 1;
    } else if (posed[index]) {
      writeChannel(property, modes[index]!, property.rest, 0);
      posed[index] = 0;
    }
  }
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
