import type { PinType } from "./types";

export type PinKind = "exec" | "data";
export type PinDirection = "in" | "out";

export type GraphPin = {
  id: string;
  name: string;
  kind: PinKind;
  direction: PinDirection;
  type: PinType;
  optional?: boolean;
};

export type GraphNode = {
  id: string;
  typeId: string;
  position: { x: number; y: number };
  pins: GraphPin[];
  properties: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
};

export type LogicGraphKind = "event" | "function" | "macro";

export type LogicGraph = {
  id: string;
  kind: LogicGraphKind;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export function createEmptyLogicGraph(
  id: string,
  kind: LogicGraphKind = "event",
): LogicGraph {
  return { id, kind, nodes: [], edges: [] };
}

export function findPin(node: GraphNode, pinId: string): GraphPin | undefined {
  return node.pins.find((p) => p.id === pinId);
}

export function findNode(
  graph: LogicGraph,
  nodeId: string,
): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}
