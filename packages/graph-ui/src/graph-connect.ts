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
  /** Compatible non-source pin centers; zone-add-node snap-connects when near one. */
  snapPins?: Array<{ x: number; y: number }>;
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

function sameDirectedPair(left: PinEdgeRef, right: PinEdgeRef): boolean {
  return left.source === right.source && left.target === right.target;
}

function sameTopology(left: PinEdgeRef, right: PinEdgeRef): boolean {
  return (
    sameDirectedPair(left, right) &&
    (left.sourceHandle ?? "") === (right.sourceHandle ?? "") &&
    (left.targetHandle ?? "") === (right.targetHandle ?? "")
  );
}

export type OrientedConnection = {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
};

/** Swap an input-first drag so the output pin is always `source`. */
export function orientConnectionByPins(
  connection: {
    source?: string | null;
    target?: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
  pinFor: ConnectPinLookup,
): OrientedConnection | null {
  const source = connection.source;
  const target = connection.target;
  const sourceHandle = connection.sourceHandle;
  const targetHandle = connection.targetHandle;
  if (!source || !target || !sourceHandle || !targetHandle) return null;
  const sourcePin = pinFor(source, sourceHandle);
  const targetPin = pinFor(target, targetHandle);
  if (!sourcePin || !targetPin) {
    return { source, target, sourceHandle, targetHandle };
  }
  if (sourcePin.direction === targetPin.direction) return null;
  if (sourcePin.direction === "out") {
    return { source, target, sourceHandle, targetHandle };
  }
  return {
    source: target,
    target: source,
    sourceHandle: targetHandle,
    targetHandle: sourceHandle,
  };
}

export type ConnectionNormalizer = (
  connection: OrientedConnection,
) => OrientedConnection | null;

/**
 * Orient to output→input, then run an optional host rewrite (Animation Graph
 * handle migration). Host rewrite still runs when stacked same-side plates
 * look same-direction so `left-out` can become `left-in`.
 */
export function finalizeOrientedConnection(
  connection: {
    source?: string | null;
    target?: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
  pinFor: ConnectPinLookup,
  normalize?: ConnectionNormalizer,
): OrientedConnection | null {
  const oriented = orientConnectionByPins(connection, pinFor);
  const fallback =
    connection.source &&
    connection.target &&
    connection.sourceHandle &&
    connection.targetHandle
      ? {
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
        }
      : null;
  const base = oriented ?? fallback;
  if (!base) return null;
  if (!normalize) return oriented;
  const normalized = normalize(base);
  if (
    !normalized?.source ||
    !normalized.target ||
    !normalized.sourceHandle ||
    !normalized.targetHandle
  ) {
    return null;
  }
  const again = orientConnectionByPins(normalized, pinFor);
  if (again) return again;
  const sourcePin = pinFor(normalized.source, normalized.sourceHandle);
  const targetPin = pinFor(normalized.target, normalized.targetHandle);
  if (sourcePin && targetPin) return null;
  return normalized;
}

function directedEdgeId(edge: OrientedConnection): string {
  return `e:${edge.source}:${edge.sourceHandle}:${edge.target}:${edge.targetHandle}`;
}

export function edgesAfterConnect<T extends PinEdgeRef>(
  edges: readonly T[],
  next: T,
  pinFor: ConnectPinLookup,
  options?: { replaceIncoming?: boolean; uniqueDirectedPair?: boolean },
): T[] {
  const oriented = orientConnectionByPins(next, pinFor);
  if (
    next.source &&
    next.target &&
    next.sourceHandle &&
    next.targetHandle &&
    pinFor(next.source, next.sourceHandle) &&
    pinFor(next.target, next.targetHandle) &&
    oriented === null
  ) {
    return [...edges];
  }
  const candidate: T = oriented
    ? {
        ...next,
        source: oriented.source,
        target: oriented.target,
        sourceHandle: oriented.sourceHandle,
        targetHandle: oriented.targetHandle,
        id:
          next.source === oriented.source &&
          next.target === oriented.target &&
          (next.sourceHandle ?? "") === oriented.sourceHandle &&
          (next.targetHandle ?? "") === oriented.targetHandle
            ? (next.id ?? directedEdgeId(oriented))
            : directedEdgeId(oriented),
      }
    : next;
  if (candidate.id && edges.some((edge) => edge.id === candidate.id)) {
    return [...edges];
  }
  if (edges.some((edge) => sameTopology(edge, candidate))) {
    return [...edges];
  }
  if (options?.uniqueDirectedPair === true) {
    const pairIndex = edges.findIndex((edge) =>
      sameDirectedPair(edge, candidate),
    );
    if (pairIndex >= 0) {
      const current = edges[pairIndex]!;
      const updated = [
        ...edges.slice(0, pairIndex),
        {
          ...current,
          source: candidate.source,
          target: candidate.target,
          sourceHandle: candidate.sourceHandle,
          targetHandle: candidate.targetHandle,
          id: current.id ?? candidate.id,
        },
        ...edges.slice(pairIndex + 1),
      ];
      return updated;
    }
  }
  const targetPin = pinFor(candidate.target, candidate.targetHandle ?? "");
  const exclusive =
    options?.replaceIncoming === true || !pinAllowsMultipleIncoming(targetPin);
  const kept = exclusive
    ? edges.filter(
        (edge) =>
          !(
            edge.target === candidate.target &&
            edge.targetHandle === candidate.targetHandle
          ),
      )
    : [...edges];
  const id =
    candidate.id ??
    `e:${candidate.source}:${candidate.sourceHandle ?? ""}:${candidate.target}:${candidate.targetHandle ?? ""}`;
  return [...kept, { ...candidate, id }];
}

export function displayNodeTitle(
  nodeType: string,
  title?: string,
  qualifier?: string,
): string {
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
      qualifier,
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
  const list = pins ?? [];
  const preferredId = oppositeSideHandleId(dragged.id);
  if (preferredId) {
    const preferred = list.find(
      (pin) => pin.id === preferredId && pinsAreCompatible(dragged, pin, rule),
    );
    if (preferred) return preferred;
  }
  return list.find((pin) => pinsAreCompatible(dragged, pin, rule));
}

const OPPOSITE_SIDE: Record<string, string> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

export function oppositeSideHandleId(pinId: string): string | undefined {
  const match = /^(top|right|bottom|left)-(in|out)$/.exec(pinId);
  if (!match) return undefined;
  const side = match[1]!;
  const direction = match[2]!;
  const oppositeSide = OPPOSITE_SIDE[side];
  if (!oppositeSide) return undefined;
  return `${oppositeSide}-${direction === "out" ? "in" : "out"}`;
}

export function filterPaletteForPin(
  nodes: PaletteNode[],
  dragged: SerializedPin,
  rule?: PinCompatibilityRule,
): PaletteNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => firstCompatiblePin(node.pins, dragged, rule))
    .sort((left, right) => {
      const score =
        palettePreferenceScore(right.node, dragged) -
        palettePreferenceScore(left.node, dragged);
      return score !== 0 ? score : left.index - right.index;
    })
    .map(({ node }) => node);
}

