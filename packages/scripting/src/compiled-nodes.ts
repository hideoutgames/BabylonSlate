import type { GraphNode, GraphPin, LogicGraph } from "./ir";

function nodesById(graph: LogicGraph): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  return nodes;
}

function pinKind(
  nodes: ReadonlyMap<string, GraphNode>,
  nodeId: string,
  pinId: string,
): GraphPin["kind"] | undefined {
  return nodes.get(nodeId)?.pins.find((pin) => pin.id === pinId)?.kind;
}

/**
 * Trigger entries `compileGraph` emits one export for. Keep this as the
 * single source of truth used by compile.ts.
 *
 * Catalog events, `flow.entry`, and exec-out-only nodes with no incoming
 * exec (function Input, input/BT/anim events). A node with an exec input is
 * a statement, never a trigger: Call Custom Event and Call Parent Event share
 * the `flow.event` prefix but run where they are wired.
 */
export function entryNodes(graph: LogicGraph): GraphNode[] {
  const nodes = nodesById(graph);
  const hasIncoming = new Set(
    graph.edges
      .filter((e) => pinKind(nodes, e.sourceNodeId, e.sourcePinId) === "exec")
      .map((e) => e.targetNodeId),
  );
  return graph.nodes.filter((n) => {
    const hasExecIn = n.pins.some(
      (p) => p.kind === "exec" && p.direction === "in",
    );
    if (hasExecIn) return false;
    if (n.typeId.startsWith("flow.event") || n.typeId === "flow.entry") {
      return true;
    }
    const hasExecOut = n.pins.some(
      (p) => p.kind === "exec" && p.direction === "out",
    );
    return hasExecOut && !hasIncoming.has(n.id);
  });
}

function isAnimRuleSink(node: GraphNode): boolean {
  return (
    node.typeId === "anim.rule.enterState" ||
    node.typeId === "anim.rule.exitState"
  );
}

function isDataOnly(node: GraphNode): boolean {
  return !node.pins.some((p) => p.kind === "exec");
}

/**
 * Node ids that `compileGraph` / `compileTransitionRuleGraph` would emit:
 * trigger entries, exec-reachable successors, and data-only pures those
 * nodes read. Isolated leftover nodes are omitted (match the emitted
 * program, not compile.ts's extra ensurePure-all loop).
 */
export function compiledNodeIds(graph: LogicGraph): Set<string> {
  const nodes = nodesById(graph);
  // Exec successors by source node, and data sources by target node.
  const execNext = new Map<string, string[]>();
  const dataSources = new Map<string, string[]>();
  const append = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of graph.edges) {
    const source = pinKind(nodes, edge.sourceNodeId, edge.sourcePinId);
    const target = pinKind(nodes, edge.targetNodeId, edge.targetPinId);
    if (source === "exec" && target === "exec") {
      append(execNext, edge.sourceNodeId, edge.targetNodeId);
    } else if (source === "data" && target === "data") {
      append(dataSources, edge.targetNodeId, edge.sourceNodeId);
    }
  }

  const compiled = new Set<string>();
  const queue: string[] = [];
  const seed = (id: string) => {
    if (compiled.has(id)) return;
    compiled.add(id);
    queue.push(id);
  };

  for (const entry of entryNodes(graph)) {
    seed(entry.id);
  }
  for (const node of graph.nodes) {
    if (isAnimRuleSink(node)) seed(node.id);
  }
  while (queue.length > 0) {
    for (const next of execNext.get(queue.pop()!) ?? []) seed(next);
  }

  // Data-only pures read by any compiled node, transitively.
  const readers = [...compiled];
  while (readers.length > 0) {
    for (const sourceId of dataSources.get(readers.pop()!) ?? []) {
      if (compiled.has(sourceId)) continue;
      const source = nodes.get(sourceId);
      if (!source || !isDataOnly(source)) continue;
      compiled.add(sourceId);
      readers.push(sourceId);
    }
  }

  return compiled;
}
