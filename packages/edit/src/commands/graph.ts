import type { SerializedGraph } from "@babylonslate/core";
import type { EditCommand } from "../command";

export class MoveNodeCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.moveNode";
  readonly mergeKey: string;

  constructor(
    readonly nodeId: string,
    readonly from: { x: number; y: number },
    readonly to: { x: number; y: number },
  ) {
    this.mergeKey = `move:${nodeId}`;
  }

  apply(doc: SerializedGraph): SerializedGraph {
    return {
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === this.nodeId
          ? { ...node, position: { ...this.to } }
          : node,
      ),
    };
  }

  invert(): MoveNodeCommand {
    return new MoveNodeCommand(this.nodeId, this.to, this.from);
  }
}

export class AddEdgeCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.addEdge";

  constructor(readonly edge: SerializedGraph["edges"][number]) {}

  apply(doc: SerializedGraph): SerializedGraph {
    if (doc.edges.some((entry) => entry.id === this.edge.id)) {
      return doc;
    }
    return {
      ...doc,
      edges: [...doc.edges, this.edge],
    };
  }

  invert(): RemoveEdgeCommand {
    return new RemoveEdgeCommand(this.edge);
  }
}

export class RemoveEdgeCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.removeEdge";

  constructor(readonly edge: SerializedGraph["edges"][number]) {}

  apply(doc: SerializedGraph): SerializedGraph {
    return {
      ...doc,
      edges: doc.edges.filter((entry) => entry.id !== this.edge.id),
    };
  }

  invert(): AddEdgeCommand {
    return new AddEdgeCommand(this.edge);
  }
}

export class SetNodeDataCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.setNodeData";
  readonly mergeKey: string;

  constructor(
    readonly nodeId: string,
    readonly from: Record<string, unknown>,
    readonly to: Record<string, unknown>,
    mergeKey?: string,
  ) {
    this.mergeKey = mergeKey ?? `data:${nodeId}`;
  }

  apply(doc: SerializedGraph): SerializedGraph {
    return {
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === this.nodeId ? { ...node, data: { ...this.to } } : node,
      ),
    };
  }

  invert(): SetNodeDataCommand {
    return new SetNodeDataCommand(
      this.nodeId,
      this.to,
      this.from,
      this.mergeKey,
    );
  }
}

export type GraphEditCommand =
  | MoveNodeCommand
  | AddEdgeCommand
  | RemoveEdgeCommand
  | SetNodeDataCommand;

export const GRAPH_COMMAND_TYPES = [
  MoveNodeCommand.prototype.type,
  AddEdgeCommand.prototype.type,
  RemoveEdgeCommand.prototype.type,
  SetNodeDataCommand.prototype.type,
] as const;

export function createMoveNodeCommandFromJson(
  payload: Record<string, unknown>,
): MoveNodeCommand {
  const from = payload.from as { x: number; y: number };
  const to = payload.to as { x: number; y: number };
  return new MoveNodeCommand(
    String(payload.nodeId),
    from,
    to,
  );
}

export function createAddEdgeCommandFromJson(
  payload: Record<string, unknown>,
): AddEdgeCommand {
  return new AddEdgeCommand(
    payload.edge as SerializedGraph["edges"][number],
  );
}

export function createRemoveEdgeCommandFromJson(
  payload: Record<string, unknown>,
): RemoveEdgeCommand {
  return new RemoveEdgeCommand(
    payload.edge as SerializedGraph["edges"][number],
  );
}

export function createSetNodeDataCommandFromJson(
  payload: Record<string, unknown>,
): SetNodeDataCommand {
  return new SetNodeDataCommand(
    String(payload.nodeId),
    payload.from as Record<string, unknown>,
    payload.to as Record<string, unknown>,
    payload.mergeKey ? String(payload.mergeKey) : undefined,
  );
}
