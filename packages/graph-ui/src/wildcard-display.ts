import {
  pinTypeFromJson,
  pinTypeKey,
  resolveWildcardPinTypes,
  type PinType,
} from "@babylonslate/scripting";
import { hasSerializedPins } from "./graph-types";

export type PinDisplayLookup = Map<string, PinType>;

export type PinDisplayNode = {
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
  nodes: readonly PinDisplayNode[],
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

/** Retain position-independent inputs across immutable XYFlow node updates. */
export function createPinDisplayNodesSelector() {
  let previousNodes: readonly PinDisplayNode[] = [];
  let signatures: string[] = [];
  let pinNodes: readonly PinDisplayNode[] = [];

  return (nodes: readonly PinDisplayNode[]): readonly PinDisplayNode[] => {
    if (nodes === previousNodes) return pinNodes;
    let changed = nodes.length !== previousNodes.length;
    const nextSignatures = nodes.map((node, index) => {
      const previous = previousNodes[index];
      // Position, selection and measurement updates retain node.data. Only
      // changed data needs its pin definitions inspected, including host edits.
      const signature =
        previous?.id === node.id && previous.data === node.data
          ? signatures[index]
          : JSON.stringify([
              node.id,
              hasSerializedPins(node.data)
                ? node.data.__pins.map((pin) => [pin.id, pin.type])
                : [],
            ]);
      if (signature !== signatures[index]) changed = true;
      return signature;
    });
    previousNodes = nodes;
    signatures = nextSignatures;
    if (changed) {
      pinNodes = nodes.map((node) => ({
        id: node.id,
        data: { __pins: hasSerializedPins(node.data) ? node.data.__pins : [] },
      }));
    }
    return pinNodes;
  };
}

export { pinTypeKey };