function palettePreferenceScore(
  node: PaletteNode,
  dragged: SerializedPin,
): number {
  const kind = dragged.type.kind;
  const guid =
    typeof dragged.type.guid === "string" ? dragged.type.guid.trim() : "";
  if (guid && kind === "structRef" && isPreferredStructNode(node, guid)) {
    return 2;
  }
  if (guid && kind === "enumRef" && isPreferredEnumNode(node, guid)) {
    return 2;
  }
  if (
    kind === "rotator" &&
    (node.id === "struct.makeRotator" || node.id === "struct.breakRotator")
  ) {
    return 2;
  }
  if (
    kind === "color" &&
    (node.id === "struct.makeColor" || node.id === "struct.breakColor")
  ) {
    return 2;
  }
  if (
    kind === "transform" &&
    (node.id === "struct.makeTransform" || node.id === "struct.breakTransform")
  ) {
    return 2;
  }
  if (
    kind === "quat" &&
    (node.id === "quat.make" || node.id === "quat.break")
  ) {
    return 2;
  }
  if (node.id === literalMakeIdForKind(kind)) {
    return 2;
  }
  if (kind === "int" && catalogTypeId(node) === "flow.switchInt") {
    return 2;
  }
  if (kind === "string" && catalogTypeId(node) === "flow.switchString") {
    return 2;
  }
  return 0;
}

