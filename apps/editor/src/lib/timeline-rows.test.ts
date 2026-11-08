import { describe, expect, it } from "vitest";
import { createActor, createTimelineClip, type SerializedScene, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import { keyRefId } from "@haptic/editor-kit";
import { formatTimelineValue, laneSelection, timelineKeyShape, timelineRowStructure, trackKeyRefs, withTimelineValues, type TimelineRowModel } from "./timeline-rows";

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
  scene, clip, collapsed: new Set<string>(), filter: "",
  actorName: (actor: { name: string }) => actor.name,
  context: { graphs: {}, parentOf: () => null },
};

describe("timeline rows", () => {
  it("lists each object, then its tracks with the value at the playhead", () => {
    const rows = withTimelineValues(timelineRowStructure(options), 0.5);
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

  it("fills in the values at a new playhead, keeping each row whose shown value is unchanged", () => {
    const structure = timelineRowStructure(options);
    const cache = new WeakMap<TimelineRowModel, TimelineRowModel>();
    const first = withTimelineValues(structure, 0.25, undefined, cache);
    expect(first[1]!.value).toBe("0.50, 0, 0");
    const second = withTimelineValues(structure, 0.75, undefined, cache);
    expect(second.map((row) => row.value ?? null)).toEqual([null, "1.50, 0, 0", "False", null, "#ff8000", "No Tracks"]);
    // Location moved, so its row is new; Visible and Color show the same text, so theirs are the rows made before.
    expect(second[1]).not.toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second[4]).toBe(first[4]);
    // Group rows have no value at the playhead: they are the structure's own rows.
    expect(second[0]).toBe(structure[0]);
  });

  it("marks rows that cannot animate: a missing actor or component, a property gone or of another type", () => {
    const broken: SerializedTimelineClip = {
      ...clip,
      objects: [
        { id: "o-door", actorId: "door", tracks: [
          { id: "loc", target: { kind: "transform", property: "location" }, valueType: "vec3", keys: [] },
          // A Class variable the actor's Class no longer has.
          { id: "glow", target: { kind: "variable", property: "Glow" }, valueType: "float", keys: [] },
          // Location keyed as a float: its type changed.
          { id: "odd", target: { kind: "transform", property: "location" }, valueType: "float", keys: [] },
        ] },
        { id: "o-lamp", actorId: "lamp", tracks: [
          { id: "gone", target: { kind: "component", componentId: "removed", property: "intensity" }, valueType: "float", keys: [] },
        ] },
        { id: "o-gone", actorId: "missing", tracks: [{ id: "lost", target: { kind: "visible", property: "visible" }, valueType: "bool", keys: [] }] },
      ],
    };
    expect(timelineRowStructure({ ...options, clip: broken }).map((row) => [row.id, row.problem ?? null])).toEqual([
      ["o-door", null],
      ["loc", null],
      ["glow", "property_unavailable"],
      ["odd", "property_unavailable"],
      ["o-lamp", null],
      ["gone", "missing_target"],
      ["o-gone", "missing_target"],
      ["lost", "missing_target"],
    ]);
  });

  it("hides collapsed objects' tracks and filters by actor or track", () => {
    expect(timelineRowStructure({ ...options, collapsed: new Set(["o-door"]) }).map((row) => row.label)).toEqual(["Door", "Lamp", "Glow › Color", "Missing Actor"]);
    expect(timelineRowStructure({ ...options, filter: "vis" }).map((row) => row.label)).toEqual(["Door", "Visible"]);
    expect(timelineRowStructure({ ...options, filter: "lamp" }).map((row) => row.label)).toEqual(["Lamp", "Glow › Color"]);
  });
});

describe("key selection", () => {
  it("expands a group's summary key to its tracks' keys on that frame, and shows it selected when all are", () => {
    const [door] = timelineRowStructure(options);
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
