import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph, type NodeRegistry } from "@haptic/scripting";
import { createDefaultNodeRegistry, decalNodes } from "./index";

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

describe("decal nodes", () => {
  it("compiles decals.spawn with size, lifetime, and fadeOutDuration defaults", () => {
    expect(decalNodes.map((definition) => definition.id)).toEqual(["decals.spawn"]);
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "spawn", "decals.spawn", { "default:texture": "scorch-tex" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "spawn", targetPinId: "execIn" },
      ],
    };
    const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as { onBeginPlay: (ctx: unknown) => void };
    const calls: unknown[][] = [];
    mod.onBeginPlay({
      self: { guid: "self" },
      spawnDecal: (...args: unknown[]) => { calls.push(args); },
    });
    expect(calls).toHaveLength(1);
    expect([calls[0]![0], calls[0]![3], calls[0]![4], calls[0]![5]]).toEqual([
      "scorch-tex",
      { x: 1, y: 1, z: 1 },
      10,
      1,
    ]);
  });
});
