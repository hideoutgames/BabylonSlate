import { describe, expect, it } from "vitest";
import { createActor, createTimelineClip, type SerializedScene, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import { keyRefId } from "@haptic/editor-kit";
import { formatTimelineValue, laneSelection, timelineKeyShape, timelineRows, trackKeyRefs } from "./timeline-rows";

const key = (id: string, Time: number, Value: unknown, Interpolation: TimelineKey["Interpolation"] = "linear"): TimelineKey =>
  ({ id, Time, Value, Interpolation, ArriveTangent: 0, LeaveTangent: 0 });

const clip: SerializedTimelineClip = {
  ...createTimelineClip("c", "Intro"),
  objects: [
    { id: "o-door", actorId: "door", tracks: [
      { id: "loc", target: { kind: "transform", property: "location" }, valueType: "vec3", keys: [key("l0", 0, { x: 0, y: 0, z: 0 }), key("l1", 1, { x: 2, y: 0, z: 0 }, "constant")] },
      { id: "vis", target: { kind: "visible", property: "visible" }, valueType: "bool", keys: [key("v1", 1, false)] },
    ] },
    { id: "o-lamp", actorId: "lamp", tracks: [
      { id: "col", target: { kind: "component", componentId: "light", property: "color" }, valueType: "color", keys: [key("c0", 0, { x: 1, y: 0.5, z: 0, w: 1 })] },
    ] },
    { id: "o-gone", actorId: "missing", tracks: [] },
  ],
};
const scene = {
  actors: [createActor("door", "Door"), { ...createActor("lamp", "Lamp"), components: [{ id: "light", classId: "LightComponent", name: "Glow", properties: {} }] }],
} as unknown as SerializedScene;
const options = {
  scene, clip, time: 0.5, collapsed: new Set<string>(), filter: "",
  actorName: (actor: { name: string }) => actor.name,
  context: { graphs: {}, parentOf: () => null },
};

describe("timelineRows", () => {
  it("lists each object, then its tracks with the value at the playhead", () => {
    const rows = timelineRows(options);
    expect(rows.map((row) => [row.kind, row.label, row.value ?? null])).toEqual([
      ["group", "Door", null],
      ["track", "Location", "1, 0, 0"],
      ["track", "Visible", "False"],
      ["group", "Lamp", null],
      ["track", "Glow › Color", "#ff8000"],
      ["group", "Missing Actor", "No Tracks"],
    ]);
    // A group sums its tracks' keys, one per frame.
    expect(rows[0]!.keys.map((entry) => entry.time)).toEqual([0, 1]);
    expect(rows[1]!.keys.map((entry) => entry.shape)).toEqual(["diamond", "square"]);
    expect(rows[1]!.connect).toBe(true);
    expect(rows[4]!.gradient).toEqual([{ time: 0, color: "rgba(255, 128, 0, 1)" }]);
    expect(rows[5]!.muted).toBe(true);
  });

  it("hides collapsed objects' tracks and filters by actor or track", () => {
    expect(timelineRows({ ...options, collapsed: new Set(["o-door"]) }).map((row) => row.label)).toEqual(["Door", "Lamp", "Glow › Color", "Missing Actor"]);
    expect(timelineRows({ ...options, filter: "vis" }).map((row) => row.label)).toEqual(["Door", "Visible"]);
    expect(timelineRows({ ...options, filter: "lamp" }).map((row) => row.label)).toEqual(["Lamp", "Glow › Color"]);
  });
});

describe("key selection", () => {
  it("expands a group's summary key to its tracks' keys on that frame, and shows it selected when all are", () => {
    const [door] = timelineRows(options);
    const summary = door!.keys.find((entry) => entry.time === 1)!;
    const refs = trackKeyRefs(clip, [{ rowId: "o-door", keyId: summary.id }, { rowId: "col", keyId: "c0" }]);
    expect(refs).toEqual([{ trackId: "loc", keyId: "l1" }, { trackId: "vis", keyId: "v1" }, { trackId: "col", keyId: "c0" }]);
    const selected = new Set(refs.map((ref) => keyRefId({ rowId: ref.trackId, keyId: ref.keyId })));
    expect(laneSelection(clip, selected).has(keyRefId({ rowId: "o-door", keyId: summary.id }))).toBe(true);
    selected.delete(keyRefId({ rowId: "vis", keyId: "v1" }));
    expect(laneSelection(clip, selected).has(keyRefId({ rowId: "o-door", keyId: summary.id }))).toBe(false);
  });
});

describe("formatting", () => {
  it("formats values and picks key shapes by interpolation", () => {
    expect(formatTimelineValue("float", 3.14159)).toBe("3.14");
    expect(formatTimelineValue("rotator", { pitch: 0, yaw: 45.5, roll: 0 })).toBe("0, 45.50, 0");
    expect(formatTimelineValue("string", "Hi")).toBe("\"Hi\"");
    expect(formatTimelineValue("asset", "g1", (guid) => (guid === "g1" ? "Oak" : undefined))).toBe("Oak");
    expect(formatTimelineValue("asset", null)).toBe("None");
    expect(timelineKeyShape("float", "auto")).toBe("circle");
    expect(timelineKeyShape("float", "quadIn")).toBe("hourglass");
    expect(timelineKeyShape("bool", "linear")).toBe("square");
  });
});
