import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createTimelineClip, type SerializedScene } from "@haptic/core";
import { createClip, deleteClip, duplicateClip, missingTrackActorIds, pasteClips, renameClip } from "./timeline-clip-edits";

const names = (scene: SerializedScene | null) => scene?.timelineClips?.map((clip) => clip.name);

describe("Timeline Clip edits", () => {
  it("creates clips with free names and removes the field with the last one", () => {
    const one = createClip(createDefaultScene(), "a");
    const two = createClip(one, "b");
    expect(names(two)).toEqual(["Timeline Clip", "Timeline Clip 2"]);
    expect(deleteClip(deleteClip(two, "a")!, "b")).not.toHaveProperty("timelineClips");
    expect(deleteClip(two, "missing")).toBeNull();
  });

  it("renames to a trimmed name another clip does not have, and ignores blank or unchanged names", () => {
    const scene = { ...createDefaultScene(), timelineClips: [createTimelineClip("a", "Intro"), createTimelineClip("b", "Outro")] };
    expect(names(renameClip(scene, "b", "  Finale "))).toEqual(["Intro", "Finale"]);
    expect(names(renameClip(scene, "b", "Intro"))).toEqual(["Intro", "Intro 2"]);
    expect(renameClip(scene, "b", "   ")).toBeNull();
    expect(renameClip(scene, "b", "Outro")).toBeNull();
  });

  it("duplicates after the original and pastes at the end, with new ids, free names and no Timeline Asset binding", () => {
    const bound = { ...createTimelineClip("a", "Intro"), timelineAsset: "timeline-asset", length: 8 };
    const scene = { ...createDefaultScene(), timelineClips: [bound, createTimelineClip("b", "Outro")] };
    const duplicated = duplicateClip(scene, "a", "c")!;
    expect(duplicated.timelineClips!.map((clip) => [clip.id, clip.name])).toEqual([["a", "Intro"], ["c", "Intro 2"], ["b", "Outro"]]);
    expect(duplicated.timelineClips![1]).toMatchObject({ length: 8 });
    expect(duplicated.timelineClips![1]).not.toHaveProperty("timelineAsset");
    expect(duplicated.timelineClips![0]!.timelineAsset).toBe("timeline-asset");

    const pasted = pasteClips(scene, [bound, bound], ["d", "e"]);
    expect(pasted.timelineClips!.map((clip) => [clip.id, clip.name])).toEqual([["a", "Intro"], ["b", "Outro"], ["d", "Intro 2"], ["e", "Intro 3"]]);
    expect(pasted.timelineClips!.slice(2).some((clip) => "timelineAsset" in clip)).toBe(false);
  });

  it("names the actors a pasted clip animates that this document does not have", () => {
    const clip = { ...createTimelineClip("a", "Intro"), objects: [
      { id: "o1", actorId: "door", tracks: [] }, { id: "o2", actorId: "lamp", tracks: [] },
    ] };
    const scene = { ...createDefaultScene(), actors: [createActor("door", "Door")] };
    expect(missingTrackActorIds(scene, clip)).toEqual(["lamp"]);
  });
});
