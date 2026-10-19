import { hasSerializedPins, type SerializedPin } from "./graph-types";

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
}

/** The part of a canvas graph the trace needs: React Flow's node and edge shapes. */
export type RunGraph = {
  nodes: ReadonlyArray<{ id: string; data?: Record<string, unknown> }>;
  edges: ReadonlyArray<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
};

type RunEdge = RunGraph["edges"][number];

export const NO_VALUE_TEXT = "No value yet";

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

function isPure(index: GraphIndex, nodeId: string): boolean {
  return index.nodes.get(nodeId)?.data?.__pure === true;
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
  if (pinOf(index, nodeId, pinId)?.kind !== "data") return false;
  return direction === "out" || index.incoming.get(nodeId)?.has(pinId) === true;
}

/**
 * The last value of a pin. A node that ran reports what it read and produced; a pure node
 * reports nothing itself, so its output shows what a node that read it got, and a wired
 * input shows what its source produced.
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
  if (direction === "in") {
    const edge = index.incoming.get(nodeId)?.get(pinId);
    if (!edge) return undefined;
    // What flowed in is what the source produced.
    return trace.value(edge.source, edge.sourceHandle ?? "", "out") ?? readThroughConsumers(trace, index, edge.source, edge.sourceHandle ?? "");
  }
  return readThroughConsumers(trace, index, nodeId, pinId);
}

/** What a node that ran read from this output, if any. */
function readThroughConsumers(
  trace: Pick<GraphRunTrace, "value">,
  index: GraphIndex,
  nodeId: string,
  pinId: string,
): string | undefined {
  for (const edge of index.outgoing.get(nodeId)?.get(pinId) ?? []) {
    const read = trace.value(edge.target, edge.targetHandle ?? "", "in");
    if (read !== undefined) return read;
  }
  return undefined;
}
