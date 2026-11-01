import {
  evaluateTimelineTrack,
  type SerializedScene,
  type SerializedTimelineClip,
  type TimelineKey,
  type TimelineObjectTrack,
  type TimelinePropertyTrack,
  type TimelineValueType,
} from "@haptic/core";
import { timelineTargetKey, type TimelinePropertyEntry } from "./timeline-property-catalog";

/**
 * Timeline window edits on one clip; each returns the next clip, or the same
 * clip when nothing changed. `newId` mints ids for objects, tracks and keys.
 */

export type NewId = () => string;
export interface TrackKeyRef {
  trackId: string;
  keyId: string;
}

/** Value types whose keys interpolate; the rest step from key to key. */
export const INTERPOLATED_VALUE_TYPES: ReadonlySet<TimelineValueType> = new Set(["float", "vec2", "vec3", "rotator", "color"]);

/** Two key times on the same frame. */
const sameFrame = (a: number, b: number, frameRate: number) => Math.abs(a - b) < 0.5 / Math.max(1, frameRate);

const sortKeys = (keys: TimelineKey[]) => keys.sort((a, b) => a.Time - b.Time);

function mapTracks(clip: SerializedTimelineClip, map: (track: TimelinePropertyTrack) => TimelinePropertyTrack): SerializedTimelineClip {
  let changed = false;
  const objects = clip.objects.map((object) => {
    let objectChanged = false;
    const tracks = object.tracks.map((track) => {
      const next = map(track);
      if (next !== track) objectChanged = true;
      return next;
    });
    if (!objectChanged) return object;
    changed = true;
    return { ...object, tracks };
  });
  return changed ? { ...clip, objects } : clip;
}

/** The scene with `clip` in place of the clip that has its id. */
export function withTimelineClip(scene: SerializedScene, clip: SerializedTimelineClip): SerializedScene {
  const clips = scene.timelineClips ?? [];
  const index = clips.findIndex((entry) => entry.id === clip.id);
  if (index < 0 || clips[index] === clip) return scene;
  const timelineClips = [...clips];
  timelineClips[index] = clip;
  return { ...scene, timelineClips };
}

export function findTimelineTrack(clip: SerializedTimelineClip, trackId: string):
  { object: TimelineObjectTrack; track: TimelinePropertyTrack } | undefined {
  for (const object of clip.objects) {
    const track = object.tracks.find((entry) => entry.id === trackId);
    if (track) return { object, track };
  }
  return undefined;
}

/** Adds an object for each actor the clip does not animate yet, in order. */
export function addTimelineObjects(clip: SerializedTimelineClip, actorIds: readonly string[], newId: NewId): SerializedTimelineClip {
  const present = new Set(clip.objects.map((object) => object.actorId));
  const added: TimelineObjectTrack[] = [];
  for (const actorId of actorIds) {
    if (present.has(actorId)) continue;
    present.add(actorId);
    added.push({ id: newId(), actorId, tracks: [] });
  }
  return added.length ? { ...clip, objects: [...clip.objects, ...added] } : clip;
}

/** Adds empty tracks for the properties the actor's object does not have yet (adding the object if needed). */
export function addTimelineTracks(
  clip: SerializedTimelineClip,
  actorId: string,
  entries: readonly TimelinePropertyEntry[],
  newId: NewId,
): SerializedTimelineClip {
  const withObject = addTimelineObjects(clip, [actorId], newId);
  const object = withObject.objects.find((entry) => entry.actorId === actorId)!;
  const present = new Set(object.tracks.map((track) => timelineTargetKey(track.target)));
  const tracks = [...object.tracks];
  for (const entry of entries) {
    const key = timelineTargetKey(entry.target);
    if (present.has(key)) continue;
    present.add(key);
    tracks.push({ id: newId(), target: { ...entry.target }, valueType: entry.valueType, keys: [] });
  }
  if (tracks.length === object.tracks.length) return withObject;
  return { ...withObject, objects: withObject.objects.map((entry) => (entry === object ? { ...object, tracks } : entry)) };
}

export function removeTimelineObject(clip: SerializedTimelineClip, objectId: string): SerializedTimelineClip {
  const objects = clip.objects.filter((object) => object.id !== objectId);
  return objects.length === clip.objects.length ? clip : { ...clip, objects };
}

export function removeTimelineTrack(clip: SerializedTimelineClip, trackId: string): SerializedTimelineClip {
  let changed = false;
  const objects = clip.objects.map((object) => {
    const tracks = object.tracks.filter((track) => track.id !== trackId);
    if (tracks.length === object.tracks.length) return object;
    changed = true;
    return { ...object, tracks };
  });
  return changed ? { ...clip, objects } : clip;
}

