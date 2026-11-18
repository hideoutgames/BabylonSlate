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
/** A direct wire this close to another node is crowding it: Format routes it around with a knot. */
const WIRE_CROWDING = 32;
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
  /** Data wires out of each node. */
  dataEdgesOut: Map<string, FormatEdge[]>;
  execEdges: FormatEdge[];
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
    } else {
      graph.dataEdgesOut.set(source.id, [...(graph.dataEdgesOut.get(source.id) ?? []), edge]);
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
function overlapIntervals(box: Box, blockers: readonly Box[], into: Interval[], gap = FORMAT_GAP_Y): void {
  for (const blocker of blockers) {
    if (box.x >= blocker.x + blocker.width || box.x + box.width <= blocker.x) continue;
    into.push({
      from: blocker.y - box.height - gap,
      to: blocker.y + blocker.height + gap,
    });
  }
}

/** Boxes laid out so far for one chain, plus the straight wires (zero height) other nodes keep clear of. */
type Layout = {
  graph: GraphIndex;
  positions: Map<string, Position>;
  placed: ReadonlyMap<string, Position>;
  /** Boxes of this chain's nodes, by id. */
  boxes: Obstacle[];
  /** Straight wires and escape lanes, as zero-height boxes. */
  lanes: Box[];
  /** Boxes of chains formatted earlier. */
  earlier: Obstacle[];
};

function located(layout: Layout, id: string): Position | undefined {
  return layout.positions.get(id) ?? layout.placed.get(id);
}

function addBox(layout: Layout, id: string, position: Position): void {
  layout.positions.set(id, position);
  layout.boxes.push({ id, ...boxAt(layout.graph, id, position) });
}

/** Whether a level wire at `y` from `fromX` to `toX` keeps `WIRE_CROWDING` from every node but its ends. */
function straightWireClear(layout: Layout, fromX: number, toX: number, y: number, ends: readonly string[]): boolean {
  for (const list of [layout.boxes, layout.earlier]) {
    for (const box of list) {
      if (ends.includes(box.id)) continue;
      if (box.x >= toX || box.x + box.width <= fromX) continue;
      if (y > box.y - WIRE_CROWDING && y < box.y + box.height + WIRE_CROWDING) return false;
    }
  }
  return true;
}

/**
 * Places one parameter block member. Its top is level with the first clear straight wire from an
 * already placed source outside the block on its left, else with a clear straight wire into its
 * tree parent, else the owner's lane floor; never above the floor. It then moves down only as far
 * as it must to keep `FORMAT_GAP_Y` from every box and straight wire, and, when it also feeds a
 * node outside its block, to keep that output's wire `WIRE_CROWDING` clear of the nodes between it
 * and its tree parent, so the wire can leave under them.
 */
function placeMember(
  layout: Layout,
  owner: string,
  block: ParameterBlock,
  id: string,
  floor: number,
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
    if (aligned < floor || !straightWireClear(layout, sourceRight, x, y, [edge.source, id])) continue;
    top = aligned;
    level = { x: sourceRight, y, width: x - sourceRight, height: 0 };
    break;
  }
  const parentId = block.parent.get(id)!;
  const parent = graph.byId.get(parentId)!;
  const parentAt = located(layout, parentId)!;
  if (top === undefined) {
    const edge = (graph.dataEdgesIn.get(parentId) ?? []).find((entry) => entry.source === id);
    if (edge) {
      const y = parentAt.y + pinY(parent, "in", edge.targetHandle);
      const aligned = y - pinY(node, "out", edge.sourceHandle);
      if (aligned >= floor && straightWireClear(layout, x + size.width, parentAt.x, y, [id, parentId])) {
        top = aligned;
        level = { x: x + size.width, y, width: parentAt.x - x - size.width, height: 0 };
      }
    }
  }
  top ??= floor;
  const box = { x, y: top, ...size };
  const intervals: Interval[] = [];
  overlapIntervals(box, layout.boxes, intervals);
  // A member keeps off a straight wire by twice the wire clearance, so a wire never runs through it
  // yet a level wire beside it (Break Hit Result's Location over Get Actor Location) can stay level.
  overlapIntervals(box, layout.lanes, intervals, 2 * WIRE_CLEARANCE);
  overlapIntervals(box, layout.earlier, intervals);
  // Outputs that also feed nodes outside the block leave under the nodes up to the tree parent.
  const escapes = new Set<number>();
  for (const edge of graph.dataEdgesOut.get(id) ?? []) {
    if (block.members.has(edge.target) || edge.target === owner) continue;
    escapes.add(pinY(node, "out", edge.sourceHandle));
  }
  const escapeFrom = x + size.width;
  const escapeTo = parentAt.x + nodeSize(parent).width;
  for (const offset of escapes) {
    for (const list of [layout.boxes, layout.earlier]) {
      for (const other of list) {
        if (other.x >= escapeTo || other.x + other.width <= escapeFrom) continue;
        intervals.push({
          from: other.y - WIRE_CROWDING - offset,
          to: other.y + other.height + WIRE_CROWDING - offset,
        });
      }
    }
  }
  box.y = firstFree(top, intervals);
  addBox(layout, id, { x, y: box.y });
  if (level && box.y === top) layout.lanes.push(level);
  for (const offset of escapes) {
    layout.lanes.push({ x: escapeFrom, y: box.y + offset, width: escapeTo - escapeFrom, height: 0 });
  }
}

