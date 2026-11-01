import { describe, expect, it } from "vitest";
import { createActor, type SerializedActor, type SerializedGraph } from "@haptic/core";
import {
  authoredTimelineValue,
  timelineKeyValue,
  timelinePropertyGroups,
  timelineTargetKey,
  type TimelinePropertyContext,
} from "./timeline-property-catalog";

const graph = (members: unknown[]) => ({ members } as unknown as SerializedGraph);
const context: TimelinePropertyContext = {
  graphs: {
    Door: graph([
      { id: "1", kind: "variable", name: "Open Amount", typeId: "float", defaultValue: 0.25 },
      { id: "2", kind: "variable", name: "Tags", typeId: "string", container: "array" },
      { id: "3", kind: "variable", name: "Target", typeId: "object" },
      { id: "4", kind: "variable", name: "Local", typeId: "float", functionId: "f" },
    ]),
    BaseDoor: graph([{ id: "5", kind: "variable", name: "Locked", typeId: "bool", defaultValue: true }]),
  },
  parentOf: (id) => (id === "Door" ? "BaseDoor" : id === "BaseDoor" ? "Actor" : null),
  classLabel: "Door",
};

const door = (): SerializedActor => ({
  ...createActor("door", "Door"),
  classId: "Door",
  components: [
    { id: "glow", classId: "LightComponent", name: "Handle Glow", properties: { intensity: 3 } },
    { id: "body", classId: "MeshComponent", properties: {} },
    { id: "audio", classId: "AudioComponent", properties: {} },
  ],
});

describe("timelinePropertyGroups", () => {
  it("offers transform and Visible, single Class variables (inherited too), and live component properties", () => {
    const groups = timelinePropertyGroups(door(), context);
    expect(groups.map((group) => group.label)).toEqual([
      "Actor", "Door (Class Variables)", "Handle Glow (Light Component)", "Mesh (Mesh Component)", "Audio (Audio Component)",
    ]);
    expect(groups[0]!.entries.map((entry) => `${entry.label}:${entry.valueType}`)).toEqual(["Location:vec3", "Rotation:rotator", "Scale:vec3", "Visible:bool"]);
    expect(groups[1]!.entries.map((entry) => `${entry.label}:${entry.valueType}`)).toEqual(["Open Amount:float", "Locked:bool"]);
    expect(groups[2]!.entries.map((entry) => entry.label)).toContain("Intensity");
    expect(groups[3]!.entries.map((entry) => entry.target.property)).toEqual(["castShadows", "receiveShadows", "materialGuid"]);
    expect(groups[4]!.entries.map((entry) => entry.target)).toEqual([{ kind: "component", componentId: "audio", property: "volume" }]);
    expect(timelineTargetKey(groups[2]!.entries[0]!.target)).toBe("component:glow:enabled");
  });
});

describe("authoredTimelineValue", () => {
  it("reads the document's value in key format, falling back to defaults", () => {
    const actor = { ...door(), transform: { position: [1, 2, 3] as [number, number, number], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } };
    expect(authoredTimelineValue(actor, { kind: "transform", property: "location" }, "vec3", context)).toEqual({ x: 1, y: 2, z: 3 });
    const rotation = authoredTimelineValue(actor, { kind: "transform", property: "rotation" }, "rotator", context) as { yaw: number };
    expect(rotation.yaw).toBeCloseTo(90);
    expect(authoredTimelineValue(actor, { kind: "visible", property: "visible" }, "bool", context)).toBe(true);
    expect(authoredTimelineValue(actor, { kind: "variable", property: "Open Amount" }, "float", context)).toBe(0.25);
    expect(authoredTimelineValue({ ...actor, properties: { "Open Amount": 0.5 } }, { kind: "variable", property: "Open Amount" }, "float", context)).toBe(0.5);
    expect(authoredTimelineValue(actor, { kind: "component", componentId: "glow", property: "intensity" }, "float", context)).toBe(3);
    // Unset: the component's default.
    expect(authoredTimelineValue(actor, { kind: "component", componentId: "glow", property: "color" }, "color", context)).toEqual({ x: 1, y: 1, z: 1, w: 1 });
  });

  it("converts stored arrays and script objects to key values", () => {
    expect(timelineKeyValue("color", [1, 0.5, 0])).toEqual({ x: 1, y: 0.5, z: 0, w: 1 });
    expect(timelineKeyValue("vec2", { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
    expect(timelineKeyValue("rotator", [10, 20, 30])).toEqual({ pitch: 10, yaw: 20, roll: 30 });
    expect(timelineKeyValue("int", 2.6)).toBe(3);
    expect(timelineKeyValue("asset", 7)).toBeNull();
  });
});
