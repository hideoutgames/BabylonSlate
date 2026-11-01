import { describe, expect, it } from "vitest";
import {
  TIMELINE_PROXY_COLORS,
  createDefaultTimelineClipAsset,
  isTimelineClipAssetType,
  normalizeTimelineClipAsset,
  stripTimelineClipAssetEditorData,
  timelineClipAssetSummaries,
  timelineClipOfAsset,
  withTimelineClipOfAsset,
} from "./timeline-clip-assets";
import { readTimelineClipSummaries } from "./timeline-assets";

const key = (id: string, Time: number, Value: unknown) => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });

const authored = {
  timelineAsset: "story",
  length: 3,
  frameRate: 24,
  loopMode: "pingPong",
  proxies: [
    { id: "door", name: "Door", represents: "actor", classId: "Door", tracks: [
      { id: "t-rot", target: { kind: "transform", property: "rotation" }, valueType: "rotator", keys: [key("k0", 0, { pitch: 0, yaw: 0, roll: 0 })] },
    ] },
    { id: "glow", name: "Handle Glow", represents: "component", classId: "LightComponent", tracks: [] },
    { id: "door", name: "Repeated", represents: "actor", classId: "Door", tracks: [] },
    { id: "nameless", represents: "actor", classId: "Lantern" },
    { id: "classless", name: "Gone", represents: "actor" },
  ],
  eventTracks: [{ id: "e", name: "On Creak", inputs: [], keys: [{ id: "ek", time: 1, values: {} }] }],
  editorPreview: { proxies: { door: { color: "#FF0000", representation: "model", size: 2, location: [1, 0, 2], rotation: [0, 90, 0], previewAs: "absolute", assetGuid: "door-model" } } },
};

describe("Timeline Clip assets", () => {
  it("has two separate types", () => {
    expect(isTimelineClipAssetType("TimelineClip2D")).toBe(true);
    expect(isTimelineClipAssetType("TimelineClip3D")).toBe(true);
    expect(isTimelineClipAssetType("Timeline")).toBe(false);
    expect(createDefaultTimelineClipAsset("story")).toEqual({
      timelineAsset: "story", length: 5, frameRate: 30, playRate: 1, loopMode: "once", whenFinished: "keep", proxies: [], eventTracks: [],
    });
  });

  it("normalizes proxies, tracks and every proxy's editor preview", () => {
    const payload = normalizeTimelineClipAsset(authored);
    expect(payload.proxies.map((proxy) => [proxy.id, proxy.name, proxy.represents, proxy.classId, proxy.tracks.length])).toEqual([
      ["door", "Door", "actor", "Door", 1],
      ["glow", "Handle Glow", "component", "LightComponent", 0],
      // A proxy without a name takes its class's.
      ["nameless", "Lantern", "actor", "Lantern", 0],
    ]);
    expect(payload).toMatchObject({ timelineAsset: "story", length: 3, frameRate: 24, loopMode: "pingPong", eventTracks: [{ name: "On Creak" }] });
    expect(payload.editorPreview?.proxies.door).toEqual({
      color: "#ff0000", representation: "model", size: 2, location: [1, 0, 2], rotation: [0, 90, 0], previewAs: "absolute", assetGuid: "door-model",
    });
    // The others take the palette in order and the defaults.
    expect(payload.editorPreview?.proxies.glow).toMatchObject({ color: TIMELINE_PROXY_COLORS[1], representation: "outline", previewAs: "relative" });
    expect(normalizeTimelineClipAsset(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it("strips the editor-only preview for Play and export", () => {
    const stripped = stripTimelineClipAssetEditorData(normalizeTimelineClipAsset(authored));
    expect(stripped).not.toHaveProperty("editorPreview");
    expect(JSON.stringify(stripped)).not.toContain("door-model");
  });

  it("edits through the shared clip shape, each proxy an object track", () => {
    const payload = normalizeTimelineClipAsset(authored);
    const clip = timelineClipOfAsset(payload, "Door Swing");
    expect(clip).toMatchObject({ id: "clip", name: "Door Swing", autoPlay: false, timelineAsset: "story", length: 3 });
    expect(clip.objects.map((object) => [object.id, object.actorId, object.tracks.length])).toEqual([["door", "door", 1], ["glow", "glow", 0], ["nameless", "nameless", 0]]);
    const edited = {
      ...clip, length: 4,
      objects: [{ ...clip.objects[1]!, tracks: [{ id: "t-int", target: { kind: "component" as const, componentId: "glow", property: "intensity" }, valueType: "float" as const, keys: [] }] }],
    };
    const next = withTimelineClipOfAsset(payload, edited);
    expect(next.length).toBe(4);
    // Proxies keep their order; one without an object track has no tracks.
    expect(next.proxies.map((proxy) => [proxy.id, proxy.tracks.map((track) => track.id)])).toEqual([["door", []], ["glow", ["t-int"]], ["nameless", []]]);
    expect(next.editorPreview).toBe(payload.editorPreview);
  });

  it("lists its clip in its header as Scene headers do", () => {
    const meta = timelineClipAssetSummaries(normalizeTimelineClipAsset(authored), "Door Swing");
    expect(readTimelineClipSummaries(meta)).toEqual([{ id: "clip", name: "Door Swing", timelineAsset: "story", length: 3, events: [{ name: "On Creak", inputs: [] }] }]);
  });
});
