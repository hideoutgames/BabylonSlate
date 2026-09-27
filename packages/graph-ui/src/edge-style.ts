import type { Edge } from "@xyflow/react";
import { hasSerializedPins } from "./graph-types";
import { edgeStyleForPin } from "./node-theme";
import {
  pinTypeKey,
  type PinDisplayLookup,
  type PinDisplayNode,
} from "./wildcard-display";

export function styleFlowEdges(
  edges: readonly Edge[],
  nodes: readonly PinDisplayNode[],
  displayTypes: PinDisplayLookup,
): Edge[] {
  if (edges.length === 0) return [];
  const nodeById = new Map<string, PinDisplayNode>();
  for (const node of nodes) {
    // Keep the first match, as the former per-edge find did.
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  }
  return edges.map((edge) => {
    const source = nodeById.get(edge.source);
    const pins = hasSerializedPins(source?.data) ? source.data.__pins : [];
    const pin = pins.find((entry) => entry.id === edge.sourceHandle);
    const display =
      (edge.sourceHandle
        ? displayTypes.get(pinTypeKey(edge.source, edge.sourceHandle))
        : undefined) ?? pin?.type;
    return {
      ...edge,
      style: edgeStyleForPin(display),
    };
  });
}
