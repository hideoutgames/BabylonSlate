import type { GraphAddPin, SerializedPin } from "./graph-types";
import { pinWithDisplayType } from "./graph-connect";
import {
  estimateGraphNodeSize,
  GRAPH_NODE_CHROME_HEIGHT,
  GRAPH_NODE_FALLBACK_WIDTH,
  GRAPH_PIN_ROW_HEIGHT,
  REROUTE_KNOT_SIZE,
} from "./graph-virtualize";

export const FORMAT_GAP_X = 120;
export const FORMAT_GAP_Y = 64;
/** Branch rows sit a little further apart than nodes within a block. */
const ROW_GAP = FORMAT_GAP_Y * 1.5;

// A selected pure root's forward data walk keeps its compact diagonal while it
// is small; taller walks use rows.
const HELIX_MAX_HEIGHT = 320;
// Clearance between a wire or a knot and the box of another node.
const WIRE_CLEARANCE = 8;
/** A direct wire this close to another node is crowding it: Format routes it around with a knot. */
const WIRE_CROWDING = FORMAT_GAP_Y / 2;
/** Parallel runs of different wires, and a wire and another wire's knot, keep this apart. */
const WIRE_SPACING = FORMAT_GAP_Y * 0.625;
/** The free lanes nearest a wire's middle height that a two-knot route tries. */
const LANE_CANDIDATES = 24;
/** Spots level with the target pin past the boxes on a blocked wire's way, nearest the target first. */
const PAST_CANDIDATES = 8;
// Points sampled along a wire's curve when testing it against node boxes.
const WIRE_SAMPLES = 24;
// XYFlow `getBezierPath`'s default curvature.
const WIRE_CURVATURE = 0.25;
/** Longer than two columns: a wire this long runs level with short transitions. */
const LONG_WIRE = 2 * (GRAPH_NODE_FALLBACK_WIDTH + FORMAT_GAP_X);
/** The longest stretch, across, of a knotted wire's change of height. */
const MAX_TRANSITION = 2 * FORMAT_GAP_X;

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

/** Reroute knots Format asks the host to chain into `edge`, source to target, by top-left corner. */
export type FormatKnot = { edge: FormatEdge; positions: { x: number; y: number }[] };

export type FormatOptions = {
  displayType?: FormatPinDisplayType;
  /** Request knots that carry data wires around nodes. Existing knots are positioned either way. */
  insertKnots?: boolean;
  /** Size of a new knot (default `REROUTE_KNOT_SIZE`). */
  knotSize?: { width: number; height: number };
  /**
   * Counts the geometry tests Format runs (segment against box, segment against segment, point
   * against box, laid wires visited by a lookup), so tests can check that its cost grows about
   * linearly with the graph rather than timing it.
   */
  work?: FormatWork;
};

export type FormatWork = { tests: number };