function placeBlock(layout: Layout, owner: string, block: ParameterBlock): void {
  const anchor = layout.positions.get(owner)!;
  const floor = anchor.y + laneFloor(layout.graph.byId.get(owner)!);
  for (const id of block.order) placeMember(layout, owner, block, id, floor);
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
  knotWidth: number,
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
    boxes: [],
    lanes: [],
    earlier: [...placed].map(([id, position]) => ({ id, ...boxAt(graph, id, position) })),
  };
  if (walk === "exec") {
    layoutExecChain(layout, tree, blocks, ownerOf, chainOrder, origin, knotWidth);
  } else {
    layoutDataWalk(layout, tree, blocks, chainOrder, origin, startId);
  }
  const moving = [...layout.positions].filter(([id]) => !placed.has(id));
  const offset = clearVerticalOffset(
    moving.map(([id, position]) => boxAt(graph, id, position)),
    layout.earlier,
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
  knotWidth: number,
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
  const lane = (id: string): number => {
    const children = tree.children.get(id) ?? [];
    return children.length > 1 && children.some((child) => blocks.get(child)!.left > 0)
      ? knotWidth + FORMAT_GAP_X
      : 0;
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
    const reserve = tree.children.get(parent)![0] === id ? block.left : 0;
    let x = -Infinity;
    for (const predecessor of predecessors.get(id) ?? []) {
      const at = xs.get(predecessor);
      if (at === undefined) continue;
      x = Math.max(x, at + width(predecessor) + FORMAT_GAP_X + lane(predecessor) + reserve);
    }
    // Data runs left to right: every source outside the block ends a gap before what it feeds.
    for (const target of [id, ...block.order]) {
      const offset = target === id ? 0 : block.x.get(target)!;
      for (const edge of graph.dataEdgesIn.get(target) ?? []) {
        if (block.members.has(edge.source) || edge.source === id) continue;
        const sourceX = xOf(edge.source);
        if (sourceX === undefined) continue;
        x = Math.max(x, sourceX + width(edge.source) + FORMAT_GAP_X - offset);
      }
    }
    xs.set(id, Number.isFinite(x) ? x : origin.x);
  }
  for (const row of execRows(tree)) {
    let y = origin.y;
    if (layout.boxes.length > 0) {
      const parent = row.parent;
      let left = parent !== undefined ? xs.get(parent)! + width(parent) : Infinity;
      let right = -Infinity;
      for (const id of row.nodes) {
        left = Math.min(left, xs.get(id)! - blocks.get(id)!.left);
        right = Math.max(right, xs.get(id)! + width(id));
      }
      let bottom = -Infinity;
      for (const list of [layout.boxes, layout.lanes]) {
        for (const box of list) {
          if (box.x >= right || box.x + box.width <= left) continue;
          bottom = Math.max(bottom, box.y + box.height);
        }
      }
      if (Number.isFinite(bottom)) y = Math.max(y, bottom + FORMAT_GAP_Y);
    }
    for (const id of row.nodes) addBox(layout, id, placed.get(id) ?? { x: xs.get(id)!, y });
    // The exec wire into a branch row runs level from beside its parent: later rows keep clear.
    if (row.parent !== undefined) {
      const first = row.nodes[0]!;
      const edge = graph.execEdges.find((entry) => entry.source === row.parent && entry.target === first);
      const at = layout.positions.get(first)!;
      const from = xs.get(row.parent)! + width(row.parent);
      layout.lanes.push({
        x: from,
        y: at.y + pinY(graph.byId.get(first)!, "in", edge?.targetHandle),
        width: at.x - from,
        height: 0,
      });
    }
    for (const id of row.nodes) placeBlock(layout, id, blocks.get(id)!);
  }
}

