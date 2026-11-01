import { describe, expect, it } from "vitest";
import { BOOL, EXEC, compileGraph, objectRef, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import {
  TIMELINE_PROXY_BIND_ACTOR_NODE_ID,
  TIMELINE_PROXY_BIND_COMPONENT_NODE_ID,
  TIMELINE_PROXY_GET_NODE_ID,
  TIMELINE_PROXY_UNBIND_ALL_NODE_ID,
  TIMELINE_PROXY_UNBIND_NODE_ID,
  timelineProxyNodeTitle,
} from "./timeline-proxies";

const registry = createDefaultNodeRegistry();
const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
  id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
});
const clip = { timelineClipDocument: "swing", timelineClipName: "Door Swing", timelineClipClassId: "TimelineClip:swing:clip" };
const door = { ...clip, timelineProxyId: "door", timelineProxyName: "Door", timelineProxyClassId: "Door", timelineProxyRepresents: "actor" };
const glow = { ...clip, timelineProxyId: "glow", timelineProxyName: "Glow", timelineProxyClassId: "LightComponent", timelineProxyRepresents: "component" };
const pins = (typeId: string, properties: Record<string, unknown> = {}) =>
  registry.get(typeId)!.pins(properties).map((entry) => [entry.id, entry.type, entry.optional === true]);

describe("Timeline Proxy nodes", () => {
  it("type the Target by the clip asset and the object by the picked proxy's Class", () => {
    expect(pins(TIMELINE_PROXY_BIND_ACTOR_NODE_ID, door)).toEqual([
      ["execIn", EXEC, false],
      ["execOut", EXEC, false],
      ["target", objectRef("TimelineClip:swing:clip"), false],
      ["actor", objectRef("Door"), false],
      ["absolute", BOOL, true],
    ]);
    expect(pins(TIMELINE_PROXY_BIND_COMPONENT_NODE_ID, glow)[3]).toEqual(["component", objectRef("LightComponent"), false]);
    expect(pins(TIMELINE_PROXY_GET_NODE_ID, glow)).toEqual([
      ["target", objectRef("TimelineClip:swing:clip"), false],
      ["object", objectRef("LightComponent"), false],
    ]);
    // Before a proxy is picked: the base classes.
    expect(pins(TIMELINE_PROXY_BIND_ACTOR_NODE_ID)[2]).toEqual(["target", objectRef("TimelineClip"), false]);
    expect(pins(TIMELINE_PROXY_BIND_ACTOR_NODE_ID)[3]).toEqual(["actor", objectRef("Actor"), false]);
    expect(pins(TIMELINE_PROXY_UNBIND_ALL_NODE_ID)[2]).toEqual(["target", objectRef("TimelineClip"), false]);
  });

  it("are titled after the picked proxy", () => {
    expect(timelineProxyNodeTitle(TIMELINE_PROXY_BIND_ACTOR_NODE_ID, door)).toBe("Bind Door Proxy");
    expect(timelineProxyNodeTitle(TIMELINE_PROXY_UNBIND_NODE_ID, door)).toBe("Unbind Door Proxy");
    expect(timelineProxyNodeTitle(TIMELINE_PROXY_GET_NODE_ID, glow)).toBe("Get Glow Proxy");
    expect(timelineProxyNodeTitle(TIMELINE_PROXY_BIND_COMPONENT_NODE_ID, {})).toBe("Bind Component to Timeline Proxy");
    expect(timelineProxyNodeTitle(TIMELINE_PROXY_GET_NODE_ID, {})).toBe("Get Timeline Proxy");
  });

  it("compile to the proxy host members", () => {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("clip", "variables.get", { variableName: "Swing", typeId: "object", typeClassId: "TimelineClip:swing:clip" }),
        node("self", "actor.getSelf"),
        node("bind", TIMELINE_PROXY_BIND_ACTOR_NODE_ID, { ...door, "default:absolute": true }),
        node("unbind", TIMELINE_PROXY_UNBIND_NODE_ID, glow),
        node("all", TIMELINE_PROXY_UNBIND_ALL_NODE_ID),
        node("get", TIMELINE_PROXY_GET_NODE_ID, door),
        node("print", "debug.print"),
      ],
      edges: [
        { id: "x1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "bind", targetPinId: "execIn" },
        { id: "x2", sourceNodeId: "bind", sourcePinId: "execOut", targetNodeId: "unbind", targetPinId: "execIn" },
        { id: "x3", sourceNodeId: "unbind", sourcePinId: "execOut", targetNodeId: "print", targetPinId: "execIn" },
        { id: "x4", sourceNodeId: "print", sourcePinId: "execOut", targetNodeId: "all", targetPinId: "execIn" },
        ...["bind", "unbind", "all", "get"].map((target) => ({ id: `t-${target}`, sourceNodeId: "clip", sourcePinId: "value", targetNodeId: target, targetPinId: "target" })),
        { id: "w1", sourceNodeId: "self", sourcePinId: "out", targetNodeId: "bind", targetPinId: "actor" },
        { id: "w2", sourceNodeId: "get", sourcePinId: "object", targetNodeId: "print", targetPinId: "value" },
      ],
    };
    const { source } = compileGraph(graph, { assetGuid: "class:door", registry });
    expect(source).toMatch(/ctx\.timelineProxy\(\w+, "bind", "door", \{ object: [^,]+, absolute: true \}\);/);
    expect(source).toMatch(/ctx\.timelineProxy\(\w+, "unbind", "glow", \{\}\);/);
    expect(source).toMatch(/ctx\.timelineProxy\(\w+, "unbindAll", "", \{\}\);/);
    expect(source).toMatch(/ctx\.timelineProxyGet\(\w+, "door"\)/);
  });
});
