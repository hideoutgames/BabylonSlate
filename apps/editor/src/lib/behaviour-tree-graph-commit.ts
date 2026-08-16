import {
  applyNodePositions,
  serializedToBehaviourTree,
  type BehaviourTreeDocument,
} from "@babylonslate/behaviour-tree";
import type { SerializedGraph } from "@babylonslate/core";

export function attachNewBehaviourTreeNodes(
  next: BehaviourTreeDocument,
  previous: BehaviourTreeDocument,
  parentId: string | null,
): BehaviourTreeDocument {
  if (!parentId) return next;
  const parent = next.nodes.find((node) => node.id === parentId);
  if (!parent || parent.kind === "task") return next;
  const prevIds = new Set(previous.nodes.map((node) => node.id));
  const claimed = new Set(next.nodes.flatMap((node) => node.children));
  const orphans = next.nodes.filter(
    (node) =>
      !prevIds.has(node.id) && !claimed.has(node.id) && node.id !== next.rootId,
  );
  if (orphans.length === 0) return next;
  return {
    ...next,
    nodes: next.nodes.map((node) =>
      node.id === parentId
        ? { ...node, children: [...node.children, ...orphans.map((row) => row.id)] }
        : node,
    ),
  };
}

export function commitBehaviourTreeGraphChange(
  doc: BehaviourTreeDocument,
  graph: SerializedGraph,
  meta: { kind?: string } | undefined,
  parentId: string | null,
): { next: BehaviourTreeDocument; mergeKey?: string } {
  if (meta?.kind === "position") {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of graph.nodes) {
      positions[node.id] = { x: node.position.x, y: node.position.y };
    }
    return { next: applyNodePositions(doc, positions) };
  }
  return {
    next: attachNewBehaviourTreeNodes(
      serializedToBehaviourTree(graph, doc),
      doc,
      parentId,
    ),
  };
}