/** The counter of the Format run in progress (Format is synchronous), if one was asked for. */
let work: FormatWork | undefined;

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
  /** Data wires out of each node. */
  dataEdgesOut: Map<string, FormatEdge[]>;
  execEdges: FormatEdge[];
  /** The first exec wire from one node to another, by `pairKey`. */
  execBetween: Map<string, FormatEdge>;
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
    dataEdgesOut: new Map(),
    execEdges: [],
    execBetween: new Map(),
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
      graph.execEdges.push(edge);
      const pair = pairKey(source.id, target.id);
      if (!graph.execBetween.has(pair)) graph.execBetween.set(pair, edge);
    } else {
      const out = graph.dataEdgesOut.get(source.id);
      if (out) out.push(edge);
      else graph.dataEdgesOut.set(source.id, [edge]);
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
  /** Every non-back link, tree and cross: the predecessors that set a node's column. */
  forward: Map<string, string[]>;
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
  return { roots, order, children, forward, ranks };
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
  members: ReadonlySet<string>;
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
  return { order, members, parent, x, columnLeft, left };
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
    if (work) work.tests += blockers.length;
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

type Interval = { from: number; to: number };

/** The first value at or above `start` inside none of the open intervals: one sweep, no pass limit. */
function firstFree(start: number, intervals: Interval[]): number {
  intervals.sort((a, b) => a.from - b.from);
  let at = start;
  for (const interval of intervals) {
    if (interval.from < at && interval.to > at) at = interval.to;
  }
  return at;
}

/** Tops at which `box` would come within `gap` of a blocker it shares columns with. */
function overlapIntervals(box: Box, blockers: BoxList<Box>, into: Interval[], gap = FORMAT_GAP_Y): void {
  forBoxesAcross(blockers, box.x, box.x + box.width, (blocker) => {
    if (box.x >= blocker.x + blocker.width || box.x + box.width <= blocker.x) return;
    into.push({
      from: blocker.y - box.height - gap,
      to: blocker.y + blocker.height + gap,
    });
  });
}

/** Bucket width of a `BoxList`: about one node column. */
const BOX_CELL = 256;

/**
 * Boxes in the order they were added, also bucketed by X, so a query for the boxes sharing some
 * columns touches only those columns. Every test that uses one is exact on X and its result does
 * not depend on the order boxes are visited in. `truncate` drops the newest boxes (a block placed
 * again).
 */
type BoxList<T extends Box> = { items: T[]; buckets: Map<number, T[]>; seen: Map<T, number>; query: number };

function boxList<T extends Box>(items: readonly T[] = []): BoxList<T> {
  const list: BoxList<T> = { items: [], buckets: new Map(), seen: new Map(), query: 0 };
  for (const item of items) pushBox(list, item);
  return list;
}

function bucketRange(box: Box): [number, number] {
  const left = Math.min(box.x, box.x + box.width);
  const right = Math.max(box.x, box.x + box.width);
  return [Math.floor(left / BOX_CELL), Math.floor(right / BOX_CELL)];
}

function pushBox<T extends Box>(list: BoxList<T>, box: T): void {
  list.items.push(box);
  const [first, last] = bucketRange(box);
  for (let bucket = first; bucket <= last; bucket++) {
    const entries = list.buckets.get(bucket);
    if (entries) entries.push(box);
    else list.buckets.set(bucket, [box]);
  }
}

function truncateBoxes<T extends Box>(list: BoxList<T>, length: number): void {
  while (list.items.length > length) {
    const box = list.items.pop()!;
    const [first, last] = bucketRange(box);
    // The newest box is the last entry of each of its buckets.
    for (let bucket = first; bucket <= last; bucket++) list.buckets.get(bucket)!.pop();
    list.seen.delete(box);
  }
}

/** Visits each box whose bucket range meets [minX, maxX] once; `visit` returns true to stop. */
function forBoxesAcross<T extends Box>(list: BoxList<T>, minX: number, maxX: number, visit: (box: T) => boolean | void): boolean {
  const query = ++list.query;
  for (let bucket = Math.floor(Math.min(minX, maxX) / BOX_CELL); bucket <= Math.floor(Math.max(minX, maxX) / BOX_CELL); bucket++) {
    for (const box of list.buckets.get(bucket) ?? []) {
      if (work) work.tests++;
      if (list.seen.get(box) === query) continue;
      list.seen.set(box, query);
      if (visit(box)) return true;
    }
  }
  return false;
}

/** Boxes laid out so far for one chain, plus the straight wires (zero height) other nodes keep clear of. */
type Layout = {
  graph: GraphIndex;
  positions: Map<string, Position>;
  placed: ReadonlyMap<string, Position>;
  /** Boxes of this chain's nodes, by id. */
  boxes: BoxList<Obstacle>;
  /** Straight wires and escape lanes, as zero-height boxes. */
  lanes: BoxList<Box>;
  /** Boxes of chains formatted earlier. */
  earlier: BoxList<Obstacle>;
};

function located(layout: Layout, id: string): Position | undefined {
  return layout.positions.get(id) ?? layout.placed.get(id);
}

function addBox(layout: Layout, id: string, position: Position): void {
  layout.positions.set(id, position);
  pushBox(layout.boxes, { id, ...boxAt(layout.graph, id, position) });
}

/** Whether a level wire at `y` from `fromX` to `toX` keeps `WIRE_CROWDING` from every node but its ends. */
function straightWireClear(layout: Layout, fromX: number, toX: number, y: number, ends: readonly string[]): boolean {
  for (const list of [layout.boxes, layout.earlier]) {
    const blocked = forBoxesAcross(list, fromX, toX, (box) => {
      if (ends.includes(box.id)) return false;
      if (box.x >= toX || box.x + box.width <= fromX) return false;
      return y > box.y - WIRE_CROWDING && y < box.y + box.height + WIRE_CROWDING;
    });
    if (blocked) return false;
  }
  return true;
}

/** Heights a block's members may take: level from `level` down, else no higher than `rest`. */
type Floors = { level: number; rest: number };

/** The top that puts a member's wire into its tree parent level with the parent's pin. */
function levelWithParent(layout: Layout, block: ParameterBlock, id: string): { top: number; y: number; edge: FormatEdge } | undefined {
  const { graph } = layout;
  const parentId = block.parent.get(id)!;
  const parentAt = located(layout, parentId)!;
  const edge = (graph.dataEdgesIn.get(parentId) ?? []).find((entry) => entry.source === id);
  if (!edge) return undefined;
  const y = parentAt.y + pinY(graph.byId.get(parentId)!, "in", edge.targetHandle);
  return { top: y - pinY(graph.byId.get(id)!, "out", edge.sourceHandle), y, edge };
}

/**
 * Tops for the members of one column that feed one node, when their level spots would overlap
 * (three Make Ints into Item 0..2): stacked `FORMAT_GAP_Y` apart and centred on the pins they
 * feed, the middle one level, so their wires fan out evenly.
 */
function fanTops(layout: Layout, block: ParameterBlock, group: readonly string[]): Map<string, number> | undefined {
  const { graph } = layout;
  const levels = group.map((id) => levelWithParent(layout, block, id)?.top);
  if (levels.some((top) => top === undefined)) return undefined;
  const heights = group.map((id) => nodeSize(graph.byId.get(id)!).height);
  const crowded = group.some((_, index) => index > 0 && levels[index]! < levels[index - 1]! + heights[index - 1]! + FORMAT_GAP_Y);
  if (!crowded) return undefined;
  const middle = Math.floor((group.length - 1) / 2);
  const tops: number[] = [];
  tops[middle] = levels[middle]!;
  for (let index = middle - 1; index >= 0; index--) tops[index] = tops[index + 1]! - FORMAT_GAP_Y - heights[index]!;
  for (let index = middle + 1; index < group.length; index++) tops[index] = tops[index - 1]! + heights[index - 1]! + FORMAT_GAP_Y;
  return new Map(group.map((id, index) => [id, tops[index]!]));
}

/**
 * Places one parameter block member. Its top is level with the first clear straight wire from an
 * already placed source outside the block on its left, else with a clear straight wire into its
 * tree parent (or its place in a centred fan), wherever its box keeps clear of the owner's exec
 * wire (`floors.level`); otherwise it starts no higher than the owner's lane floor
 * (`floors.rest`). It then moves down only as far as it must to keep `FORMAT_GAP_Y` from every
 * box and twice the wire clearance from every straight wire. A member that also feeds a node
 * outside its block keeps its level wire; the far wire takes a knot (`routeWires`).
 */
function placeMember(
  layout: Layout,
  owner: string,
  block: ParameterBlock,
  id: string,
  floors: Floors,
  fans: Map<string, number>,
  shortfall: { by: number },
): void {
  const { graph } = layout;
  const node = graph.byId.get(id)!;
  const size = nodeSize(node);
  const ownerAt = layout.positions.get(owner)!;
  const x = ownerAt.x + block.x.get(id)!;
  const columnLeft = ownerAt.x + block.columnLeft.get(id)!;
  let top: number | undefined;
  let level: Box | undefined;
  for (const edge of graph.dataEdgesIn.get(id) ?? []) {
    if (block.members.has(edge.source)) continue;
    const at = located(layout, edge.source);
    if (!at) continue;
    const source = graph.byId.get(edge.source)!;
    const sourceRight = at.x + nodeSize(source).width;
    if (sourceRight > columnLeft) continue;
    const y = at.y + pinY(source, "out", edge.sourceHandle);
    const aligned = y - pinY(node, "in", edge.targetHandle);
    if (aligned < floors.level || !straightWireClear(layout, sourceRight, x, y, [edge.source, id])) continue;
    top = aligned;
    level = { x: sourceRight, y, width: x - sourceRight, height: 0 };
    break;
  }
  const parentId = block.parent.get(id)!;
  const parentAt = located(layout, parentId)!;
  if (top === undefined) {
    // Siblings in one column whose level spots overlap share a centred fan.
    if (!fans.has(id)) {
      const column = block.columnLeft.get(id);
      const group = block.order.filter((other) => block.parent.get(other) === parentId && block.columnLeft.get(other) === column);
      for (const [member, fanTop] of (group.length > 1 ? fanTops(layout, block, group) : undefined) ?? []) fans.set(member, fanTop);
    }
    const wire = levelWithParent(layout, block, id);
    // A member rises above the lane floor only if no input above the one it feeds is wired from
    // further left: that wire has to pass over this column (Line Trace's Start over Add).
    const ownerLeft = ownerAt.x;
    const xOfSource = (source: string) => {
      if (block.members.has(source)) return ownerLeft + block.x.get(source)!;
      return located(layout, source)?.x;
    };
    const parent = graph.byId.get(parentId)!;
    const passedOver = wire !== undefined && (graph.dataEdgesIn.get(parentId) ?? []).some((edge) => {
      if (edge.source === id || pinY(parent, "in", edge.targetHandle) >= wire.y - parentAt.y) return false;
      const sourceX = xOfSource(edge.source);
      return sourceX !== undefined && sourceX < x;
    });
    const levelFloor = passedOver ? floors.rest : floors.level;
    const fan = fans.get(id);
    // A fan under a member that would rise above the floor asks for the block's lower rows to start
    // lower, taking the member down with them (a fan under the owner cannot move it).
    if (fan !== undefined && fan < levelFloor && parentId !== owner) shortfall.by = Math.max(shortfall.by, levelFloor - fan);
    if (fan !== undefined && fan >= levelFloor) {
      top = fan;
      if (wire && fan === wire.top) level = { x: x + size.width, y: wire.y, width: parentAt.x - x - size.width, height: 0 };
    } else if (wire && wire.top >= levelFloor && straightWireClear(layout, x + size.width, parentAt.x, wire.y, [id, parentId])) {
      top = wire.top;
      level = { x: x + size.width, y: wire.y, width: parentAt.x - x - size.width, height: 0 };
    }
  }
  top ??= floors.rest;
  const box = { x, y: top, ...size };
  const intervals: Interval[] = [];
  overlapIntervals(box, layout.boxes, intervals);
  // A member keeps off a straight wire by twice the wire clearance, so a wire never runs through it
  // yet a level wire beside it (Break Hit Result's Location over Get Actor Location) can stay level.
  overlapIntervals(box, layout.lanes, intervals, 2 * WIRE_CLEARANCE);
  overlapIntervals(box, layout.earlier, intervals);
  box.y = firstFree(top, intervals);
  addBox(layout, id, { x, y: box.y });
  if (level && box.y === top) pushBox(layout.lanes, level);
}

/**
 * The heights a block may take below its owner: level wires wherever a member keeps
 * `2 × WIRE_CLEARANCE` below the owner's exec input wire, otherwise from the owner's lane floor.
 */
function blockFloors(node: FormatNode, top: number): Floors {
  const rest = top + laneFloor(node);
  const execIn = (node.pins ?? []).filter((pin) => pin.kind === "exec" && pin.direction === "in" && pin.placement !== "header");
  if (execIn.length === 0) return { level: rest, rest };
  return { level: top + Math.max(...execIn.map((pin) => pinY(node, "in", pin.id))) + 2 * WIRE_CLEARANCE, rest };
}

/**
 * Places a block's members in tree preorder. When a centred fan would rise above the floor, the
 * block is placed once more, lowered by that much, so the fan stays centred on its pins and the
 * members above it keep their level wires.
 */
function placeBlock(layout: Layout, owner: string, block: ParameterBlock): void {
  const anchor = layout.positions.get(owner)!;
  const floors = blockFloors(layout.graph.byId.get(owner)!, anchor.y);
  const boxes = layout.boxes.items.length;
  const lanes = layout.lanes.items.length;
  const shortfall = { by: 0 };
  const fans = new Map<string, number>();
  for (const id of block.order) placeMember(layout, owner, block, id, floors, fans, shortfall);
  if (shortfall.by <= 0) return;
  truncateBoxes(layout.boxes, boxes);
  truncateBoxes(layout.lanes, lanes);
  for (const id of block.order) layout.positions.delete(id);
  const lowered = { level: floors.level, rest: floors.rest + shortfall.by };
  const loweredFans = new Map<string, number>();
  for (const id of block.order) placeMember(layout, owner, block, id, lowered, loweredFans, { by: 0 });
}

/**
 * Exec rows: a root, or an exec child that is not its parent's first, starts a row that runs on
 * through first children. Rows come in tree preorder, so a branch's rows follow the rows of the
 * branches that open after it.
 */
function execRows(tree: LayoutTree): { nodes: string[]; parent?: string }[] {
  const parentOf = new Map<string, string>();
  for (const [id, children] of tree.children) {
    for (const child of children) parentOf.set(child, id);
  }
  const rows: { nodes: string[]; parent?: string }[] = [];
  const rowOf = new Map<string, { nodes: string[]; parent?: string }>();
  for (const id of tree.order) {
    const parent = parentOf.get(id);
    if (parent !== undefined && tree.children.get(parent)![0] === id) {
      const row = rowOf.get(parent)!;
      row.nodes.push(id);
      rowOf.set(id, row);
    } else {
      const row = { nodes: [id], ...(parent !== undefined ? { parent } : {}) };
      rows.push(row);
      rowOf.set(id, row);
    }
  }
  return rows;
}

function layoutChain(
  startIds: readonly string[],
  graph: GraphIndex,
  placed: Map<string, Position>,
  knot: { width: number; height: number },
): void {
  const startId = startIds[0]!;
  const start = graph.byId.get(startId)!;
  const origin = placed.get(startId) ?? start.position;
  const walk = chainWalkKind(startId, graph);
  // Exec branches follow their output pins (True before False, Then 0 before Then 1), which a
  // repeat Format sees the same way; data walks follow the nodes' positions.
  const outputOrder = new Map<string, number>();
  if (walk === "exec") {
    for (const edge of graph.execEdges) {
      const pins = (graph.byId.get(edge.source)!.pins ?? []).filter((pin) => pin.direction === "out");
      const index = pins.findIndex((pin) => pin.id === edge.sourceHandle);
      const key = `${edge.source}\n${edge.target}`;
      outputOrder.set(key, Math.min(outputOrder.get(key) ?? Infinity, index < 0 ? Infinity : index));
    }
  }
  const order = (id: string, target: string) => outputOrder.get(`${id}\n${target}`) ?? 0;
  const tree = layoutTree(startIds, (id) =>
    [...(graph.outgoing[walk].get(id) ?? [])].sort(
      (a, b) =>
        Number(!placed.has(a)) - Number(!placed.has(b)) ||
        order(id, a) - order(id, b) ||
        compareNodes(graph, a, b, placed),
    ),
  );
  const owners = claimDataInputs(tree, graph, new Set(placed.keys()));
  const blocks = new Map<string, ParameterBlock>();
  const ownerOf = new Map<string, string>();
  for (const [owner, members] of owners) {
    blocks.set(owner, parameterBlock(owner, members, graph));
    for (const member of members) ownerOf.set(member, owner);
  }
  const chainOrder = [...tree.order].sort(
    (a, b) => tree.ranks.get(a)! - tree.ranks.get(b)!,
  );
  const layout: Layout = {
    graph,
    positions: new Map(),
    placed,
    boxes: boxList(),
    lanes: boxList(),
    earlier: boxList([...placed].map(([id, position]) => ({ id, ...boxAt(graph, id, position) }))),
  };
  if (walk === "exec") {
    layoutExecChain(layout, tree, blocks, ownerOf, chainOrder, origin, knot);
  } else {
    layoutDataWalk(layout, tree, blocks, chainOrder, origin, startId);
  }
  const moving = [...layout.positions].filter(([id]) => !placed.has(id));
  const offset = clearVerticalOffset(
    moving.map(([id, position]) => boxAt(graph, id, position)),
    layout.earlier.items,
  );
  for (const [id, position] of moving) {
    placed.set(id, { x: position.x, y: position.y + offset });
  }
}

/**
 * A selected pure root's forward data walk: rank columns, its small-tree diagonal or rows, then
 * the parameter blocks of its nodes.
 */
function layoutDataWalk(
  layout: Layout,
  tree: LayoutTree,
  blocks: ReadonlyMap<string, ParameterBlock>,
  chainOrder: readonly string[],
  origin: Position,
  startId: string,
): void {
  const { graph, placed } = layout;
  const widths: number[] = [];
  const inputWidths: number[] = [];
  const fixedColumns: number[] = [];
  for (const id of tree.order) {
    const rank = tree.ranks.get(id)!;
    widths[rank] = Math.max(widths[rank] ?? 0, nodeSize(graph.byId.get(id)!).width);
    inputWidths[rank] = Math.max(inputWidths[rank] ?? 0, blocks.get(id)!.left);
    const fixed = placed.get(id);
    if (fixed) fixedColumns[rank] = Math.max(fixedColumns[rank] ?? -Infinity, fixed.x);
  }
  const columns = [origin.x];
  for (let rank = 1; rank < widths.length; rank++) {
    columns[rank] = Math.max(
      columns[rank - 1]! + widths[rank - 1]! + FORMAT_GAP_X + inputWidths[rank]!,
      fixedColumns[rank] ?? -Infinity,
    );
  }
  const diagonal = treeHeights(tree, graph, true).get(startId)! <= HELIX_MAX_HEIGHT;
  const rows = treeRows(tree, graph, diagonal);
  for (const id of tree.order) {
    addBox(layout, id, placed.get(id) ?? {
      x: columns[tree.ranks.get(id)!]!,
      y: origin.y + rows.get(id)!,
    });
  }
  for (const owner of chainOrder) placeBlock(layout, owner, blocks.get(owner)!);
}

/**
 * Exec chains. Each node's X follows its exec predecessors (with a knot lane after a node that
 * branches to a lower row past parameter blocks) and keeps every data wire into it or its block
 * running left to right. A node that continues its parent's row reserves its block's width; a
 * branch child's block may spread left under earlier columns. Rows are placed in turn, each below
 * every box already placed across the span from its parent to its last node, so the exec wire
 * into it drops beside the parent and runs level; each row's blocks are placed with the row.
 */
function layoutExecChain(
  layout: Layout,
  tree: LayoutTree,
  blocks: ReadonlyMap<string, ParameterBlock>,
  ownerOf: ReadonlyMap<string, string>,
  chainOrder: readonly string[],
  origin: Position,
  knot: { width: number; height: number },
): void {
  const { graph, placed } = layout;
  const width = (id: string) => nodeSize(graph.byId.get(id)!).width;
  const parentOf = new Map<string, string>();
  for (const [id, children] of tree.children) {
    for (const child of children) parentOf.set(child, id);
  }
  const predecessors = new Map<string, string[]>();
  for (const [id, targets] of tree.forward) {
    for (const target of targets) predecessors.set(target, [...(predecessors.get(target) ?? []), id]);
  }
  // Each lower branch drops into its own knot lane beside the node, `WIRE_SPACING` apart.
  const lane = (id: string): number => {
    const children = tree.children.get(id) ?? [];
    const lower = children.length - 1;
    return lower > 0 && children.some((child) => blocks.get(child)!.left > 0)
      ? knot.width + (lower - 1) * WIRE_SPACING + FORMAT_GAP_X
      : 0;
  };
  // A lower branch's drop knot sits level with its child's exec pin, in its parent's knot lane. A
  // member level just under that exec wire would meet the knot, so the child's block keeps left of
  // the lane: it moves left (under earlier columns) unless that would move the child itself.
  const clearKnotLane = (block: ParameterBlock, x: number, parent: string, dataFloor: () => number): void => {
    const lower = tree.children.get(parent)!.length - 1;
    // The knots' spots (`routeCandidates`' lanes beside the source), grown by the knot clearance.
    const laneLeft = xs.get(parent)! + width(parent) + FORMAT_GAP_X - WIRE_CLEARANCE;
    const laneRight = laneLeft + knot.width + (lower - 1) * WIRE_SPACING + 2 * WIRE_CLEARANCE;
    const blockRight = x - FORMAT_GAP_X;
    if (block.left <= 0 || blockRight <= laneLeft || x - block.left >= laneRight) return;
    const shift = blockRight - laneLeft;
    // Past three lanes (a node with many branches) the block would leave its owner far behind.
    if (shift > knot.width + 2 * WIRE_SPACING + 2 * WIRE_CLEARANCE) return;
    const move = (by: number) => {
      for (const [member, at] of block.x) block.x.set(member, at - by);
      for (const [member, at] of block.columnLeft) block.columnLeft.set(member, at - by);
      block.left += by;
    };
    move(shift);
    if (dataFloor() > x) move(-shift);
  };
  const xs = new Map<string, number>();
  const xOf = (id: string): number | undefined => {
    const exec = xs.get(id);
    if (exec !== undefined) return exec;
    const owner = ownerOf.get(id);
    const ownerX = owner === undefined ? undefined : xs.get(owner);
    return ownerX === undefined ? undefined : ownerX + blocks.get(owner!)!.x.get(id)!;
  };
  for (const id of chainOrder) {
    const fixed = placed.get(id);
    if (fixed) {
      xs.set(id, fixed.x);
      continue;
    }
    const parent = parentOf.get(id);
    if (parent === undefined) {
      xs.set(id, origin.x);
      continue;
    }
    const block = blocks.get(id)!;
    const first = tree.children.get(parent)![0] === id;
    const reserve = first ? block.left : 0;
    let x = -Infinity;
    for (const predecessor of predecessors.get(id) ?? []) {
      const at = xs.get(predecessor);
      if (at === undefined) continue;
      x = Math.max(x, at + width(predecessor) + FORMAT_GAP_X + lane(predecessor) + reserve);
    }
    // Data runs left to right: every source outside the block ends a gap before what it feeds.
    const dataFloor = () => {
      let floor = -Infinity;
      for (const target of [id, ...block.order]) {
        const offset = target === id ? 0 : block.x.get(target)!;
        for (const edge of graph.dataEdgesIn.get(target) ?? []) {
          if (block.members.has(edge.source) || edge.source === id) continue;
          const sourceX = xOf(edge.source);
          if (sourceX === undefined) continue;
          floor = Math.max(floor, sourceX + width(edge.source) + FORMAT_GAP_X - offset);
        }
      }
      return floor;
    };
    x = Math.max(x, dataFloor());
    if (!first && Number.isFinite(x) && lane(parent) > 0) clearKnotLane(block, x, parent, dataFloor);
    xs.set(id, Number.isFinite(x) ? x : origin.x);
  }
  for (const row of execRows(tree)) {
    let y = origin.y;
    if (layout.boxes.items.length > 0) {
      const parent = row.parent;
      let left = parent !== undefined ? xs.get(parent)! + width(parent) : Infinity;
      let right = -Infinity;
      for (const id of row.nodes) {
        left = Math.min(left, xs.get(id)! - blocks.get(id)!.left);
        right = Math.max(right, xs.get(id)! + width(id));
      }
      let bottom = -Infinity;
      for (const list of [layout.boxes, layout.lanes] as BoxList<Box>[]) {
        forBoxesAcross(list, left, right, (box) => {
          if (box.x >= right || box.x + box.width <= left) return;
          bottom = Math.max(bottom, box.y + box.height);
        });
      }
      if (Number.isFinite(bottom)) y = Math.max(y, bottom + ROW_GAP);
    }
    // Along a row each node's exec input is level with the exec output before it, so the exec wire
    // runs straight even where pins sit at different heights (a custom event's lower Then).
    let rowY = y;
    row.nodes.forEach((id, index) => {
      if (index > 0) {
        const previous = row.nodes[index - 1]!;
        const edge = graph.execBetween.get(pairKey(previous, id));
        const previousAt = layout.positions.get(previous)!;
        rowY = edge
          ? previousAt.y + pinY(graph.byId.get(previous)!, "out", edge.sourceHandle) - pinY(graph.byId.get(id)!, "in", edge.targetHandle)
          : previousAt.y;
      }
      addBox(layout, id, placed.get(id) ?? { x: xs.get(id)!, y: rowY });
    });
    // The exec wire into a branch row runs level from beside its parent: later rows keep clear.
    if (row.parent !== undefined) {
      const first = row.nodes[0]!;
      const edge = graph.execBetween.get(pairKey(row.parent, first));
      const at = layout.positions.get(first)!;
      const from = xs.get(row.parent)! + width(row.parent);
      const y = at.y + pinY(graph.byId.get(first)!, "in", edge?.targetHandle);
      pushBox(layout.lanes, { x: from, y, width: at.x - from, height: 0 });
    }
    for (const id of row.nodes) placeBlock(layout, id, blocks.get(id)!);
  }
}

type LaneGraph = {
  nodes: FormatNode[];
  edges: FormatEdge[];
  /** The knots, source to target, that each direct wire stands for. */
  knotOf: Map<FormatEdge, string[]>;
};

/**
 * Lane knots are Reroutes (data or exec) with one wire in and one out, chained from a node that is
 * not a knot into a node that is not a knot. Layout reads `S → K1 → … → Kn → T` as the direct wire
 * `S → T`, so a graph lays out the same with and without the knots Format adds.
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
  const simple = (id: string) =>
    byId.get(id)!.reroute === true && incoming.get(id)?.length === 1 && outgoing.get(id)?.length === 1;
  const knotOf = new Map<FormatEdge, string[]>();
  const lanes = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    if (simple(edge.source) || !simple(edge.target)) continue;
    const chain: string[] = [];
    let last = edge;
    while (simple(last.target) && !chain.includes(last.target)) {
      chain.push(last.target);
      last = outgoing.get(last.target)![0]!;
    }
    // A chain ends in a node that is not a knot; one ending in a branching knot stays as it is.
    if (byId.get(last.target)!.reroute || chain.includes(last.target)) continue;
    for (const id of chain) lanes.add(id);
    knotOf.set(
      { source: edge.source, sourceHandle: edge.sourceHandle, target: last.target, targetHandle: last.targetHandle },
      chain,
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

function insertObstacle(obstacles: Obstacles, box: Obstacle): void {
  // After every box with the same or a smaller left edge (a binary search).
  let low = 0;
  let high = obstacles.boxes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (obstacles.boxes[middle]!.x > box.x) high = middle;
    else low = middle + 1;
  }
  obstacles.boxes.splice(low, 0, box);
  obstacles.maxWidth = Math.max(obstacles.maxWidth, box.width);
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
    if (work) work.tests++;
    if (box.x + box.width >= minX) found.push(box);
  }
  return found;
}

/** XYFlow `calculateControlOffset`. */
function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : WIRE_CURVATURE * 25 * Math.sqrt(-distance);
}

