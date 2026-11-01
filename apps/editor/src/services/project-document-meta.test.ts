import { describe, expect, it } from "vitest";
import { TIMELINE_CLIPS_META, createTimelineClip } from "@haptic/core";
import { headerMetaForSave } from "./project-document-meta";

describe("headerMetaForSave", () => {
  it("lists a Scene's or Scene Layer's Timeline Clips, so the registry can index Timeline Assets", () => {
    const content = { actors: [], timelineClips: [{ ...createTimelineClip("intro", "Intro"), timelineAsset: "hall" }] };
    for (const type of ["Scene", "SceneLayer"]) {
      expect(headerMetaForSave(type, content)?.[TIMELINE_CLIPS_META]).toEqual([
        { id: "intro", name: "Intro", timelineAsset: "hall", length: 5, events: [] },
      ]);
    }
    expect(headerMetaForSave("Scene", { actors: [] })).toBeUndefined();
  });

  it("keeps a Timeline Asset's description", () => {
    expect(headerMetaForSave("Timeline", { description: "Hall", extra: 1 })).toEqual({ description: "Hall" });
  });
});
