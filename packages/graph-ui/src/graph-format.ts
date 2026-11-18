import type { GraphAddPin, SerializedPin } from "./graph-types";
import { pinWithDisplayType } from "./graph-connect";
import {
  estimateGraphNodeSize,
  GRAPH_NODE_CHROME_HEIGHT,
  GRAPH_PIN_ROW_HEIGHT,
  REROUTE_KNOT_SIZE,
} from "./graph-virtualize";

export const FORMAT_GAP_X = 80;
export const FORMAT_GAP_Y = 40;

// A selected pure root's forward data walk keeps its compact diagonal while it
// is small; taller walks use rows.
const HELIX_MAX_HEIGHT = 320;
// Clearance between a wire or a knot and the box of another node.
const WIRE_CLEARANCE = 8;
// Points sampled along a wire's curve when testing it against node boxes.
const WIRE_SAMPLES = 24;
// XYFlow `getBezierPath`'s default curvature.
const WIRE_CURVATURE = 0.25;

export type FormatNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  pins?: SerializedPin[];
  /** A Reroute knot: estimated at the knot's size while unmeasured. */
  reroute?: boolean;
  /** The node's Add Pin control, when shown: estimated as one more pin row while unmeasured. */
  addPin?: GraphAddPin;
  /**
   * Measured handle centres, as Y from the node's top, keyed by `formatPinOffsetKey`. A pin
   * without one is estimated from its pin row.
   */
  pinOffsets?: Record<string, number>;
};

/** The `FormatNode.pinOffsets` key of a pin (a node may use one id for an input and an output). */
export function formatPinOffsetKey(direction: "in" | "out", pinId: string): string {
  return `${direction}:${pinId}`;
}

/** Resolved pin types (wildcards bound by their wires), by node and pin id. */
export type FormatPinDisplayType = (nodeId: string, pinId: string) => SerializedPin["type"] | undefined;

export type FormatEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
};

/** A Reroute knot Format asks the host to add on `edge`, its top-left corner at `position`. */
export type FormatKnot = { edge: FormatEdge; position: { x: number; y: number } };

export type FormatOptions = {
  displayType?: FormatPinDisplayType;
  /** Request knots that carry data wires around nodes. Existing knots are positioned either way. */
  insertKnots?: boolean;
  /** Size of a new knot (default `REROUTE_KNOT_SIZE`). */
  knotSize?: { width: number; height: number };
};

export type FormatResult = { nodes: FormatNode[]; knots: FormatKnot[] };

type Position = { x: number; y: number };
type Box = Position & { width: number; height: number };
type ChainWalk = "exec" | "data";
type GraphIndex = {
  byId: Map<string, FormatNode>;
  outgoing: Record<ChainWalk, Map<string, string[]>>;
  dataInputs: Map<string, string[]>;
  /** Data wires into each node, in the order of its data input pins. */
  dataEdgesIn: Map<string, FormatEdge[]>;
  dataEdges: FormatEdge[];
  incomingExec: Set<string>;
};

function nodeSize(node: FormatNode): { width: number; height: number } {
  const width = node.width ?? node.measured?.width;
  const height = node.height ?? node.measured?.height;
  if (width !== undefined && height !== undefined) return { width, height };
  // Off-screen nodes that were never mounted have no measured size.
  const estimate = estimateGraphNodeSize(
    node.pins,
    node.reroute ? { __reroute: true } : node.addPin ? { __addPin: node.addPin } : undefined,
  );
  return { width: width ?? estimate.width, height: height ?? estimate.height };
}

