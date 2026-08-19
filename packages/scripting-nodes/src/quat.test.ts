import { describe, expect, it } from "vitest";
import {
  FLOAT,
  QUAT,
  ROTATOR,
  VEC3,
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  ALL_NODE_CATEGORIES,
  createDefaultNodeRegistry,
  quatNodes,
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

describe("quaternion nodes", () => {
  it("registers Make/Break and quaternion math on the quaternion palette", () => {
    expect(ALL_NODE_CATEGORIES).toContain("quaternion");
    expect(quatNodes.map((entry) => entry.id)).toEqual([
      "quat.make",
      "quat.break",
      "quat.fromRotator",
      "quat.toRotator",
      "quat.multiply",
      "quat.inverse",
      "quat.slerp",
      "quat.rotateVector",
      "quat.normalize",
    ]);
    expect(quatNodes.every((entry) => entry.category === "quaternion")).toBe(
      true,
    );
  });

  it("Make/Break Quaternion use XYZW floats", () => {
    const registry = createDefaultNodeRegistry();
    const make = registry.get("quat.make")!;
    expect(make.title).toBe("Make Quaternion");
    expect(make.pins({}).map((pin) => pin.id)).toEqual([
      "x",
      "y",
      "z",
      "w",
      "out",
    ]);
    expect(make.pins({}).find((pin) => pin.id === "out")?.type).toEqual(QUAT);
    expect(registry.get("quat.break")!.pins({})[0]?.type).toEqual(QUAT);
    expect(registry.get("quat.fromRotator")!.pins({})[0]?.type).toEqual(ROTATOR);
    expect(registry.get("quat.toRotator")!.pins({})[1]?.type).toEqual(ROTATOR);
    expect(registry.get("quat.rotateVector")!.pins({})[1]?.type).toEqual(VEC3);
    expect(registry.get("quat.slerp")!.pins({})[2]?.type).toEqual(FLOAT);
  });

  it("compiles Slerp through ctx.slerpQuats", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "slerp", "quat.slerp"),
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
          sourceNodeId: "slerp",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.slerpQuats");
  });
});
