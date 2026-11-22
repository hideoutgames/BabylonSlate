import { accessorValues, GltfGeometryUnreadableError, multiplyMat, nodeMatrix } from "./glb-geometry";
import { gltfAnimationClips, splitGlbJsonBin } from "./importers/glb-parse";

/**
 * Root motion: how far an Animation's root bone travels across the ground and turns about the up axis, which Play
 * moves the actor by instead of the bone. A track samples it from the clip's first key, in the Model's own space with
 * the engine's handedness (glTF X mirrored, so yaw turns the other way), in the source file's units.
 */
export interface AnimationRootMotionTrack {
  /** The clip's length the track covers, from its first key. */
  durationMs: number;
  /** Time between samples; the last sample is at `durationMs`. */
  stepMs: number;
  /** The bone's travel from the first sample, along X and Z. */
  x: number[];
  z: number[];
  /** The bone's turn about Y from the first sample, in degrees, unwrapped (it may pass ±180). */
  yaw: number[];
}

export interface AnimationRootMotion {
  /** The bone whose travel and turn move the actor; render holds it in place across the ground. */
  bone: string;
  track: AnimationRootMotionTrack;
}

/** The track's sample rate: 30 a second. */
export const ROOT_MOTION_STEP_MS = 1000 / 30;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function finiteArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? entry : 0)) : [];
}

/** An Animation's root motion as stored, cleaned; undefined without a bone or a track. */
export function normalizeAnimationRootMotion(value: unknown): AnimationRootMotion | undefined {
  const record = asRecord(value);
  const bone = typeof record.bone === "string" ? record.bone.trim() : "";
  const track = asRecord(record.track);
  const x = finiteArray(track.x);
  const z = finiteArray(track.z);
  const yaw = finiteArray(track.yaw);
  const count = Math.min(x.length, z.length, yaw.length);
  const durationMs = typeof track.durationMs === "number" && track.durationMs > 0 ? track.durationMs : 0;
  const stepMs = typeof track.stepMs === "number" && track.stepMs > 0 ? track.stepMs : ROOT_MOTION_STEP_MS;
  if (!bone || count === 0 || durationMs <= 0) return undefined;
  return { bone, track: { durationMs, stepMs, x: x.slice(0, count), z: z.slice(0, count), yaw: yaw.slice(0, count) } };
}

interface Sampler {
  times: number[];
  values: number[];
  components: number;
  interpolation: string;
}

function readSampler(json: Record<string, unknown>, bin: Uint8Array, sampler: Record<string, unknown>, components: number): Sampler | null {
  if (typeof sampler.input !== "number" || typeof sampler.output !== "number") return null;
  return {
    times: accessorValues(json, bin, sampler.input, 1),
    // `accessorValues` maps a normalized (KHR_mesh_quantization) rotation to [-1, 1].
    values: accessorValues(json, bin, sampler.output, components),
    components,
    interpolation: typeof sampler.interpolation === "string" ? sampler.interpolation : "LINEAR",
  };
}

/** A sampler's value at `seconds` (clamped to its keys): linear (quaternions normalized), held for STEP, and a cubic
 * spline's values joined linearly. */
function sample(sampler: Sampler, seconds: number, out: number[]): void {
  const { times, values, components } = sampler;
  const cubic = sampler.interpolation === "CUBICSPLINE";
  const stride = cubic ? components * 3 : components;
  const valueAt = (key: number, c: number) => values[key * stride + (cubic ? components : 0) + c] ?? 0;
  const last = times.length - 1;
  if (last < 0) return;
  if (seconds <= times[0]! || last === 0) {
    for (let c = 0; c < components; c++) out[c] = valueAt(0, c);
    return;
  }
  if (seconds >= times[last]!) {
    for (let c = 0; c < components; c++) out[c] = valueAt(last, c);
    return;
  }
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= seconds) low = mid;
    else high = mid;
  }
  const span = times[high]! - times[low]!;
  const t = sampler.interpolation === "STEP" || span <= 0 ? 0 : (seconds - times[low]!) / span;
  let sign = 1;
  if (components === 4) {
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += valueAt(low, c) * valueAt(high, c);
    if (dot < 0) sign = -1;
  }
  for (let c = 0; c < components; c++) out[c] = valueAt(low, c) + (valueAt(high, c) * sign - valueAt(low, c)) * t;
  if (components === 4) {
    const length = Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!) || 1;
    for (let c = 0; c < 4; c++) out[c] = out[c]! / length;
  }
}

