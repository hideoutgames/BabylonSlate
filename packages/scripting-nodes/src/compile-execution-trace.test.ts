import { describe, expect, it } from "vitest";
import {
  compileGraph,
  pin,
  EXEC,
  FLOAT,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeDefinition,
} from "@haptic/scripting";
import { allNodeDefinitions, createDefaultNodeRegistry } from "./index";

const PROPERTIES = {
  body: "b = a;",
  inputs: [{ name: "a", type: { kind: "float" } }],
  outputs: [{ name: "b", type: { kind: "float" } }],
  count: 3,
  structGuid: "struct-stats",
  fields: [{ name: "Health", typeId: "int" }],
  enumGuid: "enum-team",
  members: [{ name: "Red", value: 1 }],
  value: "Red",
};

/** Any text a pure source can supply: every wired input of the node under test reads it. */
const SOURCE: NodeDefinition = {
  id: "test.source",
  title: "Source",
  category: "test",
  pure: true,
  pins: () => [pin("v", "v", "out", FLOAT)],
  codegen: () => ({ v: "ctx.source()" }),
};

function syntaxError(source: string): string | null {
  try {
    new Function(source.replace(/export\s+(async\s+)?function\s+/g, "$1function "));
    return null;
  } catch (error) {
    return String(error);
  }
}

function graphAround(def: NodeDefinition): LogicGraph | null {
  const pins = def.pins(PROPERTIES);
  const hasExecIn = pins.some((p) => p.kind === "exec" && p.direction === "in");
  const hasExecOut = pins.some((p) => p.kind === "exec" && p.direction === "out");
  if (def.pure || (!hasExecIn && !hasExecOut)) return null;
  const subject: GraphNode = {
    id: "subject",
    typeId: def.id,
    position: { x: 0, y: 0 },
    pins,
    properties: PROPERTIES,
  };
  const nodes: GraphNode[] = [
    subject,
    { id: "src", typeId: SOURCE.id, position: { x: 0, y: 0 }, pins: SOURCE.pins({}), properties: {} },
  ];
  const edges: GraphEdge[] = pins
    .filter((p) => p.kind === "data" && p.direction === "in")
    .map((p) => ({
      id: `d_${p.id}`,
      sourceNodeId: "src",
      sourcePinId: "v",
      targetNodeId: "subject",
      targetPinId: p.id,
    }));
  if (hasExecIn) {
    nodes.unshift({
      id: "entry",
      typeId: "flow.entry",
      position: { x: 0, y: 0 },
      pins: [pin("execOut", "then", "out", EXEC)],
      properties: {},
    });
    edges.push({
      id: "e_entry",
      sourceNodeId: "entry",
      sourcePinId: "execOut",
      targetNodeId: "subject",
      targetPinId: pins.find((p) => p.kind === "exec" && p.direction === "in")!.id,
    });
  }
  return { id: "event-graph", kind: "event", nodes, edges };
}

describe("execution-trace instrumentation across the node catalog", () => {
  it("emits valid JavaScript wherever the plain compile does, for every node that runs", () => {
    const registry = createDefaultNodeRegistry();
    registry.register(SOURCE);
    let compared = 0;
    const broken: string[] = [];
    for (const def of allNodeDefinitions()) {
      const graph = graphAround(def);
      if (!graph) continue;
      let plain;
      try {
        plain = compileGraph(graph, { assetGuid: "a", registry });
      } catch {
        continue;
      }
      if (syntaxError(plain.source) !== null) continue;
      const traced = compileGraph(graph, { assetGuid: "a", registry, instrumentExecutionTrace: true });
      const error = syntaxError(traced.source);
      if (error !== null) broken.push(`${def.id}: ${error}`);
      expect(traced.source, def.id).toContain('__dbg.exec("subject")');
      compared += 1;
    }
    expect(broken).toEqual([]);
    expect(compared).toBeGreaterThan(100);
  });
});
