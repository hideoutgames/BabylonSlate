import {
  pinTypeFromJson,
  pinTypeKey,
  resolveWildcardPinTypes,
  type PinType,
} from "@haptic/scripting";
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
  markDataOnlyKnots(nodes, edges, result.display);
  return result.display;
}

/**
 * A Reroute chain still unbound but already wired to a pin that only carries data (a data input, an
 * unbound ordinary wildcard) can never carry exec: its knots' display types are marked `dataOnly`,
 * so `anyKindTakesExec` refuses an exec wire. Graphs without knots skip this.
 */
function markDataOnlyKnots(
  nodes: readonly PinDisplayNode[],
  edges: readonly CanvasLikeEdge[],
  display: PinDisplayLookup,
): void {
  const pins = new Map<string, Map<string, { anyKind?: boolean; kind: string }>>();
  let knots = false;
  for (const node of nodes) {
    if (!hasSerializedPins(node.data)) continue;
    const byId = new Map(node.data.__pins.map((pin) => [pin.id, pin]));
    pins.set(node.id, byId);
    if (!knots) knots = node.data.__pins.some((pin) => pin.anyKind === true);
  }
  if (!knots) return;
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let at = id;
    while (parent.has(at) && parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const held: string[] = [];
  for (const edge of edges) {
    const source = pins.get(edge.source)?.get(edge.sourceHandle ?? "");
    const target = pins.get(edge.target)?.get(edge.targetHandle ?? "");
    if (!source || !target) continue;
    if (source.anyKind && target.anyKind) parent.set(root(edge.source), root(edge.target));
    else if (source.anyKind && target.kind === "data") held.push(edge.source);
    else if (target.anyKind && source.kind === "data") held.push(edge.target);
  }
  if (held.length === 0) return;
  const heldRoots = new Set(held.map(root));
  for (const [nodeId, byId] of pins) {
    if (!heldRoots.has(root(nodeId))) continue;
    for (const [pinId, pin] of byId) {
      if (!pin.anyKind) continue;
      const key = pinTypeKey(nodeId, pinId);
      const type = display.get(key);
      if (type?.kind === "resolvingWildcard") display.set(key, { ...type, dataOnly: true } as PinType);
    }
  }
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
