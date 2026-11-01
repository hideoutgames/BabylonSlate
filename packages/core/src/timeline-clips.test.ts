import { describe, expect, it } from "vitest";
import { createDefaultScene } from "./project";
import { normalizeScene } from "./scene";
import { createDefaultSceneLayer, editorSceneToSceneLayer, normalizeSceneLayer, sceneLayerToEditorScene } from "./scene-layer";
import { createTimelineClip, normalizeTimelineClips, uniqueTimelineClipName } from "./timeline-clips";

describe("Timeline Clips", () => {
  it("names a clip uniquely, numbering from 2 and replacing a trailing number", () => {
    expect(uniqueTimelineClipName("Intro", [])).toBe("Intro");
    expect(uniqueTimelineClipName("Intro", ["Intro"])).toBe("Intro 2");
    expect(uniqueTimelineClipName("Intro 2", ["Intro", "Intro 2"])).toBe("Intro 3");
    expect(uniqueTimelineClipName("  ", [])).toBe("Timeline Clip");
  });

  it("keeps valid clips in order, drops repeated ids and makes names unique", () => {
    const clips = normalizeTimelineClips([
      createTimelineClip("a", "Intro"),
      { ...createTimelineClip("b", "Intro"), length: -3, frameRate: 31, playRate: -1, loopMode: "spin" },
      createTimelineClip("a", "Copy Of A"),
      { name: "No Id" },
    ]);
    expect(clips?.map((clip) => [clip.id, clip.name])).toEqual([["a", "Intro"], ["b", "Intro 2"]]);
    expect(clips?.[1]).toMatchObject({ length: 0.1, frameRate: 30, playRate: 0, loopMode: "once" });
    expect(normalizeTimelineClips([])).toBeUndefined();
    expect(normalizeTimelineClips("bad")).toBeUndefined();
  });

  it("sorts keys by time and drops tracks it cannot apply", () => {
    const [clip] = normalizeTimelineClips([{
      ...createTimelineClip("a", "Intro"),
      objects: [{ id: "o", actorId: "door", tracks: [
        { id: "t", target: { kind: "transform", property: "location" }, valueType: "vec3", keys: [
          { id: "k2", Time: 2, Value: { x: 0, y: 1, z: 0 }, Interpolation: "linear" },
          { id: "k1", Time: 1, Value: { x: 0, y: 0, z: 0 } },
          { id: "bad", Time: Number.NaN, Value: 0 },
        ] },
        { id: "u", target: { kind: "nowhere", property: "x" }, valueType: "float", keys: [] },
      ] }],
      eventTracks: [{ id: "e", name: "On Door Open", inputs: [], keys: [{ id: "e2", time: 3, values: {} }, { id: "e1", time: 1, values: { Volume: 1 } }] }],
    }])!;
    // A key without an interpolation is Auto, as in every curve.
    expect(clip.objects[0]!.tracks.map((track) => track.keys.map((key) => [key.id, key.Interpolation]))).toEqual([[["k1", "auto"], ["k2", "linear"]]]);
    expect(clip.eventTracks[0]!.keys.map((key) => key.id)).toEqual(["e1", "e2"]);
  });

  it("round-trips through Scenes and Scene Layers, including the Scene Layer editor conversions", () => {
    const timelineClips = [createTimelineClip("a", "Intro")];
    expect(normalizeScene({ ...createDefaultScene(), timelineClips }).timelineClips).toEqual(timelineClips);
    expect(normalizeScene(createDefaultScene())).not.toHaveProperty("timelineClips");
    const layer = normalizeSceneLayer({ ...createDefaultSceneLayer(), timelineClips });
    expect(layer.timelineClips).toEqual(timelineClips);
    expect(editorSceneToSceneLayer(sceneLayerToEditorScene(layer))).toEqual(layer);
  });
});