export function setTimelineTrackMuted(clip: SerializedTimelineClip, trackId: string, muted: boolean): SerializedTimelineClip {
  return mapTracks(clip, (track) => {
    if (track.id !== trackId || (track.muted === true) === muted) return track;
    const next = { ...track };
    if (muted) next.muted = true;
    else delete next.muted;
    return next;
  });
}

/**
 * Sets a key on each track at its time: a key already on that frame takes the
 * new value and keeps its interpolation, otherwise a new key is added.
 */
export function setTimelineKeys(
  clip: SerializedTimelineClip,
  keys: ReadonlyArray<{ trackId: string; time: number; value: unknown }>,
  newId: NewId,
): SerializedTimelineClip {
  const byTrack = new Map<string, Array<{ time: number; value: unknown }>>();
  for (const key of keys) byTrack.set(key.trackId, [...(byTrack.get(key.trackId) ?? []), key]);
  return mapTracks(clip, (track) => {
    const entries = byTrack.get(track.id);
    if (!entries) return track;
    const next = [...track.keys];
    for (const { time, value } of entries) {
      const index = next.findIndex((key) => sameFrame(key.Time, time, clip.frameRate));
      if (index >= 0) next[index] = { ...next[index]!, Value: structuredClone(value) };
      else next.push({ id: newId(), Time: time, Value: structuredClone(value), Interpolation: "auto", ArriveTangent: 0, LeaveTangent: 0 });
    }
    return { ...track, keys: sortKeys(next) };
  });
}

export function deleteTimelineKeys(clip: SerializedTimelineClip, refs: readonly TrackKeyRef[]): SerializedTimelineClip {
  if (refs.length === 0) return clip;
  const ids = new Set(refs.map((ref) => `${ref.trackId}\u0000${ref.keyId}`));
  return mapTracks(clip, (track) => {
    const keys = track.keys.filter((key) => !ids.has(`${track.id}\u0000${key.id}`));
    return keys.length === track.keys.length ? track : { ...track, keys };
  });
}

/** The keys `refs` name, with their tracks, as they are now: the start of a drag. */
export function snapshotTimelineKeys(clip: SerializedTimelineClip, refs: readonly TrackKeyRef[]): Map<string, TimelineKey[]> {
  const wanted = new Set(refs.map((ref) => `${ref.trackId}\u0000${ref.keyId}`));
  const snapshot = new Map<string, TimelineKey[]>();
  for (const object of clip.objects) {
    for (const track of object.tracks) {
      const keys = track.keys.filter((key) => wanted.has(`${track.id}\u0000${key.id}`));
      if (keys.length) snapshot.set(track.id, keys);
    }
  }
  return snapshot;
}

/** The shift that keeps every snapshot key inside the clip. */
export function clampTimelineKeyShift(snapshot: ReadonlyMap<string, readonly TimelineKey[]>, delta: number, length: number): number {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const keys of snapshot.values()) {
    for (const key of keys) {
      earliest = Math.min(earliest, key.Time);
      latest = Math.max(latest, key.Time);
    }
  }
  if (!Number.isFinite(earliest)) return 0;
  return Math.min(length - latest, Math.max(-earliest, delta));
}

/**
 * `base` (the clip when the drag started) with the snapshot keys shifted by
 * `delta` seconds. A moved key replaces an unmoved key it lands on.
 */
export function shiftTimelineKeys(
  base: SerializedTimelineClip,
  snapshot: ReadonlyMap<string, readonly TimelineKey[]>,
  delta: number,
): SerializedTimelineClip {
  const shift = clampTimelineKeyShift(snapshot, delta, base.length);
  if (shift === 0) return base;
  return mapTracks(base, (track) => {
    const moving = snapshot.get(track.id);
    if (!moving) return track;
    const movingIds = new Set(moving.map((key) => key.id));
    const moved = moving.map((key) => ({ ...key, Time: Number((key.Time + shift).toFixed(6)) }));
    const kept = track.keys.filter((key) => !movingIds.has(key.id)
      && !moved.some((entry) => sameFrame(entry.Time, key.Time, base.frameRate)));
    return { ...track, keys: sortKeys([...kept, ...moved]) };
  });
}

export interface CopiedTimelineKeys {
  /** Seconds of the earliest copied key; pasting puts it at the playhead. */
  origin: number;
  tracks: Array<{ trackId: string; target: TimelinePropertyTrack["target"]; actorId: string; keys: TimelineKey[] }>;
}