/** A wire's identity by its ends, the same for a wire and for the knot pair that replaces it. */
function edgeKey(edge: FormatEdge): string {
  return [edge.target, edge.targetHandle ?? "", edge.source, edge.sourceHandle ?? ""].join("\n");
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Centre of a pin's handle below the node's top: measured, else its pin row. Like `zipPinRows`
 * (graph-nodes.tsx), each side lists its exec pins and then its data pins, one per row; header
 * pins sit in the title bar.
 */
function pinY(node: FormatNode, direction: "in" | "out", pinId: string | undefined): number {
  const measured = pinId === undefined ? undefined : node.pinOffsets?.[formatPinOffsetKey(direction, pinId)];
  if (measured !== undefined) return measured;
  if (node.reroute) return nodeSize(node).height / 2;
  const pins = node.pins ?? [];
  const pin = pins.find((entry) => entry.id === pinId && entry.direction === direction);
  if (pin?.placement === "header") return GRAPH_NODE_CHROME_HEIGHT / 2;
  let row = 0;
  if (pin) {
    const side = pins.filter((entry) => entry.direction === direction && entry.placement !== "header");
    const exec = side.filter((entry) => entry.kind === "exec");
    row = pin.kind === "exec"
      ? exec.indexOf(pin)
      : exec.length + side.filter((entry) => entry.kind !== "exec").indexOf(pin);
  }
  return GRAPH_NODE_CHROME_HEIGHT + row * GRAPH_PIN_ROW_HEIGHT + GRAPH_PIN_ROW_HEIGHT / 2;
}

/**
 * The top of a node's parameter block below the node's top: under the row of its first data
 * input (else its last exec row), leaving the lanes of the exec wires and that first input free.
 */
function laneFloor(node: FormatNode): number {
  const pins = (node.pins ?? []).filter((pin) => pin.placement !== "header");
  const firstData = pins.find((pin) => pin.direction === "in" && pin.kind !== "exec");
  const lanes = firstData ? [firstData] : pins.filter((pin) => pin.kind === "exec");
  if (lanes.length === 0) return nodeSize(node).height + FORMAT_GAP_Y;
  return (
    Math.max(...lanes.map((pin) => pinY(node, pin.direction, pin.id))) +
    GRAPH_PIN_ROW_HEIGHT / 2 +
    FORMAT_GAP_Y
  );
}

function compareNodes(
  graph: GraphIndex,
  a: string,
  b: string,
  positions?: ReadonlyMap<string, Position>,
): number {
  const left = positions?.get(a) ?? graph.byId.get(a)!.position;
  const right = positions?.get(b) ?? graph.byId.get(b)!.position;
  return left.y - right.y || left.x - right.x || a.localeCompare(b);
}

function indexGraph(
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): GraphIndex {
  const graph: GraphIndex = {
    byId: new Map(nodes.map((node) => [node.id, node])),
    outgoing: { exec: new Map(), data: new Map() },
    dataInputs: new Map(),
    dataEdgesIn: new Map(),
    dataEdges: [],
    incomingExec: new Set(),
  };
  const incomingData = new Map<string, Map<string, number>>();
  const pinOrder = new Map<FormatEdge, number>();
  for (const edge of edges) {
    const source = graph.byId.get(edge.source);
    const target = graph.byId.get(edge.target);
    if (!source || !target) continue;
    const pin = source.pins?.find((entry) => entry.id === edge.sourceHandle);
    // A host node that supplies no pins links through data walks.
    const kind = pin
      ? pin.direction === "out"
        ? pin.kind
        : undefined
      : edge.sourceHandle
        ? "data"
        : undefined;
    if (kind !== "exec" && kind !== "data") continue;
    const targets = graph.outgoing[kind].get(source.id) ?? [];
    if (!targets.includes(target.id)) targets.push(target.id);
    graph.outgoing[kind].set(source.id, targets);
    if (kind === "exec") {
      graph.incomingExec.add(target.id);
    } else {
      const pins =
        target.pins?.filter(
          (entry) => entry.kind === "data" && entry.direction === "in",
        ) ?? [];
      const pinIndex = pins.findIndex(
        (entry) => entry.id === edge.targetHandle,
      );
      const order = pinIndex < 0 ? Number.MAX_SAFE_INTEGER : pinIndex;
      graph.dataEdges.push(edge);
      pinOrder.set(edge, order);
      const into = graph.dataEdgesIn.get(target.id) ?? [];
      into.push(edge);
      graph.dataEdgesIn.set(target.id, into);
      const sources = incomingData.get(target.id) ?? new Map<string, number>();
      sources.set(source.id, Math.min(sources.get(source.id) ?? order, order));
      incomingData.set(target.id, sources);
    }
  }
  for (const into of graph.dataEdgesIn.values()) {
    into.sort((a, b) => pinOrder.get(a)! - pinOrder.get(b)! || compareKeys(edgeKey(a), edgeKey(b)));
  }
  for (const [id, sources] of incomingData) {
    graph.dataInputs.set(
      id,
      [...sources.keys()].sort(
        (a, b) =>
          sources.get(a)! - sources.get(b)! || compareNodes(graph, a, b),
      ),
    );
  }
  return graph;
}

function chainWalkKind(startId: string, graph: GraphIndex): ChainWalk {
  const pins = graph.byId.get(startId)?.pins ?? [];
  return pins.some((pin) => pin.kind === "exec") ? "exec" : "data";
}

function collectChain(startId: string, graph: GraphIndex): string[] {
  if (!graph.byId.has(startId)) return [];
  const outgoing = graph.outgoing[chainWalkKind(startId, graph)];
  const order = [startId];
  const visited = new Set(order);
  for (let index = 0; index < order.length; index++) {
    for (const target of outgoing.get(order[index]!) ?? []) {
      if (visited.has(target)) continue;
      visited.add(target);
      order.push(target);
    }
  }
  return order;
}

type LayoutTree = {
  roots: string[];
  order: string[];
  children: Map<string, string[]>;
  ranks: Map<string, number>;
};

function layoutTree(
  startIds: readonly string[],
  successors: (id: string) => readonly string[],
): LayoutTree {
  const roots: string[] = [];
  const order: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const children = new Map<string, string[]>();
  const forward = new Map<string, string[]>();
  const finished: string[] = [];
  for (const startId of startIds) {
    if (visited.has(startId)) continue;
    roots.push(startId);
    order.push(startId);
    visited.add(startId);
    active.add(startId);
    const stack = [{ id: startId, targets: successors(startId), next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const target = frame.targets[frame.next++];
      if (target === undefined) {
        active.delete(frame.id);
        finished.push(frame.id);
        stack.pop();
        continue;
      }
      // A loop's return wire must remain a return wire. Ignore only DFS back
      // edges when computing ranks; retain every other predecessor of a merge.
      if (active.has(target)) continue;
      const links = forward.get(frame.id) ?? [];
      links.push(target);
      forward.set(frame.id, links);
      if (visited.has(target)) continue;
      const owned = children.get(frame.id) ?? [];
      owned.push(target);
      children.set(frame.id, owned);
      visited.add(target);
      active.add(target);
      order.push(target);
      stack.push({ id: target, targets: successors(target), next: 0 });
    }
  }
  const ranks = new Map<string, number>(roots.map((id) => [id, 0]));
  for (let index = finished.length - 1; index >= 0; index--) {
    const id = finished[index]!;
    for (const target of forward.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, ranks.get(id)! + 1));
    }
  }
  return { roots, order, children, ranks };
}

