import { describe, expect, it } from "vitest";
import { createActor, createTimelineClip, type SerializedScene, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import {
  addTimelineObjects,
  addTimelineTracks,
  adjacentTimelineKeyTime,
  copyTimelineKeys,
  deleteTimelineKeys,
  moveTimelineRow,
  pasteTimelineTrack,
  setTimelineKeyInterpolation,
  setTimelineKeyTime,
  setTimelineKeyValue,
  timelineRowKeyRefs,
  pasteTimelineKeys,
  removeTimelineObject,
  removeTimelineTrack,
  setTimelineKeys,
  setTimelineTrackMuted,
  shiftTimelineKeys,
  snapshotTimelineKeys,
  timelineKeyAt,
  timelineKeyTimes,
  withTimelineClip,
} from "./timeline-track-edits";

const key = (id: string, Time: number, Value: unknown = Time): TimelineKey => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });

function ids(): () => string {
  let next = 0;
  return () => `id${++next}`;
}

const clip = (): SerializedTimelineClip => ({
  ...createTimelineClip("c", "Clip"),
  length: 4,
  objects: [{ id: "o1", actorId: "door", tracks: [
    { id: "a", target: { kind: "variable", property: "Open" }, valueType: "float", keys: [key("a0", 0), key("a2", 2)] },
    { id: "b", target: { kind: "visible", property: "visible" }, valueType: "bool", keys: [key("b1", 1, true)] },
  ] }],
});
const times = (value: SerializedTimelineClip, trackId: string) =>
  value.objects.flatMap((object) => object.tracks).find((track) => track.id === trackId)!.keys.map((entry) => entry.Time);

describe("objects and tracks", () => {
  it("adds each actor once and tracks once per property", () => {
    const newId = ids();
    const withObjects = addTimelineObjects(clip(), ["door", "lamp", "lamp"], newId);
    expect(withObjects.objects.map((object) => object.actorId)).toEqual(["door", "lamp"]);
    const base = clip();
    expect(addTimelineObjects(base, ["door"], newId)).toBe(base);

    const entries = [
      { target: { kind: "visible" as const, property: "visible" }, valueType: "bool" as const, label: "Visible" },
      { target: { kind: "transform" as const, property: "scale" }, valueType: "vec3" as const, label: "Scale" },
    ];
    const withTracks = addTimelineTracks(base, "door", entries, newId);
    expect(withTracks.objects[0]!.tracks.map((track) => track.target.property)).toEqual(["Open", "visible", "scale"]);
    const onNew = addTimelineTracks(base, "lamp", entries, newId);
    expect(onNew.objects[1]).toMatchObject({ actorId: "lamp", tracks: [{ valueType: "bool", keys: [] }, { valueType: "vec3", keys: [] }] });
  });

  it("removes and mutes", () => {
    expect(removeTimelineTrack(clip(), "b").objects[0]!.tracks.map((track) => track.id)).toEqual(["a"]);
    expect(removeTimelineObject(clip(), "o1").objects).toEqual([]);
    const muted = setTimelineTrackMuted(clip(), "a", true);
    expect(muted.objects[0]!.tracks[0]!.muted).toBe(true);
    expect("muted" in setTimelineTrackMuted(muted, "a", false).objects[0]!.tracks[0]!).toBe(false);
    expect(setTimelineTrackMuted(muted, "a", true)).toBe(muted);
  });
});

describe("keys", () => {
  it("sets a key, replacing the value of one already on that frame", () => {
    const next = setTimelineKeys(clip(), [{ trackId: "a", time: 1, value: 5 }, { trackId: "a", time: 2.01, value: 9 }], ids());
    const track = next.objects[0]!.tracks[0]!;
    expect(track.keys.map((entry) => [entry.id, entry.Time, entry.Value, entry.Interpolation])).toEqual([
      ["a0", 0, 0, "linear"], ["id1", 1, 5, "auto"], ["a2", 2, 9, "linear"],
    ]);
    expect(timelineKeyAt(track, 1.01, 30)?.id).toBe("id1");
  });

  it("moves selected keys from the drag's start, kept inside the clip, replacing keys they land on", () => {
    const base = clip();
    const snapshot = snapshotTimelineKeys(base, [{ trackId: "a", keyId: "a0" }]);
    expect(times(shiftTimelineKeys(base, snapshot, 1.5), "a")).toEqual([1.5, 2]);
    // Landing on a2 replaces it.
    const landed = shiftTimelineKeys(base, snapshot, 2);
    expect(landed.objects[0]!.tracks[0]!.keys.map((entry) => entry.id)).toEqual(["a0"]);
    // Both keys move together and stop at the clip's end.
    const both = snapshotTimelineKeys(base, [{ trackId: "a", keyId: "a0" }, { trackId: "a", keyId: "a2" }]);
    expect(times(shiftTimelineKeys(base, both, 9), "a")).toEqual([2, 4]);
    expect(times(shiftTimelineKeys(base, both, -1), "a")).toEqual([0, 2]);
    expect(shiftTimelineKeys(base, both, 0)).toBe(base);
  });

  it("deletes, copies and pastes keys at the playhead", () => {
    expect(times(deleteTimelineKeys(clip(), [{ trackId: "a", keyId: "a2" }]), "a")).toEqual([0]);
    const copied = copyTimelineKeys(clip(), [{ trackId: "a", keyId: "a2" }, { trackId: "b", keyId: "b1" }])!;
    expect(copied.origin).toBe(1);
    const { clip: pasted, pasted: refs } = pasteTimelineKeys(clip(), copied, 3, ids());
    expect(times(pasted, "a")).toEqual([0, 2, 4]);
    expect(times(pasted, "b")).toEqual([1, 3]);
    expect(refs).toHaveLength(2);
    // Past the end, keys are dropped.
    expect(times(pasteTimelineKeys(clip(), copied, 3.5, ids()).clip, "a")).toEqual([0, 2]);
  });

  it("pastes onto the same property of the same actor in another clip", () => {
    const copied = copyTimelineKeys(clip(), [{ trackId: "a", keyId: "a2" }])!;
    const other = { ...clip(), objects: [{ id: "o9", actorId: "door", tracks: [{ ...clip().objects[0]!.tracks[0]!, id: "z", keys: [] }] }] };
    expect(times(pasteTimelineKeys(other, copied, 1, ids()).clip, "z")).toEqual([1]);
  });

  it("lists key times once per frame and finds the next and previous", () => {
    const all = timelineKeyTimes(clip());
    expect(all).toEqual([0, 1, 2]);
    expect(adjacentTimelineKeyTime(all, 0, 1, 30)).toBe(1);
    expect(adjacentTimelineKeyTime(all, 1.01, -1, 30)).toBe(0);
    expect(adjacentTimelineKeyTime(all, 2, 1, 30)).toBeUndefined();
  });
});