/**
 * The wire the editor draws between two pins, sampled: XYFlow's bezier from a right-facing source
 * to a left-facing target (`getBezierPath`, default curvature), `WIRE_SAMPLES` + 1 points.
 */
function bezierPoints(from: Point, to: Point): Point[] {
  const offset = controlOffset(to.x - from.x);
  const points: Point[] = [];
  for (let sample = 0; sample <= WIRE_SAMPLES; sample++) {
    const t = sample / WIRE_SAMPLES;
    const u = 1 - t;
    points.push({
      x: u * u * u * from.x + 3 * u * u * t * (from.x + offset) + 3 * u * t * t * (to.x - offset) + t * t * t * to.x,
      // The controls sit level with each end: written this way a level wire stays exactly level.
      y: from.y + (to.y - from.y) * (3 * u * t * t + t * t * t),
    });
  }
  return points;
}

/**
 * The first box (from source to target) that the wire the editor draws between two pins
 * (`bezierPoints`) runs within `clearance` of.
 */
function firstObstruction(
  from: Point,
  to: Point,
  ends: readonly string[],
  obstacles: Obstacles,
  clearance = WIRE_CLEARANCE,
): Obstacle | undefined {
  const offset = controlOffset(to.x - from.x);
  const first = { x: from.x + offset, y: from.y };
  const second = { x: to.x - offset, y: to.y };
  // The curve stays inside its control points' bounds.
  const minX = Math.min(from.x, second.x) - clearance;
  const maxX = Math.max(first.x, to.x) + clearance;
  const minY = Math.min(from.y, to.y) - clearance;
  const maxY = Math.max(from.y, to.y) + clearance;
  const near = boxesAcross(obstacles, minX, maxX).filter(
    (box) => !ends.includes(box.id) && box.y <= maxY && box.y + box.height >= minY,
  );
  if (near.length === 0) return undefined;
  for (let sample = 1; sample <= WIRE_SAMPLES; sample++) {
    const t = sample / (WIRE_SAMPLES + 1);
    const u = 1 - t;
    const x = u * u * u * from.x + 3 * u * u * t * first.x + 3 * u * t * t * second.x + t * t * t * to.x;
    // first.y is from.y and second.y is to.y: written this way a level wire stays exactly level.
    const y = from.y + (to.y - from.y) * (3 * u * t * t + t * t * t);
    const hit = near.find((box) => {
      if (work) work.tests++;
      return x > box.x - clearance && x < box.x + box.width + clearance && y > box.y - clearance && y < box.y + box.height + clearance;
    });
    if (hit) return hit;
  }
  return undefined;
}

