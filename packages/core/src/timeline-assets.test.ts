import { describe, expect, it } from "vitest";
import { createTimelineClip } from "./timeline-clips";
import {
  TIMELINE_CLIPS_META,
  normalizeTimelineAsset,
  readTimelineClipSummaries,
  timelineClipSummaries,
} from "./timeline-assets";

describe("Timeline Asset", () => {
  it("keeps only its description", () => {
    expect(normalizeTimelineAsset({ description: "Hall", clips: ["x"] })).toEqual({ description: "Hall" });
    expect(normalizeTimelineAsset(null)).toEqual({ description: "" });
  });

  it("summarizes a document's clips for its header and reads them back", () => {
    const intro = {
      ...createTimelineClip("intro", "Intro"),
      length: 4,
      timelineAsset: "hall",
      eventTracks: [{ id: "e", name: "On Line", inputs: [{ name: "Text", typeId: "string", direction: "in" as const }], keys: [{ id: "k", time: 1, values: {} }] }],
    };
    const outro = createTimelineClip("outro", "Outro");
    const summaries = timelineClipSummaries([intro, outro]);
    expect(summaries).toEqual([
      { id: "intro", name: "Intro", timelineAsset: "hall", length: 4, events: [{ name: "On Line", inputs: [{ name: "Text", typeId: "string", direction: "in" }] }] },
      { id: "outro", name: "Outro", length: 5, events: [] },
    ]);
    expect(readTimelineClipSummaries({ [TIMELINE_CLIPS_META]: JSON.parse(JSON.stringify(summaries)) })).toEqual(summaries);
    expect(readTimelineClipSummaries({ [TIMELINE_CLIPS_META]: [{ id: 1 }, "x", { id: "a", name: "A" }] }))
      .toEqual([{ id: "a", name: "A", length: 0, events: [] }]);
    expect(readTimelineClipSummaries(undefined)).toEqual([]);
  });
});