function treeHeights(
  tree: LayoutTree,
  graph: GraphIndex,
  diagonal: boolean,
): Map<string, number> {
  const heights = new Map<string, number>();
  for (let index = tree.order.length - 1; index >= 0; index--) {
    const id = tree.order[index]!;
    const height = nodeSize(graph.byId.get(id)!).height;
    const children = tree.children.get(id) ?? [];
    const childHeight =
      children.reduce(
        (total, child) => total + heights.get(child)! + FORMAT_GAP_Y,
        0,
      ) - (children.length > 0 ? FORMAT_GAP_Y : 0);
    heights.set(
      id,
      diagonal && children.length > 0
        ? height + FORMAT_GAP_Y + childHeight
        : Math.max(height, childHeight),
    );
  }
  return heights;
}

function treeRows(
  tree: LayoutTree,
  graph: GraphIndex,
  diagonal: boolean,
): Map<string, number> {
  const heights = treeHeights(tree, graph, diagonal);
  const rows = new Map<string, number>();
  let rootY = 0;
  for (const root of tree.roots) {
    rows.set(root, rootY);
    rootY += heights.get(root)! + FORMAT_GAP_Y;
  }
  for (const id of tree.order) {
    let y =
      rows.get(id)! +
      (diagonal ? nodeSize(graph.byId.get(id)!).height + FORMAT_GAP_Y : 0);
    for (const child of tree.children.get(id) ?? []) {
      rows.set(child, y);
      y += heights.get(child)! + FORMAT_GAP_Y;
    }
  }
  return rows;
}

function claimDataInputs(
  chain: LayoutTree,
  graph: GraphIndex,
  previouslyPlaced: ReadonlySet<string>,
): Map<string, Set<string>> {
  const claimed = new Set([...chain.order, ...previouslyPlaced]);
  const owners = new Map<string, Set<string>>();
  // Prefer the earliest execution consumer, even if DFS visited its merge
  // before a shorter branch. Shared parameters are moved exactly once.
  const chainOrder = [...chain.order].sort(
    (a, b) => chain.ranks.get(a)! - chain.ranks.get(b)!,
  );
  for (const owner of chainOrder) {
    const inputs = new Set<string>();
    const stack = [...(graph.dataInputs.get(owner) ?? [])].reverse();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (claimed.has(id) || graph.incomingExec.has(id)) continue;
      claimed.add(id);
      inputs.add(id);
      stack.push(...[...(graph.dataInputs.get(id) ?? [])].reverse());
    }
    owners.set(owner, inputs);
  }
  return owners;
}

