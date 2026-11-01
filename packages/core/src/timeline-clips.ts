import type { GraphClassMemberPin } from "./project";

/**
 * Timeline Clips authored in a Scene or Scene Layer (`timelineClips` beside
 * `script`). Key editing and playback build on this shape; the field is
 * additive, so documents without it stay valid.
 */
export const TIMELINE_FRAME_RATES = [24, 25, 30, 48, 50, 60] as const;
export type TimelineFrameRate = (typeof TIMELINE_FRAME_RATES)[number];
export type TimelineLoopMode = "once" | "loop" | "pingPong";
export type TimelineWhenFinished = "keep" | "restore";

export const DEFAULT_TIMELINE_CLIP_LENGTH = 5;
export const DEFAULT_TIMELINE_FRAME_RATE: TimelineFrameRate = 30;
/** Shortest clip Length, in seconds. */
export const MIN_TIMELINE_CLIP_LENGTH = 0.1;

/** One key: the shared curve key fields plus a stable id. */
export interface TimelineKey {
  id: string;
  Time: number;
  Value: unknown;
  Interpolation: string;
  ArriveTangent?: unknown;
  LeaveTangent?: unknown;
}

export interface TimelinePropertyTrack {
  id: string;
  target: { kind: "transform" | "visible" | "variable" | "component"; componentId?: string; property: string };
  valueType: "float" | "int" | "bool" | "vec2" | "vec3" | "rotator" | "color" | "string" | "enum" | "asset";
  muted?: boolean;
  /** Sorted by Time. */
  keys: TimelineKey[];
}

export interface TimelineObjectTrack {
  id: string;
  /** The animated actor's id in the owning document. */
  actorId: string;
  tracks: TimelinePropertyTrack[];
}

export interface TimelineEventTrack {
  id: string;
  /** The Event Dispatcher the track declares, such as `On Door Open`. */
  name: string;
  inputs: GraphClassMemberPin[];
  keys: Array<{ id: string; time: number; values: Record<string, unknown> }>;
}

export interface SerializedTimelineClip {
  /** Stable; survives renames. */
  id: string;
  /** Unique within the document. */
  name: string;
  /** Seconds. */
  length: number;
  frameRate: TimelineFrameRate;
  playRate: number;
  loopMode: TimelineLoopMode;
  autoPlay: boolean;
  whenFinished: TimelineWhenFinished;
  /** Bound Timeline Asset guid. */
  timelineAsset?: string;
  objects: TimelineObjectTrack[];
  eventTracks: TimelineEventTrack[];
}

/** A new, empty clip. */
export function createTimelineClip(id: string, name: string): SerializedTimelineClip {
  return {
    id,
    name,
    length: DEFAULT_TIMELINE_CLIP_LENGTH,
    frameRate: DEFAULT_TIMELINE_FRAME_RATE,
    playRate: 1,
    loopMode: "once",
    autoPlay: false,
    whenFinished: "keep",
    objects: [],
    eventTracks: [],
  };
}

/**
 * `base` when no clip in `taken` has it, else `base 2`, `base 3` and so on
 * (a trailing number on `base` is replaced, so copying `Intro 2` gives `Intro 3`).
 */
export function uniqueTimelineClipName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const trimmed = base.trim() || "Timeline Clip";
  if (!used.has(trimmed)) return trimmed;
  const stem = trimmed.replace(/\s+\d+$/, "") || trimmed;
  let index = 2;
  while (used.has(`${stem} ${index}`)) index += 1;
  return `${stem} ${index}`;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function normalizeKeys(value: unknown): TimelineKey[] {
  if (!Array.isArray(value)) return [];
  const keys = value.flatMap((entry): TimelineKey[] => {
    const key = record(entry);
    const id = text(key.id);
    if (!id || typeof key.Time !== "number" || !Number.isFinite(key.Time)) return [];
    return [{ ...(key as unknown as TimelineKey), id, Interpolation: text(key.Interpolation) ?? "linear" }];
  });
  return keys.sort((a, b) => a.Time - b.Time);
}

