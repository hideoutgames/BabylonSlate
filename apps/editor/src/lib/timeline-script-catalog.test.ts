import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import type { ProjectTimelineClip } from "./timeline-asset-index";
import {
  refreshTimelineClipNodes,
  timelineGraphDiagnostics,
  timelineRefiredDispatchers,
  timelineScriptAssets,
  timelineScriptClassIds,
  timelineScriptSymbols,
} from "./timeline-script-catalog";

const asset = (guid: string, name: string) => ({ header: { type: "Timeline", guid, name } });
const clip = (documentGuid: string, id: string, name: string, timelineAsset?: string): ProjectTimelineClip => ({
  clip: { id, name, length: 5, ...(timelineAsset ? { timelineAsset } : {}), events: id === "intro" ? [{ name: "On Line", inputs: [{ name: "Text", typeId: "string", direction: "in" }] }] : [] },
  documentPath: `/${documentGuid}.scene.hasset`,
  documentKind: "scene",
  documentName: documentGuid === "level" ? "Main" : "HUD",
  documentGuid,
});

const assets = timelineScriptAssets(
  [asset("story", "Story"), asset("empty", "Empty"), { header: { type: "Scene", guid: "level", name: "Main" } }],
  [clip("level", "intro", "Intro", "story"), clip("hud", "reveal", "Reveal", "story"), clip("level", "free", "Free")],
);

describe("timelineScriptAssets", () => {
  it("lists every Timeline Asset with the scene clips bound to it", () => {
    expect(assets.map((entry) => [entry.classId, entry.clips.map((entry) => entry.classId)])).toEqual([
      ["Timeline:story", ["TimelineClip:level:intro", "TimelineClip:hud:reveal"]],
      ["Timeline:empty", []],
    ]);
    expect(timelineScriptClassIds(assets)).toEqual(["Timeline:story", "TimelineClip:level:intro", "TimelineClip:hud:reveal", "Timeline:empty"]);
  });

  it("re-fires each clip's events and On Finished and On Looped, with the clip as the last input", () => {
    expect(timelineRefiredDispatchers(assets[0]!).map((entry) => [entry.name, entry.pins.map((pin) => pin.name)])).toEqual([
      ["On Line (Intro)", ["Text", "Timeline Clip"]],
      ["On Finished (Intro)", ["Timeline Clip"]],
      ["On Looped (Intro)", ["Timeline Clip"]],
      ["On Finished (Reveal)", ["Timeline Clip"]],
      ["On Looped (Reveal)", ["Timeline Clip"]],
    ]);
    const symbols = timelineScriptSymbols(assets);
    expect(symbols.find((entry) => entry.name === "On Line (Intro)")).toMatchObject({ kind: "dispatcher", classId: "Timeline:story" });
    // The clip's own Custom Event Track is a dispatcher of its class too.
    expect(symbols.find((entry) => entry.name === "On Line")).toMatchObject({ kind: "dispatcher", classId: "TimelineClip:level:intro" });
  });
});

describe("Timeline graph nodes", () => {
  const graph = (data: Record<string, unknown>, extra: Partial<SerializedGraph> = {}): SerializedGraph => ({
    nodes: [{ id: "get", type: "timeline.getClip", position: { x: 0, y: 0 }, data }],
    edges: [],
    ...extra,
  });
  const anchor = { assetGuid: "door", graphId: "graph:door" };

  it("follows a clip's rename and reports a clip that left its asset", () => {
    const stale = { timelineAssetGuid: "story", timelineClipDocument: "level", timelineClipId: "intro", timelineClipName: "Opening", title: "Get Opening Timeline Clip" };
    expect(refreshTimelineClipNodes(graph(stale), assets).nodes[0]!.data).toMatchObject({
      timelineClipName: "Intro", timelineClipClassId: "TimelineClip:level:intro", title: "Get Intro Timeline Clip",
    });
    expect(timelineGraphDiagnostics(graph(stale), assets, anchor)).toEqual([]);

    const gone = { ...stale, timelineClipId: "free" };
    expect(refreshTimelineClipNodes(graph(gone), assets).nodes[0]!.data).toBe(gone);
    expect(timelineGraphDiagnostics(graph(gone), assets, anchor)).toEqual([expect.objectContaining({
      severity: "error", code: "timeline.clip_not_in_asset", nodeId: "get",
      message: "Get Opening Timeline Clip: the Timeline Clip is no longer in Story.",
    })]);
  });

  it("warns where a node or a variable's default names a Timeline Asset with no clips", () => {
    const named = (guid: string): SerializedGraph => ({
      nodes: [{ id: "from", type: "timeline.fromAsset", position: { x: 0, y: 0 }, data: { "default:timelineAsset": guid } }],
      edges: [],
      members: [{ id: "v", kind: "variable", name: "Cutscene", typeId: "asset", typeClassId: "Timeline", defaultValue: guid }],
    });
    expect(timelineGraphDiagnostics(named("empty"), assets, anchor).map((entry) => [entry.severity, entry.code, entry.nodeId, entry.message])).toEqual([
      ["warning", "timeline.asset_empty", "from", "Empty holds no Timeline Clips yet. Bind a clip to it in a Scene's or Scene Layer's Clips window."],
      ["warning", "timeline.asset_empty", undefined, "Cutscene: Empty holds no Timeline Clips yet."],
    ]);
    expect(timelineGraphDiagnostics(named("story"), assets, anchor)).toEqual([]);
  });
});
