import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import { OWNED_TIMELINE_CLIP_GET_NODE_ID } from "./scene-owned";
import { timelineClipNodes } from "./timeline-clips";

const registry = createDefaultNodeRegistry();
const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
  id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
});

describe("Timeline Clip nodes", () => {
  it("are exec controls and pure reads on a Timeline Clip subject", () => {
    for (const def of timelineClipNodes) {
      const target = def.pins({}).find((entry) => entry.id === "target");
      expect(target).toMatchObject({ subject: true, type: { kind: "objectRef", classId: "TimelineClip" } });
      expect(def.pure === true).toBe(def.id.startsWith("timelineClip.get") || def.id.startsWith("timelineClip.is"));
    }
  });

  it("compile to the Timeline Clip host members with their inputs", () => {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("clip", OWNED_TIMELINE_CLIP_GET_NODE_ID, { sceneTimelineClipId: "intro", sceneTimelineClipName: "Intro" }),
        node("rate", "timelineClip.setPlayRate", { "default:playRate": 2 }),
        node("mode", "timelineClip.setLoopMode", { "default:loopMode": "Ping Pong" }),
        node("position", "timelineClip.getPosition"),
        node("seek", "timelineClip.setPosition"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "rate", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "rate", sourcePinId: "execOut", targetNodeId: "mode", targetPinId: "execIn" },
        { id: "e3", sourceNodeId: "mode", sourcePinId: "execOut", targetNodeId: "seek", targetPinId: "execIn" },
        { id: "w1", sourceNodeId: "clip", sourcePinId: "clip", targetNodeId: "rate", targetPinId: "target" },
        { id: "w2", sourceNodeId: "clip", sourcePinId: "clip", targetNodeId: "mode", targetPinId: "target" },
        { id: "w3", sourceNodeId: "clip", sourcePinId: "clip", targetNodeId: "position", targetPinId: "target" },
        { id: "w4", sourceNodeId: "clip", sourcePinId: "clip", targetNodeId: "seek", targetPinId: "target" },
        { id: "w5", sourceNodeId: "position", sourcePinId: "position", targetNodeId: "seek", targetPinId: "time" },
      ],
    };
    const { source } = compileGraph(graph, { assetGuid: "Scene:level", registry });
    expect(source).toContain('ctx.getOwnedTimelineClip("intro")');
    expect(source).toMatch(/ctx\.timelineClipControl\([^)]*, "setPlayRate", \{ "playRate": 2 \}\)/);
    expect(source).toMatch(/ctx\.timelineClipControl\([^)]*, "setLoopMode", \{ "loopMode": "Ping Pong" \}\)/);
    expect(source).toContain('ctx.timelineClipState(');
    expect(source).toMatch(/"setPosition", \{ "time": /);
    // A null clip logs instead of running the node.
    expect(source).toContain("Set Timeline Clip Play Rate (Target) tried to access null.");
  });
});
