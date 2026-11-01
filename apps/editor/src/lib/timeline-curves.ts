import type { CurveEditorKind, CurveEditorValue } from "@haptic/editor-kit";
import type { TimelineKey, TimelinePropertyTrack, TimelineValueType } from "@haptic/core";
import type { NewId } from "./timeline-track-edits";

/**
 * A Timeline track as the shared curve editor shows it: Float as a float
 * curve, Vector 2, Vector and Rotator (pitch, yaw, roll as X, Y, Z) as a vector
 * curve, Color as a color curve. Stepped types have no curve.
 */

export function timelineCurveKind(valueType: TimelineValueType): CurveEditorKind | null {
  switch (valueType) {
    case "float": return "float";
    case "vec2": case "vec3": case "rotator": return "vec3";
    case "color": return "color";
    default: return null;
  }
}

/** Channels the curve editor shows: Vector 2 has no Z. */
export function timelineCurveChannels(valueType: TimelineValueType): boolean[] | undefined {
  return valueType === "vec2" ? [true, true, false] : undefined;
}

const num = (value: unknown, name: string) => {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
};
const scalar = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function toCurve(valueType: TimelineValueType, value: unknown): unknown {
  if (valueType === "rotator") return { x: num(value, "pitch"), y: num(value, "yaw"), z: num(value, "roll") };
  if (valueType === "vec2") return { x: num(value, "x"), y: num(value, "y"), z: 0 };
  return value;
}

function fromCurve(valueType: TimelineValueType, value: unknown): unknown {
  if (valueType === "rotator") return { pitch: num(value, "x"), yaw: num(value, "y"), roll: num(value, "z") };
  if (valueType === "vec2") return { x: num(value, "x"), y: num(value, "y") };
  if (valueType === "float") return scalar(value);
  return value;
}

/** Tangents of 0 stay 0, as every key starts. */
const tangentToCurve = (valueType: TimelineValueType, value: unknown) => (typeof value === "number" ? value : toCurve(valueType, value));
const tangentFromCurve = (valueType: TimelineValueType, value: unknown) => (typeof value === "number" ? value : fromCurve(valueType, value));

export function timelineTrackCurve(track: TimelinePropertyTrack): CurveEditorValue {
  return {
    Keys: track.keys.map((key) => ({
      Time: key.Time,
      Value: toCurve(track.valueType, key.Value),
      Interpolation: key.Interpolation,
      ArriveTangent: tangentToCurve(track.valueType, key.ArriveTangent),
      LeaveTangent: tangentToCurve(track.valueType, key.LeaveTangent),
    })),
    Before: "constant",
    After: "constant",
  };
}

/**
 * The track with the curve editor's keys. Keys keep their ids by position when
 * the count is unchanged, else by time; new keys get new ids.
 */
export function applyTimelineCurve(track: TimelinePropertyTrack, curve: { Keys: unknown[] }, newId: NewId): TimelinePropertyTrack {
  const sameCount = curve.Keys.length === track.keys.length;
  const unused = new Map(track.keys.map((key) => [key.id, key]));
  const keys = curve.Keys.map((raw, index): TimelineKey => {
    const entry = raw as { Time: number; Value: unknown; Interpolation: TimelineKey["Interpolation"]; ArriveTangent: unknown; LeaveTangent: unknown };
    const previous = sameCount ? track.keys[index] : [...unused.values()].find((key) => Math.abs(key.Time - entry.Time) < 1e-6);
    if (previous) unused.delete(previous.id);
    return {
      id: previous?.id ?? newId(),
      Time: entry.Time,
      Value: fromCurve(track.valueType, entry.Value),
      Interpolation: entry.Interpolation,
      ArriveTangent: tangentFromCurve(track.valueType, entry.ArriveTangent),
      LeaveTangent: tangentFromCurve(track.valueType, entry.LeaveTangent),
    };
  });
  return { ...track, keys: keys.sort((a, b) => a.Time - b.Time) };
}