function boxesMeet(a: Box, b: Box, clearance: number): boolean {
  if (work) work.tests++;
  return (
    a.x < b.x + b.width + clearance &&
    a.x + a.width > b.x - clearance &&
    a.y < b.y + b.height + clearance &&
    a.y + a.height > b.y - clearance
  );
}

/** The first node or placed knot box (knots are obstacles once placed) `box` comes within the wire clearance of, if any. */
function boxInTheWay(box: Box, obstacles: Obstacles): Box | undefined {
  return boxesAcross(obstacles, box.x - WIRE_CLEARANCE, box.x + box.width + WIRE_CLEARANCE).find((other) =>
    boxesMeet(box, other, WIRE_CLEARANCE),
  );
}

type Size = { width: number; height: number };

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

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
/** One stretch of a routed wire: level (a run) or a bezier between two heights, sampled. */
type Piece = {
  from: Point;
  to: Point;
  level: boolean;
  /**
   * The wire's samples (`path`) with points added along straight stretches every `WIRE_SPACING`,
   * for distances; built on first use (`densePoints`), as most pieces never need them.
   */
  points?: Point[];
  /** The wire's samples alone, for crossings: the added points lie on its segments. */
  path: Point[];
  bounds: Bounds;
};
type Committed = {
  wire: string;
  node: string;
  targetNode: string;
  source: string;
  target: string;
  /** Pin heights at each end, and the height of the wire's main (longest level) run. */
  fromY: number;
  toY: number;
  lane: number;
  pieces: Piece[];
  knots: Box[];
  /** Pieces and knots together. */
  bounds: Bounds;
  /** Last `WireIndex` query that returned this wire, so one query lists it once. */
  seen: number;
};

