import { describe, expect, it } from "vitest";
import { EXEC, arrayOf, assetRef, compileGraph, objectRef, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import {
  TIMELINE_CREATE_CLIP_NODE_ID,
  TIMELINE_FROM_ASSET_NODE_ID,
  TIMELINE_GET_CLIP_NODE_ID,
  TIMELINE_LOADED_CLIPS_NODE_ID,
  timelineClipNodeTitle,
  timelineCreateClipNodeTitle,
} from "./timeline-assets";

const registry = createDefaultNodeRegistry();
const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
  id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
});
const pinType = (typeId: string, pinId: string, properties: Record<string, unknown> = {}) =>
  registry.get(typeId)!.pins(properties).find((entry) => entry.id === pinId)?.type;

describe("Timeline Asset nodes", () => {
  it("type the Timeline from the asset it names, else as a plain Timeline", () => {
    expect(pinType(TIMELINE_FROM_ASSET_NODE_ID, "timelineAsset")).toEqual(assetRef("Timeline"));
    expect(pinType(TIMELINE_FROM_ASSET_NODE_ID, "timeline")).toEqual(objectRef("Timeline"));
    expect(pinType(TIMELINE_FROM_ASSET_NODE_ID, "timeline", { "default:timelineAsset": "fx" })).toEqual(objectRef("Timeline:fx"));
    // A wired variable's default, which the editor resolves, wins.
    expect(pinType(TIMELINE_FROM_ASSET_NODE_ID, "timeline", { "default:timelineAsset": "fx", timelineAssetGuid: "story" }))
      .toEqual(objectRef("Timeline:story"));
    // Anything else wired there gives a plain Timeline.
    expect(pinType(TIMELINE_FROM_ASSET_NODE_ID, "timeline", { "default:timelineAsset": "fx", timelineAssetGuid: "" }))
      .toEqual(objectRef("Timeline"));
  });

  it("type a clip getter by its asset and clip class, and Get Loaded Timeline Clips as an array", () => {
    const properties = { timelineAssetGuid: "fx", timelineClipDocument: "level", timelineClipId: "intro", timelineClipName: "Intro", timelineClipClassId: "TimelineClip:level:intro" };
    expect(registry.get(TIMELINE_GET_CLIP_NODE_ID)!.pins(properties).map((entry) => [entry.id, entry.type, entry.subject === true])).toEqual([
      ["target", objectRef("Timeline:fx"), true],
      ["clip", objectRef("TimelineClip:level:intro"), false],
    ]);
    expect(timelineClipNodeTitle(properties)).toBe("Get Intro Timeline Clip");
    expect(timelineClipNodeTitle({})).toBe("Get Timeline Clip");
    expect(pinType(TIMELINE_LOADED_CLIPS_NODE_ID, "target")).toEqual(objectRef("Timeline"));
    expect(pinType(TIMELINE_LOADED_CLIPS_NODE_ID, "clips")).toEqual(arrayOf(objectRef("TimelineClip")));
  });

  it("compile to the Timeline host members", () => {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("timeline", TIMELINE_FROM_ASSET_NODE_ID, { "default:timelineAsset": "fx" }),
        node("clip", TIMELINE_GET_CLIP_NODE_ID, { timelineAssetGuid: "fx", timelineClipDocument: "level", timelineClipId: "intro", timelineClipName: "Intro" }),
        node("loaded", TIMELINE_LOADED_CLIPS_NODE_ID),
        node("play", "timelineClip.play"),
        node("length", "array.length"),
        node("print", "debug.print"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "play", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "play", sourcePinId: "execOut", targetNodeId: "print", targetPinId: "execIn" },
        { id: "w1", sourceNodeId: "timeline", sourcePinId: "timeline", targetNodeId: "clip", targetPinId: "target" },
        { id: "w2", sourceNodeId: "timeline", sourcePinId: "timeline", targetNodeId: "loaded", targetPinId: "target" },
        { id: "w3", sourceNodeId: "clip", sourcePinId: "clip", targetNodeId: "play", targetPinId: "target" },
        { id: "w4", sourceNodeId: "loaded", sourcePinId: "clips", targetNodeId: "length", targetPinId: "array" },
        { id: "w5", sourceNodeId: "length", sourcePinId: "out", targetNodeId: "print", targetPinId: "value" },
      ],
    };
    const { source } = compileGraph(graph, { assetGuid: "class:door", registry });
    expect(source).toContain('ctx.getTimeline("fx")');
    // The Target is null-checked first, like any subject.
    expect(source).toMatch(/ctx\.getTimelineClip\(\w+, "level", "intro"\)/);
    expect(source).toContain("ctx.getLoadedTimelineClips(");
  });

  const swing = {
    timelineAssetGuid: "fx", timelineClipDocument: "swing", timelineClipId: "clip", timelineClipName: "Door Swing", timelineClipClassId: "TimelineClip:swing:clip",
    timelineClipProxies: [
      { id: "door", name: "Door", represents: "actor", classId: "Door" },
      { id: "glow", name: "Glow", represents: "component", classId: "LightComponent" },
    ],
  };

  it("give Create <Name> Timeline Clip an input per proxy, typed to its Class, and the clip asset's class", () => {
    expect(registry.get(TIMELINE_CREATE_CLIP_NODE_ID)!.pins(swing).map((entry) => [entry.id, entry.name, entry.type])).toEqual([
      ["execIn", "exec", EXEC],
      ["execOut", "then", EXEC],
      ["target", "Target", objectRef("Timeline:fx")],
      ["proxy:door", "Door", objectRef("Door")],
      ["proxy:glow", "Glow", objectRef("LightComponent")],
      ["clip", "Timeline Clip", objectRef("TimelineClip:swing:clip")],
    ]);
    expect(timelineCreateClipNodeTitle(swing)).toBe("Create Door Swing Timeline Clip");
    expect(timelineCreateClipNodeTitle({})).toBe("Create Timeline Clip");
  });

  it("compile Create to the host member, with unconnected proxies left unbound", () => {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("timeline", TIMELINE_FROM_ASSET_NODE_ID, { "default:timelineAsset": "fx" }),
        node("self", "actor.getSelf"),
        node("create", TIMELINE_CREATE_CLIP_NODE_ID, swing),
        node("play", "timelineClip.play"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "create", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "create", sourcePinId: "execOut", targetNodeId: "play", targetPinId: "execIn" },
        { id: "w1", sourceNodeId: "timeline", sourcePinId: "timeline", targetNodeId: "create", targetPinId: "target" },
        { id: "w2", sourceNodeId: "self", sourcePinId: "out", targetNodeId: "create", targetPinId: "proxy:door" },
        { id: "w3", sourceNodeId: "create", sourcePinId: "clip", targetNodeId: "play", targetPinId: "target" },
      ],
    };
    const { source } = compileGraph(graph, { assetGuid: "class:door", registry });
    expect(source).toMatch(/= ctx\.createTimelineClip\(\w+, "swing", \{ "door": [^,]+, "glow": null \}\);/);
    expect(source).toContain("ctx.timelineClipControl(");
  });
});
