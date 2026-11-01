import { describe, expect, it } from "vitest";
import {
  TIMELINE_CLIPS_META,
  createDefaultTimelineClipAsset,
  createTimelineClip,
  timelineClipAssetSummaries,
  timelineClipSummaries,
  type SerializedScene,
} from "@haptic/core";
import {
  bindTimelineClip,
  isSceneClipDocument,
  projectTimelineClips,
  timelineAssetClips,
  timelineBindBlocker,
  timelineClipNameCollisions,
} from "./timeline-asset-index";
import { timelineClipBindingDiagnostics } from "./timeline-clip-diagnostics";

const clip = (id: string, name: string, timelineAsset?: string) => ({ ...createTimelineClip(id, name), ...(timelineAsset ? { timelineAsset } : {}) });
const asset = (path: string, type: string, name: string, clips: ReturnType<typeof clip>[] = []) => ({
  path,
  header: { type, guid: `${name}-guid`, name, payload: clips.length ? { [TIMELINE_CLIPS_META]: timelineClipSummaries(clips) } : {} },
});

const assets = [
  asset("assets/Main.scene.hasset", "Scene", "Main", [clip("intro", "Intro", "hall"), clip("door", "Door Open")]),
  asset("assets/Hud.scenelayer.hasset", "SceneLayer", "Hud", [clip("lights", "Hall Lights", "hall")]),
  asset("assets/Hall.timeline.hasset", "Timeline", "Hall"),
];

describe("Timeline Asset index", () => {
  it("lists the clips each asset holds from document headers, an open document's clips first", () => {
    expect(timelineAssetClips(projectTimelineClips(assets, []), "hall").map((entry) => [entry.clip.name, entry.documentName, entry.documentKind]))
      .toEqual([["Intro", "Main", "scene"], ["Hall Lights", "Hud", "scene-layer"]]);
    // The open Main has the door bound and the intro unbound, not yet saved.
    const open = { ref: { kind: "scene", path: "assets/Main.scene.hasset" }, content: { timelineClips: [clip("intro", "Intro"), clip("door", "Door Open", "hall")] } };
    expect(timelineAssetClips(projectTimelineClips(assets, [open]), "hall").map((entry) => entry.clip.name)).toEqual(["Door Open", "Hall Lights"]);
  });

  it("lists a clip asset's clip under the asset's name, an open clip asset's edits first", () => {
    const swing = { ...createDefaultTimelineClipAsset("hall"), length: 2 };
    const clipAssets = [
      ...assets,
      { path: "assets/Swing.timelineclip3d.hasset", header: { type: "TimelineClip3D", guid: "swing", name: "Door Swing", payload: timelineClipAssetSummaries(swing, "") } },
    ];
    const listed = timelineAssetClips(projectTimelineClips(clipAssets, []), "hall");
    expect(listed.map((entry) => [entry.clip.name, entry.clip.length, entry.documentKind, isSceneClipDocument(entry.documentKind)])).toEqual([
      ["Intro", 5, "scene", true], ["Hall Lights", 5, "scene-layer", true], ["Door Swing", 2, "timeline-clip-3d", false],
    ]);
    const open = { ref: { kind: "timeline-clip-3d", path: "assets/Swing.timelineclip3d.hasset" }, content: { ...swing, timelineAsset: "other" } };
    expect(timelineAssetClips(projectTimelineClips(clipAssets, [open]), "hall").map((entry) => entry.clip.name)).toEqual(["Intro", "Hall Lights"]);
  });

  it("refuses a clip whose name the asset already holds, but not the clip itself", () => {
    const clips = projectTimelineClips(assets, []);
    const other = { documentPath: "assets/Other.scene.hasset", clipId: "x", clipName: "Intro" };
    expect(timelineBindBlocker(clips, "hall", other)).toBe("Already holds a clip named Intro (Main).");
    expect(timelineBindBlocker(clips, "hall", { documentPath: "assets/Main.scene.hasset", clipId: "intro", clipName: "Intro" })).toBeUndefined();
    expect(timelineBindBlocker(clips, "hall", { ...other, clipName: "Outro" })).toBeUndefined();
  });

  it("binds and unbinds a clip", () => {
    const scene = { actors: [], settings: {}, timelineClips: [clip("intro", "Intro")] } as unknown as SerializedScene;
    const bound = bindTimelineClip(scene, "intro", "hall");
    expect(bound.timelineClips![0]!.timelineAsset).toBe("hall");
    expect(bindTimelineClip(bound, "intro", "hall")).toBe(bound);
    expect(bindTimelineClip(bound, "intro", undefined).timelineClips![0]).not.toHaveProperty("timelineAsset");
  });

  it("reports two clips of one asset that share a name, in each owner's document", () => {
    const clashing = [...assets, asset("assets/Lobby.scene.hasset", "Scene", "Lobby", [clip("intro-2", "Intro", "hall")])];
    const clips = projectTimelineClips(clashing, []);
    expect(timelineClipNameCollisions(clips).map((entry) => entry.documentName)).toEqual(["Main", "Lobby"]);
    const diagnostics = timelineClipBindingDiagnostics(clips, "assets/Main.scene.hasset", { assetGuid: "assets/Main.scene.hasset", graphId: "scene:main" },
      (guid) => (guid === "hall" ? "Hall" : undefined));
    expect(diagnostics.map((entry) => [entry.code, entry.severity, entry.message])).toEqual([[
      "timeline.clip_name_collision", "error", "Intro: Hall already holds another clip with this name (Lobby). Rename one of them.",
    ]]);
  });
});