type ParameterBlock = {
  /** Members in tree preorder: parents before children, children in their consumer's pin order. */
  order: string[];
  /** The member or owner each member feeds in the tree. */
  parent: Map<string, string>;
  /** Left edges relative to the owner's left edge. */
  x: Map<string, number>;
  columnLeft: Map<string, number>;
  /** Width the block takes left of its owner. */
  left: number;
};

function parameterBlock(
  owner: string,
  members: ReadonlySet<string>,
  graph: GraphIndex,
): ParameterBlock {
  const tree = layoutTree([owner], (id) =>
    (graph.dataInputs.get(id) ?? []).filter((source) => members.has(source)),
  );
  const parent = new Map<string, string>();
  for (const [id, children] of tree.children) {
    for (const child of children) parent.set(child, id);
  }
  const order = tree.order.filter((id) => id !== owner);
  const widths: number[] = [];
  for (const id of order) {
    const rank = tree.ranks.get(id)!;
    widths[rank] = Math.max(
      widths[rank] ?? 0,
      nodeSize(graph.byId.get(id)!).width,
    );
  }
  const columns = [0];
  for (let rank = 1; rank < widths.length; rank++) {
    columns[rank] = columns[rank - 1]! - FORMAT_GAP_X - widths[rank]!;
  }
  const x = new Map<string, number>();
  const columnLeft = new Map<string, number>();
  let left = 0;
  for (const id of order) {
    const rank = tree.ranks.get(id)!;
    // Right-aligned in its rank's column, so every wire leaves towards its consumer.
    x.set(id, columns[rank]! + widths[rank]! - nodeSize(graph.byId.get(id)!).width);
    columnLeft.set(id, columns[rank]!);
    left = Math.max(left, -columns[rank]!);
  }
  return { order, parent, x, columnLeft, left };
}

function boxAt(graph: GraphIndex, id: string, position: Position): Box {
  return { ...position, ...nodeSize(graph.byId.get(id)!) };
}

function clearVerticalOffset(
  moving: readonly Box[],
  blockers: readonly Box[],
): number {
  // Each horizontally intersecting pair excludes one interval of Y offsets.
  // Sweeping these intervals gives a clear position without a pass limit and
  // moves entire trees together instead of tearing individual nodes off them.
  const intervals: { from: number; to: number }[] = [];
  for (const mover of moving) {
    for (const blocker of blockers) {
      if (
        mover.x >= blocker.x + blocker.width ||
        mover.x + mover.width <= blocker.x
      ) {
        continue;
      }
      const to = blocker.y + blocker.height - mover.y;
      if (to <= 0) continue;
      intervals.push({ from: blocker.y - mover.y - mover.height, to });
    }
  }
  intervals.sort((a, b) => a.from - b.from);
  let offset = 0;
  for (const interval of intervals) {
    if (interval.from < offset && interval.to > offset)
      offset = interval.to + FORMAT_GAP_Y;
  }
  return offset;
}

/** The first Y at or below `box.y` where `box` keeps `FORMAT_GAP_Y` from every blocker it shares columns with. */
function pushDown(box: Box, blockerLists: readonly (readonly Box[])[]): number {
  const intervals: { from: number; to: number }[] = [];
  for (const blockers of blockerLists) {
    for (const blocker of blockers) {
      if (box.x >= blocker.x + blocker.width || box.x + box.width <= blocker.x) continue;
      const to = blocker.y + blocker.height + FORMAT_GAP_Y;
      if (to <= box.y) continue;
      intervals.push({ from: blocker.y - box.height - FORMAT_GAP_Y, to });
    }
  }
  // Sorted by start, one sweep finds the first free Y without a pass limit.
  intervals.sort((a, b) => a.from - b.from);
  let y = box.y;
  for (const interval of intervals) {
    if (interval.from < y && interval.to > y) y = interval.to;
  }
  return y;
}

/**
 * Where a member's top goes before clamping: level with the first wire from an already placed
 * node outside its block on its left, else level with the wire into its tree parent.
 */
function alignedTop(
  id: string,
  block: ParameterBlock,
  members: ReadonlySet<string>,
  graph: GraphIndex,
  located: (id: string) => Position | undefined,
  columnLeft: number,
): number {
  const node = graph.byId.get(id)!;
  for (const edge of graph.dataEdgesIn.get(id) ?? []) {
    if (members.has(edge.source)) continue;
    const at = located(edge.source);
    if (!at) continue;
    const source = graph.byId.get(edge.source)!;
    if (at.x + nodeSize(source).width > columnLeft) continue;
    return at.y + pinY(source, "out", edge.sourceHandle) - pinY(node, "in", edge.targetHandle);
  }
  const parentId = block.parent.get(id)!;
  const parent = graph.byId.get(parentId)!;
  const parentAt = located(parentId)!;
  const edge = (graph.dataEdgesIn.get(parentId) ?? []).find((entry) => entry.source === id);
  if (!edge) return parentAt.y;
  return parentAt.y + pinY(parent, "in", edge.targetHandle) - pinY(node, "out", edge.sourceHandle);
}