/** A column-major matrix's rotation as a quaternion `[x, y, z, w]`, its columns' scale divided out. */
function matrixRotation(m: Float64Array): number[] {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const r00 = m[0]! / sx, r10 = m[1]! / sx, r20 = m[2]! / sx;
  const r01 = m[4]! / sy, r11 = m[5]! / sy, r21 = m[6]! / sy;
  const r02 = m[8]! / sz, r12 = m[9]! / sz, r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    return [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    return [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
  return [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
}

function multiplyQuat(a: readonly number[], b: readonly number[]): number[] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const round = (value: number) => Math.round(value * 1e4) / 1e4 + 0;

/**
 * Samples the root motion of `clipName`'s `bone` from a GLB (or glTF JSON) file: the bone's travel along X and Z and
 * its turn about Y, in the Model's space, from the clip's first key. Its ancestors are taken at rest. Null when the
 * file has no such clip or bone.
 */
export function extractAnimationRootMotion(
  bytes: Uint8Array,
  clipName: string,
  bone: string,
  stepMs = ROOT_MOTION_STEP_MS,
): AnimationRootMotion | null {
  const split = splitGlbJsonBin(bytes);
  if (!split) return null;
  const { json, bin } = split;
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const boneIndex = nodes.findIndex((node) => asRecord(node).name === bone);
  const clips = gltfAnimationClips(json);
  const clipIndex = clips.findIndex((clip) => clip.name === clipName);
  if (boneIndex < 0 || clipIndex < 0) return null;
  const animation = asRecord((json.animations as unknown[])[clipIndex]);
  const samplers = Array.isArray(animation.samplers) ? animation.samplers : [];
  const channels = Array.isArray(animation.channels) ? animation.channels : [];
  let translation: Sampler | null = null;
  let rotation: Sampler | null = null;
  try {
    for (const entry of channels) {
      const channel = asRecord(entry);
      const target = asRecord(channel.target);
      if (target.node !== boneIndex || typeof channel.sampler !== "number") continue;
      const sampler = asRecord(samplers[channel.sampler]);
      if (target.path === "translation") translation = readSampler(json, bin, sampler, 3);
      if (target.path === "rotation") rotation = readSampler(json, bin, sampler, 4);
    }
  } catch (error) {
    // Meshopt-compressed or malformed keys: no root motion rather than a track sampled from the wrong bytes.
    if (error instanceof GltfGeometryUnreadableError) return null;
    throw error;
  }
  // The bone's parent at rest, from the scene root down.
  const parents = new Map<number, number>();
  nodes.forEach((node, index) => {
    for (const child of Array.isArray(asRecord(node).children) ? (asRecord(node).children as unknown[]) : []) {
      if (typeof child === "number") parents.set(child, index);
    }
  });
  let parent: Float64Array = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (let at = parents.get(boneIndex); at !== undefined; at = parents.get(at)) {
    parent = multiplyMat(nodeMatrix(asRecord(nodes[at])), parent);
  }
  const parentRotation = matrixRotation(parent);
  const rest = asRecord(nodes[boneIndex]);
  const restT = Array.isArray(rest.translation) ? rest.translation.map(Number) : [0, 0, 0];
  const restR = Array.isArray(rest.rotation) ? rest.rotation.map(Number) : [0, 0, 0, 1];
  const startMs = clips[clipIndex]!.startTimeMs ?? 0;
  const durationMs = clips[clipIndex]!.durationMs ?? 0;
  if (!(durationMs > 0)) return null;
  const count = Math.max(2, Math.ceil(durationMs / stepMs) + 1);
  const x: number[] = [];
  const z: number[] = [];
  const yaw: number[] = [];
  const t = [0, 0, 0];
  const r = [0, 0, 0, 1];
  let origin: number[] | null = null;
  let firstTurn: number[] | null = null;
  let previousYaw = 0;
  for (let i = 0; i < count; i++) {
    const seconds = (startMs + Math.min(durationMs, i * stepMs)) / 1000;
    if (translation) sample(translation, seconds, t);
    else for (let c = 0; c < 3; c++) t[c] = restT[c] ?? 0;
    if (rotation) sample(rotation, seconds, r);
    else for (let c = 0; c < 4; c++) r[c] = restR[c] ?? (c === 3 ? 1 : 0);
    const position = [
      parent[0]! * t[0]! + parent[4]! * t[1]! + parent[8]! * t[2]! + parent[12]!,
      parent[1]! * t[0]! + parent[5]! * t[1]! + parent[9]! * t[2]! + parent[13]!,
      parent[2]! * t[0]! + parent[6]! * t[1]! + parent[10]! * t[2]! + parent[14]!,
    ];
    const turn = multiplyQuat(parentRotation, r);
    origin ??= position;
    firstTurn ??= turn;
    // The turn since the first sample, and its twist about Y.
    const inverseFirst = [-firstTurn[0]!, -firstTurn[1]!, -firstTurn[2]!, firstTurn[3]!];
    const delta = multiplyQuat(turn, inverseFirst);
    let degrees = (2 * Math.atan2(delta[1]!, delta[3]!) * 180) / Math.PI;
    // Unwrapped, so a full turn reads as 360 rather than jumping back.
    while (degrees - previousYaw > 180) degrees -= 360;
    while (degrees - previousYaw < -180) degrees += 360;
    previousYaw = degrees;
    // The engine mirrors glTF's X: travel along X and the turn about Y both flip.
    x.push(round(-(position[0]! - origin[0]!)));
    z.push(round(position[2]! - origin[2]!));
    yaw.push(round(-degrees));
  }
  return { bone, track: { durationMs, stepMs, x, z, yaw } };
}

/** Root motion as an actor plays it: travel scaled by its source Model's import scale (turns are unscaled). */
export function scaledAnimationRootMotion(motion: AnimationRootMotion, scale: number): AnimationRootMotion {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (factor === 1) return motion;
  const { track } = motion;
  return { bone: motion.bone, track: { ...track, x: track.x.map((value) => value * factor), z: track.z.map((value) => value * factor) } };
}