export function copyTimelineKeys(clip: SerializedTimelineClip, refs: readonly TrackKeyRef[]): CopiedTimelineKeys | null {
  const snapshot = snapshotTimelineKeys(clip, refs);
  if (snapshot.size === 0) return null;
  const tracks: CopiedTimelineKeys["tracks"] = [];
  let origin = Number.POSITIVE_INFINITY;
  for (const object of clip.objects) {
    for (const track of object.tracks) {
      const keys = snapshot.get(track.id);
      if (!keys) continue;
      origin = Math.min(origin, ...keys.map((key) => key.Time));
      tracks.push({ trackId: track.id, target: track.target, actorId: object.actorId, keys: structuredClone(keys) });
    }
  }
  return { origin, tracks };
}

/**
 * Pastes copied keys at `time` onto the tracks they came from, or onto the
 * same property of the same actor in this clip. Keys past the clip's end are
 * dropped. Returns the clip and the pasted keys.
 */
export function pasteTimelineKeys(
  clip: SerializedTimelineClip,
  copied: CopiedTimelineKeys,
  time: number,
  newId: NewId,
): { clip: SerializedTimelineClip; pasted: TrackKeyRef[] } {
  const pasted: TrackKeyRef[] = [];
  const byTrack = new Map<string, TimelineKey[]>();
  for (const source of copied.tracks) {
    const target = findTimelineTrack(clip, source.trackId)?.track
      ?? clip.objects.find((object) => object.actorId === source.actorId)?.tracks
        .find((track) => timelineTargetKey(track.target) === timelineTargetKey(source.target));
    if (!target) continue;
    const keys = source.keys
      .map((key) => ({ ...structuredClone(key), id: newId(), Time: Number((key.Time - copied.origin + time).toFixed(6)) }))
      .filter((key) => key.Time >= 0 && key.Time <= clip.length + 1e-9);
    if (keys.length) byTrack.set(target.id, [...(byTrack.get(target.id) ?? []), ...keys]);
  }
  const next = mapTracks(clip, (track) => {
    const added = byTrack.get(track.id);
    if (!added) return track;
    const kept = track.keys.filter((key) => !added.some((entry) => sameFrame(entry.Time, key.Time, clip.frameRate)));
    for (const key of added) pasted.push({ trackId: track.id, keyId: key.id });
    return { ...track, keys: sortKeys([...kept, ...added]) };
  });
  return { clip: next, pasted };
}

/** Every key time in the clip (or in `trackIds`), sorted and without repeats on one frame. */
export function timelineKeyTimes(clip: SerializedTimelineClip, trackIds?: ReadonlySet<string>): number[] {
  const times: number[] = [];
  for (const object of clip.objects) {
    for (const track of object.tracks) {
      if (trackIds && !trackIds.has(track.id)) continue;
      for (const key of track.keys) times.push(key.Time);
    }
  }
  times.sort((a, b) => a - b);
  return times.filter((value, index) => index === 0 || !sameFrame(value, times[index - 1]!, clip.frameRate));
}

/** The next key time after `time` (or before it, going back), if any. */
export function adjacentTimelineKeyTime(times: readonly number[], time: number, direction: 1 | -1, frameRate: number): number | undefined {
  const epsilon = 0.5 / Math.max(1, frameRate);
  if (direction > 0) return times.find((value) => value > time + epsilon);
  for (let index = times.length - 1; index >= 0; index--) if (times[index]! < time - epsilon) return times[index];
  return undefined;
}

/** The key on `time`'s frame, if the track has one. */
export function timelineKeyAt(track: TimelinePropertyTrack, time: number, frameRate: number): TimelineKey | undefined {
  return track.keys.find((key) => sameFrame(key.Time, time, frameRate));
}

/** What a new key on `track` at `time` records: the track's value there, or `authored` when it has no keys. */
export function timelineKeyValueAt(track: TimelinePropertyTrack, time: number, authored: unknown): unknown {
  const value = evaluateTimelineTrack(track, time);
  return value === undefined ? authored : value;
}

