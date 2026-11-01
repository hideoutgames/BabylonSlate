import {
  uniqueTimelineClipName,
  type GraphClassMemberPin,
  type SerializedScene,
  type SerializedTimelineClip,
  type TimelineEventTrack,
} from "@haptic/core";
import { frameAt } from "@haptic/editor-kit";
import { TIMELINE_CLIP_BUILT_IN_DISPATCHERS, isTimelineClipClassId } from "@haptic/object-model";
import { defaultValueForMember } from "@haptic/scripting";
import { syncDispatcher } from "./class-members";
import { copyTimelineKeys, pasteTimelineKeys, type CopiedTimelineKeys, type NewId, type TrackKeyRef } from "./timeline-track-edits";

/**
 * Pure edits of a clip's Custom Event Tracks: each declares one Event
 * Dispatcher on the clip's class, and its keys fire it with their values.
 */

/** The Timeline window's row that sums every event track's keys. */
export const TIMELINE_EVENTS_ROW_ID = "timeline:events";

/** Input types a key can hold a value of; the Inspector edits them per key. */
export const TIMELINE_EVENT_INPUT_TYPES = ["bool", "int", "float", "string", "vec2", "vec3", "rotator", "color"] as const;

export type TimelineEventKey = TimelineEventTrack["keys"][number];

export function findTimelineEventTrack(clip: SerializedTimelineClip, trackId: string): TimelineEventTrack | undefined {
  return clip.eventTracks.find((track) => track.id === trackId);
}

function mapEventTracks(clip: SerializedTimelineClip, map: (track: TimelineEventTrack) => TimelineEventTrack): SerializedTimelineClip {
  let changed = false;
  const eventTracks = clip.eventTracks.map((track) => {
    const next = map(track);
    if (next !== track) changed = true;
    return next;
  });
  return changed ? { ...clip, eventTracks } : clip;
}

const sortKeys = (keys: TimelineEventKey[]) => keys.sort((a, b) => a.time - b.time);

/** A name no other track of the clip, and no built-in event, uses. */
export function uniqueTimelineEventName(clip: SerializedTimelineClip, name: string, exceptTrackId?: string): string {
  const taken = [
    ...TIMELINE_CLIP_BUILT_IN_DISPATCHERS,
    ...clip.eventTracks.filter((track) => track.id !== exceptTrackId).map((track) => track.name),
  ];
  return uniqueTimelineClipName(name.trim() || "On Event", taken);
}

export function addTimelineEventTrack(clip: SerializedTimelineClip, newId: NewId): { clip: SerializedTimelineClip; trackId: string } {
  const trackId = newId();
  const track: TimelineEventTrack = { id: trackId, name: uniqueTimelineEventName(clip, "On Event"), inputs: [], keys: [] };
  return { clip: { ...clip, eventTracks: [...clip.eventTracks, track] }, trackId };
}

export function renameTimelineEventTrack(clip: SerializedTimelineClip, trackId: string, name: string): SerializedTimelineClip {
  return mapEventTracks(clip, (track) => {
    if (track.id !== trackId) return track;
    const next = uniqueTimelineEventName(clip, name, trackId);
    return next === track.name ? track : { ...track, name: next };
  });
}

/** New inputs; keys keep the values of inputs that are still there under the same name and type. */
export function setTimelineEventTrackInputs(
  clip: SerializedTimelineClip,
  trackId: string,
  inputs: readonly GraphClassMemberPin[],
): SerializedTimelineClip {
  return mapEventTracks(clip, (track) => {
    if (track.id !== trackId) return track;
    const kept = new Set(inputs.filter((input) =>
      track.inputs.some((previous) => previous.name === input.name && previous.typeId === input.typeId)).map((input) => input.name));
    return {
      ...track,
      inputs: inputs.map((input) => ({ ...input, direction: "in" as const })),
      keys: track.keys.map((key) => ({
        ...key,
        values: Object.fromEntries(Object.entries(key.values).filter(([name]) => kept.has(name))),
      })),
    };
  });
}

export function removeTimelineEventTrack(clip: SerializedTimelineClip, trackId: string): SerializedTimelineClip {
  return clip.eventTracks.some((track) => track.id === trackId)
    ? { ...clip, eventTracks: clip.eventTracks.filter((track) => track.id !== trackId) }
    : clip;
}

export function moveTimelineEventTrack(clip: SerializedTimelineClip, trackId: string, direction: -1 | 1): SerializedTimelineClip {
  const index = clip.eventTracks.findIndex((track) => track.id === trackId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= clip.eventTracks.length) return clip;
  const eventTracks = [...clip.eventTracks];
  [eventTracks[index], eventTracks[target]] = [eventTracks[target]!, eventTracks[index]!];
  return { ...clip, eventTracks };
}

