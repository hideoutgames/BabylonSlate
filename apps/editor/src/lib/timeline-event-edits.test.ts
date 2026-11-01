import { describe, expect, it } from "vitest";
import { createTimelineClip, type SerializedTimelineClip } from "@haptic/core";
import {
  addTimelineEventTrack,
  deleteTimelineEventKeys,
  moveTimelineEventTrack,
  renameTimelineEventTrack,
  setTimelineEventKeyTime,
  setTimelineEventKeyValue,
  setTimelineEventKeys,
  setTimelineEventTrackInputs,
  shiftTimelineEventKeys,
  snapshotTimelineEventKeys,
  timelineEventKeyValue,
  toggleTimelineEventKey,
} from "./timeline-event-edits";

let next = 0;
const newId = () => `id${next++}`;

function clipWithTracks(): SerializedTimelineClip {
  let clip: SerializedTimelineClip = { ...createTimelineClip("intro", "Intro"), length: 2 };
  clip = addTimelineEventTrack(clip, newId).clip;
  clip = addTimelineEventTrack(clip, newId).clip;
  return clip;
}

describe("Custom Event Track edits", () => {
  it("names new and renamed tracks apart from each other and the built-in events", () => {
    const clip = clipWithTracks();
    expect(clip.eventTracks.map((track) => track.name)).toEqual(["On Event", "On Event 2"]);
    const [first, second] = clip.eventTracks;
    expect(renameTimelineEventTrack(clip, second!.id, "On Event").eventTracks[1]!.name).toBe("On Event 2");
    expect(renameTimelineEventTrack(clip, first!.id, "On Finished").eventTracks[0]!.name).toBe("On Finished 2");
    expect(renameTimelineEventTrack(clip, first!.id, "On Door Open").eventTracks[0]!.name).toBe("On Door Open");
    expect(moveTimelineEventTrack(clip, second!.id, -1).eventTracks.map((track) => track.id)).toEqual([second!.id, first!.id]);
  });

  it("adds a key per frame, toggles it, and keeps values of inputs that stay", () => {
    let clip = clipWithTracks();
    const trackId = clip.eventTracks[0]!.id;
    clip = setTimelineEventTrackInputs(clip, trackId, [
      { name: "Line", typeId: "string", direction: "in" }, { name: "Volume", typeId: "float", direction: "in" },
    ]);
    const { clip: keyed, added } = setTimelineEventKeys(clip, [trackId], 0.5, newId);
    expect(setTimelineEventKeys(keyed, [trackId], 0.51, newId).added).toEqual([]);
    clip = setTimelineEventKeyValue(keyed, added[0]!, "Line", "Hello");
    clip = setTimelineEventKeyValue(clip, added[0]!, "Volume", 2);
    const key = clip.eventTracks[0]!.keys[0]!;
    expect(timelineEventKeyValue(key, { name: "Volume", typeId: "float", direction: "in" })).toBe(2);
    clip = setTimelineEventTrackInputs(clip, trackId, [
      { name: "Line", typeId: "string", direction: "in" }, { name: "Volume", typeId: "int", direction: "in" },
    ]);
    expect(clip.eventTracks[0]!.keys[0]!.values).toEqual({ Line: "Hello" });
    expect(timelineEventKeyValue(clip.eventTracks[0]!.keys[0]!, clip.eventTracks[0]!.inputs[1]!)).toBe(0);
    expect(toggleTimelineEventKey(clip, trackId, 0.5, newId).eventTracks[0]!.keys).toEqual([]);
  });

  it("moves keys within the clip, replacing a key they land on, and deletes them", () => {
    let clip = clipWithTracks();
    const trackId = clip.eventTracks[0]!.id;
    const a = setTimelineEventKeys(clip, [trackId], 0.5, newId);
    const b = setTimelineEventKeys(a.clip, [trackId], 1.5, newId);
    clip = b.clip;
    const snapshot = snapshotTimelineEventKeys(clip, a.added);
    expect(shiftTimelineEventKeys(clip, snapshot, 5).eventTracks[0]!.keys.map((key) => key.time)).toEqual([1.5, 2]);
    expect(shiftTimelineEventKeys(clip, snapshot, 1).eventTracks[0]!.keys.map((key) => key.id)).toEqual([a.added[0]!.keyId]);
    expect(setTimelineEventKeyTime(clip, b.added[0]!, 0.25).eventTracks[0]!.keys.map((key) => key.time)).toEqual([0.25, 0.5]);
    expect(deleteTimelineEventKeys(clip, b.added).eventTracks[0]!.keys.map((key) => key.time)).toEqual([0.5]);
  });
});
