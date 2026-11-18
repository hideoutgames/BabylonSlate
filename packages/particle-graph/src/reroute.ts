import { collapsePassThroughNodes } from "@haptic/core";
import type { ParticleGraphEdge, ParticleGraphNode } from "./document";

/** Catalog type of the Reroute knot: one wildcard input `in` and output `out`. */
export const PARTICLE_REROUTE_NODE_TYPE = "utility.reroute";

export function isParticleRerouteNode(node: Pick<ParticleGraphNode, "type">): boolean {
  return node.type === PARTICLE_REROUTE_NODE_TYPE;
}

/**
 * `graph` with every Reroute removed and each wire through one rewired between its real
 * endpoints (`collapsePassThroughNodes`), so validation, type resolution and lowering never
 * see a Reroute and a wire through knots is the direct wire. A knot chain with no real source
 * or target vanishes, so its target reads its default. Returns `graph` itself when it has none.
 */
export function collapseParticleReroutes<
  G extends { readonly nodes: readonly ParticleGraphNode[]; readonly edges: readonly ParticleGraphEdge[] },
>(graph: G): G {
  const { nodes, edges } = collapsePassThroughNodes(graph.nodes, graph.edges, isParticleRerouteNode);
  if (nodes === graph.nodes && edges === graph.edges) return graph;
  return { ...graph, nodes: nodes as ParticleGraphNode[], edges: edges as ParticleGraphEdge[] } as G;
}
