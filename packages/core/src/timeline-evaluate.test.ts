import { describe, expect, it } from "vitest";
import { createDefaultScene } from "./project";
import { createActor } from "./scene";
import { applyTimelineClipToScene, evaluateTimelineTrack } from "./timeline-evaluate";
import { createTimelineClip, type TimelineKey, type TimelinePropertyTrack } from "./timeline-clips";

const key = (Time: number, Value: unknown, Interpolation: TimelineKey["Interpolation"] = "linear"): TimelineKey =>
  ({ id: `k${Time}`, Time, Value, Interpolation, ArriveTangent: 0, LeaveTangent: 0 });
const track = (valueType: TimelinePropertyTrack["valueType"], keys: TimelineKey[], target: TimelinePropertyTrack["target"] = { kind: "variable", property: "Value" }): TimelinePropertyTrack =>
  ({ id: `t-${valueType}`, target, valueType, keys });

describe("evaluateTimelineTrack", () => {
  it("interpolates floats per key interpolation and holds the end values outside the keys", () => {
    const linear = track("float", [key(1, 10), key(3, 30)]);
    expect([0, 1, 2, 3, 5].map((time) => evaluateTimelineTrack(linear, time))).toEqual([10, 10, 20, 30, 30]);
    const stepped = track("float", [key(0, 1, "constant"), key(2, 5)]);
    expect(evaluateTimelineTrack(stepped, 1.9)).toBe(1);
    // Quad In: t² of the way at the middle.
    const eased = track("float", [key(0, 0, "quadIn"), key(2, 8)]);
    expect(evaluateTimelineTrack(eased, 1)).toBeCloseTo(2);
    expect(evaluateTimelineTrack(track("float", []), 1)).toBeUndefined();
  });

  it("interpolates vectors, Vector 2 values and colours per channel", () => {
    expect(evaluateTimelineTrack(track("vec3", [key(0, { x: 0, y: 0, z: 0 }), key(2, { x: 2, y: 4, z: -2 })]), 1)).toEqual({ x: 1, y: 2, z: -1 });
    expect(evaluateTimelineTrack(track("vec2", [key(0, { x: 0, y: 10 }), key(1, { x: 4, y: 0 })]), 0.25)).toEqual({ x: 1, y: 7.5 });
    expect(evaluateTimelineTrack(track("color", [key(0, { x: 0, y: 0, z: 0, w: 1 }), key(1, { x: 1, y: 0.5, z: 0, w: 0 })]), 0.5))
      .toEqual({ x: 0.5, y: 0.25, z: 0, w: 0.5 });
  });

  it("turns rotators through their authored degrees, so 0 to 720 is two turns", () => {
    const spin = track("rotator", [key(0, { pitch: 0, yaw: 0, roll: 0 }), key(4, { pitch: 0, yaw: 720, roll: 90 })]);
    expect(evaluateTimelineTrack(spin, 1)).toEqual({ pitch: 0, yaw: 180, roll: 22.5 });
  });

  it("steps booleans, integers, text, enums and assets, holding the first key before it", () => {
    const visible = track("bool", [key(1, true), key(2, false)]);
    expect([0, 1, 1.5, 2, 9].map((time) => evaluateTimelineTrack(visible, time))).toEqual([true, true, true, false, false]);
    expect(evaluateTimelineTrack(track("int", [key(0, 1), key(1, 9)]), 0.9)).toBe(1);
    expect(evaluateTimelineTrack(track("string", [key(0, "Hello"), key(1, "World")]), 1)).toBe("World");
  });
});

