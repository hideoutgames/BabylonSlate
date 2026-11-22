import { describe, expect, it } from "vitest";
import { createPinTypeResolver, indexIncomingPinEdges, normalizeGraphNodes } from "./node-graph-core";

type Pin = { id: string; type: { kind: string } };
type Definition = { inputs: Pin[]; outputs: Pin[] };
const edge = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
  ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });

/** A toy catalog: `vec3` and `float` sources, and `add`, whose generic group takes the widest wired type. */
const DEFINITIONS: Record<string, Definition> = {
  vec3: { inputs: [], outputs: [{ id: "out", type: { kind: "vec3" } }] },
  float: { inputs: [], outputs: [{ id: "out", type: { kind: "float" } }] },
  add: {
    inputs: [{ id: "a", type: { kind: "generic" } }, { id: "b", type: { kind: "generic" } }],
    outputs: [{ id: "out", type: { kind: "generic" } }],
  },
  knot: { inputs: [{ id: "in", type: { kind: "wildcard" } }], outputs: [{ id: "out", type: { kind: "wildcard" } }] },
};
const WIDTH: Record<string, number> = { float: 1, vec3: 3 };

function resolverFor(nodes: { id: string; type: string }[], edges: ReturnType<typeof edge>[], asked: string[] = []) {
  return createPinTypeResolver({
    nodes,
    edges,
    definition: (node: { id: string; type: string }) => {
      asked.push(node.id);
      return DEFINITIONS[node.type];
    },
    group: (definition: Definition) => (definition.inputs.some((pin) => pin.type.kind === "generic") ? true : null),
    resolve: (connected: readonly string[]) => connected.reduce((widest, type) => (WIDTH[type]! > WIDTH[widest]! ? type : widest), "float"),
    wildcard: "float",
  });
}

describe("indexIncomingPinEdges", () => {
  it("answers the first wire into a pin wired twice, and nothing for an unwired pin", () => {
    const first = edge("e1", "a", "out", "n", "in");
    const incoming = indexIncomingPinEdges([first, edge("e2", "b", "out", "n", "in"), edge("e3", "a", "out", "m", "in")]);
    expect(incoming("n", "in")).toBe(first);
    expect(incoming("n", "other")).toBeUndefined();
    expect(incoming("missing", "in")).toBeUndefined();
  });
});

describe("createPinTypeResolver", () => {
  it("carries a wired width down a chain of generic nodes, asking each node's definition once", () => {
    const asked: string[] = [];
    const resolver = resolverFor(
      [{ id: "v", type: "vec3" }, { id: "f", type: "float" }, { id: "add1", type: "add" }, { id: "add2", type: "add" }],
      [edge("e1", "v", "out", "add1", "a"), edge("e2", "f", "out", "add1", "b"), edge("e3", "add1", "out", "add2", "a")],
      asked,
    );
    expect(resolver.outputType("add2", "out")).toBe("vec3");
    expect(resolver.inputType("add2", "b")).toBe("vec3");
    expect(resolver.outputType("f", "out")).toBe("float");
    expect(resolver.genericOf("v")).toBeUndefined();
    expect(resolver.outputType("add1", "missing")).toBeNull();
    expect(resolver.outputType("gone", "out")).toBeNull();
    expect(asked.sort()).toEqual(["add1", "add2", "f", "v"]);
  });

  it("reads a node reached again while it resolves as a conflict instead of recursing, and lists it", () => {
    const resolver = resolverFor(
      [{ id: "x", type: "add" }, { id: "y", type: "add" }, { id: "v", type: "vec3" }],
      [edge("e1", "x", "out", "y", "a"), edge("e2", "y", "out", "x", "a"), edge("e3", "v", "out", "y", "b")],
    );
    // x asks y, which asks x again: that inner read is the conflict, y resolves from what remains (vec3).
    expect(resolver.genericOf("x")).toBe("vec3");
    expect(resolver.conflicts()).toEqual([]);
    const loop = createPinTypeResolver({
      nodes: [{ id: "x" }],
      edges: [edge("e", "x", "out", "x", "a")],
      definition: () => DEFINITIONS.add,
      group: () => true,
      resolve: (connected: readonly string[]) => (connected.length ? connected[0]! : "conflict"),
      wildcard: null,
    });
    expect(loop.genericOf("x")).toBe("conflict");
    expect(loop.conflicts()).toEqual(["x"]);
  });

  it("reads a wildcard pin as the given type and skips sources that do not contribute", () => {
    const nodes = [{ id: "v", type: "vec3" }, { id: "k", type: "knot" }, { id: "add", type: "add" }];
    const edges = [edge("e1", "v", "out", "add", "a")];
    expect(resolverFor(nodes, edges).outputType("k", "out")).toBe("float");
    const skipping = createPinTypeResolver({
      nodes,
      edges,
      definition: (node: { type: string }) => DEFINITIONS[node.type],
      group: (definition: Definition) => (definition.inputs.length ? true : null),
      contributes: (type: string) => type !== "vec3",
      resolve: (connected: readonly string[]) => connected[0] ?? "float",
      wildcard: null,
    });
    expect(skipping.outputType("add", "out")).toBe("float");
    expect(skipping.outputType("k", "out")).toBeNull();
  });

  it("follows a shared incoming index instead of indexing its own edges", () => {
    const wired = edge("e1", "v", "out", "add", "a");
    const resolver = createPinTypeResolver({
      nodes: [{ id: "v", type: "vec3" }, { id: "add", type: "add" }],
      edges: [] as ReturnType<typeof edge>[],
      incoming: (nodeId, pinId) => (nodeId === "add" && pinId === "a" ? wired : undefined),
      definition: (node: { type: string }) => DEFINITIONS[node.type],
      group: () => true,
      resolve: (connected: readonly string[]) => connected[0] ?? "float",
      wildcard: null,
    });
    expect(resolver.outputType("add", "out")).toBe("vec3");
    expect(resolver.incoming("add", "a")).toBe(wired);
  });
});

describe("normalizeGraphNodes", () => {
  it("keeps typed nodes, filling ids and finite positions, and passes properties through the graph's rules", () => {
    const nodes = normalizeGraphNodes(
      [
        { id: "a", type: "add", position: { x: 4, y: Number.NaN }, properties: { value: 1 } },
        { type: "add", position: "far", properties: [1] },
        { id: "untyped", type: " " },
        "junk",
      ],
      (type, properties) => ({ ...properties, seen: type }),
    );
    expect(nodes).toEqual([
      { id: "a", type: "add", position: { x: 4, y: 0 }, properties: { value: 1, seen: "add" } },
      { id: "node-1", type: "add", position: { x: 0, y: 0 }, properties: { seen: "add" } },
    ]);
    expect(normalizeGraphNodes({ nodes: [] }, (_type, properties) => properties)).toEqual([]);
  });
});