const TRACK_TARGETS = new Set(["transform", "visible", "variable", "component"]);
const VALUE_TYPES = new Set(["float", "int", "bool", "vec2", "vec3", "rotator", "color", "string", "enum", "asset"]);

function normalizeObjectTracks(value: unknown): TimelineObjectTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TimelineObjectTrack[] => {
    const object = record(entry);
    const id = text(object.id);
    const actorId = text(object.actorId);
    if (!id || !actorId) return [];
    const tracks = (Array.isArray(object.tracks) ? object.tracks : []).flatMap((raw): TimelinePropertyTrack[] => {
      const track = record(raw);
      const target = record(track.target);
      const trackId = text(track.id);
      const property = text(target.property);
      if (!trackId || !property || !TRACK_TARGETS.has(String(target.kind)) || !VALUE_TYPES.has(String(track.valueType))) return [];
      const componentId = text(target.componentId);
      return [{
        id: trackId,
        target: { kind: target.kind as TimelinePropertyTrack["target"]["kind"], ...(componentId ? { componentId } : {}), property },
        valueType: track.valueType as TimelinePropertyTrack["valueType"],
        ...(track.muted === true ? { muted: true } : {}),
        keys: normalizeKeys(track.keys),
      }];
    });
    return [{ id, actorId, tracks }];
  });
}

function normalizeEventTracks(value: unknown): TimelineEventTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TimelineEventTrack[] => {
    const track = record(entry);
    const id = text(track.id);
    const name = text(track.name);
    if (!id || !name) return [];
    const keys = (Array.isArray(track.keys) ? track.keys : []).flatMap((raw) => {
      const key = record(raw);
      const keyId = text(key.id);
      return keyId && typeof key.time === "number" && Number.isFinite(key.time)
        ? [{ id: keyId, time: key.time, values: { ...record(key.values) } }]
        : [];
    }).sort((a, b) => a.time - b.time);
    return [{ id, name, inputs: Array.isArray(track.inputs) ? (track.inputs as GraphClassMemberPin[]) : [], keys }];
  });
}

/** One clip, or undefined when it has no usable id. Names are made unique by `normalizeTimelineClips`. */
export function normalizeTimelineClip(value: unknown): SerializedTimelineClip | undefined {
  const source = record(value);
  const id = text(source.id);
  if (!id) return undefined;
  const frameRate = (TIMELINE_FRAME_RATES as readonly number[]).includes(source.frameRate as number)
    ? (source.frameRate as TimelineFrameRate)
    : DEFAULT_TIMELINE_FRAME_RATE;
  const timelineAsset = text(source.timelineAsset);
  return {
    id,
    name: text(source.name) ?? "Timeline Clip",
    length: Math.max(MIN_TIMELINE_CLIP_LENGTH, finite(source.length, DEFAULT_TIMELINE_CLIP_LENGTH)),
    frameRate,
    playRate: Math.max(0, finite(source.playRate, 1)),
    loopMode: source.loopMode === "loop" || source.loopMode === "pingPong" ? source.loopMode : "once",
    autoPlay: source.autoPlay === true,
    whenFinished: source.whenFinished === "restore" ? "restore" : "keep",
    ...(timelineAsset ? { timelineAsset } : {}),
    objects: normalizeObjectTracks(source.objects),
    eventTracks: normalizeEventTracks(source.eventTracks),
  };
}

/**
 * A document's clips: invalid entries and repeated ids dropped, names made
 * unique in order. Undefined when there are none, so the field stays absent.
 */
export function normalizeTimelineClips(value: unknown): SerializedTimelineClip[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const names = new Set<string>();
  const clips: SerializedTimelineClip[] = [];
  for (const entry of value) {
    const clip = normalizeTimelineClip(entry);
    if (!clip || ids.has(clip.id)) continue;
    ids.add(clip.id);
    clip.name = uniqueTimelineClipName(clip.name, names);
    names.add(clip.name);
    clips.push(clip);
  }
  return clips.length > 0 ? clips : undefined;
}
