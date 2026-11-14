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

  it("keeps a Blend Space's Skeleton, axes and samples, which graphs resolve their players from", () => {
    expect(headerMetaForSave("BlendSpace", {
      skeletonGuid: "rig",
      axes: [{ name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0, wrap: false }],
      samples: [{ animationGuid: "walk", x: 2, y: 0, rateScale: 1 }],
      stray: true,
    })).toEqual({
      skeletonGuid: "rig",
      previewModelGuid: null,
      axes: [{ name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0, wrap: false }],
      samples: [{ animationGuid: "walk", x: 2, y: 0, rateScale: 1 }],
    });
  });

  it("keeps a Sprite Blend Space's layout, hysteresis and Keep Time", () => {
    expect(headerMetaForSave("SpriteBlendSpace", { samples: [{ animationGuid: "walk", x: 0 }], hysteresis: 0.1, keepTime: false })).toMatchObject({
      samples: [{ animationGuid: "walk", x: 0, y: 0, rateScale: 1 }],
      hysteresis: 0.1,
      keepTime: false,
    });
  });
});
