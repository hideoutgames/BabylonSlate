import type { SerializedGraph } from "@babylonslate/core";
import {
  AddEdgeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  SetNodeDataCommand,
} from "./graph";

function positionsEqual(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return a.x === b.x && a.y === b.y;
}

function dataEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Derives minimal graph edit commands from a before/after pair.
 * Used by the graph editor to route mutations through the undo stack.
 */
export function diffGraphCommands(
  before: SerializedGraph,
  after: SerializedGraph,
): Array<
  MoveNodeCommand | AddEdgeCommand | RemoveEdgeCommand | SetNodeDataCommand
> {
  const commands: Array<
    MoveNodeCommand | AddEdgeCommand | RemoveEdgeCommand | SetNodeDataCommand
  > = [];

  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));

  for (const [nodeId, afterNode] of afterNodes) {
    const beforeNode = beforeNodes.get(nodeId);
    if (!beforeNode) {
      continue;
    }
    if (!positionsEqual(beforeNode.position, afterNode.position)) {
      commands.push(
        new MoveNodeCommand(nodeId, beforeNode.position, afterNode.position),
      );
    }
    if (!dataEqual(beforeNode.data, afterNode.data)) {
      commands.push(
        new SetNodeDataCommand(nodeId, beforeNode.data, afterNode.data),
      );
    }
  }

  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));

  for (const [edgeId, edge] of afterEdges) {
    if (!beforeEdges.has(edgeId)) {
      commands.push(new AddEdgeCommand(edge));
    }
  }

  for (const [edgeId, edge] of beforeEdges) {
    if (!afterEdges.has(edgeId)) {
      commands.push(new RemoveEdgeCommand(edge));
    }
  }

  return commands;
}
