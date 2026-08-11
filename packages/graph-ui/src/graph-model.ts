import type { SerializedGraph } from "@babylonslate/core";

export const DEFAULT_NODE_TYPE = "logMessage";

interface CanvasNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: unknown;
}

/**
 * Projects React Flow's canvas nodes back onto the serialized graph shape.
 * Kept pure so it is testable without mounting a canvas.
 */
export function toSerializedGraph(
  nodes: CanvasNode[],
  edges: SerializedGraph["edges"],
): SerializedGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? DEFAULT_NODE_TYPE,
      position: node.position,
      data: (node.data ?? {}) as Record<string, unknown>,
    })),
    edges,
  };
}