/** Sets the interpolation of each key `refs` names (it shapes the move to the next key). */
export function setTimelineKeyInterpolation(
  clip: SerializedTimelineClip,
  refs: readonly TrackKeyRef[],
  interpolation: TimelineKey["Interpolation"],
): SerializedTimelineClip {
  const ids = new Set(refs.map((ref) => `${ref.trackId}\u0000${ref.keyId}`));
  return mapTracks(clip, (track) => {
    if (!track.keys.some((key) => ids.has(`${track.id}\u0000${key.id}`) && key.Interpolation !== interpolation)) return track;
    return { ...track, keys: track.keys.map((key) => (ids.has(`${track.id}\u0000${key.id}`) ? { ...key, Interpolation: interpolation } : key)) };
  });
}

/** Changes one key's value. */
export function setTimelineKeyValue(clip: SerializedTimelineClip, ref: TrackKeyRef, value: unknown): SerializedTimelineClip {
  return mapTracks(clip, (track) => {
    if (track.id !== ref.trackId) return track;
    const index = track.keys.findIndex((key) => key.id === ref.keyId);
    if (index < 0) return track;
    const keys = [...track.keys];
    keys[index] = { ...keys[index]!, Value: structuredClone(value) };
    return { ...track, keys };
  });
}

/** Moves one key to `time` (kept inside the clip); it replaces a key already on that frame. */
export function setTimelineKeyTime(clip: SerializedTimelineClip, ref: TrackKeyRef, time: number): SerializedTimelineClip {
  const key = findTimelineTrack(clip, ref.trackId)?.track.keys.find((entry) => entry.id === ref.keyId);
  if (!key) return clip;
  return shiftTimelineKeys(clip, new Map([[ref.trackId, [key]]]), time - key.Time);
}

/** Moves a track one place up or down among its object's tracks, or an object among the clip's. */
export function moveTimelineRow(clip: SerializedTimelineClip, rowId: string, direction: -1 | 1): SerializedTimelineClip {
  const swap = <T>(list: readonly T[], index: number): T[] | null => {
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return null;
    const next = [...list];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  };
  const objectIndex = clip.objects.findIndex((object) => object.id === rowId);
  if (objectIndex >= 0) {
    const objects = swap(clip.objects, objectIndex);
    return objects ? { ...clip, objects } : clip;
  }
  for (const object of clip.objects) {
    const tracks = swap(object.tracks, object.tracks.findIndex((track) => track.id === rowId));
    if (tracks) return { ...clip, objects: clip.objects.map((entry) => (entry === object ? { ...object, tracks } : entry)) };
  }
  return clip;
}

/** Every key of a track, or of every track of an object. */
export function timelineRowKeyRefs(clip: SerializedTimelineClip, rowId: string): TrackKeyRef[] {
  const object = clip.objects.find((entry) => entry.id === rowId);
  const tracks = object ? object.tracks : [findTimelineTrack(clip, rowId)?.track].filter((track) => track !== undefined);
  return tracks.flatMap((track) => track.keys.map((key) => ({ trackId: track.id, keyId: key.id })));
}

export interface CopiedTimelineTrack {
  target: TimelinePropertyTrack["target"];
  valueType: TimelineValueType;
  /** The component's class, so a component track pastes onto a component of the same class. */
  componentClassId?: string;
  keys: TimelineKey[];
}

/**
 * Pastes a copied track onto an object: onto its track for the same property,
 * replacing that track's keys, or as a new track when the actor has the
 * property. A component track lands on the actor's first component of the
 * copied class. Null when the actor cannot take it.
 */
export function pasteTimelineTrack(
  clip: SerializedTimelineClip,
  objectId: string,
  copied: CopiedTimelineTrack,
  actor: { components: ReadonlyArray<{ id: string; classId: string }> },
  newId: NewId,
): SerializedTimelineClip | null {
  const object = clip.objects.find((entry) => entry.id === objectId);
  if (!object) return null;
  let target = copied.target;
  if (target.kind === "component") {
    const component = actor.components.find((entry) => entry.id === target.componentId && (!copied.componentClassId || entry.classId === copied.componentClassId))
      ?? actor.components.find((entry) => entry.classId === copied.componentClassId);
    if (!component) return null;
    target = { ...target, componentId: component.id };
  }
  const keys = copied.keys
    .filter((key) => key.Time <= clip.length + 1e-9)
    .map((key) => ({ ...structuredClone(key), id: newId() }));
  const existing = object.tracks.find((track) => timelineTargetKey(track.target) === timelineTargetKey(target));
  const tracks = existing
    ? object.tracks.map((track) => (track === existing ? { ...track, keys } : track))
    : [...object.tracks, { id: newId(), target, valueType: copied.valueType, keys }];
  return { ...clip, objects: clip.objects.map((entry) => (entry === object ? { ...object, tracks } : entry)) };
}