function layoutChain(
  startIds: readonly string[],
  graph: GraphIndex,
  placed: Map<string, Position>,
): void {
  const startId = startIds[0]!;
  const start = graph.byId.get(startId)!;
  const origin = placed.get(startId) ?? start.position;
  const walk = chainWalkKind(startId, graph);
  const tree = layoutTree(startIds, (id) =>
    [...(graph.outgoing[walk].get(id) ?? [])].sort(
      (a, b) =>
        Number(!placed.has(a)) - Number(!placed.has(b)) ||
        compareNodes(graph, a, b, placed),
    ),
  );
  const owners = claimDataInputs(tree, graph, new Set(placed.keys()));
  const blocks = new Map<string, ParameterBlock>();
  for (const [owner, members] of owners) {
    blocks.set(owner, parameterBlock(owner, members, graph));
  }
  const widths: number[] = [];
  const inputWidths: number[] = [];
  const fixedColumns: number[] = [];
  for (const id of tree.order) {
    const rank = tree.ranks.get(id)!;
    widths[rank] = Math.max(
      widths[rank] ?? 0,
      nodeSize(graph.byId.get(id)!).width,
    );
    inputWidths[rank] = Math.max(inputWidths[rank] ?? 0, blocks.get(id)!.left);
    const fixed = placed.get(id);
    if (fixed)
      fixedColumns[rank] = Math.max(fixedColumns[rank] ?? -Infinity, fixed.x);
  }
  const columns = [origin.x];
  for (let rank = 1; rank < widths.length; rank++) {
    columns[rank] = Math.max(
      columns[rank - 1]! +
        widths[rank - 1]! +
        FORMAT_GAP_X +
        inputWidths[rank]!,
      fixedColumns[rank] ?? -Infinity,
    );
  }
  const diagonal =
    walk === "data" &&
    treeHeights(tree, graph, true).get(startId)! <= HELIX_MAX_HEIGHT;
  const rows = treeRows(tree, graph, diagonal);
  const positions = new Map<string, Position>();
  const blockers: Box[] = [];
  for (const id of tree.order) {
    const position = placed.get(id) ?? {
      x: columns[tree.ranks.get(id)!]!,
      y: origin.y + rows.get(id)!,
    };
    positions.set(id, position);
    blockers.push(boxAt(graph, id, position));
  }
  const earlier = [...placed].map(([id, position]) => boxAt(graph, id, position));
  const located = (id: string) => positions.get(id) ?? placed.get(id);
  const chainOrder = [...tree.order].sort(
    (a, b) => tree.ranks.get(a)! - tree.ranks.get(b)!,
  );
  // Members go one by one, each as high as its level wire allows, so a member in a free column
  // shares a row instead of stacking under a whole subtree.
  for (const owner of chainOrder) {
    const block = blocks.get(owner)!;
    const members = owners.get(owner)!;
    const anchor = positions.get(owner)!;
    const floor = anchor.y + laneFloor(graph.byId.get(owner)!);
    for (const id of block.order) {
      const x = anchor.x + block.x.get(id)!;
      const top = Math.max(
        alignedTop(id, block, members, graph, located, anchor.x + block.columnLeft.get(id)!),
        floor,
      );
      const box = { x, y: top, ...nodeSize(graph.byId.get(id)!) };
      box.y = pushDown(box, [blockers, earlier]);
      positions.set(id, { x, y: box.y });
      blockers.push(box);
    }
  }
  const moving = [...positions].filter(([id]) => !placed.has(id));
  const offset = clearVerticalOffset(
    moving.map(([id, position]) => boxAt(graph, id, position)),
    earlier,
  );
  for (const [id, position] of moving) {
    placed.set(id, { x: position.x, y: position.y + offset });
  }
}

type LaneGraph = {
  nodes: FormatNode[];
  edges: FormatEdge[];
  /** The knot each direct wire stands for. */
  knotOf: Map<FormatEdge, string>;
};