/** The key on `time`'s frame, if any. */
export function timelineEventKeyAt(track: TimelineEventTrack, time: number, frameRate: number): TimelineEventKey | undefined {
  const frame = frameAt(time, frameRate);
  return track.keys.find((key) => frameAt(key.time, frameRate) === frame);
}

/** Adds a key at `time` to each track; a key already on that frame stays. */
export function setTimelineEventKeys(
  clip: SerializedTimelineClip,
  trackIds: readonly string[],
  time: number,
  newId: NewId,
): { clip: SerializedTimelineClip; added: TrackKeyRef[] } {
  const added: TrackKeyRef[] = [];
  const next = mapEventTracks(clip, (track) => {
    if (!trackIds.includes(track.id) || timelineEventKeyAt(track, time, clip.frameRate)) return track;
    const key: TimelineEventKey = { id: newId(), time, values: {} };
    added.push({ trackId: track.id, keyId: key.id });
    return { ...track, keys: sortKeys([...track.keys, key]) };
  });
  return { clip: next, added };
}

/** The diamond on an event track's row: removes the key on the playhead's frame, or adds one. */
export function toggleTimelineEventKey(clip: SerializedTimelineClip, trackId: string, time: number, newId: NewId): SerializedTimelineClip {
  const track = findTimelineEventTrack(clip, trackId);
  if (!track) return clip;
  const existing = timelineEventKeyAt(track, time, clip.frameRate);
  return existing ? deleteTimelineEventKeys(clip, [{ trackId, keyId: existing.id }]) : setTimelineEventKeys(clip, [trackId], time, newId).clip;
}

export function deleteTimelineEventKeys(clip: SerializedTimelineClip, refs: readonly TrackKeyRef[]): SerializedTimelineClip {
  const wanted = new Set(refs.map((ref) => `${ref.trackId}\u0000${ref.keyId}`));
  return mapEventTracks(clip, (track) => {
    const keys = track.keys.filter((key) => !wanted.has(`${track.id}\u0000${key.id}`));
    return keys.length === track.keys.length ? track : { ...track, keys };
  });
}

/** Every key of the clip's event tracks, for the Events row and Select All. */
export function timelineEventKeyRefs(clip: SerializedTimelineClip, trackId?: string): TrackKeyRef[] {
  return clip.eventTracks
    .filter((track) => trackId === undefined || track.id === trackId)
    .flatMap((track) => track.keys.map((key) => ({ trackId: track.id, keyId: key.id })));
}

export function timelineEventKeyTimes(clip: SerializedTimelineClip): number[] {
  return clip.eventTracks.flatMap((track) => track.keys.map((key) => key.time));
}

export function snapshotTimelineEventKeys(clip: SerializedTimelineClip, refs: readonly TrackKeyRef[]): Map<string, TimelineEventKey[]> {
  const wanted = new Set(refs.map((ref) => `${ref.trackId}\u0000${ref.keyId}`));
  const snapshot = new Map<string, TimelineEventKey[]>();
  for (const track of clip.eventTracks) {
    const keys = track.keys.filter((key) => wanted.has(`${track.id}\u0000${key.id}`));
    if (keys.length) snapshot.set(track.id, keys);
  }
  return snapshot;
}

/** The shift that keeps every snapshot key inside the clip. */
export function clampTimelineEventKeyShift(snapshot: ReadonlyMap<string, readonly TimelineEventKey[]>, delta: number, length: number): number {
  const times = [...snapshot.values()].flat().map((key) => key.time);
  if (times.length === 0) return delta;
  return Math.min(length - Math.max(...times), Math.max(-Math.min(...times), delta));
}

/** `base` with the snapshot keys moved by `delta` seconds; a moved key replaces an unmoved one on its frame. */
export function shiftTimelineEventKeys(
  base: SerializedTimelineClip,
  snapshot: ReadonlyMap<string, readonly TimelineEventKey[]>,
  delta: number,
): SerializedTimelineClip {
  const shift = clampTimelineEventKeyShift(snapshot, delta, base.length);
  if (shift === 0 || snapshot.size === 0) return base;
  return mapEventTracks(base, (track) => {
    const moving = snapshot.get(track.id);
    if (!moving) return track;
    const movingIds = new Set(moving.map((key) => key.id));
    const moved = moving.map((key) => ({ ...key, time: Number((key.time + shift).toFixed(6)) }));
    const frames = new Set(moved.map((key) => frameAt(key.time, base.frameRate)));
    const kept = track.keys.filter((key) => !movingIds.has(key.id) && !frames.has(frameAt(key.time, base.frameRate)));
    return { ...track, keys: sortKeys([...kept, ...moved]) };
  });
}

