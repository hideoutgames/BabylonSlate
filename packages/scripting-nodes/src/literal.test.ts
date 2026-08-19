import { describe, expect, it } from "vitest";
import {
  BOOL,
  FLOAT,
  INT,
  STRING,
  classRef,
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  ALL_NODE_CATEGORIES,
  createDefaultNodeRegistry,
  literalNodes,
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

describe("literal nodes", () => {
  it("registers Make Bool, Int, Float, String, and Class on the literal palette", () => {
    expect(ALL_NODE_CATEGORIES).toContain("literal");
    expect(literalNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "literal.makeBool",
        "literal.makeInt",
        "literal.makeFloat",
        "literal.makeString",
        "literal.makeClass",
      ]),
    );
    expect(literalNodes.every((entry) => entry.category === "literal")).toBe(
      true,
    );
    expect(literalNodes.every((entry) => entry.pure === true)).toBe(true);
  });

  it("uses Title Case Make titles and In/Out pins of the same type", () => {
    const registry = createDefaultNodeRegistry();
    const makeInt = registry.get("literal.makeInt")!;
    expect(makeInt.title).toBe("Make Int");
    expect(makeInt.pins({}).map((pin) => ({
      id: pin.id,
      name: pin.name,
      direction: pin.direction,
      type: pin.type,
    }))).toEqual([
      { id: "in", name: "In", direction: "in", type: INT },
      { id: "out", name: "Out", direction: "out", type: INT },
    ]);
    expect(registry.get("literal.makeBool")!.title).toBe("Make Bool");
    expect(registry.get("literal.makeFloat")!.pins({})[0]?.type).toEqual(FLOAT);
    expect(registry.get("literal.makeString")!.pins({})[0]?.type).toEqual(STRING);
    expect(registry.get("literal.makeBool")!.pins({})[0]?.type).toEqual(BOOL);
    expect(registry.get("literal.makeClass")!.pins({})[0]?.type).toEqual(
      classRef("BObject"),
    );
  });

  it("compiles an unconnected Make String from the pin default", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "literal.makeString", {
          "default:in": "hello",
        }),
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
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('"hello"');
  });

  it("compiles a wired Make Int as a pass-through into Make Float", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "makeInt", "literal.makeInt", { "default:in": 7 }),
        node(registry, "makeFloat", "literal.makeFloat"),
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
          sourceNodeId: "makeInt",
          sourcePinId: "out",
          targetNodeId: "makeFloat",
          targetPinId: "in",
        },
        {
          id: "e3",
          sourceNodeId: "makeFloat",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("7");
  });

  it("registers typed To String nodes for scalars, vectors, and rotator", () => {
    expect(literalNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "literal.toStringBool",
        "literal.toStringInt",
        "literal.toStringFloat",
        "literal.toStringVec2",
        "literal.toStringVec3",
        "literal.toStringVec4",
        "literal.toStringRotator",
      ]),
    );
    const toInt = createDefaultNodeRegistry().get("literal.toStringInt")!;
    expect(toInt.title).toBe("To String (Int)");
    expect(toInt.pins({})[0]?.type).toEqual(INT);
    expect(toInt.pins({})[1]?.type).toEqual(STRING);
  });

  it("compiles To String (Float) through formatValue", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "literal.makeFloat", { "default:in": 1.5 }),
        node(registry, "toString", "literal.toStringFloat"),
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
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "toString",
          targetPinId: "in",
        },
        {
          id: "e3",
          sourceNodeId: "toString",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.formatValue");
  });
});