/**
 * A lane knot is a data Reroute with one wire in and one out, into a node that is not a knot.
 * Layout reads `S → knot → T` as the direct wire `S → T`, so a graph lays out the same with and
 * without the knots Format adds.
 */
function collapseLaneKnots(
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): LaneGraph {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, FormatEdge[]>();
  const outgoing = new Map<string, FormatEdge[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const knotOf = new Map<FormatEdge, string>();
  const lanes = new Set<string>();
  for (const node of nodes) {
    if (!node.reroute || node.pins?.some((pin) => pin.kind === "exec")) continue;
    const into = incoming.get(node.id);
    const out = outgoing.get(node.id);
    if (into?.length !== 1 || out?.length !== 1) continue;
    if (into[0]!.source === node.id || byId.get(out[0]!.target)!.reroute) continue;
    lanes.add(node.id);
    knotOf.set(
      {
        source: into[0]!.source,
        sourceHandle: into[0]!.sourceHandle,
        target: out[0]!.target,
        targetHandle: out[0]!.targetHandle,
      },
      node.id,
    );
  }
  if (lanes.size === 0) return { nodes: [...nodes], edges: [...edges], knotOf };
  return {
    nodes: nodes.filter((node) => !lanes.has(node.id)),
    edges: [
      ...edges.filter((edge) => !lanes.has(edge.source) && !lanes.has(edge.target)),
      ...knotOf.keys(),
    ],
    knotOf,
  };
}

type Point = { x: number; y: number };
type Obstacle = Box & { id: string };
/** Positioned node boxes sorted by left edge, for range queries along X. */
type Obstacles = { boxes: Obstacle[]; maxWidth: number };

function obstaclesOf(graph: GraphIndex, positions: ReadonlyMap<string, Position>): Obstacles {
  const boxes = [...positions].map(([id, position]) => ({ id, ...boxAt(graph, id, position) }));
  boxes.sort((a, b) => a.x - b.x);
  return { boxes, maxWidth: Math.max(0, ...boxes.map((box) => box.width)) };
}

/** Boxes whose X range meets [minX, maxX]: a binary search, then a scan of that window only. */
function boxesAcross(obstacles: Obstacles, minX: number, maxX: number): Obstacle[] {
  const { boxes } = obstacles;
  const from = minX - obstacles.maxWidth;
  let low = 0;
  let high = boxes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (boxes[middle]!.x < from) low = middle + 1;
    else high = middle;
  }
  const found: Obstacle[] = [];
  for (let index = low; index < boxes.length && boxes[index]!.x <= maxX; index++) {
    const box = boxes[index]!;
    if (box.x + box.width >= minX) found.push(box);
  }
  return found;
}

/** XYFlow `calculateControlOffset`. */
function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : WIRE_CURVATURE * 25 * Math.sqrt(-distance);
}

/**
 * The first box (from source to target) that the wire the editor draws between two pins runs
 * through: XYFlow's bezier from a right-facing source to a left-facing target, sampled.
 */
function firstObstruction(
  from: Point,
  to: Point,
  ends: readonly string[],
  obstacles: Obstacles,
): Obstacle | undefined {
  const offset = controlOffset(to.x - from.x);
  const first = { x: from.x + offset, y: from.y };
  const second = { x: to.x - offset, y: to.y };
  // The curve stays inside its control points' bounds.
  const minX = Math.min(from.x, second.x) - WIRE_CLEARANCE;
  const maxX = Math.max(first.x, to.x) + WIRE_CLEARANCE;
  const minY = Math.min(from.y, to.y) - WIRE_CLEARANCE;
  const maxY = Math.max(from.y, to.y) + WIRE_CLEARANCE;
  const near = boxesAcross(obstacles, minX, maxX).filter(
    (box) => !ends.includes(box.id) && box.y <= maxY && box.y + box.height >= minY,
  );
  if (near.length === 0) return undefined;
  for (let sample = 1; sample <= WIRE_SAMPLES; sample++) {
    const t = sample / (WIRE_SAMPLES + 1);
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    const x = a * from.x + b * first.x + c * second.x + d * to.x;
    const y = a * from.y + b * first.y + c * second.y + d * to.y;
    const hit = near.find(
      (box) =>
        x > box.x - WIRE_CLEARANCE &&
        x < box.x + box.width + WIRE_CLEARANCE &&
        y > box.y - WIRE_CLEARANCE &&
        y < box.y + box.height + WIRE_CLEARANCE,
    );
    if (hit) return hit;
  }
  return undefined;
}

function boxesMeet(a: Box, b: Box, clearance: number): boolean {
  return (
    a.x < b.x + b.width + clearance &&
    a.x + a.width > b.x - clearance &&
    a.y < b.y + b.height + clearance &&
    a.y + a.height > b.y - clearance
  );
}

