import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

const CHANNELS = ["r", "g", "b", "a"] as const;

describe("color nodes", () => {
  it.each([
    ["color.lerp", { "default:alpha": 0.5 }],
    ["color.multiply", {}],
    ["color.nearlyEqual", {}],
  ] as const)("%s reads a changing color once for every channel", (typeId, properties) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "color",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        ...CHANNELS.map((channel) => node(registry, `r${channel}`, "math.random")),
        node(registry, "make", "struct.makeColor"),
        node(registry, "op", typeId, { ...properties }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        ...CHANNELS.map((channel) => ({
          id: `w${channel}`, sourceNodeId: `r${channel}`, sourcePinId: "out", targetNodeId: "make", targetPinId: channel,
        })),
        { id: "e2", sourceNodeId: "make", sourcePinId: "out", targetNodeId: "op", targetPinId: "a" },
        { id: "e3", sourceNodeId: "op", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const body = compileGraph(graph, { assetGuid: "color", registry }).source
      .replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void;
    let samples = 0;
    onBeginPlay({ random: { float: () => (samples += 1) }, formatValue: (value: unknown) => value, log: () => {} });
    expect(samples).toBe(CHANNELS.length);
  });
});
