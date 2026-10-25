import type { GraphEdge, GraphNode, GraphPin, LogicGraph } from "./ir";
import { findPin } from "./ir";
import type { PinType } from "./types";
import { pinTypeKey, resolveWildcardPinTypes } from "./wildcard-resolve";

/** Node, incoming and outgoing edge lookups built once per compile. */
export type GraphIndex = {
  node(nodeId: string): GraphNode | undefined;
  /** First edge into an input pin, in authored edge order. */
  incoming(nodeId: string, pinId: string): GraphEdge | undefined;
  /** Edges leaving a node, in authored edge order. */
  outgoing(nodeId: string): readonly GraphEdge[];
};

export function indexGraph(graph: LogicGraph): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  const incoming = new Map<string, GraphEdge>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const key = `${edge.targetNodeId}\0${edge.targetPinId}`;
    if (!incoming.has(key)) incoming.set(key, edge);
    const leaving = outgoing.get(edge.sourceNodeId);
    if (leaving) leaving.push(edge);
    else outgoing.set(edge.sourceNodeId, [edge]);
  }
  return {
    node: (nodeId) => nodes.get(nodeId),
    incoming: (nodeId, pinId) => incoming.get(`${nodeId}\0${pinId}`),
    outgoing: (nodeId) => outgoing.get(nodeId) ?? [],
  };
}

/** Codegen sees concrete pin types; the authored graph keeps its wildcards. */
export function withResolvedPinTypes(graph: LogicGraph): LogicGraph {
  const resolved = resolveWildcardPinTypes(graph).resolved;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      pins: node.pins.map((pin) => ({
        ...pin,
        type: resolved.get(pinTypeKey(node.id, pin.id)) ?? pin.type,
      })),
    })),
  };
}

function isPassthroughExecOut(pin: GraphPin): boolean {
  return (
    pin.kind === "exec" &&
    pin.direction === "out" &&
    (pin.name === "then" || pin.name.startsWith("then_"))
  );
}

/**
 * Skip-as-no-op: continue at `then`, or Sequence `then_*` pins in order.
 * Exclusive Branch true/false (and any other multi-out that is not `then`)
 * are not entered — the stripped node cannot choose an arm.
 */
export function stripExecSuccessors(index: GraphIndex, node: GraphNode) {
  const passthrough = node.pins.filter(isPassthroughExecOut);
  if (passthrough.length > 0) {
    return passthrough.flatMap((out) => execSuccessorEdges(index, node.id, out.id));
  }
  const outs = node.pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "out",
  );
  if (outs.length === 1) {
    return execSuccessorEdges(index, node.id, outs[0]!.id);
  }
  return [];
}

/**
 * Exec outputs named by pin id, or by display name when no pin has that id
 * (generic `then`, `ctx.branch` arms). Ids keep a case such as "Default" or a
 * Title Case label from also matching another pin's name.
 */
function execOutPins(node: GraphNode, pinRef?: string): GraphPin[] {
  const outs = node.pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "out",
  );
  if (pinRef === undefined) return outs;
  const byId = outs.filter((pin) => pin.id === pinRef);
  return byId.length > 0 ? byId : outs.filter((pin) => pin.name === pinRef);
}

/** An exec wire followed to its target; `GraphEdge` fits. */
export type ExecTarget = { id: string; targetNodeId: string; targetPinId: string };

export function execSuccessorEdges(
  index: GraphIndex,
  nodeId: string,
  pinRef?: string,
): ExecTarget[] {
  const node = index.node(nodeId);
  if (!node) return [];
  const leaving = index.outgoing(nodeId);
  const result: ExecTarget[] = [];
  for (const out of execOutPins(node, pinRef)) {
    for (const e of leaving) {
      if (e.sourcePinId === out.id) {
        result.push({
          id: e.id,
          targetNodeId: e.targetNodeId,
          targetPinId: e.targetPinId,
        });
      }
    }
  }
  return result;
}

export function entryPinMatches(
  node: GraphNode,
  pinRef: string,
  entryPinId: string | undefined,
): boolean {
  if (!entryPinId) {
    const preferred = pinForCodegen(node, pinRef, "in");
    if (!preferred) return false;
    const execIns = node.pins.filter(
      (p) => p.kind === "exec" && p.direction === "in",
    );
    if (execIns.length <= 1) return true;
    return preferred.id === execIns[0]?.id;
  }
  const pin = findPin(node, entryPinId);
  return !!pin && (pin.id === pinRef || pin.name === pinRef);
}

/** Static type of the pin wired into `pinId`, unless disconnected or stripped. */
export function wiredSourceType(
  index: GraphIndex,
  node: GraphNode,
  pinId: string,
  shouldStrip: (node: GraphNode) => boolean,
): PinType | undefined {
  const incoming = index.incoming(node.id, pinId);
  if (!incoming) return undefined;
  const srcNode = index.node(incoming.sourceNodeId);
  const srcPin = srcNode && findPin(srcNode, incoming.sourcePinId);
  if (!srcNode || !srcPin || shouldStrip(srcNode)) return undefined;
  return srcPin.type;
}

export function pinForCodegen(
  node: GraphNode,
  pinName: string,
  direction: "in" | "out",
): GraphPin | undefined {
  return (
    node.pins.find(
      (pin) => pin.direction === direction && pin.id === pinName,
    ) ??
    node.pins.find((pin) => pin.direction === direction && pin.name === pinName)
  );
}
