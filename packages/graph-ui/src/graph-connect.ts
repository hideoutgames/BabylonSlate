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
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ConnectPinLookup = (
  nodeId: string,
  pinId: string,
) => SerializedPin | undefined;

/** Exec pins fan-in and fan-out. Data inputs are exclusive. Missing pins do not strip. */
export function pinAllowsMultipleIncoming(
  pin: SerializedPin | undefined,
): boolean {
  if (!pin) return true;
  return pin.kind === "exec";
}

export function edgesAfterConnect<T extends PinEdgeRef>(
  edges: readonly T[],
  next: T,
  pinFor: ConnectPinLookup,
  options?: { replaceIncoming?: boolean },
): T[] {
  if (next.id && edges.some((edge) => edge.id === next.id)) {
    return [...edges];
  }
  const targetPin = pinFor(next.target, next.targetHandle ?? "");
  const exclusive =
    options?.replaceIncoming === true || !pinAllowsMultipleIncoming(targetPin);
  const kept = exclusive
    ? edges.filter(
        (edge) =>
          !(
            edge.target === next.target &&
            edge.targetHandle === next.targetHandle
          ),
      )
    : [...edges];
  const id =
    next.id ??
    `e:${next.source}:${next.sourceHandle ?? ""}:${next.target}:${next.targetHandle ?? ""}`;
  return [...kept, { ...next, id }];
}

export function displayNodeTitle(nodeType: string, title?: string): string {
  // Call Custom Event / Call Parent must stay "Call …", not "Event Call …".
  if (nodeType === "flow.event.call" || nodeType === "flow.event.callParent") {
    if (title && title.trim().length > 0) return title.trim();
    return nodeType === "flow.event.callParent"
      ? "Call Parent Event"
      : "Call Custom Event";
  }
  if (nodeType.startsWith("flow.event.")) {
    return formatEventTitle(
      title?.trim() || nodeType.slice("flow.event.".length),
    );
  }
  if (title && title.trim().length > 0) return title;
  return humanizePropertyLabel(nodeType.replace(/\./g, " "));
}

/**
 * Host-supplied connection rule. Material graphs allow a Float to splat into a
 * vector pin, which the default exact-kind rule would reject.
 */
export type PinCompatibilityRule = (
  outgoing: SerializedPin,
  incoming: SerializedPin,
) => boolean;

export function pinsAreCompatible(
  source: SerializedPin,
  target: SerializedPin,
  rule?: PinCompatibilityRule,
): boolean {
  if (source.direction === target.direction) return false;
  const outgoing = source.direction === "out" ? source : target;
  const incoming = source.direction === "in" ? source : target;
  if (outgoing.kind !== incoming.kind) return false;
  if (outgoing.kind === "exec") return true;
  if (rule) return rule(outgoing, incoming);
  if (outgoing.type.kind === incoming.type.kind) return true;
  return (
    outgoing.type.kind.toLowerCase().includes("wildcard") ||
    incoming.type.kind.toLowerCase().includes("wildcard")
  );
}

export function firstCompatiblePin(
  pins: SerializedPin[] | undefined,
  dragged: SerializedPin,
  rule?: PinCompatibilityRule,
): SerializedPin | undefined {
  return (pins ?? []).find((pin) => pinsAreCompatible(dragged, pin, rule));
}

export function filterPaletteForPin(
  nodes: PaletteNode[],
  dragged: SerializedPin,
  rule?: PinCompatibilityRule,
): PaletteNode[] {
  return nodes.filter((node) => firstCompatiblePin(node.pins, dragged, rule));
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
  rule?: PinCompatibilityRule,
): SafeConnectPinRef[] {
  const refs: SafeConnectPinRef[] = [
    { nodeId: draggedNodeId, pinId: draggedPin.id },
  ];
  for (const node of nodes) {
    for (const pin of node.pins ?? []) {
      if (node.id === draggedNodeId && pin.id === draggedPin.id) continue;
      if (pinsAreCompatible(draggedPin, pin, rule)) {
        refs.push({ nodeId: node.id, pinId: pin.id });
      }
    }
  }
  return refs;
}

export function connectEventPointerId(event: Event | {
  pointerId?: number;
  changedTouches?: ArrayLike<{ identifier: number }>;
}): number {
  const pointerId = (event as { pointerId?: number }).pointerId;
  if (typeof pointerId === "number" && pointerId !== 0) {
    return pointerId;
  }
  const touch = (event as { changedTouches?: ArrayLike<{ identifier: number }> })
    .changedTouches?.[0];
  if (touch && typeof touch.identifier === "number") return touch.identifier;
  return 1;
}

export type ConnectEndMode =
  | "default"
  | "add-node"
  | "disabled"
  | "zone-add-node";

export type SecondaryCancelPointer = {
  connectionActive: boolean;
  dragPointerId: number | null;
  eventPointerId: number;
  inAddNodeZone: boolean;
};

export function shouldCancelConnectOnSecondaryPointer({
  connectionActive,
  dragPointerId,
  eventPointerId,
  inAddNodeZone,
}: SecondaryCancelPointer): boolean {
  if (!connectionActive || !inAddNodeZone) return false;
  if (dragPointerId == null) return false;
  return eventPointerId !== dragPointerId;
}

export type SecondaryAddNodeCancelPointer = {
  connectionActive: boolean;
  dragPointerId: number | null;
  eventPointerId: number;
  mode: ConnectEndMode;
};

export function shouldCancelConnectionOnSecondaryPointer({
  connectionActive,
  dragPointerId,
  eventPointerId,
  mode,
}: SecondaryAddNodeCancelPointer): boolean {
  if (mode !== "add-node") return false;
  if (!connectionActive) return false;
  if (dragPointerId == null) return false;
  return eventPointerId !== dragPointerId;
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

export type ConnectEndAction = "add-node" | "break" | "none";

export function connectEndAction(
  decision: ConnectEndBreakDecision,
  mode: ConnectEndMode = "default",
): ConnectEndAction {
  if (mode === "disabled") return "none";
  if (decision.hasTargetHandle) return "none";
  if (mode === "add-node") {
    if (decision.pointerOverNode) return "none";
    return "add-node";
  }
  if (mode === "zone-add-node") {
    if (decision.pointerOverNode) return "none";
    if (shouldOpenAddNodeOnConnectEnd(decision)) return "add-node";
    return "none";
  }
  if (shouldOpenAddNodeOnConnectEnd(decision)) return "add-node";
  if (shouldBreakPinConnectionsOnConnectEnd(decision)) return "break";
  return "none";
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

export function edgeTouchesNode(edge: PinEdgeRef, nodeId: string): boolean {
  return edge.source === nodeId || edge.target === nodeId;
}

export function edgesTouchingNodes<T extends PinEdgeRef>(
  edges: readonly T[],
  nodeIds: ReadonlySet<string>,
): T[] {
  return edges.filter(
    (edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target),
  );
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
