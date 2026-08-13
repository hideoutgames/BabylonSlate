import {
  formatEventTitle,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import {
  hasSerializedPins,
  type PaletteNode,
  type SerializedPin,
} from "./graph-types";

/** Drop closer than this (screen px) to a safe pin cancels Add Node. */
export const CONNECT_END_CANCEL_PX = 96;

export type SafeConnectPinRef = {
  nodeId: string;
  pinId: string;
};

export type ConnectEndDecision = {
  hasTargetHandle: boolean;
  pointerOverNode: boolean;
  pointer: { x: number; y: number };
  safePins: Array<{ x: number; y: number }>;
  thresholdPx?: number;
};

export type ConnectEndBreakDecision = ConnectEndDecision & {
  pointerOverSourceHandle: boolean;
};

type PinEdgeRef = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export function displayNodeTitle(nodeType: string, title?: string): string {
  if (nodeType.startsWith("flow.event.")) {
    return formatEventTitle(
      title?.trim() || nodeType.slice("flow.event.".length),
    );
  }
  if (title && title.trim().length > 0) return title;
  return humanizePropertyLabel(nodeType.replace(/\./g, " "));
}

export function pinsAreCompatible(
  source: SerializedPin,
  target: SerializedPin,
): boolean {
  if (source.direction === target.direction) return false;
  const outgoing = source.direction === "out" ? source : target;
  const incoming = source.direction === "in" ? source : target;
  if (outgoing.kind !== incoming.kind) return false;
  if (outgoing.kind === "exec") return true;
  if (outgoing.type.kind === incoming.type.kind) return true;
  return (
    outgoing.type.kind.toLowerCase().includes("wildcard") ||
    incoming.type.kind.toLowerCase().includes("wildcard")
  );
}

export function firstCompatiblePin(
  pins: SerializedPin[] | undefined,
  dragged: SerializedPin,
): SerializedPin | undefined {
  return (pins ?? []).find((pin) => pinsAreCompatible(dragged, pin));
}

export function filterPaletteForPin(
  nodes: PaletteNode[],
  dragged: SerializedPin,
): PaletteNode[] {
  return nodes.filter((node) => firstCompatiblePin(node.pins, dragged));
}

export function isNearSourcePin(
  from: { x: number; y: number },
  to: { x: number; y: number },
  thresholdPx = CONNECT_END_CANCEL_PX,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) < thresholdPx;
}

export function collectSafeConnectPins(
  nodes: Array<{ id: string; pins?: SerializedPin[] }>,
  draggedNodeId: string,
  draggedPin: SerializedPin,
): SafeConnectPinRef[] {
  const refs: SafeConnectPinRef[] = [
    { nodeId: draggedNodeId, pinId: draggedPin.id },
  ];
  for (const node of nodes) {
    for (const pin of node.pins ?? []) {
      if (node.id === draggedNodeId && pin.id === draggedPin.id) continue;
      if (pinsAreCompatible(draggedPin, pin)) {
        refs.push({ nodeId: node.id, pinId: pin.id });
      }
    }
  }
  return refs;
}

export function shouldOpenAddNodeOnConnectEnd({
  hasTargetHandle,
  pointerOverNode,
  pointer,
  safePins,
  thresholdPx = CONNECT_END_CANCEL_PX,
}: ConnectEndDecision): boolean {
  if (hasTargetHandle || pointerOverNode) return false;
  return !safePins.some((pin) => isNearSourcePin(pin, pointer, thresholdPx));
}

export function shouldBreakPinConnectionsOnConnectEnd(
  decision: ConnectEndBreakDecision,
): boolean {
  if (decision.hasTargetHandle || decision.pointerOverSourceHandle) {
    return false;
  }
  if (shouldOpenAddNodeOnConnectEnd(decision)) return false;
  return true;
}

export function edgeTouchesPin(
  edge: PinEdgeRef,
  nodeId: string,
  pinId: string,
): boolean {
  return (
    (edge.source === nodeId && edge.sourceHandle === pinId) ||
    (edge.target === nodeId && edge.targetHandle === pinId)
  );
}

export function edgesTouchingPin<T extends PinEdgeRef>(
  edges: readonly T[],
  nodeId: string,
  pinId: string,
): T[] {
  return edges.filter((edge) => edgeTouchesPin(edge, nodeId, pinId));
}

export function nodePinLists(
  nodes: Array<{ id: string; data?: Record<string, unknown> }>,
): Array<{ id: string; pins?: SerializedPin[] }> {
  return nodes.map((node) => ({
    id: node.id,
    pins: hasSerializedPins(node.data) ? node.data.__pins : undefined,
  }));
}

export function screenCentersForSafePins(
  root: ParentNode,
  refs: SafeConnectPinRef[],
): Array<{ x: number; y: number }> {
  const handles = Array.from(root.querySelectorAll(".react-flow__handle"));
  const centers: Array<{ x: number; y: number }> = [];
  for (const ref of refs) {
    const handle = handles.find(
      (entry) =>
        entry.getAttribute("data-nodeid") === ref.nodeId &&
        entry.getAttribute("data-handleid") === ref.pinId,
    );
    if (!handle) continue;
    const rect = handle.getBoundingClientRect();
    centers.push({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }
  return centers;
}

export function isClientPointOverGraphNode(
  pointer: { x: number; y: number },
  root: ParentNode = document,
): boolean {
  const nodes = Array.from(root.querySelectorAll(".react-flow__node"));
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

export function isClientPointOverHandle(
  pointer: { x: number; y: number },
  nodeId: string,
  pinId: string,
  root: ParentNode = document,
): boolean {
  const handles = Array.from(root.querySelectorAll(".react-flow__handle"));
  const handle = handles.find(
    (entry) =>
      entry.getAttribute("data-nodeid") === nodeId &&
      entry.getAttribute("data-handleid") === pinId,
  );
  if (!handle) return false;
  const rect = handle.getBoundingClientRect();
  return (
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom
  );
}

export function containerPointerToClient(
  pointer: { x: number; y: number },
  container: Element,
): { x: number; y: number } {
  const rect = container.getBoundingClientRect();
  return { x: rect.left + pointer.x, y: rect.top + pointer.y };
}