function literalMakeIdForKind(kind: string): string | undefined {
  switch (kind) {
    case "bool":
      return "literal.makeBool";
    case "int":
      return "literal.makeInt";
    case "float":
      return "literal.makeFloat";
    case "string":
      return "literal.makeString";
    case "classRef":
      return "literal.makeClass";
    case "assetRef":
      return "literal.makeAsset";
    case "quat":
      return "literal.makeQuat";
    default:
      return undefined;
  }
}

function catalogTypeId(node: PaletteNode): string {
  return node.nodeType ?? node.id.split(":")[0]!;
}

function isPreferredStructNode(node: PaletteNode, guid: string): boolean {
  const typeId = catalogTypeId(node);
  if (typeId !== "struct.make" && typeId !== "struct.break") return false;
  if (node.id === `${typeId}:${guid}`) return true;
  return node.defaultData?.structGuid === guid;
}

function isPreferredEnumNode(node: PaletteNode, guid: string): boolean {
  const typeId = catalogTypeId(node);
  if (
    typeId !== "enum.make" &&
    typeId !== "enum.equals" &&
    typeId !== "enum.notEquals" &&
    typeId !== "enum.toString" &&
    typeId !== "enum.switch" &&
    typeId !== "enum.select"
  ) {
    return false;
  }
  if (node.id === `${typeId}:${guid}`) return true;
  return node.defaultData?.enumGuid === guid;
}

export function isNearSourcePin(
  from: { x: number; y: number },
  to: { x: number; y: number },
  thresholdPx = CONNECT_END_CANCEL_PX,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) < thresholdPx;
}

export type SnapConnectPin = {
  nodeId: string;
  pinId: string;
  x: number;
  y: number;
};

export function nearestSnapConnectPin(
  pointer: { x: number; y: number },
  source: { nodeId: string; pinId: string },
  pins: readonly SnapConnectPin[],
  thresholdPx = CONNECT_END_CANCEL_PX,
): { nodeId: string; pinId: string } | undefined {
  let best: { nodeId: string; pinId: string; dist: number } | undefined;
  for (const pin of pins) {
    if (pin.nodeId === source.nodeId) continue;
    const dist = Math.hypot(pin.x - pointer.x, pin.y - pointer.y);
    if (dist >= thresholdPx) continue;
    if (!best || dist < best.dist) {
      best = { nodeId: pin.nodeId, pinId: pin.pinId, dist };
    }
  }
  return best ? { nodeId: best.nodeId, pinId: best.pinId } : undefined;
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

export type ConnectEndAction = "add-node" | "break" | "none" | "connect";

function isNearSnapPin(decision: ConnectEndDecision): boolean {
  return (decision.snapPins ?? []).some((pin) =>
    isNearSourcePin(pin, decision.pointer, decision.thresholdPx),
  );
}

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
    if (isNearSnapPin(decision)) return "connect";
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

export function screenPinsForSafeRefs(
  root: ParentNode,
  refs: SafeConnectPinRef[],
): SnapConnectPin[] {
  const handles = Array.from(root.querySelectorAll(".react-flow__handle"));
  const pins: SnapConnectPin[] = [];
  for (const ref of refs) {
    const handle = handles.find(
      (entry) =>
        entry.getAttribute("data-nodeid") === ref.nodeId &&
        entry.getAttribute("data-handleid") === ref.pinId,
    );
    if (!handle) continue;
    const rect = handle.getBoundingClientRect();
    pins.push({
      nodeId: ref.nodeId,
      pinId: ref.pinId,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }
  return pins;
}

export function screenCentersForSafePins(
  root: ParentNode,
  refs: SafeConnectPinRef[],
): Array<{ x: number; y: number }> {
  return screenPinsForSafeRefs(root, refs).map((pin) => ({
    x: pin.x,
    y: pin.y,
  }));
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
