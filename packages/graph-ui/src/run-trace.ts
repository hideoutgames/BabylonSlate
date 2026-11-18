import { hasSerializedPins, isRerouteNodeData, type SerializedPin } from "./graph-types";

/**
 * What ran in a graph while its owner was running, for a canvas to show. Any graph kind can
 * supply one: Class graphs report exec nodes and wires, Behaviour Trees and Animation Graphs
 * report the nodes and transitions they activate.
 */
export type GraphRunEvent = {
  /** Ids of nodes that ran. */
  nodes: readonly string[];
  /** Ids of wires an exec flow took. */
  edges: readonly string[];
};

export interface GraphRunTrace {
  /** Calls `listener` for each report of what ran, until the returned function is called. */
  subscribe(listener: (run: GraphRunEvent) => void): () => void;
  /** The text last read from (`in`) or produced on (`out`) a pin, or undefined before any run. */
  value(nodeId: string, pinId: string, direction: "in" | "out"): string | undefined;
  /**
   * A node's live status (a Behaviour Tree node's `running`, `success` or `failure`), or undefined
   * before it has one. Only graphs whose nodes have a status supply it.
   */
  status?(nodeId: string): string | undefined;
  /** Calls `listener` when that node's status changes, until the returned function is called. */
  subscribeStatus?(nodeId: string, listener: () => void): () => void;
  /**
   * Whether the owner is paused, so what ran last stays lit instead of fading. Calls `listener` at
   * once with the current state, then on each change, until the returned function is called.
   */
  subscribeHold?(listener: (held: boolean) => void): () => void;
}

/** The part of a canvas graph the trace needs: React Flow's node and edge shapes. */
export type RunGraph = {
  nodes: ReadonlyArray<{ id: string; data?: Record<string, unknown> }>;
  edges: ReadonlyArray<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
};

type RunEdge = RunGraph["edges"][number];

export const NO_VALUE_TEXT = "No value yet";
export const NO_STATUS_TEXT = "No status yet";

type GraphIndex = {
  nodes: Map<string, RunGraph["nodes"][number]>;
  /** Wire into an input pin: node id, then pin id. */
  incoming: Map<string, Map<string, RunEdge>>;
  /** Wires out of an output pin: node id, then pin id. */
  outgoing: Map<string, Map<string, RunEdge[]>>;
};

// React Flow replaces its arrays on every edit, so an index lives as long as its arrays.
const indexes = new WeakMap<RunGraph["edges"], { nodes: RunGraph["nodes"]; index: GraphIndex }>();

function graphIndex(graph: RunGraph): GraphIndex {
  const cached = indexes.get(graph.edges);
  if (cached?.nodes === graph.nodes) return cached.index;
  const index: GraphIndex = { nodes: new Map(), incoming: new Map(), outgoing: new Map() };
  for (const node of graph.nodes) if (!index.nodes.has(node.id)) index.nodes.set(node.id, node);
  for (const edge of graph.edges) {
    const target = edge.targetHandle ?? "";
    const source = edge.sourceHandle ?? "";
    let incoming = index.incoming.get(edge.target);
    if (!incoming) index.incoming.set(edge.target, incoming = new Map());
    if (!incoming.has(target)) incoming.set(target, edge);
    let outgoing = index.outgoing.get(edge.source);
    if (!outgoing) index.outgoing.set(edge.source, outgoing = new Map());
    const leaving = outgoing.get(source);
    if (leaving) leaving.push(edge);
    else outgoing.set(source, [edge]);
  }
  indexes.set(graph.edges, { nodes: graph.nodes, index });
  return index;
}

function pinOf(index: GraphIndex, nodeId: string, pinId: string): SerializedPin | undefined {
  const data = index.nodes.get(nodeId)?.data;
  return hasSerializedPins(data) ? data.__pins.find((pin) => pin.id === pinId) : undefined;
}

function isReroute(index: GraphIndex, nodeId: string): boolean {
  return isRerouteNodeData(index.nodes.get(nodeId)?.data);
}

/** Pure nodes evaluate when their consumer reads them; a Reroute knot is compiled away and passes its wire through. */
function isPure(index: GraphIndex, nodeId: string): boolean {
  return index.nodes.get(nodeId)?.data?.__pure === true || isReroute(index, nodeId);
}

/** The wire into a Reroute knot's input, if one is wired. */
function wireIntoReroute(index: GraphIndex, nodeId: string): RunEdge | undefined {
  const incoming = index.incoming.get(nodeId);
  return incoming?.get("in") ?? incoming?.values().next().value;
}

