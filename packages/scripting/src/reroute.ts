import { collapsePassThroughNodes } from "@haptic/core";
import type { GraphNode, LogicGraph } from "./ir";

/** Catalog id of the Reroute knot: one `anyKind` wildcard input `in` and output `out`. */
export const REROUTE_NODE_TYPE = "flow.reroute";

export function isRerouteNode(node: Pick<GraphNode, "typeId">): boolean {
  return node.typeId === REROUTE_NODE_TYPE;
}

/**
 * The graph with every Reroute removed and each wire through one rewired between its real
 * endpoints (`collapsePassThroughNodes`), so no compiler or validator stage sees a Reroute.
 * Returns `graph` itself when it has none.
 */
export function collapseReroutes(graph: LogicGraph): LogicGraph {
  const { nodes, edges } = collapsePassThroughNodes(graph.nodes, graph.edges, isRerouteNode);
  if (nodes === graph.nodes && edges === graph.edges) return graph;
  return { ...graph, nodes: nodes as GraphNode[], edges: edges as LogicGraph["edges"] };
}