/** The first node or knot box `box` comes within the wire clearance of, if any. */
function boxInTheWay(box: Box, obstacles: Obstacles, knots: readonly Box[]): Box | undefined {
  return (
    boxesAcross(obstacles, box.x - WIRE_CLEARANCE, box.x + box.width + WIRE_CLEARANCE).find((other) =>
      boxesMeet(box, other, WIRE_CLEARANCE),
    ) ?? knots.find((other) => boxesMeet(box, other, WIRE_CLEARANCE))
  );
}

type Size = { width: number; height: number };

/**
 * A knot level with the target pin that carries the wire around the nodes in its way: above or
 * below the left edge of the first box in the way, else of a later box before the target.
 * A spot is taken only if both halves of the wire run clear and the knot fits there.
 */
function knotAround(
  blocked: Box,
  from: Point,
  to: Point,
  ends: readonly string[],
  size: Size,
  obstacles: Obstacles,
  knots: readonly Box[],
): Position | undefined {
  const lowest = from.x + FORMAT_GAP_X;
  const highest = to.x - FORMAT_GAP_X - size.width;
  if (lowest > highest) return undefined;
  const lefts = [
    blocked.x,
    ...boxesAcross(obstacles, blocked.x, highest)
      .filter((box) => box.x > blocked.x && !ends.includes(box.id))
      .map((box) => box.x),
  ];
  const tried = new Set<number>();
  for (const left of lefts) {
    const x = Math.min(Math.max(left, lowest), highest);
    if (tried.has(x)) continue;
    tried.add(x);
    const at = { x, y: to.y - size.height / 2 };
    if (
      !firstObstruction(from, { x, y: to.y }, ends, obstacles) &&
      !firstObstruction({ x: x + size.width, y: to.y }, to, ends, obstacles) &&
      !boxInTheWay({ ...at, ...size }, obstacles, knots)
    ) {
      return at;
    }
  }
  return undefined;
}

/**
 * Where an existing knot goes when its wire needs no detour: level with the target pin just
 * before the target (not left of the source's right edge while it fits), then left past any box
 * other than the wire's own ends it would come near.
 */
function knotBesideTarget(
  from: Point,
  to: Point,
  ends: readonly string[],
  size: Size,
  obstacles: Obstacles,
  knots: readonly Box[],
): Position {
  const at = {
    x: to.x - FORMAT_GAP_X - size.width,
    y: to.y - size.height / 2,
  };
  if (to.x - size.width >= from.x) at.x = Math.max(at.x, from.x);
  for (;;) {
    const box = { ...at, ...size };
    const hit =
      boxesAcross(obstacles, box.x - WIRE_CLEARANCE, box.x + box.width + WIRE_CLEARANCE).find((other) =>
        boxesMeet(box, other, ends.includes(other.id) ? 0 : WIRE_CLEARANCE),
      ) ?? knots.find((other) => boxesMeet(box, other, WIRE_CLEARANCE));
    if (!hit) return at;
    at.x = hit.x - WIRE_CLEARANCE - size.width;
  }
}

/**
 * Carries each data wire between two formatted nodes around the nodes in its way with a knot
 * level with its target pin. Wires go in a fixed order (by their ends), so a second Format
 * places every knot where the first one did. Testing a wire costs O(log N + W + S·K): a binary
 * search, the boxes W in its X range and S samples against the K boxes also in its Y range. Only
 * a blocked wire tries knot spots, at most one per box in its X range, each two such tests.
 */
function routeDataWires(
  graph: GraphIndex,
  positions: ReadonlyMap<string, Position>,
  lanes: LaneGraph,
  knotNodes: ReadonlyMap<string, FormatNode>,
  insertKnots: boolean,
  knotSize: Size,
): { moved: Map<string, Position>; knots: FormatKnot[] } {
  const moved = new Map<string, Position>();
  const knots: FormatKnot[] = [];
  const obstacles = obstaclesOf(graph, positions);
  const placedKnots: Box[] = [];
  const wires = graph.dataEdges
    .filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    .sort((a, b) => compareKeys(edgeKey(a), edgeKey(b)));
  for (const edge of wires) {
    const source = graph.byId.get(edge.source)!;
    const target = graph.byId.get(edge.target)!;
    const sourceAt = positions.get(edge.source)!;
    const targetAt = positions.get(edge.target)!;
    const from = {
      x: sourceAt.x + nodeSize(source).width,
      y: sourceAt.y + pinY(source, "out", edge.sourceHandle),
    };
    const to = { x: targetAt.x, y: targetAt.y + pinY(target, "in", edge.targetHandle) };
    const ends = [edge.source, edge.target];
    const knotId = lanes.knotOf.get(edge);
    if (!knotId && !insertKnots) continue;
    const size = knotId ? nodeSize(knotNodes.get(knotId)!) : knotSize;
    const blocked = firstObstruction(from, to, ends, obstacles);
    let at = blocked ? knotAround(blocked, from, to, ends, size, obstacles, placedKnots) : undefined;
    if (knotId) {
      at ??= knotBesideTarget(from, to, ends, size, obstacles, placedKnots);
      moved.set(knotId, at);
    } else if (at) {
      knots.push({ edge, position: at });
    } else {
      continue;
    }
    placedKnots.push({ ...at, ...size });
  }
  return { moved, knots };
}

