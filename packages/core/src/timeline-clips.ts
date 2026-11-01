import { parseCurveInterpolation, type CurveKey } from "./curves";
import type { GraphClassMemberPin } from "./project";

/**
 * Timeline Clips authored in a Scene or Scene Layer (`timelineClips` beside
 * `script`). Key editing and playback build on this shape; the field is
 * additive, so documents without it stay valid.
 */
export const TIMELINE_FRAME_RATES = [24, 25, 30, 48, 50, 60] as const;
export type TimelineFrameRate = (typeof TIMELINE_FRAME_RATES)[number];
export const TIMELINE_LOOP_MODES = ["once", "loop", "pingPong"] as const;
export type TimelineLoopMode = (typeof TIMELINE_LOOP_MODES)[number];
export const TIMELINE_LOOP_MODE_LABELS: Record<TimelineLoopMode, string> = { once: "Once", loop: "Loop", pingPong: "Ping Pong" };
/** Set Timeline Clip Loop Mode's enum; its members are the labels. */
export const ENGINE_TIMELINE_LOOP_MODE_ENUM_ID = "engine:TimelineLoopMode";

/** A loop mode from its id, its label (an enum value) or its member index; undefined otherwise. */
export function parseTimelineLoopMode(value: unknown): TimelineLoopMode | undefined {
  if (typeof value === "number") return TIMELINE_LOOP_MODES[value];
  if (typeof value !== "string") return undefined;
  return TIMELINE_LOOP_MODES.find((mode) => mode === value || TIMELINE_LOOP_MODE_LABELS[mode] === value);
}
export type TimelineWhenFinished = "keep" | "restore";

export const DEFAULT_TIMELINE_CLIP_LENGTH = 5;
export const DEFAULT_TIMELINE_FRAME_RATE: TimelineFrameRate = 30;
/** Shortest clip Length, in seconds. */
export const MIN_TIMELINE_CLIP_LENGTH = 0.1;

/** One key: the shared curve key format (`curves.ts`) plus a stable id. */
export interface TimelineKey extends CurveKey<unknown> {
  id: string;
}

export type TimelineValueType = "float" | "int" | "bool" | "vec2" | "vec3" | "rotator" | "color" | "string" | "enum" | "asset";

export interface TimelinePropertyTrack {
  id: string;
  target: { kind: "transform" | "visible" | "variable" | "component"; componentId?: string; property: string };
  valueType: TimelineValueType;
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
    return [{
      id,
      Time: key.Time,
      Value: key.Value,
      Interpolation: parseCurveInterpolation(key.Interpolation),
      ArriveTangent: key.ArriveTangent ?? 0,
      LeaveTangent: key.LeaveTangent ?? 0,
    }];
  });
  return keys.sort((a, b) => a.Time - b.Time);
}

const VALUE_TYPE_FOR_TYPE_ID: Readonly<Record<string, TimelineValueType>> = {
  float: "float", number: "float", int: "int", bool: "bool", boolean: "bool", string: "string",
  vec2: "vec2", vec3: "vec3", rotator: "rotator", color: "color", enum: "enum", asset: "asset",
};

/** The track value type for a variable or property type id, or undefined when tracks cannot animate it. */
export function timelineValueTypeFor(typeId: string | undefined): TimelineValueType | undefined {
  return typeId ? VALUE_TYPE_FOR_TYPE_ID[typeId] : undefined;
}

/** A key value of `valueType` for a property that has no value: zero, false, empty or white. */
export function defaultTimelineValue(valueType: TimelineValueType): unknown {
  switch (valueType) {
    case "float": case "int": return 0;
    case "bool": return false;
    case "vec2": return { x: 0, y: 0 };
    case "vec3": return { x: 0, y: 0, z: 0 };
    case "rotator": return { pitch: 0, yaw: 0, roll: 0 };
    case "color": return { x: 1, y: 1, z: 1, w: 1 };
    case "asset": return null;
    default: return "";
  }
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
