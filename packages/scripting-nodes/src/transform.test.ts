import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
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
  it("registers Get/Set Actor Location, Rotation, Scale, and Transform", () => {
    expect(transformNodes.map((entry) => entry.id)).toEqual([
      "transform.getLocation",
      "transform.setLocation",
      "transform.getRotation",
      "transform.setRotation",
      "transform.getScale",
      "transform.setScale",
      "transform.get",
      "transform.set",
      "transform.forward",
      "transform.right",
      "transform.up",
      "transform.addWorldOffset",
    ]);
    const registry = createDefaultNodeRegistry();
    expect(registry.get("transform.getRotation")?.title).toBe(
      "Get Actor Rotation",
    );
    expect(registry.get("transform.setRotation")?.title).toBe(
      "Set Actor Rotation",
    );
    expect(registry.get("transform.getScale")?.title).toBe("Get Actor Scale");
    expect(registry.get("transform.setScale")?.title).toBe("Set Actor Scale");
    expect(registry.get("transform.get")?.title).toBe("Get Actor Transform");
    expect(registry.get("transform.set")?.title).toBe("Set Actor Transform");
    expect(registry.get("transform.forward")?.title).toBe(
      "Get Actor Forward Vector",
    );
    expect(
      registry.get("transform.setRotation")?.pins({}).map((pin) => pin.name),
    ).toEqual(["exec", "then", "Target", "Rotation"]);
  });

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

  it("registers Add World Offset and compiles through ctx.addActorWorldOffset", () => {
    expect(transformNodes.map((entry) => entry.id)).toContain(
      "transform.addWorldOffset",
    );
    expect(
      transformNodes.find((entry) => entry.id === "transform.addWorldOffset")
        ?.title,
    ).toBe("Add World Offset");
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
});
