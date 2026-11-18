/** The input pin id of a pass-through (reroute) node. */
export const PASS_THROUGH_INPUT_PIN = "in";
/** The output pin id of a pass-through (reroute) node. */
export const PASS_THROUGH_OUTPUT_PIN = "out";

export interface PinEdgeLike {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
  viaEdgeIds?: readonly string[];
}

const pinKey = (nodeId: string, pinId: string) => `${nodeId}\0${pinId}`;

/**
 * Removes pass-through nodes (one input pin `in`, one output pin `out`) and rewires each
 * maximal chain into direct edges between the real endpoints. A collapsed edge lists every
 * original edge id it replaced, in source→target order, in `viaEdgeIds`, and its `id` is
 * those ids joined with "|". Chains with no real source or no real target vanish. Cycles made
 * only of pass-through nodes vanish. Returns the SAME `nodes` and `edges` arrays when no node
 * is pass-through.
 *
 * Each real source pin reaches a final (target-side) edge at most once, however many paths of
 * pass-through nodes join them: a diamond of knots is one edge, along the first path found
 * following edges in authored order. The work is linear in nodes and edges per real source pin
 * that feeds a pass-through node.
 */
export function collapsePassThroughNodes<N extends { id: string }, E extends PinEdgeLike>(
  nodes: readonly N[],
  edges: readonly E[],
  isPassThrough: (node: N) => boolean,
): { nodes: readonly N[]; edges: readonly E[] } {
  let passIds: Set<string> | undefined;
  for (const node of nodes) {
    if (isPassThrough(node)) (passIds ??= new Set()).add(node.id);
  }
  if (!passIds) return { nodes, edges };
  const passThrough = passIds;
  const segments = (edge: E): readonly string[] => edge.viaEdgeIds ?? [edge.id];

  // Edges leaving each pass-through node's output, and the edges from each real source pin into
  // a pass-through input, both in authored order (source pins in order of their first such edge).
  const leaving = new Map<string, E[]>();
  const starts = new Map<string, E[]>();
  const push = (map: Map<string, E[]>, key: string, edge: E) => {
    const list = map.get(key);
    if (list) list.push(edge);
    else map.set(key, [edge]);
  };
  for (const edge of edges) {
    if (passThrough.has(edge.sourceNodeId)) {
      if (edge.sourcePinId === PASS_THROUGH_OUTPUT_PIN) push(leaving, edge.sourceNodeId, edge);
    } else if (passThrough.has(edge.targetNodeId) && edge.targetPinId === PASS_THROUGH_INPUT_PIN) {
      push(starts, pinKey(edge.sourceNodeId, edge.sourcePinId), edge);
    }
  }

  // Per final edge, the real sources reaching it, each once, with the segments of its first path.
  const reaching = new Map<E, { source: E; ids: readonly string[] }[]>();
  for (const sourceEdges of starts.values()) {
    const source = sourceEdges[0]!;
    // The edge each pass-through node was first reached by: it is walked once, along that path.
    const reachedBy = new Map<string, E>();
    const pathTo = (nodeId: string, final: E): string[] => {
      const chunks = [segments(final)];
      for (let edge = reachedBy.get(nodeId); edge; edge = reachedBy.get(edge.sourceNodeId)) {
        chunks.push(segments(edge));
        if (!passThrough.has(edge.sourceNodeId)) break;
      }
      return chunks.reverse().flat();
    };
    // Depth first, edges in authored order, with an explicit stack so long chains cannot overflow.
    const frames: { nodeId: string; next: number }[] = [];
    for (const start of sourceEdges) {
      if (reachedBy.has(start.targetNodeId)) continue;
      reachedBy.set(start.targetNodeId, start);
      frames.push({ nodeId: start.targetNodeId, next: 0 });
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        const out = leaving.get(frame.nodeId) ?? [];
        if (frame.next >= out.length) {
          frames.pop();
          continue;
        }
        const edge = out[frame.next++]!;
        if (!passThrough.has(edge.targetNodeId)) {
          const entry = { source, ids: pathTo(frame.nodeId, edge) };
          const list = reaching.get(edge);
          if (list) list.push(entry);
          else reaching.set(edge, [entry]);
        } else if (edge.targetPinId === PASS_THROUGH_INPUT_PIN && !reachedBy.has(edge.targetNodeId)) {
          reachedBy.set(edge.targetNodeId, edge);
          frames.push({ nodeId: edge.targetNodeId, next: 0 });
        }
      }
    }
  }

  const collapsed: E[] = [];
  for (const edge of edges) {
    if (passThrough.has(edge.targetNodeId)) continue;
    if (!passThrough.has(edge.sourceNodeId)) {
      collapsed.push(edge);
      continue;
    }
    for (const { source, ids } of reaching.get(edge) ?? []) {
      collapsed.push({
        ...edge,
        id: ids.join("|"),
        sourceNodeId: source.sourceNodeId,
        sourcePinId: source.sourcePinId,
        viaEdgeIds: ids,
      });
    }
  }

  return { nodes: nodes.filter((node) => !passThrough.has(node.id)), edges: collapsed };
}

