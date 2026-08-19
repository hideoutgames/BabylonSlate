import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  ALL_NODE_CATEGORIES,
  createDefaultNodeRegistry,
  rotatorNodes,
} from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("rotator nodes", () => {
  it("registers rotator math on the rotator palette", () => {
    expect(ALL_NODE_CATEGORIES).toContain("rotator");
    expect(rotatorNodes.map((entry) => entry.id)).toEqual([
      "rotator.combine",
      "rotator.delta",
      "rotator.inverse",
      "rotator.lerp",
      "rotator.forward",
      "rotator.right",
      "rotator.up",
      "rotator.lookAt",
      "rotator.nearlyEqual",
    ]);
    expect(rotatorNodes.every((entry) => entry.category === "rotator")).toBe(
      true,
    );
  });

  it("keeps Make/Break Rotator ids and lists them under rotator", () => {
    const registry = createDefaultNodeRegistry();
    expect(registry.get("struct.makeRotator")?.category).toBe("rotator");
    expect(registry.get("struct.breakRotator")?.category).toBe("rotator");
    expect(registry.get("struct.makeRotator")?.title).toBe("Make Rotator");
  });

  it("compiles Combine Rotators through ctx.combineRotators", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "combine", "rotator.combine"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "combine",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.combineRotators");
  });
});