/** Grid cell size for laid wires: about one node column across. */
const WIRE_CELL = 256;

/**
 * Laid wires, bucketed in a uniform grid by their bounds, so a candidate route is tested only
 * against the wires near it. Every wire-to-wire rule (spacing, knots, crossings) acts within
 * `WIRE_SPACING`, so a query by the candidate's bounds grown by that much is exact. The two rules
 * that are not local keep lists of their own: knots of one node's wires (`byNode`, distinct lanes
 * across) and wires between the same two nodes (`byPair`, pin order).
 */
type WireIndex = {
  /** Level runs of laid wires, as zero-height boxes, for free lanes (`routeCandidates`). */
  runs: BoxList<Box>;
  cells: Map<number, Committed[]>;
  byNode: Map<string, Committed[]>;
  byPair: Map<string, Committed[]>;
  query: number;
};

function cellKey(column: number, row: number): number {
  return column * 1048576 + row;
}

function pairKey(source: string, target: string): string {
  return `${source}\n${target}`;
}

function addWire(index: WireIndex, wire: Committed): void {
  for (const piece of wire.pieces) {
    if (!piece.level) continue;
    const left = Math.min(piece.from.x, piece.to.x);
    pushBox(index.runs, { x: left, y: piece.from.y, width: Math.max(piece.from.x, piece.to.x) - left, height: 0 });
  }
  const { bounds } = wire;
  for (let column = Math.floor(bounds.minX / WIRE_CELL); column <= Math.floor(bounds.maxX / WIRE_CELL); column++) {
    for (let row = Math.floor(bounds.minY / WIRE_CELL); row <= Math.floor(bounds.maxY / WIRE_CELL); row++) {
      const key = cellKey(column, row);
      const cell = index.cells.get(key);
      if (cell) cell.push(wire);
      else index.cells.set(key, [wire]);
    }
  }
  const byNode = index.byNode.get(wire.node);
  if (byNode) byNode.push(wire);
  else index.byNode.set(wire.node, [wire]);
  const key = pairKey(wire.node, wire.targetNode);
  const byPair = index.byPair.get(key);
  if (byPair) byPair.push(wire);
  else index.byPair.set(key, [wire]);
}

/** Laid wires whose bounds come within `margin` of `bounds`, in the order they were laid. */
function wiresNear(index: WireIndex, bounds: Bounds, margin: number): Committed[] {
  const query = ++index.query;
  const found: Committed[] = [];
  const minX = bounds.minX - margin;
  const maxX = bounds.maxX + margin;
  const minY = bounds.minY - margin;
  const maxY = bounds.maxY + margin;
  for (let column = Math.floor(minX / WIRE_CELL); column <= Math.floor(maxX / WIRE_CELL); column++) {
    for (let row = Math.floor(minY / WIRE_CELL); row <= Math.floor(maxY / WIRE_CELL); row++) {
      for (const wire of index.cells.get(cellKey(column, row)) ?? []) {
        if (work) work.tests++;
        if (wire.seen === query) continue;
        wire.seen = query;
        const other = wire.bounds;
        if (other.maxX < minX || other.minX > maxX || other.maxY < minY || other.minY > maxY) continue;
        found.push(wire);
      }
    }
  }
  return found;
}