/** The real output a wire carries: its source, or, through Reroute knots, the pin feeding the first one. */
function realSource(index: GraphIndex, edge: RunEdge | undefined): { nodeId: string; pinId: string } | undefined {
  const visited = new Set<string>();
  let current = edge;
  while (current && isReroute(index, current.source)) {
    if (visited.has(current.source)) return undefined;
    visited.add(current.source);
    current = wireIntoReroute(index, current.source);
  }
  return current ? { nodeId: current.source, pinId: current.sourceHandle ?? "" } : undefined;
}

/**
 * The data wires a node that ran read: each wire into one of its data inputs, and, through
 * pure nodes that evaluate when their consumer reads them, the wires into those too.
 */
export function dataWiresRead(graph: RunGraph, nodeId: string): RunEdge[] {
  const index = graphIndex(graph);
  const wires: RunEdge[] = [];
  const visited = new Set<string>();
  const read = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const [pinId, edge] of index.incoming.get(id) ?? []) {
      if (pinOf(index, id, pinId)?.kind !== "data") continue;
      wires.push(edge);
      if (isPure(index, edge.source)) read(edge.source);
    }
  };
  read(nodeId);
  return wires;
}

/** The source and target pins of a wire, as `[nodeId, pinId]` pairs. */
export function wireEnds(edge: RunEdge): [[string, string], [string, string]] {
  return [[edge.source, edge.sourceHandle ?? ""], [edge.target, edge.targetHandle ?? ""]];
}

/**
 * Whether a pin carries a value worth a tip: any data output, and a data input something is
 * wired into. An unwired input shows its own literal on the node.
 */
export function pinShowsValue(graph: RunGraph, nodeId: string, pinId: string, direction: "in" | "out"): boolean {
  const index = graphIndex(graph);
  if (isReroute(index, nodeId)) {
    // A knot shows what it passes on: a value only when a data output feeds it.
    const source = realSource(index, wireIntoReroute(index, nodeId));
    return source !== undefined && pinOf(index, source.nodeId, source.pinId)?.kind === "data";
  }
  if (pinOf(index, nodeId, pinId)?.kind !== "data") return false;
  return direction === "out" || index.incoming.get(nodeId)?.has(pinId) === true;
}

/**
 * The last value of a pin. A node that ran reports what it read and produced, and a Class
 * graph's pure nodes report their outputs each time they are evaluated. A wired input shows what
 * its source produced; an output nothing recorded (a graph whose pure nodes do not report, such
 * as a Behaviour Tree's) shows what a node that read it got.
 */
export function resolvePinValue(
  trace: Pick<GraphRunTrace, "value">,
  graph: RunGraph,
  nodeId: string,
  pinId: string,
  direction: "in" | "out",
): string | undefined {
  const own = trace.value(nodeId, pinId, direction);
  if (own !== undefined) return own;
  const index = graphIndex(graph);
  // Either pin of a Reroute knot, and an input wired from one, show the real source's value.
  const reroute = isReroute(index, nodeId);
  if (direction === "in" || reroute) {
    const edge = reroute ? wireIntoReroute(index, nodeId) : index.incoming.get(nodeId)?.get(pinId);
    const source = realSource(index, edge);
    if (!source) {
      if (!reroute) return undefined;
      for (const outPin of index.outgoing.get(nodeId)?.keys() ?? []) {
        const read = readThroughConsumers(trace, index, nodeId, outPin, new Set([nodeId]));
        if (read !== undefined) return read;
      }
      return undefined;
    }
    // What flowed in is what the source produced.
    return trace.value(source.nodeId, source.pinId, "out") ?? readThroughConsumers(trace, index, source.nodeId, source.pinId);
  }
  return readThroughConsumers(trace, index, nodeId, pinId);
}

/** What a node that ran read from this output, if any, looking through Reroute knots to their consumers. */
function readThroughConsumers(
  trace: Pick<GraphRunTrace, "value">,
  index: GraphIndex,
  nodeId: string,
  pinId: string,
  visited: Set<string> = new Set(),
): string | undefined {
  for (const edge of index.outgoing.get(nodeId)?.get(pinId) ?? []) {
    if (isReroute(index, edge.target)) {
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      for (const outPin of index.outgoing.get(edge.target)?.keys() ?? []) {
        const read = readThroughConsumers(trace, index, edge.target, outPin, visited);
        if (read !== undefined) return read;
      }
      continue;
    }
    const read = trace.value(edge.target, edge.targetHandle ?? "", "in");
    if (read !== undefined) return read;
  }
  return undefined;
}
