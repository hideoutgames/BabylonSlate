import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
import { createDefaultNodeRegistry, transformNodes } from "./index";

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

describe("transform nodes", () => {
  it("compiles Set Actor Rotation through ctx.setActorRotation", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "set", "transform.setRotation"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "set",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.setActorRotation");
  });

  it("registers Add Actor World Offset and compiles through ctx.addActorWorldOffset", () => {
    expect(transformNodes.map((entry) => entry.id)).toContain(
      "transform.addWorldOffset",
    );
    expect(
      transformNodes.find((entry) => entry.id === "transform.addWorldOffset")
        ?.title,
    ).toBe("Add Actor World Offset");
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "offset", "transform.addWorldOffset"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "offset",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.addActorWorldOffset");
  });

  it.each([
    ["transform.getLocation", "position"],
    ["transform.getScale", "scale"],
  ] as const)("%s returns a copy, so a stored value does not follow the actor", (typeId, field) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [node(registry, "begin", "flow.event.beginPlay"), node(registry, "get", typeId), node(registry, "log", "debug.log")],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "get", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    // The runtime moves an actor by writing into these objects in place.
    const transform = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 4, y: 5, z: 6 } };
    const read: Array<{ x: number; y: number; z: number }> = [];
    const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+function\s+/g, "function ");
    (new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({
      self: { transform },
      nullAccess: () => {},
      formatValue: (value: unknown) => value,
      log: (_severity: string, _category: string, value: { x: number; y: number; z: number }) => read.push(value),
    });
    const before = { ...transform[field] };
    transform[field].x = 99;
    expect(read).toEqual([before]);
  });
});
