import { describe, expect, it } from "vitest";
import type { TimelineKey, TimelinePropertyTrack } from "@haptic/core";
import { applyTimelineCurve, timelineCurveChannels, timelineCurveKind, timelineTrackCurve } from "./timeline-curves";

const key = (id: string, Time: number, Value: unknown, tangent: unknown = 0): TimelineKey =>
  ({ id, Time, Value, Interpolation: "custom", ArriveTangent: tangent, LeaveTangent: tangent });
const track = (valueType: TimelinePropertyTrack["valueType"], keys: TimelineKey[]): TimelinePropertyTrack =>
  ({ id: "t", target: { kind: "transform", property: "rotation" }, valueType, keys });
let next = 0;
const newId = () => `new${++next}`;

describe("timeline curves", () => {
  it("shows interpolated tracks as curves and stepped ones not at all", () => {
    expect(["float", "vec2", "vec3", "rotator", "color", "bool", "int", "string"].map((type) => timelineCurveKind(type as never)))
      .toEqual(["float", "vec3", "vec3", "vec3", "color", null, null, null]);
    expect(timelineCurveChannels("vec2")).toEqual([true, true, false]);
    expect(timelineCurveChannels("vec3")).toBeUndefined();
  });

  it("maps rotators to X, Y and Z and back, with their tangents, keeping key ids", () => {
    const rotation = track("rotator", [key("a", 0, { pitch: 1, yaw: 2, roll: 3 }, { pitch: 0, yaw: 5, roll: 0 }), key("b", 2, { pitch: 0, yaw: 90, roll: 0 })]);
    const curve = timelineTrackCurve(rotation);
    expect(curve.Keys[0]).toMatchObject({ Value: { x: 1, y: 2, z: 3 }, ArriveTangent: { x: 0, y: 5, z: 0 }, Interpolation: "custom" });
    const edited = { Keys: [{ ...(curve.Keys[0] as object), Time: 0.5 }, curve.Keys[1]] };
    const back = applyTimelineCurve(rotation, edited, newId);
    expect(back.keys.map((entry) => [entry.id, entry.Time])).toEqual([["a", 0.5], ["b", 2]]);
    expect(back.keys[0]!.Value).toEqual({ pitch: 1, yaw: 2, roll: 3 });
    expect(back.keys[0]!.LeaveTangent).toEqual({ pitch: 0, yaw: 5, roll: 0 });
    expect(back.keys[1]!.ArriveTangent).toBe(0);
  });

  it("gives an added key a new id and keeps the others by time", () => {
    const float = track("float", [key("a", 0, 1), key("b", 2, 3)]);
    const curve = timelineTrackCurve(float);
    const added = { Keys: [curve.Keys[0], { Time: 1, Value: 2, Interpolation: "auto", ArriveTangent: 0, LeaveTangent: 0 }, curve.Keys[1]] };
    expect(applyTimelineCurve(float, added, newId).keys.map((entry) => entry.id)).toEqual(["a", "new1", "b"]);
    const vec2 = track("vec2", [key("v", 0, { x: 1, y: 2 })]);
    expect(timelineTrackCurve(vec2).Keys[0]).toMatchObject({ Value: { x: 1, y: 2, z: 0 } });
    expect(applyTimelineCurve(vec2, timelineTrackCurve(vec2), newId).keys[0]!.Value).toEqual({ x: 1, y: 2 });
  });
});