function routeBounds(pieces: readonly Piece[], knots: readonly Box[]): Bounds {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const { bounds: piece } of pieces) {
    bounds.minX = Math.min(bounds.minX, piece.minX);
    bounds.maxX = Math.max(bounds.maxX, piece.maxX);
    bounds.minY = Math.min(bounds.minY, piece.minY);
    bounds.maxY = Math.max(bounds.maxY, piece.maxY);
  }
  for (const knot of knots) {
    bounds.minX = Math.min(bounds.minX, knot.x);
    bounds.maxX = Math.max(bounds.maxX, knot.x + knot.width);
    bounds.minY = Math.min(bounds.minY, knot.y);
    bounds.maxY = Math.max(bounds.maxY, knot.y + knot.height);
  }
  return bounds;
}

/** The height of a route's longest level run, or its middle height when it has none. */
function mainLane(pieces: readonly Piece[], from: Point, to: Point): number {
  let best: Piece | undefined;
  for (const piece of pieces) {
    if (piece.level && (!best || Math.abs(piece.to.x - piece.from.x) > Math.abs(best.to.x - best.from.x))) best = piece;
  }
  return best ? best.from.y : (from.y + to.y) / 2;
}

function curvePoints(path: readonly Point[]): Point[] {
  const points: Point[] = [];
  for (const point of path) {
    const last = points[points.length - 1];
    if (last) {
      const steps = Math.floor(Math.hypot(point.x - last.x, point.y - last.y) / WIRE_SPACING);
      for (let step = 1; step < steps; step++) {
        points.push({ x: last.x + ((point.x - last.x) * step) / steps, y: last.y + ((point.y - last.y) * step) / steps });
      }
    }
    points.push(point);
  }
  return points;
}

function densePoints(piece: Piece): Point[] {
  return (piece.points ??= piece.level ? piece.path : curvePoints(piece.path));
}

/** The pieces of a wire from `from` through knots (top-left corners) to `to`. */
function piecesOf(from: Point, knots: readonly Position[], size: Size, to: Point): Piece[] {
  const stops: Point[] = [from];
  for (const knot of knots) {
    stops.push({ x: knot.x, y: knot.y + size.height / 2 }, { x: knot.x + size.width, y: knot.y + size.height / 2 });
  }
  stops.push(to);
  const pieces: Piece[] = [];
  for (let index = 0; index < stops.length; index += 2) {
    const a = stops[index]!;
    const b = stops[index + 1]!;
    const level = a.y === b.y;
    const path = level ? [a, b] : bezierPoints(a, b);
    pieces.push({ from: a, to: b, level, path, bounds: pointBounds(path) });
  }
  return pieces;
}

function pointBounds(points: readonly Point[]): Bounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY };
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  if (work) work.tests++;
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Crossings between two wires' pieces: bounding boxes first, then each segment against the other
 * piece's box, then segment pairs. Two level runs never cross (both are horizontal).
 */
function crossings(pieces: readonly Piece[], others: readonly Piece[], limit = Infinity): number {
  let count = 0;
  for (const piece of pieces) {
    const a = piece.bounds;
    for (const other of others) {
      if (piece.level && other.level) continue;
      const b = other.bounds;
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
      for (let i = 1; i < piece.path.length; i++) {
        const p = piece.path[i - 1]!;
        const q = piece.path[i]!;
        if (Math.max(p.x, q.x) < b.minX || Math.min(p.x, q.x) > b.maxX || Math.max(p.y, q.y) < b.minY || Math.min(p.y, q.y) > b.maxY) continue;
        for (let j = 1; j < other.path.length; j++) {
          const r = other.path[j - 1]!;
          const t = other.path[j]!;
          if (Math.max(r.x, t.x) < Math.min(p.x, q.x) || Math.min(r.x, t.x) > Math.max(p.x, q.x)) continue;
          if (Math.max(r.y, t.y) < Math.min(p.y, q.y) || Math.min(r.y, t.y) > Math.max(p.y, q.y)) continue;
          if (segmentsCross(p, q, r, t) && ++count > limit) return count;
        }
      }
    }
  }
  return count;
}

/**
 * Whether any point of a piece's dense points (`curvePoints`) comes within `distance` of a box:
 * bounds first, then each sampled segment's box, generating the points between its ends only for
 * segments that come near (a tall drop meets few knots).
 */
function pieceNearBox(piece: Piece, box: Box, distance: number): boolean {
  const { bounds, path } = piece;
  const minX = box.x - distance;
  const maxX = box.x + box.width + distance;
  const minY = box.y - distance;
  const maxY = box.y + box.height + distance;
  if (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY) return false;
  if (distanceToBox(path[0]!, box) < distance) return true;
  for (let index = 1; index < path.length; index++) {
    const last = path[index - 1]!;
    const point = path[index]!;
    if (Math.max(last.x, point.x) < minX || Math.min(last.x, point.x) > maxX) continue;
    if (Math.max(last.y, point.y) < minY || Math.min(last.y, point.y) > maxY) continue;
    // The same points `curvePoints` adds between these two samples, then the second sample.
    const steps = piece.level ? 0 : Math.floor(Math.hypot(point.x - last.x, point.y - last.y) / WIRE_SPACING);
    for (let step = 1; step < steps; step++) {
      const at = { x: last.x + ((point.x - last.x) * step) / steps, y: last.y + ((point.y - last.y) * step) / steps };
      if (distanceToBox(at, box) < distance) return true;
    }
    if (distanceToBox(point, box) < distance) return true;
  }
  return false;
}

function distanceToBox(point: Point, box: Box): number {
  if (work) work.tests++;
  const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.width);
  const dy = Math.max(box.y - point.y, 0, point.y - box.y - box.height);
  return Math.hypot(dx, dy);
}

/**
 * Whether a route keeps its distances. Pieces stay `clearance` from every node and knot but the
 * wire's ends (a run in a lane `WIRE_CROWDING`); its knots fit; its runs keep `WIRE_SPACING` from
 * other wires' runs, and its knots and pieces keep `WIRE_SPACING` from other wires' knots and runs.
 * A final knot level with the target pin, and its run into the pin, need not keep that spacing from
 * other wires into the same node: neighbouring pins (the node's own exec input) sit one pin row
 * apart, closer than `WIRE_SPACING`, so a knot level with a pin could otherwise never fit.
 */
