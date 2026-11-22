import type { AnimClipSweep } from "./events";

/** A root motion track: the root bone's travel along X and Z and turn about Y from its first sample, at even steps. */
export interface AnimClipRootMotionTrack {
  durationMs: number;
  stepMs: number;
  x: readonly number[];
  z: readonly number[];
  yaw: readonly number[];
}

/**
 * Root motion as the worker plays it: an Animation's root bone travel across the ground and turn about the up axis,
 * sampled from its first key, in the actor's own axes and units (the catalog scales the Animation's track by its source
 * Model's import scale). Each tick, every clip playing with root motion adds its travel since the last tick, by its
 * weight, and the actor moves by the sum instead of the bone.
 */
export interface AnimClipRootMotion {
  bone: string;
  /**
   * Absent in a catalog built from asset headers (the editor's), which name only the bone: a player then holds the bone
   * in place and moves nothing. Play and exported games build their catalogs from documents, with the track.
   */
  track?: AnimClipRootMotionTrack;
}

/** A tick's root motion: travel along the actor's X and Z, and its turn about Y in degrees. */
export interface AnimRootMotionDelta {
  x: number;
  z: number;
  yaw: number;
}

function trackAt(track: AnimClipRootMotionTrack, normalised: number): AnimRootMotionDelta {
  const last = track.x.length - 1;
  if (last < 0) return { x: 0, z: 0, yaw: 0 };
  const position = Math.min(last, (Math.min(1, Math.max(0, normalised)) * track.durationMs) / Math.max(1e-6, track.stepMs));
  const low = Math.floor(position);
  const high = Math.min(last, low + 1);
  const t = high > low ? position - low : 0;
  const lerp = (values: readonly number[]) => values[low]! + (values[high]! - values[low]!) * t;
  return { x: lerp(track.x), z: lerp(track.z), yaw: lerp(track.yaw) };
}

/** Where the track has carried the bone at sweep position `p`: whole passes of a looping clip, then into the next. */
function travelled(track: AnimClipRootMotionTrack, p: number, loop: boolean): AnimRootMotionDelta {
  if (!loop) return trackAt(track, p);
  const passes = Math.floor(p);
  const end = trackAt(track, 1);
  const into = trackAt(track, p - passes);
  return { x: passes * end.x + into.x, z: passes * end.z + into.z, yaw: passes * end.yaw + into.yaw };
}

/**
 * The travel and turn a clip made over a tick's sweep: from where it was to where it is, through each pass it
 * completed. A pass's travel turns with the turn the passes before it made, so a clip that turns as it walks curves.
 */
export function animRootMotionDelta(track: AnimClipRootMotionTrack, sweep: AnimClipSweep): AnimRootMotionDelta {
  const from = travelled(track, sweep.from, sweep.loop);
  const to = travelled(track, sweep.to, sweep.loop);
  // Travel since the sweep's start, in the actor's axes at its start.
  const radians = (-from.yaw * Math.PI) / 180;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return {
    x: dx * Math.cos(radians) + dz * Math.sin(radians),
    z: -dx * Math.sin(radians) + dz * Math.cos(radians),
    yaw: to.yaw - from.yaw,
  };
}

/** Root motion parts summed by weight; undefined when they move nothing. */
export function sumAnimRootMotion(parts: ReadonlyArray<AnimRootMotionDelta & { weight: number }>): AnimRootMotionDelta | undefined {
  let x = 0;
  let z = 0;
  let yaw = 0;
  for (const part of parts) {
    x += part.x * part.weight;
    z += part.z * part.weight;
    yaw += part.yaw * part.weight;
  }
  return Math.abs(x) + Math.abs(z) + Math.abs(yaw) > 1e-9 ? { x, z, yaw } : undefined;
}

/**
 * A root motion as stored on a resolved clip node, or undefined. One without a track (from a header catalog) keeps its
 * bone; one whose track is malformed is none.
 */
export function parseAnimClipRootMotion(value: unknown): AnimClipRootMotion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { bone?: unknown; track?: unknown };
  if (typeof row.bone !== "string" || !row.bone) return undefined;
  if (row.track === undefined) return { bone: row.bone };
  if (!row.track || typeof row.track !== "object") return undefined;
  const track = row.track as Record<string, unknown>;
  const numbers = (entry: unknown) => (Array.isArray(entry) ? (entry as number[]) : []);
  const durationMs = typeof track.durationMs === "number" ? track.durationMs : 0;
  const stepMs = typeof track.stepMs === "number" ? track.stepMs : 0;
  if (!(durationMs > 0) || !(stepMs > 0)) return undefined;
  return { bone: row.bone, track: { durationMs, stepMs, x: numbers(track.x), z: numbers(track.z), yaw: numbers(track.yaw) } };
}