type LaneGraph = {
  nodes: FormatNode[];
  edges: FormatEdge[];
  /** The knot each direct wire stands for. */
  knotOf: Map<FormatEdge, string>;
};

/**
 * A lane knot is a Reroute (data or exec) with one wire in and one out, into a node that is not a knot.
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
    if (!node.reroute) continue;
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

function insertObstacle(obstacles: Obstacles, box: Obstacle): void {
  let index = obstacles.boxes.findIndex((other) => other.x > box.x);
  if (index < 0) index = obstacles.boxes.length;
  obstacles.boxes.splice(index, 0, box);
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
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    const x = a * from.x + b * first.x + c * second.x + d * to.x;
    // first.y is from.y and second.y is to.y: written this way a level wire stays exactly level.
    const y = from.y + (to.y - from.y) * (c + d);
    const hit = near.find(
      (box) =>
        x > box.x - clearance &&
        x < box.x + box.width + clearance &&
        y > box.y - clearance &&
        y < box.y + box.height + clearance,
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
 * A knot that carries the wire around the nodes in its way. Spots are tried level with the target
 * pin, then just above and just below the first box in the way; along each, at the preferred X
 * (an exec branch's lane beside its parent), the left edge of the first box in the way, the left
 * edges of later boxes, and last as near the target as the gaps allow. A spot is taken only if both
 * halves of the wire keep `WIRE_CLEARANCE` from every other box and the knot fits there. At most
 * 3 × (boxes in the wire's X range + 2) spots, each two wire tests.
 */
function knotAround(
  blocked: Box,
  from: Point,
  to: Point,
  ends: readonly string[],
  size: Size,
  obstacles: Obstacles,
  knots: readonly Box[],
  preferred: readonly number[] = [],
): Position | undefined {
  const lowest = from.x + FORMAT_GAP_X;
  const highest = to.x - FORMAT_GAP_X - size.width;
  if (lowest > highest) return undefined;
  const lefts = [
    ...preferred,
    blocked.x,
    ...boxesAcross(obstacles, blocked.x, highest)
      .filter((box) => box.x > blocked.x && !ends.includes(box.id))
      .map((box) => box.x),
    highest,
  ];
  const clearance = 2 * WIRE_CLEARANCE;
  const lanes = [
    to.y,
    blocked.y - clearance - size.height / 2,
    blocked.y + blocked.height + clearance + size.height / 2,
  ];
  for (const lane of lanes) {
    const tried = new Set<number>();
    for (const left of lefts) {
      const x = Math.min(Math.max(left, lowest), highest);
      if (tried.has(x)) continue;
      tried.add(x);
      const at = { x, y: lane - size.height / 2 };
      if (
        !firstObstruction(from, { x, y: lane }, ends, obstacles) &&
        !firstObstruction({ x: x + size.width, y: lane }, to, ends, obstacles) &&
        !boxInTheWay({ ...at, ...size }, obstacles, knots)
      ) {
        return at;
      }
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
 * Carries each data or exec wire between two formatted nodes that runs through or crowds another
 * node around it with a knot (`knotAround`). Wires go in a fixed order (by their ends), so a second Format
 * places every knot where the first one did. Testing a wire costs O(log N + W + S·K): a binary
 * search, the boxes W in its X range and S samples against the K boxes also in its Y range. Only
 * a blocked wire tries knot spots, at most one per box in its X range, each two such tests.
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
  const placedKnots: Box[] = [];
  const exec = new Set(graph.execEdges);
  const wires = [...graph.dataEdges, ...graph.execEdges]
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
    // A curve that crowds a node reads as running into it; a level wire only needs to clear it,
    // and a knot could not make it any straighter.
    const crowding = from.y === to.y ? WIRE_CLEARANCE : WIRE_CROWDING;
    const blocked = firstObstruction(from, to, ends, obstacles, crowding);
    // An exec wire to a lower row drops in the lane beside its parent.
    const preferred = exec.has(edge) ? [from.x + FORMAT_GAP_X] : [];
    let at = blocked ? knotAround(blocked, from, to, ends, size, obstacles, placedKnots, preferred) : undefined;
    if (knotId) {
      at ??= knotBesideTarget(from, to, ends, size, obstacles, placedKnots);
      moved.set(knotId, at);
    } else if (at) {
      knots.push({ edge, position: at });
    } else {
      continue;
    }
    placedKnots.push({ ...at, ...size });
    // Later wires route around this knot like around a node.
    insertObstacle(obstacles, { id: `\u0000knot${placedKnots.length}`, ...at, ...size });
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
    layoutChain(group, graph, positions, knotSize.width);
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