function routeFits(
  pieces: readonly Piece[],
  knots: readonly Box[],
  ends: readonly string[],
  curveClearance: number,
  obstacles: Obstacles,
  wires: WireIndex,
  near: () => readonly Committed[],
  sharesPin: (other: Committed) => boolean,
  direct: boolean,
  node: string,
  target: string,
  spaced: boolean,
  keepsOrder: (other: Committed) => boolean,
): boolean {
  for (const knot of knots) {
    if (boxInTheWay(knot, obstacles)) return false;
    if (!spaced) continue;
    // Wires from one node drop into knot lanes of their own.
    for (const other of wires.byNode.get(node) ?? []) {
      if (other.knots.some((box) => Math.abs(box.x - knot.x) < WIRE_SPACING)) return false;
    }
  }
  for (const piece of pieces) {
    if (piece.level) {
      const runClearance = direct ? WIRE_CLEARANCE : WIRE_CROWDING;
      const minX = Math.min(piece.from.x, piece.to.x);
      const maxX = Math.max(piece.from.x, piece.to.x);
      for (const box of boxesAcross(obstacles, minX - runClearance, maxX + runClearance)) {
        if (ends.includes(box.id) || box.x >= maxX || box.x + box.width <= minX) continue;
        if (piece.from.y > box.y - runClearance && piece.from.y < box.y + box.height + runClearance) return false;
      }
    } else if (firstObstruction(piece.from, piece.to, ends, obstacles, curveClearance)) {
      return false;
    }
  }
  if (!spaced) return true;
  for (const other of wires.byPair.get(pairKey(node, target)) ?? []) {
    if (!keepsOrder(other)) return false;
  }
  const lastPiece = pieces[pieces.length - 1]!;
  const intoPin = !direct && lastPiece.level;
  const finalKnot = intoPin ? knots[knots.length - 1] : undefined;
  for (const other of near()) {
    if (sharesPin(other)) continue;
    const besidePin = other.targetNode === target;
    for (const piece of pieces) {
      if (besidePin && intoPin && piece === lastPiece) continue;
      for (const otherPiece of other.pieces) {
        if (piece.level && otherPiece.level) {
          const overlap =
            Math.min(Math.max(piece.from.x, piece.to.x), Math.max(otherPiece.from.x, otherPiece.to.x)) -
            Math.max(Math.min(piece.from.x, piece.to.x), Math.min(otherPiece.from.x, otherPiece.to.x));
          if (overlap > 0 && Math.abs(piece.from.y - otherPiece.from.y) < WIRE_SPACING) return false;
        }
      }
      for (const knot of other.knots) {
        if (pieceNearBox(piece, knot, WIRE_SPACING)) return false;
      }
    }
    for (const knot of knots) {
      if (besidePin && knot === finalKnot) continue;
      for (const otherPiece of other.pieces) {
        if (pieceNearBox(otherPiece, knot, WIRE_SPACING)) return false;
        if (otherPiece.level) {
          const minX = Math.min(otherPiece.from.x, otherPiece.to.x);
          const maxX = Math.max(otherPiece.from.x, otherPiece.to.x);
          if (maxX > knot.x && minX < knot.x + knot.width && distanceToBox({ x: Math.max(minX, Math.min(maxX, knot.x)), y: otherPiece.from.y }, knot) < WIRE_SPACING) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

function routeLength(pieces: readonly Piece[]): number {
  let length = 0;
  for (const piece of pieces) {
    const points = densePoints(piece);
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    }
  }
  return length;
}

/**
 * Knot spots for a wire, as routes of 0, 1 or 2 knots (top-left corners), source to target:
 * direct; a drop beside the source to the target's height (an exec branch's lane, or a few lanes
 * further out so drops from one node keep apart); level from the source to a knot beside the
 * target; two knots with the long run in a free lane, between or beyond the boxes and runs on the
 * way; and the round-two spots around the first box in the way.
 */
function routeCandidates(
  from: Point,
  to: Point,
  ends: readonly string[],
  size: Size,
  obstacles: Obstacles,
  runs: BoxList<Box>,
  nest: number,
): Position[][] {
  const routes: Position[][] = [[]];
  const knot = (x: number, lane: number): Position => ({ x, y: lane - size.height / 2 });
  // Lanes beside the source, `WIRE_SPACING` apart, so drops from one node nest without meeting.
  const near = (index: number) => from.x + FORMAT_GAP_X + index * WIRE_SPACING;
  const far = to.x - FORMAT_GAP_X - size.width;
  // The three lanes nearest the source, and the lane this wire nests in when the source's other
  // knotted wires (its lower branches, routed lowest first) already hold the ones before it.
  const nearLanes = nest >= 3 ? [0, 1, 2, nest] : [0, 1, 2];
  for (const index of nearLanes) {
    if (near(index) + size.width <= to.x - FORMAT_GAP_X / 2) routes.push([knot(near(index), to.y)]);
  }
  if (near(0) + size.width + FORMAT_GAP_X <= far) {
    const lanes = new Set<number>();
    const half = size.height / 2;
    for (const box of boxesAcross(obstacles, from.x, to.x)) {
      if (ends.includes(box.id)) continue;
      lanes.add(box.y - WIRE_CROWDING - half);
      lanes.add(box.y + box.height + WIRE_CROWDING + half);
    }
    forBoxesAcross(runs, from.x, to.x, (run) => {
      if (run.x + run.width < from.x || run.x > to.x) return;
      lanes.add(run.y - WIRE_SPACING - half);
      lanes.add(run.y + WIRE_SPACING + half);
    });
    const middle = (from.y + to.y) / 2;
    const ordered = [...lanes].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
    // Knot lanes beside each end, `WIRE_SPACING` apart, so wires sharing an end keep apart.
    const before = (index: number) => far - index * (size.width + WIRE_SPACING);
    for (const lane of ordered.slice(0, LANE_CANDIDATES)) {
      for (let last = 0; last < 2; last++) {
        for (let first = 0; first < 3; first++) {
          if (near(first) + size.width + FORMAT_GAP_X <= before(last)) routes.push([knot(near(first), lane), knot(before(last), lane)]);
        }
      }
      // The run in the lane, then the last knot level with the target pin just before it.
      for (let first = 0; first < 3; first++) {
        if (lane !== to.y && near(first) + size.width + FORMAT_GAP_X <= before(0)) routes.push([knot(near(first), lane), knot(before(0), to.y)]);
      }
    }
  }
  const blocked = firstObstruction(from, to, ends, obstacles, WIRE_CROWDING);
  if (blocked) {
    const lowest = from.x + FORMAT_GAP_X;
    const highest = to.x - FORMAT_GAP_X - size.width;
    if (lowest <= highest) {
      for (const lane of [to.y, blocked.y - 2 * WIRE_CLEARANCE - size.height / 2, blocked.y + blocked.height + 2 * WIRE_CLEARANCE + size.height / 2]) {
        for (const left of [blocked.x, highest]) routes.push([knot(Math.min(Math.max(left, lowest), highest), lane)]);
      }
      // Level with the target pin just past a box on the way, nearest the target first, so the wire
      // turns once past the boxes and runs level into the pin (Line Trace's Target).
      const past = new Set<number>();
      for (const box of boxesAcross(obstacles, from.x, to.x)) {
        if (ends.includes(box.id)) continue;
        const left = box.x + box.width + WIRE_CROWDING;
        if (left > lowest && left < highest) past.add(left);
      }
      for (const left of [...past].sort((a, b) => b - a).slice(0, PAST_CANDIDATES)) routes.push([knot(left, to.y)]);
    }
  }
  // Last: level from the source to a knot before the target (an exec drop prefers its lanes).
  if (far >= from.x + FORMAT_GAP_X / 2) routes.push([knot(far, from.y)]);
  return routes;
}

/** Lexicographic: fewer knots, then fewer crossings, then candidate order (exec) or length (data). */
function cheaper(cost: readonly number[], than: readonly number[]): boolean {
  for (let index = 0; index < cost.length; index++) {
    if (cost[index] !== than[index]) return cost[index]! < than[index]!;
  }
  return false;
}

/**
 * Lays every data and exec wire between two formatted nodes as level runs joined by short
 * transitions. A wire that is level and clear stays direct; a short wire stays direct while it
 * keeps clear of nodes and other wires; a long or steep one (`LONG_WIRE`), and one that runs into
 * a node, takes the best route of `routeCandidates` that fits (`routeFits`) and whose transitions
 * span at most `MAX_TRANSITION` across: fewest knots, then fewest crossings with the wires already
 * laid, then candidate order for exec wires (nearest lane first) and the shortest for data wires.
 * Exec wires go first, each node's lowest branch
 * first so its drop sits nearest the node; then data wires; each in a fixed order, so a second
 * Format lays every wire the same way. Placed knots and wires are obstacles for later wires.
 * Cost per wire: O(C · (W + R + P²)) for C candidates (at most 10 + 6 × `LANE_CANDIDATES`), W boxes in
 * its X range, R runs and P sampled points of the wires its bounds meet.
 */
function routeWires(
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
  let placedKnots = 0;
  const index: WireIndex = { runs: boxList(), cells: new Map(), byNode: new Map(), byPair: new Map(), query: 0 };
  const endsOf = new Map<FormatEdge, { from: Point; to: Point }>();
  const ends = (edge: FormatEdge) => {
    let found = endsOf.get(edge);
    if (found) return found;
    const source = graph.byId.get(edge.source)!;
    const target = graph.byId.get(edge.target)!;
    const sourceAt = positions.get(edge.source)!;
    const targetAt = positions.get(edge.target)!;
    found = {
      from: { x: sourceAt.x + nodeSize(source).width, y: sourceAt.y + pinY(source, "out", edge.sourceHandle) },
      to: { x: targetAt.x, y: targetAt.y + pinY(target, "in", edge.targetHandle) },
    };
    endsOf.set(edge, found);
    return found;
  };
  const exec = new Set(graph.execEdges);
  const wires = [...graph.dataEdges, ...graph.execEdges]
    .filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    .sort((a, b) => {
      const kind = Number(!exec.has(a)) - Number(!exec.has(b));
      if (kind !== 0) return kind;
      if (!exec.has(a)) return compareKeys(edgeKey(a), edgeKey(b));
      // Exec wires by node, each node's lowest branch first.
      return compareKeys(a.source, b.source) || ends(b).to.y - ends(a).to.y || compareKeys(edgeKey(a), edgeKey(b));
    });
  // Level wires that run clear are fixed first: everything else keeps its distance from them.
  const settled = new Set<FormatEdge>();
  for (const edge of wires) {
    const { from, to } = ends(edge);
    if (from.y !== to.y || from.x > to.x || lanes.knotOf.has(edge)) continue;
    if (firstObstruction(from, to, [edge.source, edge.target], obstacles, WIRE_CLEARANCE)) continue;
    settled.add(edge);
    const pieces = piecesOf(from, [], knotSize, to);
    addWire(index, {
      wire: edgeKey(edge),
      node: edge.source,
      targetNode: edge.target,
      source: `${edge.source}\n${edge.sourceHandle}`,
      target: `${edge.target}\n${edge.targetHandle}`,
      fromY: from.y,
      toY: to.y,
      lane: from.y,
      pieces,
      knots: [],
      bounds: routeBounds(pieces, []),
      seen: 0,
    });
  }
  for (const edge of wires) {
    if (settled.has(edge)) continue;
    const { from, to } = ends(edge);
    const endIds = [edge.source, edge.target];
    const existing = lanes.knotOf.get(edge) ?? [];
    const size = existing.length > 0 ? nodeSize(knotNodes.get(existing[0]!)!) : knotSize;
    const limit = existing.length > 0 ? existing.length : insertKnots ? 2 : 0;
    const source = `${edge.source}\n${edge.sourceHandle}`;
    const target = `${edge.target}\n${edge.targetHandle}`;
    const sharesPin = (other: Committed) => other.source === source || other.target === target;
    const dx = to.x - from.x;
    const dy = Math.abs(to.y - from.y);
    // A long wire, or a steep one past the next column, runs level with short transitions: under
    // XYFlow's bezier it would otherwise be a long diagonal. Pins a few units apart (a custom
    // event's lower exec pin) already read as level.
    const needsLevel = dy > WIRE_CLEARANCE && (dx > LONG_WIRE || (dx > 2 * FORMAT_GAP_X && dy > dx));
    // Transitions stay short; the first may reach past the knot lanes of the source's other wires.
    const reach = (index: number) => MAX_TRANSITION + (index === 0 ? 2 * (size.width + WIRE_SPACING) : 0);
    let best: { route: Position[]; pieces: Piece[]; cost: number[] } | undefined;
    // Wires keep apart where they can; where no route can, they still keep clear of every node.
    // An exec drop takes the first lane that fits, nearest its node, so a node's lowest branch
    // (routed first) drops nearest it and the rows above keep clear of its drop.
    const isExec = exec.has(edge);
    // Cost is lexicographic with the knot count first, so candidates are tried by knot count and
    // the first count with a fitting route ends the search; the other candidates are built only
    // when the direct wire does not fit.
    let candidates: Position[][] | undefined;
    for (const spaced of [true, false]) {
      if (best) break;
      for (let count = 0; count <= limit && !best; count++) {
        if (count > 0) {
          const nest = (index.byNode.get(edge.source) ?? []).filter((other) => other.knots.length > 0).length;
          candidates ??= routeCandidates(from, to, endIds, size, obstacles, index.runs, nest);
        }
        const group = count === 0 ? [[] as Position[]] : candidates!;
        for (const [order, route] of group.entries()) {
          if (route.length !== count) continue;
          if (count === 0 && needsLevel && limit > 0 && spaced) continue;
          const pieces = piecesOf(from, route, size, to);
          if (count > 0 && pieces.some((piece, at) => !piece.level && Math.abs(piece.to.x - piece.from.x) > reach(at))) continue;
          const boxes = route.map((at) => ({ ...at, ...size }));
          const direct = route.length === 0;
          const clearance = direct ? (from.y === to.y ? WIRE_CLEARANCE : WIRE_CROWDING) : WIRE_CLEARANCE;
          // Wires between the same two nodes keep their pins' order across their lanes, so they never
          // cross each other (Element over Index into A over B).
          const lane = mainLane(pieces, from, to);
          const keepsOrder = (other: Committed) => {
            if (other.node !== edge.source || other.targetNode !== edge.target) return true;
            const atSource = Math.sign(from.y - other.fromY);
            if (atSource === 0 || atSource !== Math.sign(to.y - other.toY)) return true;
            return Math.sign(lane - other.lane) === atSource;
          };
          // Laid wires within reach of every wire-to-wire rule, looked up once per candidate.
          let nearby: Committed[] | undefined;
          const near = () => (nearby ??= wiresNear(index, routeBounds(pieces, boxes), WIRE_SPACING));
          if (!routeFits(pieces, boxes, endIds, clearance, obstacles, index, near, sharesPin, direct, edge.source, edge.target, spaced, keepsOrder)) continue;
          // The direct wire is the only route without knots, so it needs no comparison.
          if (direct) {
            best = { route, pieces, cost: [] };
            break;
          }
          // Counting stops once this route has more crossings than the best one: it cannot win.
          const most = best ? best.cost[1]! : Infinity;
          let crossed = 0;
          for (const other of near()) {
            if (crossed > most) break;
            if (!sharesPin(other)) crossed += crossings(pieces, other.pieces, most - crossed);
          }
          // Among routes as good, one whose last knot is level with the target pin runs level into it.
          const levelEnd = route[route.length - 1]!.y + size.height / 2 === to.y ? 0 : 1;
          const cost = [route.length, crossed, levelEnd, isExec ? order : routeLength(pieces)];
          if (!best || cheaper(cost, best.cost)) best = { route, pieces, cost };
        }
      }
    }
    const route = best?.route ?? [];
    const pieces = best?.pieces ?? piecesOf(from, [], size, to);
    const boxes: Box[] = route.map((at) => ({ ...at, ...size }));
    if (existing.length > 0) {
      existing.forEach((id, index) => {
        let at = route[index];
        if (!at) {
          // A knot the route does not need waits beside the target, left of the ones after it.
          // Placed knots are obstacles already; this wire's own are not yet.
          at = knotBesideTarget(from, to, endIds, size, obstacles, boxes);
          boxes.push({ ...at, ...size });
        }
        moved.set(id, at);
      });
    } else if (route.length > 0) {
      knots.push({ edge, positions: route });
    }
    for (const box of boxes) {
      placedKnots++;
      insertObstacle(obstacles, { id: `\u0000knot${placedKnots}`, ...box });
    }
    addWire(index, {
      wire: edgeKey(edge),
      node: edge.source,
      targetNode: edge.target,
      source,
      target,
      fromY: from.y,
      toY: to.y,
      lane: mainLane(pieces, from, to),
      pieces,
      knots: boxes,
      bounds: routeBounds(pieces, boxes),
      seen: 0,
    });
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
  work = options.work;
  try {
    return formatNodes(nodes, edges, selectedIds, options);
  } finally {
    work = undefined;
  }
}

function formatNodes(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  selectedIds: readonly string[],
  options: FormatOptions,
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
    layoutChain(group, graph, positions, knotSize);
  }
  const routed = routeWires(
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
