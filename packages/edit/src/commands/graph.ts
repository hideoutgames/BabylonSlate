import type { SerializedGraph } from "@babylonslate/core";
import type { EditCommand } from "../command";

export class MoveNodeCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.moveNode";
  readonly mergeKey: string;
  readonly nodeId: string;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };

  constructor(
    nodeId: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) {
    this.nodeId = nodeId;
    this.from = from;
    this.to = to;
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
  readonly edge: SerializedGraph["edges"][number];

  constructor(edge: SerializedGraph["edges"][number]) {
    this.edge = edge;
  }

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
  readonly edge: SerializedGraph["edges"][number];

  constructor(edge: SerializedGraph["edges"][number]) {
    this.edge = edge;
  }

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
  readonly nodeId: string;
  readonly from: Record<string, unknown>;
  readonly to: Record<string, unknown>;
  /** Captured payload size so snapshot-style data edits count toward the byte budget. */
  readonly byteSize: number;

  constructor(
    nodeId: string,
    from: Record<string, unknown>,
    to: Record<string, unknown>,
    mergeKey?: string,
  ) {
    this.nodeId = nodeId;
    this.from = from;
    this.to = to;
    this.mergeKey = mergeKey ?? `data:${nodeId}`;
    this.byteSize =
      new TextEncoder().encode(JSON.stringify({ from, to })).byteLength;
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

export class AddNodeCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.addNode";
  readonly node: SerializedGraph["nodes"][number];

  constructor(node: SerializedGraph["nodes"][number]) {
    this.node = node;
  }

  apply(doc: SerializedGraph): SerializedGraph {
    if (doc.nodes.some((entry) => entry.id === this.node.id)) {
      return doc;
    }
    return {
      ...doc,
      nodes: [...doc.nodes, this.node],
    };
  }

  invert(): RemoveNodeCommand {
    return new RemoveNodeCommand(this.node);
  }
}

export class RemoveNodeCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.removeNode";
  readonly node: SerializedGraph["nodes"][number];

  constructor(node: SerializedGraph["nodes"][number]) {
    this.node = node;
  }

  apply(doc: SerializedGraph): SerializedGraph {
    return {
      ...doc,
      nodes: doc.nodes.filter((entry) => entry.id !== this.node.id),
      edges: doc.edges.filter(
        (edge) => edge.source !== this.node.id && edge.target !== this.node.id,
      ),
    };
  }

  invert(): AddNodeCommand {
    return new AddNodeCommand(this.node);
  }
}

export class SetGraphMembersCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.setMembers";
  readonly from: SerializedGraph["members"];
  readonly to: SerializedGraph["members"];

  constructor(
    from: SerializedGraph["members"],
    to: SerializedGraph["members"],
  ) {
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedGraph): SerializedGraph {
    if (this.to === undefined) {
      const next = { ...doc };
      delete next.members;
      return next;
    }
    return { ...doc, members: this.to };
  }

  invert(): SetGraphMembersCommand {
    return new SetGraphMembersCommand(this.to, this.from);
  }
}

export class SetGraphComponentsCommand implements EditCommand<SerializedGraph> {
  readonly type = "graph.setComponents";
  readonly from: SerializedGraph["components"];
  readonly to: SerializedGraph["components"];

  constructor(
    from: SerializedGraph["components"],
    to: SerializedGraph["components"],
  ) {
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedGraph): SerializedGraph {
    if (this.to === undefined) {
      const next = { ...doc };
      delete next.components;
      return next;
    }
    return { ...doc, components: this.to };
  }

  invert(): SetGraphComponentsCommand {
    return new SetGraphComponentsCommand(this.to, this.from);
  }
}

export type GraphEditCommand =
  | MoveNodeCommand
  | AddEdgeCommand
  | RemoveEdgeCommand
  | SetNodeDataCommand
  | AddNodeCommand
  | RemoveNodeCommand
  | SetGraphMembersCommand
  | SetGraphComponentsCommand;

export const GRAPH_COMMAND_TYPES = [
  "graph.moveNode",
  "graph.addEdge",
  "graph.removeEdge",
  "graph.setNodeData",
  "graph.addNode",
  "graph.removeNode",
  "graph.setMembers",
  "graph.setComponents",
] as const;

export function createMoveNodeCommandFromJson(
  payload: Record<string, unknown>,
): MoveNodeCommand {
  const from = payload.from as { x: number; y: number };
  const to = payload.to as { x: number; y: number };
  return new MoveNodeCommand(String(payload.nodeId), from, to);
}

export function createAddEdgeCommandFromJson(
  payload: Record<string, unknown>,
): AddEdgeCommand {
  return new AddEdgeCommand(payload.edge as SerializedGraph["edges"][number]);
}

export function createRemoveEdgeCommandFromJson(
  payload: Record<string, unknown>,
): RemoveEdgeCommand {
  return new RemoveEdgeCommand(payload.edge as SerializedGraph["edges"][number]);
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

export function createAddNodeCommandFromJson(
  payload: Record<string, unknown>,
): AddNodeCommand {
  return new AddNodeCommand(payload.node as SerializedGraph["nodes"][number]);
}

export function createRemoveNodeCommandFromJson(
  payload: Record<string, unknown>,
): RemoveNodeCommand {
  return new RemoveNodeCommand(
    payload.node as SerializedGraph["nodes"][number],
  );
}

export function createSetGraphMembersCommandFromJson(
  payload: Record<string, unknown>,
): SetGraphMembersCommand {
  return new SetGraphMembersCommand(
    payload.from as SerializedGraph["members"],
    payload.to as SerializedGraph["members"],
  );
}

export function createSetGraphComponentsCommandFromJson(
  payload: Record<string, unknown>,
): SetGraphComponentsCommand {
  return new SetGraphComponentsCommand(
    payload.from as SerializedGraph["components"],
    payload.to as SerializedGraph["components"],
  );
}
