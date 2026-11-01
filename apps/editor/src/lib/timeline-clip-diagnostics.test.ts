import { describe, expect, it } from "vitest";
import { createTimelineClip } from "@haptic/core";
import { timelineClipDiagnostics } from "./timeline-clip-diagnostics";

const track = (name: string) => ({ id: name, name, inputs: [], keys: [] });

describe("timelineClipDiagnostics", () => {
  it("reports Custom Event Tracks a script cannot tell apart", () => {
    const clip = { ...createTimelineClip("intro", "Intro"), eventTracks: [track("On Beat"), track("On_Beat"), track("On Finished"), track("On Line")] };
    const diagnostics = timelineClipDiagnostics([clip], { assetGuid: "level", graphId: "scene:level" });
    expect(diagnostics.map((entry) => [entry.code, entry.severity, entry.message])).toEqual([
      ["timeline.event_name_collision", "error", 'Intro: two Custom Event Tracks are named "On_Beat" and "On Beat".'],
      ["timeline.event_name_collision", "error", 'Intro: "On Finished" is the name of a built-in Timeline Clip event.'],
    ]);
    expect(timelineClipDiagnostics([{ ...clip, eventTracks: [track("On Line")] }], { assetGuid: "level", graphId: "g" })).toEqual([]);
  });
});
