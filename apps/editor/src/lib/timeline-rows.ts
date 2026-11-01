import type {
  CurveInterpolation,
  SerializedActor,
  SerializedScene,
  SerializedTimelineClip,
  TimelineObjectTrack,
  TimelinePropertyTrack,
  TimelineValueType,
} from "@haptic/core";
import { frameAt, keyRefId, type KeyRef, type KeyframeShape } from "@haptic/editor-kit";
import {
  authoredTimelineValue,
  timelineComponentLabel,
  timelinePropertyGroups,
  timelineTargetKey,
  type TimelinePropertyContext,
} from "./timeline-property-catalog";
import { INTERPOLATED_VALUE_TYPES, timelineKeyValueAt, type TrackKeyRef } from "./timeline-track-edits";

/**
 * What the Timeline window lists for a clip: a group row per animated actor
 * (its lane sums its tracks' keys) followed, when open, by a row per track.
 */

export interface TimelineRowKey {
  id: string;
  time: number;
  shape: KeyframeShape;
}

export interface TimelineRowModel {
  /** The object id for groups, the track id for tracks. */
  id: string;
  kind: "group" | "track";
  objectId: string;
  actor: SerializedActor | undefined;
  track?: TimelinePropertyTrack;
  label: string;
  /** The value at the playhead, as text. */
  value?: string;
  keys: TimelineRowKey[];
  connect: boolean;
  gradient?: Array<{ time: number; color: string }>;
  muted: boolean;
  expanded?: boolean;
}

