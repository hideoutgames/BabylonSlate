import { describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { hydrateSerializedGraphForEditor } from "../services/graph-validation";
import { graphNodeInspectorRows, type GraphNodeRowsEnv } from "./inspector-node-rows";

const registry = createDefaultNodeRegistry();
type Node = SerializedGraph["nodes"][number];
const node = (id: string, type: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: {} });
const wire = (id: string, from: string, to: string) => {
  const [source, sourceHandle] = from.split(".") as [string, string];
  const [target, targetHandle] = to.split(".") as [string, string];
  return { id, source, sourceHandle, target, targetHandle };
};

function rows(graph: SerializedGraph, nodeId: string, updateNodeData: (patch: Record<string, unknown>) => void = () => {}) {
  const hydrated = hydrateSerializedGraphForEditor(graph, registry);
  const env = {
    graph: hydrated,
    inspectGraph: hydrated,
    hydratedInspectGraph: hydrated,
    catalogs: {
      dataAssets: [],
      enumMembers: {},
      objectClassEntries: [],
      pickerAssets: [],
      typeCatalog: { enums: [], structures: [], dataDefinitions: [] },
      typeSchemas: { enums: {}, structs: {} },
    },
    tags: undefined,
    proxyClip: undefined,
    updateNodeData,
    onPickClass: () => {},
    onPickAsset: () => {},
  } as unknown as GraphNodeRowsEnv;
  return graphNodeInspectorRows(hydrated.nodes.find((entry) => entry.id === nodeId)!, env);
}

describe("Inspector rows around Reroute knots", () => {
  it("give a knot no rows, even when the type it carries takes a literal", () => {
    const result = rows({
      nodes: [node("knot", "flow.reroute"), node("print", "debug.printString")],
      edges: [wire("a", "knot.out", "print.inString")],
    }, "knot");
    expect(result.literalDefaults).toEqual([]);
    expect(result.pinDefaults).toEqual([]);
    expect(Object.values(result.sections).flat()).toEqual([]);
  });

  it("show the literal of an input that only a knot nothing feeds is wired to", () => {
    const graph: SerializedGraph = {
      nodes: [node("text", "literal.makeString"), node("knot", "flow.reroute"), node("print", "debug.printString")],
      edges: [wire("b", "knot.out", "print.inString")],
    };
    const shown = (value: SerializedGraph) => rows(value, "print").literalDefaults.map((entry) => entry.pinId);
    expect(shown(graph)).toContain("inString");
    expect(shown({ ...graph, edges: [wire("a", "text.out", "knot.in"), ...graph.edges] })).not.toContain("inString");
  });
});

describe("Inspector operand type rows of the math nodes", () => {
  const typed = (type: string, data: Record<string, unknown>): Node => ({ ...node("op", type), data });
  const operandRows = (graph: SerializedGraph, update?: (patch: Record<string, unknown>) => void) =>
    rows(graph, "op", update).sections.numericOperands;

  it("offer every type against a number, and numbers or the same vector against a vector", () => {
    const [a, b] = operandRows({ nodes: [typed("math.mul", { aType: "vec3" })], edges: [] });
    expect(a).toMatchObject({ label: "A Type", value: "vec3" });
    expect(a?.kind === "enum" && a.options.map((option) => option.label)).toEqual(["Integer", "Float", "Vector2", "Vector3", "Vector4"]);
    expect(b).toMatchObject({ label: "B Type", value: "float" });
    expect(b?.kind === "enum" && b.options.map((option) => option.value)).toEqual(["int", "float", "vec3"]);
  });

  it("offer Modulo numbers only and name Negate's one row Value Type", () => {
    const [a] = operandRows({ nodes: [typed("math.mod", {})], edges: [] });
    expect(a?.kind === "enum" && a.options.map((option) => option.value)).toEqual(["int", "float"]);
    expect(operandRows({ nodes: [typed("math.negate", {})], edges: [] }).map((row) => row.label)).toEqual(["Value Type"]);
  });

  it("hide the row of a wired operand, whose type follows the wire", () => {
    const graph: SerializedGraph = {
      nodes: [node("vec", "vector.make3"), typed("math.add", { "default:b": 1 })],
      edges: [wire("w", "vec.out", "op.a")],
    };
    expect(operandRows(graph).map((row) => [row.label, row.value])).toEqual([["B Type", "float"]]);
  });

  it("drop the operand's old value with a type pick", () => {
    const update = vi.fn();
    const graph: SerializedGraph = { nodes: [typed("math.sub", { aType: "vec3", bType: "vec3", "default:a": { x: 1, y: 2, z: 3 }, "default:b": { x: 1, y: 1, z: 1 } })], edges: [] };
    const [, b] = operandRows(graph, update);
    if (b?.kind !== "enum") throw new Error("B Type is an enum row");
    b.onChange("float");
    expect(update.mock.lastCall?.[0]).toStrictEqual({ aType: "vec3", bType: "float", "default:a": { x: 1, y: 2, z: 3 }, "default:b": undefined });
  });

  it("save the types the wires gave with every edit, so a pick is not undone", () => {
    const update = vi.fn();
    // Saved before the wire retyped it: the node shows Vector3 for both operands.
    const graph: SerializedGraph = { nodes: [node("vec", "vector.make3"), typed("math.add", {})], edges: [wire("w", "vec.out", "op.a")] };
    const [b] = operandRows(graph, update);
    if (b?.kind !== "enum") throw new Error("B Type is an enum row");
    b.onChange("float");
    expect(update.mock.lastCall?.[0]).toStrictEqual({ aType: "vec3", bType: "float", "default:a": undefined, "default:b": undefined });
  });
});
