import {
  pinTypeFromJson,
  pinTypeKey,
  resolveWildcardPinTypes,
  type PinType,
} from "@babylonslate/scripting";
import { hasSerializedPins } from "./graph-types";

export type PinDisplayLookup = Map<string, PinType>;

type CanvasLikeNode = {
  id: string;
  data?: Record<string, unknown>;
};

type CanvasLikeEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export function displayPinTypesForGraph(
  nodes: readonly CanvasLikeNode[],
  edges: readonly CanvasLikeEdge[],
): PinDisplayLookup {
  const result = resolveWildcardPinTypes({
    nodes: nodes.map((node) => ({
      id: node.id,
      pins: hasSerializedPins(node.data)
        ? node.data.__pins.map((pin) => ({
            id: pin.id,
            type: pinTypeFromJson(pin.type),
          }))
        : [],
    })),
    edges: edges.map((edge) => ({
      sourceNodeId: edge.source,
      sourcePinId: edge.sourceHandle ?? "",
      targetNodeId: edge.target,
      targetPinId: edge.targetHandle ?? "",
    })),
  });
  return result.display;
}

export { pinTypeKey };