/** Constant steps (square), Linear (diamond), Auto and Custom (circle), easings (hourglass). */
export function timelineKeyShape(valueType: TimelineValueType, interpolation: CurveInterpolation): KeyframeShape {
  if (!INTERPOLATED_VALUE_TYPES.has(valueType) || interpolation === "constant") return "square";
  if (interpolation === "linear") return "diamond";
  if (interpolation === "auto" || interpolation === "custom") return "circle";
  return "hourglass";
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const short = (value: unknown) => {
  const n = number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const field = (value: unknown, name: string) => (value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined);
const channel = (value: unknown) => Math.round(Math.min(1, Math.max(0, number(value))) * 255).toString(16).padStart(2, "0");

/** A key value as the track list shows it. */
export function formatTimelineValue(valueType: TimelineValueType, value: unknown, assetName?: (guid: string) => string | undefined): string {
  switch (valueType) {
    case "float": return number(value).toFixed(2);
    case "int": return String(Math.round(number(value)));
    case "bool": return value === true ? "True" : "False";
    case "vec2": return `${short(field(value, "x"))}, ${short(field(value, "y"))}`;
    case "vec3": return `${short(field(value, "x"))}, ${short(field(value, "y"))}, ${short(field(value, "z"))}`;
    case "rotator": return `${short(field(value, "pitch"))}, ${short(field(value, "yaw"))}, ${short(field(value, "roll"))}`;
    case "color": return `#${channel(field(value, "x"))}${channel(field(value, "y"))}${channel(field(value, "z"))}`;
    case "asset": return typeof value === "string" && value ? assetName?.(value) ?? value : "None";
    default: return typeof value === "string" ? `"${value}"` : "";
  }
}

/** A colour key value as CSS, for the lane gradient. */
export function timelineCssColor(value: unknown): string {
  const byte = (name: string) => Math.round(Math.min(1, Math.max(0, number(field(value, name)))) * 255);
  const alpha = field(value, "w");
  return `rgba(${byte("x")}, ${byte("y")}, ${byte("z")}, ${typeof alpha === "number" ? Math.min(1, Math.max(0, alpha)) : 1})`;
}

/** Property labels by `timelineTargetKey`, for one actor. */
export function timelinePropertyLabels(actor: SerializedActor | undefined, context: TimelinePropertyContext): Map<string, string> {
  const labels = new Map<string, string>();
  if (!actor) return labels;
  for (const group of timelinePropertyGroups(actor, context)) {
    for (const entry of group.entries) labels.set(timelineTargetKey(entry.target), entry.label);
  }
  return labels;
}

/** A track's label: the property, after the component's name for component tracks. */
export function timelineTrackLabel(actor: SerializedActor | undefined, track: TimelinePropertyTrack, labels: ReadonlyMap<string, string>): string {
  const property = labels.get(timelineTargetKey(track.target)) ?? track.target.property;
  if (track.target.kind !== "component") return property;
  const component = actor?.components.find((entry) => entry.id === track.target.componentId);
  return `${component ? timelineComponentLabel(component) : "Missing Component"} › ${property}`;
}

/** The summary key id a group row shows for every key on one frame. */
const summaryKeyId = (frame: number) => `f${frame}`;

export interface TimelineRowsOptions {
  scene: SerializedScene;
  clip: SerializedTimelineClip;
  time: number;
  /** Object ids whose tracks are hidden. */
  collapsed: ReadonlySet<string>;
  filter: string;
  actorName: (actor: SerializedActor) => string;
  context: TimelinePropertyContext;
  assetName?: (guid: string) => string | undefined;
}

function trackRow(
  object: TimelineObjectTrack,
  actor: SerializedActor | undefined,
  track: TimelinePropertyTrack,
  label: string,
  options: TimelineRowsOptions,
): TimelineRowModel {
  const { time, context } = options;
  const authored = actor ? authoredTimelineValue(actor, track.target, track.valueType, context) : undefined;
  const value = timelineKeyValueAt(track, time, authored);
  const interpolates = INTERPOLATED_VALUE_TYPES.has(track.valueType);
  return {
    id: track.id,
    kind: "track",
    objectId: object.id,
    actor,
    track,
    label,
    value: value === undefined ? undefined : formatTimelineValue(track.valueType, value, options.assetName),
    keys: track.keys.map((key) => ({ id: key.id, time: key.Time, shape: timelineKeyShape(track.valueType, key.Interpolation) })),
    connect: interpolates && track.keys.length > 1 && track.valueType !== "color",
    ...(track.valueType === "color" && track.keys.length > 0
      ? { gradient: track.keys.map((key) => ({ time: key.Time, color: timelineCssColor(key.Value) })) }
      : {}),
    muted: track.muted === true || !actor,
  };
}

export function timelineRows(options: TimelineRowsOptions): TimelineRowModel[] {
  const { scene, clip, collapsed, filter, actorName, context } = options;
  const needle = filter.trim().toLowerCase();
  const rows: TimelineRowModel[] = [];
  for (const object of clip.objects) {
    const actor = scene.actors.find((entry) => entry.id === object.actorId);
    const label = actor ? actorName(actor) : "Missing Actor";
    const groupMatches = !needle || label.toLowerCase().includes(needle);
    const labels = timelinePropertyLabels(actor, context);
    const tracks = object.tracks
      .map((track) => ({ track, label: timelineTrackLabel(actor, track, labels) }))
      .filter((entry) => groupMatches || entry.label.toLowerCase().includes(needle));
    if (!groupMatches && tracks.length === 0) continue;
    const frames = new Map<number, number>();
    for (const track of object.tracks) for (const key of track.keys) frames.set(frameAt(key.Time, clip.frameRate), key.Time);
    const expanded = !collapsed.has(object.id) || Boolean(needle);
    rows.push({
      id: object.id,
      kind: "group",
      objectId: object.id,
      actor,
      label,
      ...(object.tracks.length > 0 ? {} : { value: "No Tracks" }),
      keys: [...frames].sort((a, b) => a[0] - b[0]).map(([frame, keyTime]) => ({ id: summaryKeyId(frame), time: keyTime, shape: "diamond" })),
      connect: false,
      muted: !actor,
      ...(object.tracks.length > 0 ? { expanded } : {}),
    });
    if (!expanded) continue;
    for (const entry of tracks) rows.push(trackRow(object, actor, entry.track, entry.label, options));
  }
  return rows;
}

/**
 * Lane key refs (a group's summary keys included) as track key refs: a
 * summary key stands for every key of its object on that frame.
 */
export function trackKeyRefs(clip: SerializedTimelineClip, refs: readonly KeyRef[]): TrackKeyRef[] {
  const out: TrackKeyRef[] = [];
  const seen = new Set<string>();
  const push = (trackId: string, keyId: string) => {
    const id = `${trackId}\u0000${keyId}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ trackId, keyId });
  };
  for (const ref of refs) {
    const object = clip.objects.find((entry) => entry.id === ref.rowId);
    if (!object) {
      push(ref.rowId, ref.keyId);
      continue;
    }
    const frame = Number(ref.keyId.slice(1));
    for (const track of object.tracks) {
      for (const key of track.keys) if (frameAt(key.Time, clip.frameRate) === frame) push(track.id, key.id);
    }
  }
  return out;
}

/** The lanes' selection: the selected track keys, plus each summary key whose keys are all selected. */
export function laneSelection(clip: SerializedTimelineClip, selected: ReadonlySet<string>): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const shown = new Set(selected);
  for (const object of clip.objects) {
    const byFrame = new Map<number, boolean>();
    for (const track of object.tracks) {
      for (const key of track.keys) {
        const frame = frameAt(key.Time, clip.frameRate);
        const isSelected = selected.has(keyRefId({ rowId: track.id, keyId: key.id }));
        byFrame.set(frame, (byFrame.get(frame) ?? true) && isSelected);
      }
    }
    for (const [frame, all] of byFrame) if (all) shown.add(keyRefId({ rowId: object.id, keyId: summaryKeyId(frame) }));
  }
  return shown;
}