/**
 * Serialized-edge variant for editor code: follows pass-through nodes upstream from an input
 * pin and returns the real source pins (data inputs: zero or one; exec: any number).
 */
export function passThroughSources(
  edges: readonly { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  isPassThroughNode: (nodeId: string) => boolean,
  targetNodeId: string,
  targetPinId: string,
): { nodeId: string; pinId: string }[] {
  type Edge = (typeof edges)[number];
  // Built only when a wire leads into a pass-through node.
  let into: Map<string, Edge[]> | undefined;
  const incoming = (nodeId: string, pinId: string): readonly Edge[] => {
    if (!into) {
      into = new Map();
      for (const edge of edges) {
        const key = pinKey(edge.target, edge.targetHandle ?? "");
        const list = into.get(key);
        if (list) list.push(edge);
        else into.set(key, [edge]);
      }
    }
    return into.get(pinKey(nodeId, pinId)) ?? [];
  };

  const sources: { nodeId: string; pinId: string }[] = [];
  const seen = new Set<string>();
  const onPath = new Set<string>();
  const visit = (edge: Edge) => {
    const pinId = edge.sourceHandle ?? "";
    if (!isPassThroughNode(edge.source)) {
      const key = pinKey(edge.source, pinId);
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({ nodeId: edge.source, pinId });
      return;
    }
    if (pinId !== PASS_THROUGH_OUTPUT_PIN || onPath.has(edge.source)) return;
    onPath.add(edge.source);
    for (const upstream of incoming(edge.source, PASS_THROUGH_INPUT_PIN)) visit(upstream);
    onPath.delete(edge.source);
  };
  for (const edge of edges) {
    if (edge.target === targetNodeId && (edge.targetHandle ?? "") === targetPinId) visit(edge);
  }
  return sources;
}

/**
 * The downstream twin of `passThroughSources`: follows pass-through nodes from an output pin and
 * returns the real input pins its wires end on, in wire order.
 */
export function passThroughTargets(
  edges: readonly { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  isPassThroughNode: (nodeId: string) => boolean,
  sourceNodeId: string,
  sourcePinId: string,
): { nodeId: string; pinId: string }[] {
  type Edge = (typeof edges)[number];
  // Built only when a wire leads into a pass-through node.
  let from: Map<string, Edge[]> | undefined;
  const outgoing = (nodeId: string, pinId: string): readonly Edge[] => {
    if (!from) {
      from = new Map();
      for (const edge of edges) {
        const key = pinKey(edge.source, edge.sourceHandle ?? "");
        const list = from.get(key);
        if (list) list.push(edge);
        else from.set(key, [edge]);
      }
    }
    return from.get(pinKey(nodeId, pinId)) ?? [];
  };

  const targets: { nodeId: string; pinId: string }[] = [];
  const seen = new Set<string>();
  const onPath = new Set<string>();
  const visit = (edge: Edge) => {
    const pinId = edge.targetHandle ?? "";
    if (!isPassThroughNode(edge.target)) {
      const key = pinKey(edge.target, pinId);
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ nodeId: edge.target, pinId });
      return;
    }
    if (pinId !== PASS_THROUGH_INPUT_PIN || onPath.has(edge.target)) return;
    onPath.add(edge.target);
    for (const downstream of outgoing(edge.target, PASS_THROUGH_OUTPUT_PIN)) visit(downstream);
    onPath.delete(edge.target);
  };
  for (const edge of edges) {
    if (edge.source === sourceNodeId && (edge.sourceHandle ?? "") === sourcePinId) visit(edge);
  }
  return targets;
}
