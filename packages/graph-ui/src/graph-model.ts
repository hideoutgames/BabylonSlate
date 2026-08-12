import type { GraphDocument, GraphEdge } from "./graph-types";

export const DEFAULT_NODE_TYPE = "logMessage";

interface CanvasNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: unknown;
}

const NODE_TYPE_KEY = "__nodeType";

function serializedNodeType(node: CanvasNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data[NODE_TYPE_KEY] === "string") {
    return data[NODE_TYPE_KEY];
  }
  return node.type ?? DEFAULT_NODE_TYPE;
}

function serializedNodeData(data: unknown): Record<string, unknown> {
  const raw = (data ?? {}) as Record<string, unknown>;
  if (!(NODE_TYPE_KEY in raw)) {
    return raw;
  }
  const rest = { ...raw };
  delete rest[NODE_TYPE_KEY];
  return rest;
}

/**
 * Projects React Flow's canvas nodes back onto the serialized graph shape.
 * Kept pure so it is testable without mounting a canvas.
 */
export function toSerializedGraph(
  nodes: CanvasNode[],
  edges: GraphEdge[],
  extras?: Pick<GraphDocument, "members">,
): GraphDocument {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: serializedNodeType(node),
      position: node.position,
      data: serializedNodeData(node.data),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    })),
    ...(extras?.members && extras.members.length > 0
      ? { members: extras.members }
      : {}),
  };
}

export function nodesMissingFromLocal<T extends { id: string }>(
  local: readonly T[],
  incoming: readonly T[],
): T[] {
  const have = new Set(local.map((node) => node.id));
  return incoming.filter((node) => !have.has(node.id));
}

export function createEdgeId(
  source: string,
  sourceHandle: string | undefined,
  target: string,
  targetHandle: string | undefined,
): string {
  return `e:${source}:${sourceHandle ?? ""}:${target}:${targetHandle ?? ""}`;
}
