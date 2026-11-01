import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import type { ProjectTimelineClip } from "./timeline-asset-index";
import {
  refreshTimelineClipNodes,
  timelineProxyPickerRows,
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

const swing: ProjectTimelineClip = {
  clip: {
    id: "clip", name: "Door Swing", length: 2, timelineAsset: "story",
    events: [{ name: "On Open", inputs: [] }],
    proxies: [{ id: "door", name: "Door", represents: "actor", classId: "Door" }, { id: "glow", name: "Glow", represents: "component", classId: "LightComponent" }],
  },
  documentPath: "/swing.timelineclip3d.hasset",
  documentKind: "timeline-clip-3d",
  documentName: "Door Swing",
  documentGuid: "swing",
};

const assets = timelineScriptAssets(
  [asset("story", "Story"), asset("empty", "Empty"), { header: { type: "Scene", guid: "level", name: "Main" } }],
  [clip("level", "intro", "Intro", "story"), clip("hud", "reveal", "Reveal", "story"), clip("level", "free", "Free"), swing],
);

describe("timelineScriptAssets", () => {
  it("lists every Timeline Asset with the scene clips and clip assets bound to it", () => {
    expect(assets.map((entry) => [entry.classId, entry.clips.map((entry) => entry.classId), entry.clipAssets.map((entry) => entry.classId)])).toEqual([
      ["Timeline:story", ["TimelineClip:level:intro", "TimelineClip:hud:reveal"], ["TimelineClip:swing:clip"]],
      ["Timeline:empty", [], []],
    ]);
    expect(assets[0]!.clipAssets[0]!.proxies.map((proxy) => proxy.name)).toEqual(["Door", "Glow"]);
    expect(timelineScriptClassIds(assets)).toEqual([
      "Timeline:story", "TimelineClip:level:intro", "TimelineClip:hud:reveal", "TimelineClip:swing:clip", "Timeline:empty",
    ]);
  });

  it("re-fires each clip's events and On Finished and On Looped, with the clip as the last input", () => {
    expect(timelineRefiredDispatchers(assets[0]!).map((entry) => [entry.name, entry.pins.map((pin) => pin.name)])).toEqual([
      ["On Line (Intro)", ["Text", "Timeline Clip"]],
      ["On Finished (Intro)", ["Timeline Clip"]],
      ["On Looped (Intro)", ["Timeline Clip"]],
      ["On Finished (Reveal)", ["Timeline Clip"]],
      ["On Looped (Reveal)", ["Timeline Clip"]],
      ["On Open (Door Swing)", ["Timeline Clip"]],
      ["On Finished (Door Swing)", ["Timeline Clip"]],
      ["On Looped (Door Swing)", ["Timeline Clip"]],
    ]);
    const symbols = timelineScriptSymbols(assets);
    expect(symbols.find((entry) => entry.name === "On Line (Intro)")).toMatchObject({ kind: "dispatcher", classId: "Timeline:story" });
    // The clip's own Custom Event Track is a dispatcher of its class too.
    expect(symbols.find((entry) => entry.name === "On Line")).toMatchObject({ kind: "dispatcher", classId: "TimelineClip:level:intro" });
    expect(symbols.find((entry) => entry.name === "On Open")).toMatchObject({ kind: "dispatcher", classId: "TimelineClip:swing:clip" });
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

  it("gives a Create node the clip asset's current name and an input per current proxy, and reports one that left", () => {
    const stale = {
      timelineAssetGuid: "story", timelineClipDocument: "swing", timelineClipId: "clip", timelineClipName: "Swing",
      timelineClipProxies: [{ id: "door", name: "Door", represents: "actor", classId: "Door" }],
    };
    const create = (data: Record<string, unknown>): SerializedGraph => ({ nodes: [{ id: "create", type: "timeline.createClip", position: { x: 0, y: 0 }, data }], edges: [] });
    const refreshed = refreshTimelineClipNodes(create(stale), assets);
    expect(refreshed.nodes[0]!.data).toMatchObject({
      title: "Create Door Swing Timeline Clip", timelineClipClassId: "TimelineClip:swing:clip",
      timelineClipProxies: [expect.objectContaining({ id: "door" }), expect.objectContaining({ id: "glow", represents: "component" })],
    });
    // Already current: nothing changes.
    expect(refreshTimelineClipNodes(refreshed, assets)).toBe(refreshed);
    expect(timelineGraphDiagnostics(create(stale), assets, anchor)).toEqual([]);
    expect(timelineGraphDiagnostics(create({ ...stale, timelineClipDocument: "gone" }), assets, anchor)).toEqual([expect.objectContaining({
      code: "timeline.clip_not_in_asset", nodeId: "create", message: "Create Swing Timeline Clip: the Timeline Clip is no longer in Story.",
    })]);
  });

  it("keeps proxy nodes on their proxy, and reports a removed proxy or a Bind of the wrong kind", () => {
    const proxyNode = (type: string, data: Record<string, unknown>): SerializedGraph => ({ nodes: [{ id: "proxy", type, position: { x: 0, y: 0 }, data }], edges: [] });
    const stale = { timelineClipDocument: "swing", timelineClipName: "Swing", timelineProxyId: "door", timelineProxyName: "Panel", timelineProxyRepresents: "actor" };
    expect(refreshTimelineClipNodes(proxyNode("timelineProxy.bindActor", stale), assets).nodes[0]!.data).toMatchObject({
      title: "Bind Door Proxy", timelineProxyName: "Door", timelineProxyClassId: "Door", timelineClipName: "Door Swing", timelineClipClassId: "TimelineClip:swing:clip",
    });
    expect(timelineGraphDiagnostics(proxyNode("timelineProxy.bindActor", stale), assets, anchor)).toEqual([]);
    const codes = (type: string, data: Record<string, unknown>) =>
      timelineGraphDiagnostics(proxyNode(type, data), assets, anchor).map((entry) => [entry.code, entry.message]);
    expect(codes("timelineProxy.get", { ...stale, timelineProxyId: "lantern", timelineProxyName: "Lantern" })).toEqual([
      ["timeline.proxy_member_missing", "Get Lantern Proxy: Door Swing has no Lantern proxy any more."],
    ]);
    expect(codes("timelineProxy.unbind", { timelineClipDocument: "swing" })).toEqual([
      ["timeline.proxy_member_missing", "Unbind Timeline Proxy: pick a proxy in the Inspector."],
    ]);
    expect(codes("timelineProxy.bindActor", { ...stale, timelineProxyId: "glow", timelineProxyName: "Glow" })).toEqual([
      ["timeline.proxy_kind_mismatch", "Bind Glow Proxy: Glow stands in for a component. Use Bind Component to Timeline Proxy."],
    ]);
  });

  it("offers a Bind node the clip asset's proxies of its kind in the Inspector, and picking one retypes the node", () => {
    const patches: Array<Record<string, unknown>> = [];
    const clipAsset = assets[0]!.clipAssets[0]!;
    const [row] = timelineProxyPickerRows("timelineProxy.bindComponent", { timelineClipDocument: "swing" }, clipAsset, (patch) => patches.push(patch));
    expect(row).toMatchObject({ kind: "enum", label: "Proxy", options: [{ value: "glow", label: "Glow" }] });
    (row as { onChange: (value: string) => void }).onChange("glow");
    expect(patches).toEqual([expect.objectContaining({ timelineProxyId: "glow", timelineProxyClassId: "LightComponent", title: "Bind Glow Proxy" })]);
    // Unbind and Get list every proxy; other nodes have no row.
    expect((timelineProxyPickerRows("timelineProxy.get", {}, clipAsset, () => {})[0] as { options: unknown[] }).options).toHaveLength(2);
    expect(timelineProxyPickerRows("timeline.createClip", {}, clipAsset, () => {})).toEqual([]);
  });

  it("warns where a node or a variable's default names a Timeline Asset with no clips", () => {
    const named = (guid: string): SerializedGraph => ({
      nodes: [{ id: "from", type: "timeline.fromAsset", position: { x: 0, y: 0 }, data: { "default:timelineAsset": guid } }],
      edges: [],
      members: [{ id: "v", kind: "variable", name: "Cutscene", typeId: "asset", typeClassId: "Timeline", defaultValue: guid }],
    });
    expect(timelineGraphDiagnostics(named("empty"), assets, anchor).map((entry) => [entry.severity, entry.code, entry.nodeId, entry.message])).toEqual([
      ["warning", "timeline.asset_empty", "from", "Empty holds no Timeline Clips yet. Bind a clip to it in a Scene's or Scene Layer's Clips window, or create a 2D or 3D Timeline Clip asset for it."],
      ["warning", "timeline.asset_empty", undefined, "Cutscene: Empty holds no Timeline Clips yet."],
    ]);
    expect(timelineGraphDiagnostics(named("story"), assets, anchor)).toEqual([]);
  });
});