describe("applyTimelineClipToScene", () => {
  it("writes animated values into copies of the animated actors only, never into the scene", () => {
    const door = createActor("door", "Door");
    const lamp = { ...createActor("lamp", "Lamp"), components: [{ id: "light", classId: "LightComponent", properties: { intensity: 1, color: [1, 1, 1] } }] };
    const still = createActor("still", "Still");
    const scene = { ...createDefaultScene(), actors: [door, lamp, still] } as ReturnType<typeof createDefaultScene>;
    const clip = {
      ...createTimelineClip("intro", "Intro"),
      objects: [
        { id: "o-door", actorId: "door", tracks: [
          track("vec3", [key(0, { x: 0, y: 0, z: 0 }), key(2, { x: 4, y: 0, z: 0 })], { kind: "transform", property: "location" }),
          track("rotator", [key(0, { pitch: 0, yaw: 90, roll: 0 })], { kind: "transform", property: "rotation" }),
          track("bool", [key(0, false)], { kind: "visible", property: "visible" }),
          { ...track("float", [key(0, 99)], { kind: "variable", property: "Speed" }), muted: true },
        ] },
        { id: "o-lamp", actorId: "lamp", tracks: [
          track("float", [key(0, 0), key(2, 10)], { kind: "component", componentId: "light", property: "intensity" }),
          track("color", [key(0, { x: 1, y: 0, z: 0, w: 1 })], { kind: "component", componentId: "light", property: "color" }),
        ] },
        { id: "o-gone", actorId: "missing", tracks: [track("float", [key(0, 1)])] },
      ],
    };

    const shown = applyTimelineClipToScene(scene, clip, 1);

    const [shownDoor, shownLamp, shownStill] = shown.actors;
    expect(shownDoor!.transform.position).toEqual([2, 0, 0]);
    // Yaw 90°: a quarter turn about Y.
    expect(shownDoor!.transform.rotation.map((value) => Number(value.toFixed(4)))).toEqual([0, 0.7071, 0, 0.7071]);
    expect(shownDoor!.visible).toBe(false);
    expect(shownDoor!.properties?.Speed).toBeUndefined();
    // A three-channel colour stays three channels.
    expect(shownLamp!.components[0]!.properties).toEqual({ intensity: 5, color: [1, 0, 0] });
    expect(shownStill).toBe(still);
    // The document is unchanged.
    expect(door.transform.position).toEqual([0, 0, 0]);
    expect(lamp.components[0]!.properties).toEqual({ intensity: 1, color: [1, 1, 1] });
    // A clip that animates nothing in this scene returns the scene itself.
    expect(applyTimelineClipToScene(scene, createTimelineClip("empty", "Empty"), 1)).toBe(scene);
  });

  it("keeps Class variables as script values and gives unset component properties arrays", () => {
    const crate = {
      ...createActor("crate", "Crate"),
      properties: { Offset: { x: 0, y: 0, z: 0 } },
      components: [{ id: "label", classId: "2DTextComponent", properties: {} }],
    };
    const scene = { ...createDefaultScene(), actors: [crate] } as ReturnType<typeof createDefaultScene>;
    const red = { x: 1, y: 0, z: 0, w: 1 };
    const clip = {
      ...createTimelineClip("c", "C"),
      objects: [{ id: "o", actorId: "crate", tracks: [
        track("vec3", [key(0, { x: 1, y: 2, z: 3 })], { kind: "variable", property: "Offset" }),
        track("rotator", [key(0, { pitch: 0, yaw: 30, roll: 0 })], { kind: "variable", property: "Turn" }),
        track("color", [key(0, red)], { kind: "variable", property: "Glow" }),
        track("color", [key(0, red)], { kind: "component", componentId: "label", property: "color" }),
        track("color", [key(0, red)], { kind: "component", componentId: "label", property: "tint" }),
        track("vec2", [key(0, { x: 4, y: 5 })], { kind: "component", componentId: "label", property: "wrap" }),
      ] }],
    };

    const [shown] = applyTimelineClipToScene(scene, clip, 0).actors;

    expect(shown!.properties).toEqual({ Offset: { x: 1, y: 2, z: 3 }, Turn: { pitch: 0, yaw: 30, roll: 0 }, Glow: red });
    expect(shown!.components[0]!.properties).toEqual({ color: [1, 0, 0], tint: [1, 0, 0, 1], wrap: [4, 5] });
  });

  it("takes override values in place of tracks' values", () => {
    const door = createActor("door", "Door");
    const scene = { ...createDefaultScene(), actors: [door] } as ReturnType<typeof createDefaultScene>;
    const clip = {
      ...createTimelineClip("c", "C"),
      objects: [{ id: "o", actorId: "door", tracks: [
        { ...track("vec3", [key(0, { x: 1, y: 0, z: 0 })], { kind: "transform", property: "location" }), id: "loc" },
      ] }],
    };
    const shown = applyTimelineClipToScene(scene, clip, 0, new Map([["loc", { x: 5, y: 6, z: 7 }]]));
    expect(shown.actors[0]!.transform.position).toEqual([5, 6, 7]);
  });
});

