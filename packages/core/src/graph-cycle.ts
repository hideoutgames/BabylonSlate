/** Depth-first cycle search over all edges; returns the node ids on the first loop found. */
export function findGraphCycle(graph: {
  nodes: readonly { id: string }[];
  edges: readonly { sourceNodeId: string; targetNodeId: string }[];
}): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.sourceNodeId) ?? [];
    list.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, list);
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (nodeId: string): string[] | null => {
    const current = state.get(nodeId);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(nodeId);
      return stack.slice(start >= 0 ? start : 0);
    }
    state.set(nodeId, "visiting");
    stack.push(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(nodeId, "done");
    return null;
  };

  for (const node of graph.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}
