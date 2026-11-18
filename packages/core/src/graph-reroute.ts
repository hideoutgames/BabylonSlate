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

  // Edges into each pass-through node's input, in authored order (exec inputs fan in).
  const into = new Map<string, E[]>();
  for (const edge of edges) {
    if (!passThrough.has(edge.targetNodeId) || edge.targetPinId !== PASS_THROUGH_INPUT_PIN) continue;
    const list = into.get(edge.targetNodeId);
    if (list) list.push(edge);
    else into.set(edge.targetNodeId, [edge]);
  }

  const collapsed: E[] = [];
  const onPath = new Set<string>();
  const walk = (final: E, nodeId: string, downstream: readonly string[]) => {
    if (onPath.has(nodeId)) return;
    onPath.add(nodeId);
    for (const edge of into.get(nodeId) ?? []) {
      const ids = [...(edge.viaEdgeIds ?? [edge.id]), ...downstream];
      if (!passThrough.has(edge.sourceNodeId)) {
        collapsed.push({
          ...final,
          id: ids.join("|"),
          sourceNodeId: edge.sourceNodeId,
          sourcePinId: edge.sourcePinId,
          viaEdgeIds: ids,
        });
      } else if (edge.sourcePinId === PASS_THROUGH_OUTPUT_PIN) {
        walk(final, edge.sourceNodeId, ids);
      }
    }
    onPath.delete(nodeId);
  };

  for (const edge of edges) {
    if (passThrough.has(edge.targetNodeId)) continue;
    if (!passThrough.has(edge.sourceNodeId)) {
      collapsed.push(edge);
      continue;
    }
    if (edge.sourcePinId !== PASS_THROUGH_OUTPUT_PIN) continue;
    walk(edge, edge.sourceNodeId, edge.viaEdgeIds ?? [edge.id]);
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
