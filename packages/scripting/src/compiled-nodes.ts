import type { GraphNode, LogicGraph } from "./ir";
import { findNode, findPin } from "./ir";

/**
 * Must match `entryNodes` in compile.ts: catalog events, `flow.entry`, and
 * exec-out-only nodes with no incoming exec (function Input, input/BT/anim
 * events). Compile emits one export per entry; validation uses the same set.
 */
function triggerableEntryNodes(graph: LogicGraph): GraphNode[] {
  const hasIncoming = new Set(
    graph.edges
      .filter((e) => {
        const src = findNode(graph, e.sourceNodeId);
        const sp = src && findPin(src, e.sourcePinId);
        return sp?.kind === "exec";
      })
      .map((e) => e.targetNodeId),
  );
  return graph.nodes.filter((n) => {
    if (n.typeId.startsWith("flow.event") || n.typeId === "flow.entry") {
      return true;
    }
    const hasExecIn = n.pins.some(
      (p) => p.kind === "exec" && p.direction === "in",
    );
    const hasExecOut = n.pins.some(
      (p) => p.kind === "exec" && p.direction === "out",
    );
    return hasExecOut && !hasExecIn && !hasIncoming.has(n.id);
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

function isExecEdge(graph: LogicGraph, edge: LogicGraph["edges"][number]): boolean {
  const src = findNode(graph, edge.sourceNodeId);
  const sp = src && findPin(src, edge.sourcePinId);
  const dst = findNode(graph, edge.targetNodeId);
  const tp = dst && findPin(dst, edge.targetPinId);
  return sp?.kind === "exec" && tp?.kind === "exec";
}

function isDataEdge(graph: LogicGraph, edge: LogicGraph["edges"][number]): boolean {
  const src = findNode(graph, edge.sourceNodeId);
  const sp = src && findPin(src, edge.sourcePinId);
  const dst = findNode(graph, edge.targetNodeId);
  const tp = dst && findPin(dst, edge.targetPinId);
  return sp?.kind === "data" && tp?.kind === "data";
}

/**
 * Node ids that `compileGraph` / `compileTransitionRuleGraph` would emit:
 * trigger entries, exec-reachable successors, and data-only pures those
 * nodes read. Isolated leftover nodes are omitted (match the emitted
 * program, not compile.ts's extra ensurePure-all loop).
 */
export function compiledNodeIds(graph: LogicGraph): Set<string> {
  const compiled = new Set<string>();
  const queue: string[] = [];

  const seed = (id: string) => {
    if (compiled.has(id)) return;
    compiled.add(id);
    queue.push(id);
  };

  for (const entry of triggerableEntryNodes(graph)) {
    seed(entry.id);
  }
  for (const node of graph.nodes) {
    if (isAnimRuleSink(node)) seed(node.id);
  }

  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of graph.edges) {
      if (edge.sourceNodeId !== id || !isExecEdge(graph, edge)) continue;
      seed(edge.targetNodeId);
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of graph.edges) {
      if (!isDataEdge(graph, edge)) continue;
      if (!compiled.has(edge.targetNodeId) || compiled.has(edge.sourceNodeId)) {
        continue;
      }
      const src = findNode(graph, edge.sourceNodeId);
      if (!src || !isDataOnly(src)) continue;
      compiled.add(src.id);
      grew = true;
    }
  }

  return compiled;
}
