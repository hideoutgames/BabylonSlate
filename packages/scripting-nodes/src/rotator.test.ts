import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  createDefaultNodeRegistry,
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

  it.each([
    [{ pitch: 0, yaw: 360, roll: -180 }, { pitch: 720, yaw: 0, roll: 180 }, "true"],
    [{ pitch: 0, yaw: 359.9995, roll: 0 }, { pitch: 0, yaw: 0, roll: 0 }, "true"],
    [{ pitch: 0, yaw: 10, roll: 0 }, { pitch: 0, yaw: 370.1, roll: 0 }, "false"],
  ])("Rotator Nearly Equal compares %o and %o with wrapped axes", (a, b, expected) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "eq", "rotator.nearlyEqual", { "default:a": a, "default:b": b }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "eq", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void;
    const logged: string[] = [];
    onBeginPlay({
      formatValue: String,
      log: (_severity: string, _category: string, message: string) => logged.push(message),
    });
    expect(logged).toEqual([expected]);
  });
});
