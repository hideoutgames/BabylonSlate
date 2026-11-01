import { describe, expect, it } from "vitest";
import { createActor, createTimelineClip, type SerializedScene, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import { timelineTransformEdit } from "./timeline-transform-edit";

const key = (id: string, Time: number, Value: unknown): TimelineKey => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });
const identity: [number, number, number, number] = [0, 0, 0, 1];

const clip = (muted = false): SerializedTimelineClip => ({
  ...createTimelineClip("c", "Intro"),
  objects: [{ id: "o", actorId: "door", tracks: [
    { id: "loc", target: { kind: "transform", property: "location" }, valueType: "vec3", ...(muted ? { muted: true } : {}),
      keys: [key("k0", 0, { x: 0, y: 0, z: 0 }), key("k2", 2, { x: 4, y: 0, z: 0 })] },
    { id: "rot", target: { kind: "transform", property: "rotation" }, valueType: "rotator", keys: [key("r0", 0, { pitch: 0, yaw: 170, roll: 0 })] },
  ] }],
});
const scene = (value: SerializedTimelineClip): SerializedScene =>
  ({ actors: [createActor("door", "Door")], settings: {}, timelineClips: [value] }) as unknown as SerializedScene;
const ids = () => {
  let next = 0;
  return () => `n${++next}`;
};

describe("timelineTransformEdit", () => {
  it("keeps tracked channels out of the document and keys them with Auto Key", () => {
    const base = scene(clip());
    // At 1 s the clip shows x = 2; the gizmo moved it to x = 3 and scaled it, which no track animates.
    const half = (170 * Math.PI) / 360;
    const live = { actorId: "door", position: [3, 0, 0] as [number, number, number], rotation: [0, Math.sin(half), 0, Math.cos(half)] as [number, number, number, number], scale: [2, 2, 2] as [number, number, number] };
    const edit = timelineTransformEdit(base, clip(), 1, [live], { autoKey: true, unkeyed: new Map(), newId: ids() });
    const door = edit.scene.actors[0]!;
    expect(door.transform.position).toEqual([0, 0, 0]);
    expect(door.transform.rotation).toEqual(identity);
    expect(door.transform.scale).toEqual([2, 2, 2]);
    const tracks = edit.scene.timelineClips![0]!.objects[0]!.tracks;
    expect(tracks[0]!.keys.find((entry) => entry.Time === 1)!.Value).toEqual({ x: 3, y: 0, z: 0 });
    // Rotation is unchanged at 170°, so it gets no key.
    expect(tracks[1]!.keys).toHaveLength(1);
    expect(edit.unkeyed.size).toBe(0);
  });

  it("previews tracked changes as unkeyed values without Auto Key", () => {
    const base = scene(clip());
    // A 20° turn past 170° keys as 190°, not -170°.
    const yaw = (190 * Math.PI) / 180;
    const live = { actorId: "door", position: [2, 0, 0] as [number, number, number], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
    const edit = timelineTransformEdit(base, clip(), 1, [live], { autoKey: false, unkeyed: new Map(), newId: ids() });
    expect(edit.scene).toBe(base);
    expect([...edit.unkeyed.keys()]).toEqual(["rot"]);
    expect((edit.unkeyed.get("rot") as { yaw: number }).yaw).toBeCloseTo(190, 3);
  });

  it("edits the document for a muted track's channel", () => {
    const muted = clip(true);
    const base = scene(muted);
    const live = { actorId: "door", position: [5, 0, 0] as [number, number, number], rotation: identity, scale: [1, 1, 1] as [number, number, number] };
    const edit = timelineTransformEdit(base, muted, 1, [live], { autoKey: true, unkeyed: new Map(), newId: ids() });
    expect(edit.scene.actors[0]!.transform.position).toEqual([5, 0, 0]);
  });
});