function formatChainRoots(
  selectedIds: readonly string[],
  graph: GraphIndex,
): string[] {
  const selected = [...new Set(selectedIds)]
    .filter((id) => graph.byId.has(id))
    .sort((a, b) => {
      const left = graph.byId.get(a)!;
      const right = graph.byId.get(b)!;
      return (
        Number(chainWalkKind(a, graph) === "data") -
          Number(chainWalkKind(b, graph) === "data") ||
        left.position.y - right.position.y ||
        left.position.x - right.position.x ||
        a.localeCompare(b)
      );
    });
  const chains = new Map(
    selected.map((id) => [id, new Set(collectChain(id, graph))]),
  );
  return selected.filter(
    (id, index) =>
      !selected.some(
        (other, otherIndex) =>
          other !== id &&
          chainWalkKind(other, graph) === chainWalkKind(id, graph) &&
          chains.get(other)!.has(id) &&
          (!chains.get(id)!.has(other) || otherIndex < index),
      ),
  );
}

/**
 * Lays out the chains of the selected nodes: exec runs left to right on rows, each exec node's
 * data inputs below-left of it with level wires where they fit, and returns the moved nodes plus
 * the knots to add (`insertKnots`) where a data wire would run through another node.
 */
export function formatGraphNodes(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  selectedIds: readonly string[],
  options: FormatOptions = {},
): FormatResult {
  if (selectedIds.length === 0) return { nodes, knots: [] };
  const { displayType, insertKnots = false, knotSize = REROUTE_KNOT_SIZE } = options;
  // A Reroute's any-kind pins take the kind their wires bound them to, so an exec knot sits on
  // the exec row and a data knot is a pure node or a lane knot.
  const effective = displayType
    ? nodes.map((node) =>
        node.pins?.some((pin) => pin.anyKind)
          ? { ...node, pins: node.pins.map((pin) => (pin.anyKind ? pinWithDisplayType(pin, displayType(node.id, pin.id)) : pin)) }
          : node,
      )
    : nodes;
  const lanes = collapseLaneKnots(effective, edges);
  const graph = indexGraph(lanes.nodes, lanes.edges);
  const roots = formatChainRoots(selectedIds, graph);
  if (roots.length === 0) return { nodes, knots: [] };
  const positions = new Map<string, Position>();
  const remaining = new Set(roots);
  const chains = new Map(
    roots.map((root) => [root, new Set(collectChain(root, graph))]),
  );
  for (const root of roots) {
    if (
      !remaining.delete(root) ||
      [...chains.get(root)!].every((id) => positions.has(id))
    )
      continue;
    const group = [root];
    for (let index = 0; index < group.length; index++) {
      const chain = chains.get(group[index]!)!;
      for (const other of remaining) {
        if (chainWalkKind(other, graph) !== chainWalkKind(root, graph))
          continue;
        if (![...chains.get(other)!].some((id) => chain.has(id))) continue;
        remaining.delete(other);
        group.push(other);
      }
    }
    // Selected roots which meet at a join share ranks and lanes. Disconnected
    // roots remain separate blocks, anchored at their own original positions.
    layoutChain(group, graph, positions);
  }
  const routed = routeDataWires(
    graph,
    positions,
    lanes,
    new Map(effective.map((node) => [node.id, node])),
    insertKnots,
    knotSize,
  );
  for (const [id, position] of routed.moved) positions.set(id, position);
  return {
    nodes: nodes.map((node) => {
      const position = positions.get(node.id);
      if (
        !position ||
        (position.x === node.position.x && position.y === node.position.y)
      )
        return node;
      return { ...node, position };
    }),
    knots: routed.knots,
  };
}
