import { describe, expect, it } from "vitest";
import { createDefaultTimelineClipAsset, createTimelineClip, type SerializedTimelineClipAsset } from "@haptic/core";
import { timelineClipAssetDiagnostics, timelineClipDiagnostics } from "./timeline-clip-diagnostics";

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

describe("timelineClipAssetDiagnostics", () => {
  const anchor = { assetGuid: "assets/Swing.timelineclip3d.hasset", graphId: "doc" };
  const proxy = (id: string, name: string, represents: "actor" | "component", classId: string) => ({ id, name, represents, classId, tracks: [] });
  const check = (payload: SerializedTimelineClipAsset, twoD = false) => timelineClipAssetDiagnostics(payload, {
    twoD,
    timelineAssetName: (guid) => (guid === "story" ? "Story" : undefined),
    classExists: (classId) => classId !== "Gone",
  }, anchor).map((entry) => [entry.severity, entry.code, entry.message]);

  it("reports a clip asset without its Timeline Asset", () => {
    expect(check(createDefaultTimelineClipAsset(""))).toEqual([
      ["error", "timeline.clip_asset_unbound", "It has no Timeline Asset. Pick one under Timeline Asset in the Inspector."],
    ]);
    expect(check(createDefaultTimelineClipAsset("deleted"))).toEqual([
      ["error", "timeline.clip_asset_unbound", "Its Timeline Asset was deleted. Pick another under Timeline Asset in the Inspector."],
    ]);
    expect(check(createDefaultTimelineClipAsset("story"))).toEqual([]);
  });

  it("reports shared proxy names, deleted Classes and components that do not suit the clip's type", () => {
    const payload = {
      ...createDefaultTimelineClipAsset("story"),
      proxies: [
        proxy("a", "Door", "actor", "Actor"),
        proxy("b", "Door", "actor", "Actor"),
        proxy("c", "Ghost", "actor", "Gone"),
        proxy("d", "Badge", "component", "2DTextComponent"),
        proxy("e", "Glow", "component", "LightComponent"),
      ],
    };
    expect(check(payload)).toEqual([
      ["error", "timeline.proxy_name_collision", "2 proxies are named Door. Rename them so each has its own Create input and nodes."],
      ["error", "timeline.proxy_class_missing", "Ghost: its Class Gone no longer exists. Remove the proxy or add it again with another Class."],
      ["warning", "timeline.proxy_placement", "Badge: 2DTextComponent is not a 3D component, so no object in a Scene can stand in for it."],
    ]);
    // In a 2D clip the 2D Text suits; a component Scene Layers refuse does not.
    expect(check({ ...payload, proxies: payload.proxies.slice(3) }, true).map((entry) => entry[2])).not.toContain(expect.stringContaining("Badge"));
  });
});
