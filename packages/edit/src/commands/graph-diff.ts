import type { SerializedGraph } from "@babylonslate/core";
import {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetGraphComponentsCommand,
  SetGraphFunctionGraphsCommand,
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
function membersEqual(
  a: SerializedGraph["members"],
  b: SerializedGraph["members"],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function componentsEqual(
  a: SerializedGraph["components"],
  b: SerializedGraph["components"],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function functionGraphsEqual(
  a: SerializedGraph["functionGraphs"],
  b: SerializedGraph["functionGraphs"],
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

export function diffGraphCommands(
  before: SerializedGraph,
  after: SerializedGraph,
): Array<
  | MoveNodeCommand
  | AddEdgeCommand
  | RemoveEdgeCommand
  | SetNodeDataCommand
  | AddNodeCommand
  | RemoveNodeCommand
  | SetGraphMembersCommand
  | SetGraphComponentsCommand
  | SetGraphFunctionGraphsCommand
> {
  const commands: Array<
    | MoveNodeCommand
    | AddEdgeCommand
    | RemoveEdgeCommand
    | SetNodeDataCommand
    | AddNodeCommand
    | RemoveNodeCommand
    | SetGraphMembersCommand
    | SetGraphComponentsCommand
    | SetGraphFunctionGraphsCommand
  > = [];

  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));

  for (const [nodeId, afterNode] of afterNodes) {
    const beforeNode = beforeNodes.get(nodeId);
    if (!beforeNode) {
      commands.push(new AddNodeCommand(afterNode));
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

  for (const [nodeId, beforeNode] of beforeNodes) {
    if (!afterNodes.has(nodeId)) {
      commands.push(new RemoveNodeCommand(beforeNode));
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

  if (!membersEqual(before.members, after.members)) {
    commands.push(new SetGraphMembersCommand(before.members, after.members));
  }

  if (!componentsEqual(before.components, after.components)) {
    commands.push(
      new SetGraphComponentsCommand(before.components, after.components),
    );
  }

  if (!functionGraphsEqual(before.functionGraphs, after.functionGraphs)) {
    commands.push(
      new SetGraphFunctionGraphsCommand(
        before.functionGraphs,
        after.functionGraphs,
      ),
    );
  }

  return commands;
}
