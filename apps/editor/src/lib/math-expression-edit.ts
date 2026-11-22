import type { SerializedGraph } from "@haptic/core";
import { editMathExpressionFormula } from "@haptic/scripting";
import { catalogTypeId } from "../services/graph-node-refresh";

/**
 * A Math Expression formula edit from the Inspector as one graph change: the formula, the pins and
 * the wires that follow a renamed variable (or go with a removed one), in the Event Graph or the
 * open function's slice. `wiredInputTypes` are the types the canvas derived from the wires, which
 * the saved node may not hold yet. Returns `graph` itself for any other node.
 */
export function commitMathExpressionFormula(
  graph: SerializedGraph,
  nodeId: string,
  formula: string,
  functionId: string | null,
  wiredInputTypes?: unknown,
): SerializedGraph {
  const slice = functionId ? graph.functionGraphs?.[functionId] : undefined;
  const nodes = slice ? slice.nodes : graph.nodes;
  const edges = slice ? slice.edges : graph.edges;
  const seeded = wiredInputTypes === undefined
    ? nodes
    : nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, wiredInputTypes } } : node);
  const next = editMathExpressionFormula(seeded, edges, nodeId, formula, catalogTypeId);
  if (!next) return graph;
  if (slice && functionId) {
    return { ...graph, functionGraphs: { ...graph.functionGraphs, [functionId]: { ...slice, nodes: next.nodes, edges: next.edges } } };
  }
  return { ...graph, nodes: next.nodes, edges: next.edges };
}
