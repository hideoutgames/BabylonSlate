/**
 * Wire ends seen through Reroute knots. A Class graph Reroute is compiled away
 * (`collapseReroutes`), so editor code that reads what feeds an input, or what an
 * output feeds, looks through knots exactly as the compiler does: a knot with no
 * source leaves its targets unwired.
 */
import { passThroughSources, passThroughTargets } from "@haptic/core";
import { REROUTE_NODE_TYPE } from "@haptic/scripting";

type WireNode = { id: string; type?: string; data?: Record<string, unknown> };
type Wire = { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };
type WireGraph = { nodes: readonly WireNode[]; edges: readonly Wire[] };
export type WireEnd = { nodeId: string; pinId: string };

/** A Class graph Reroute knot, by catalog type or by its canvas marker. */
export function isRerouteNode(node: WireNode): boolean {
  return node.type === REROUTE_NODE_TYPE || node.data?.__nodeType === REROUTE_NODE_TYPE || node.data?.__reroute === true;
}

const NO_KNOTS = () => false;

/** Knot lookup by node id for `nodes`; a graph without knots costs one scan. */
export function rerouteNodeIdLookup(nodes: readonly WireNode[]): (nodeId: string) => boolean {
  let ids: Set<string> | undefined;
  for (const node of nodes) if (isRerouteNode(node)) (ids ??= new Set()).add(node.id);
  return ids ? (nodeId) => ids.has(nodeId) : NO_KNOTS;
}

/** The real output pins wired into `pinId` (a data input has at most one; exec inputs may have several). */
export function wiredSources(graph: WireGraph, nodeId: string, pinId: string): WireEnd[] {
  return passThroughSources(graph.edges, rerouteNodeIdLookup(graph.nodes), nodeId, pinId);
}

/** The real output pin read by input `pinId`, through any knots. */
export function wiredSource(graph: WireGraph, nodeId: string, pinId: string): WireEnd | undefined {
  return wiredSources(graph, nodeId, pinId)[0];
}

/** The real input pins output `pinId` feeds, through any knots, in wire order. */
export function wiredTargets(graph: WireGraph, nodeId: string, pinId: string): WireEnd[] {
  return passThroughTargets(graph.edges, rerouteNodeIdLookup(graph.nodes), nodeId, pinId);
}

/** Whether input `pinId` reads a real source: a knot nothing feeds leaves it unwired. */
export function isInputWired(graph: WireGraph, nodeId: string, pinId: string): boolean {
  return wiredSources(graph, nodeId, pinId).length > 0;
}

/**
 * `graph.edges` with each wire into `nodeId` read through Reroute knots: it leaves the real source
 * pin instead of a knot, and a wire from a knot nothing feeds is gone. Other wires are unchanged.
 */
export function edgesIntoNodeThroughKnots<E extends Wire>(
  graph: { nodes: readonly WireNode[]; edges: readonly E[] },
  nodeId: string,
): E[] {
  const isKnot = rerouteNodeIdLookup(graph.nodes);
  return graph.edges.flatMap((edge) => {
    if (edge.target !== nodeId || !isKnot(edge.source)) return [edge];
    return passThroughSources([edge, ...graph.edges.filter((entry) => entry !== edge && entry.target !== nodeId)],
      isKnot, nodeId, edge.targetHandle ?? "")
      .map((end) => ({ ...edge, source: end.nodeId, sourceHandle: end.pinId }));
  });
}