describe("withTimelineClip", () => {
  it("replaces the clip by id and keeps the scene when nothing changed", () => {
    const scene = { actors: [createActor("door", "Door")], timelineClips: [clip()] } as unknown as SerializedScene;
    expect(withTimelineClip(scene, scene.timelineClips![0]!)).toBe(scene);
    const renamed = { ...clip(), name: "Renamed" };
    expect(withTimelineClip(scene, renamed).timelineClips![0]!.name).toBe("Renamed");
  });
});

describe("key settings, rows and copied tracks", () => {
  it("sets interpolation, value and time of keys", () => {
    const eased = setTimelineKeyInterpolation(clip(), [{ trackId: "a", keyId: "a2" }], "cubicIn");
    expect(eased.objects[0]!.tracks[0]!.keys.map((entry) => entry.Interpolation)).toEqual(["linear", "cubicIn"]);
    expect(setTimelineKeyInterpolation(eased, [{ trackId: "a", keyId: "a2" }], "cubicIn")).toBe(eased);
    expect(setTimelineKeyValue(clip(), { trackId: "a", keyId: "a0" }, 7).objects[0]!.tracks[0]!.keys[0]!.Value).toBe(7);
    // Moving onto another key's frame replaces it; the time stays inside the clip.
    expect(setTimelineKeyTime(clip(), { trackId: "a", keyId: "a0" }, 2).objects[0]!.tracks[0]!.keys.map((entry) => entry.id)).toEqual(["a0"]);
    expect(times(setTimelineKeyTime(clip(), { trackId: "a", keyId: "a2" }, 9), "a")).toEqual([0, 4]);
  });

  it("moves tracks and objects up and down, and lists a row's keys", () => {
    expect(moveTimelineRow(clip(), "b", -1).objects[0]!.tracks.map((track) => track.id)).toEqual(["b", "a"]);
    const base = clip();
    expect(moveTimelineRow(base, "a", -1)).toBe(base);
    const two = addTimelineObjects(clip(), ["lamp"], ids());
    expect(moveTimelineRow(two, "o1", 1).objects.map((object) => object.actorId)).toEqual(["lamp", "door"]);
    expect(timelineRowKeyRefs(clip(), "o1")).toHaveLength(3);
    expect(timelineRowKeyRefs(clip(), "b")).toEqual([{ trackId: "b", keyId: "b1" }]);
  });

  it("pastes a copied track onto the same property, or onto a component of the copied class", () => {
    const copied = { target: { kind: "variable" as const, property: "Open" }, valueType: "float" as const, keys: [key("x", 1, 5)] };
    const replaced = pasteTimelineTrack(clip(), "o1", copied, { components: [] }, ids())!;
    expect(replaced.objects[0]!.tracks[0]!.keys.map((entry) => [entry.Time, entry.Value])).toEqual([[1, 5]]);

    const light = { target: { kind: "component" as const, componentId: "glow", property: "intensity" }, valueType: "float" as const,
      componentClassId: "LightComponent", keys: [key("y", 0, 2)] };
    const pasted = pasteTimelineTrack(clip(), "o1", light, { components: [{ id: "lamp-light", classId: "LightComponent" }] }, ids())!;
    expect(pasted.objects[0]!.tracks[2]).toMatchObject({ target: { kind: "component", componentId: "lamp-light", property: "intensity" }, keys: [{ Time: 0, Value: 2 }] });
    expect(pasteTimelineTrack(clip(), "o1", light, { components: [] }, ids())).toBeNull();
  });
});

