import { describe, expect, it } from "vitest";
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

function rows(graph: SerializedGraph, nodeId: string) {
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
    updateNodeData: () => {},
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
