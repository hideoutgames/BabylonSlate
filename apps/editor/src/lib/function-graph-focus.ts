import type { SerializedGraph } from "@haptic/core";

export type GraphNodeOwner =
  | { kind: "event" }
  | { kind: "function"; functionId: string };

/**
 * The graph of a Class document that holds a node: its Event Graph, or the
 * function whose graph does. A node in neither (stale or foreign id) has no owner.
 */
export function graphOwningNode(
  graph: Pick<SerializedGraph, "nodes" | "functionGraphs"> | null | undefined,
  nodeId: string,
): GraphNodeOwner | null {
  if (!graph) return null;
  if (graph.nodes.some((node) => node.id === nodeId)) return { kind: "event" };
  for (const [functionId, slice] of Object.entries(graph.functionGraphs ?? {})) {
    if (slice.nodes.some((node) => node.id === nodeId)) return { kind: "function", functionId };
  }
  return null;
}

/** Focus requests a graph panel has already routed, so a panel that mounts later ignores them. */
const routedFocus = new WeakSet<object>();

/** True once per focus request: the first graph panel to see it routes it to the owning tab. */
export function claimFocusRouting(focus: object): boolean {
  if (routedFocus.has(focus)) return false;
  routedFocus.add(focus);
  return true;
}