export function setTimelineEventKeyTime(clip: SerializedTimelineClip, ref: TrackKeyRef, time: number): SerializedTimelineClip {
  const track = findTimelineEventTrack(clip, ref.trackId);
  const key = track?.keys.find((entry) => entry.id === ref.keyId);
  if (!track || !key) return clip;
  return shiftTimelineEventKeys(clip, new Map([[track.id, [key]]]), Math.min(clip.length, Math.max(0, time)) - key.time);
}

export function setTimelineEventKeyValue(clip: SerializedTimelineClip, ref: TrackKeyRef, input: string, value: unknown): SerializedTimelineClip {
  return mapEventTracks(clip, (track) => track.id !== ref.trackId ? track : {
    ...track,
    keys: track.keys.map((key) => key.id === ref.keyId ? { ...key, values: { ...key.values, [input]: value } } : key),
  });
}

/** A key's value for an input: what it stores, else the input type's default, as Play passes it. */
export function timelineEventKeyValue(key: TimelineEventKey, input: GraphClassMemberPin): unknown {
  return Object.hasOwn(key.values, input.name) ? key.values[input.name] : defaultValueForMember(input.typeId, input.typeClassId);
}

/**
 * The document's script after a Custom Event Track was renamed or its inputs
 * changed: Bind and Unbind nodes on that clip's dispatcher, and the custom
 * events wired to them, take the new name and inputs.
 */
export function syncTimelineEventDispatcher(
  scene: SerializedScene,
  clipId: string,
  previousName: string,
  track: TimelineEventTrack,
): SerializedScene {
  const script = scene.script;
  if (!script) return scene;
  const nodes = [...script.nodes, ...Object.values(script.functionGraphs ?? {}).flatMap((slice) => slice.nodes)];
  const classIds = new Set(nodes.flatMap((node) => {
    const classId = typeof node.data.classId === "string" ? node.data.classId : "";
    return node.data.name === previousName && isTimelineClipClassId(classId) && classId.endsWith(`:${clipId}`) ? [classId] : [];
  }));
  let next = script;
  for (const classId of classIds) {
    next = syncDispatcher(next, previousName, { id: track.id, kind: "dispatcher", name: track.name, pins: track.inputs }, classId);
  }
  return next === script ? scene : { ...scene, script: next };
}

/**
 * Copy of the selected property and event keys; the earliest of either is
 * the paste origin.
 */
export function copyTimelineSelectedKeys(clip: SerializedTimelineClip, refs: readonly TrackKeyRef[]): CopiedTimelineKeys | null {
  const properties = copyTimelineKeys(clip, refs);
  const events = [...snapshotTimelineEventKeys(clip, refs)].map(([trackId, keys]) => ({
    trackId, name: findTimelineEventTrack(clip, trackId)?.name ?? "", keys: structuredClone(keys),
  }));
  if (!properties && events.length === 0) return null;
  const origin = Math.min(properties?.origin ?? Number.POSITIVE_INFINITY, ...events.flatMap((track) => track.keys.map((key) => key.time)));
  return { origin, tracks: properties?.tracks ?? [], ...(events.length ? { events } : {}) };
}

/**
 * Pastes copied keys at `time`: property keys as `pasteTimelineKeys` does,
 * event keys onto the event track they came from or one of this clip with
 * the same name, keeping the values of inputs it still has. A pasted key
 * replaces one on its frame; keys past the clip's end are dropped.
 */
export function pasteTimelineSelectedKeys(
  clip: SerializedTimelineClip,
  copied: CopiedTimelineKeys,
  time: number,
  newId: NewId,
): { clip: SerializedTimelineClip; pasted: TrackKeyRef[] } {
  const { clip: withProperties, pasted } = pasteTimelineKeys(clip, copied, time, newId);
  const byTrack = new Map<string, TimelineEventKey[]>();
  for (const source of copied.events ?? []) {
    const target = findTimelineEventTrack(withProperties, source.trackId)
      ?? withProperties.eventTracks.find((track) => track.name === source.name);
    if (!target) continue;
    const inputs = new Set(target.inputs.map((input) => input.name));
    const keys = source.keys
      .map((key) => ({
        id: newId(),
        time: Number((key.time - copied.origin + time).toFixed(6)),
        values: Object.fromEntries(Object.entries(structuredClone(key.values)).filter(([name]) => inputs.has(name))),
      }))
      .filter((key) => key.time >= 0 && key.time <= clip.length + 1e-9);
    if (keys.length) byTrack.set(target.id, [...(byTrack.get(target.id) ?? []), ...keys]);
  }
  const next = mapEventTracks(withProperties, (track) => {
    const added = byTrack.get(track.id);
    if (!added) return track;
    const frames = new Set(added.map((key) => frameAt(key.time, clip.frameRate)));
    for (const key of added) pasted.push({ trackId: track.id, keyId: key.id });
    return { ...track, keys: sortKeys([...track.keys.filter((key) => !frames.has(frameAt(key.time, clip.frameRate))), ...added]) };
  });
  return { clip: next, pasted };
}
