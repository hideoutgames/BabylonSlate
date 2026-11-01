import { describe, expect, it } from "vitest";
import { TIMELINE_CLIPS_META, createTimelineClip, timelineClipSummaries, type SerializedScene } from "@haptic/core";
import {
  bindTimelineClip,
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
