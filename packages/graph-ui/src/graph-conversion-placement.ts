import { FORMAT_GAP_X } from "./graph-format";
import { NODE_PLACEMENT_GAP } from "./graph-placement";

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** An existing node as placement sees it: its box at its measured size, else the pin-row estimate. */
export type ConversionPlacementNode = Box & {
  id: string;
  /** Has an exec pin (or unknown pins): it never moves unless it is the source itself, and then alone. */
  exec: boolean;
};

export type ConversionPlacementInput = {
  nodes: readonly ConversionPlacementNode[];
  /** Every wire, by its ends: the source's private feeders are found from them. */
  edges: ReadonlyArray<{ source: string; target: string }>;
  source: string;
  /** The source output pin's centre, in flow units. */
  sourcePoint: Point;
  target: string;
  /** The target input pin's centre, in flow units. */
  targetPoint: Point;
  /** The new node's size and its output pin's centre below its top edge. */
  converter: { width: number; height: number; outY: number };
  /** `nodeSnapGrid`; 0 or unset leaves positions unsnapped. */
  snapGrid?: number;
};

export type ConversionPlacement = {
  /** The converter's top-left. */
  position: Point;
  /** Existing nodes moved to make room: the source and the nodes that only feed it. */
  moves: ReadonlyArray<{ id: string; position: Point }>;
};

function boxesMeet(a: Box, b: Box, clearance: number): boolean {
  return (
    a.x < b.x + b.width + clearance &&
    b.x < a.x + a.width + clearance &&
    a.y < b.y + b.height + clearance &&
    b.y < a.y + a.height + clearance
  );
}

/**
 * Where "Convert to <Type>" puts the converter between `source` and `target`, so the three read left to right with
 * forward wires and the converter's output level with the target pin:
 *
 * 1. When the gap between the source's right edge and the target's left edge holds the converter plus `FORMAT_GAP_X`
 *    on each side, it goes in the middle of that gap and nothing moves.
 * 2. Otherwise, when the source is wholly left of the target, the converter goes one gap left of the target and the
 *    source moves left by the shortfall, with the nodes that only feed it (upstream nodes whose every wire stays inside
 *    the set and that have no exec pin; an exec source starts alone) and, transitively, every other node a moving
 *    node would come within `NODE_PLACEMENT_GAP` of (and was not already that close beside). All of them move by the same
 *    amount, so their layout is kept; the source's other wires stretch.
 * 3. When the source is not wholly left of the target, or the push would reach the target or a node whose left edge
 *    is at or right of the converter's slot, nothing moves: the converter goes one gap left of the target.
 *
 * In every case the converter is then pushed straight down, never up, to the first spot clear of every node.
 * With a snap grid the converter lands on it and moved nodes move by a whole number of grid cells.
 *
 * Cost: O(nodes + edges) to find the feeders; O(nodes log nodes) to sort the boxes by their left edge, then per moved
 * node a binary search plus the boxes whose left edge lies in the x band it sweeps through, so
 * O((moved + pushed) × (log nodes + band)); O(nodes log nodes) to push the converter down.
 */
export function placeConversion({
  nodes,
  edges,
  source,
  sourcePoint,
  target,
  targetPoint,
  converter,
  snapGrid = 0,
}: ConversionPlacementInput): ConversionPlacement {
  const grid = snapGrid > 0 ? snapGrid : 0;
  const snap = (value: number, mode: "round" | "floor" | "ceil") =>
    grid ? Math[mode](value / grid) * grid : value;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const from = source === target ? undefined : byId.get(source);
  const targetLeft = byId.get(target)?.x ?? targetPoint.x;
  const levelY = snap(targetPoint.y - converter.outY, "round");
  const besideTarget = targetLeft - FORMAT_GAP_X - converter.width;
  const below = (x: number, boxes: readonly Box[]): Point => ({
    x,
    y: firstClearY(x, levelY, converter, boxes, (value) => snap(value, "ceil")),
  });

  const sourceRight = from ? from.x + from.width : sourcePoint.x;
  if (!from || sourceRight > targetLeft) return { position: below(snap(besideTarget, "floor"), nodes), moves: [] };

  const fitsLeft = sourceRight + FORMAT_GAP_X;
  if (besideTarget >= fitsLeft) {
    return { position: below(snapWithin((fitsLeft + besideTarget) / 2, fitsLeft, besideTarget, grid), nodes), moves: [] };
  }

  const x = snap(besideTarget, "floor");
  const shift = snap(fitsLeft - x, "ceil");
  const fixed = (node: ConversionPlacementNode) => node.id === target || node.x >= x;
  const moved = pushedLeft(nodes, byId, privateFeeders(from, target, byId, edges), shift, fixed);
  if (!moved) return { position: below(x, nodes), moves: [] };
  const moves = [...moved].map((id) => {
    const node = byId.get(id)!;
    return { id, position: { x: node.x - shift, y: node.y } };
  });
  const shifted = nodes.map((node) => (moved.has(node.id) ? { ...node, x: node.x - shift } : node));
  return { position: below(x, shifted), moves };
}

/**
 * `start` plus every node it pushes when the set moves `shift` left: a node joins when a moving box would come within
 * `NODE_PLACEMENT_GAP` of it and was not already that close beside it (above or below), and then pushes in turn. Null when it would push a node
 * `fixed` keeps in place. Each node joins at most once, so there are at most `nodes.length` rounds; each round
 * binary-searches the boxes sorted by left edge for the band its box sweeps through.
 */
function pushedLeft(
  nodes: readonly ConversionPlacementNode[],
  byId: ReadonlyMap<string, ConversionPlacementNode>,
  start: ReadonlySet<string>,
  shift: number,
  fixed: (node: ConversionPlacementNode) => boolean,
): Set<string> | null {
  const gap = NODE_PLACEMENT_GAP;
  const sorted = [...nodes].sort((a, b) => a.x - b.x);
  const widest = sorted.reduce((most, node) => Math.max(most, node.width), 0);
  const firstAtOrRightOf = (value: number) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle]!.x < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const moved = new Set(start);
  const order = [...start];
  for (let round = 0; round < order.length; round++) {
    if (round >= nodes.length) throw new Error("placeConversion: a push joined more nodes than the graph holds");
    const node = byId.get(order[round]!)!;
    const after = { ...node, x: node.x - shift };
    // A box it can meet starts within the sweep from its new left edge (less the widest box) to its old right edge.
    for (
      let index = firstAtOrRightOf(after.x - gap - widest);
      index < sorted.length && sorted[index]!.x < node.x + node.width + gap;
      index++
    ) {
      const other = sorted[index]!;
      // A neighbour already that close above or below stays alongside as the box slides left; one wholly to its left
      // would be run into, however close it already was.
      const alongside = boxesMeet(node, other, gap) && other.x + other.width > node.x;
      if (moved.has(other.id) || alongside || !boxesMeet(after, other, gap)) continue;
      if (fixed(other)) return null;
      moved.add(other.id);
      order.push(other.id);
    }
  }
  return moved;
}

/**
 * The source and the upstream nodes that exist only to feed it: a node joins once every one of its outgoing wires
 * ends inside the set. Nodes with an exec pin never join, and an exec source moves alone. O(nodes + edges).
 */
function privateFeeders(
  source: ConversionPlacementNode,
  target: string,
  byId: ReadonlyMap<string, ConversionPlacementNode>,
  edges: ConversionPlacementInput["edges"],
): Set<string> {
  const moved = new Set([source.id]);
  if (source.exec) return moved;
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    const feeders = incoming.get(edge.target);
    if (feeders) feeders.push(edge.source);
    else incoming.set(edge.target, [edge.source]);
  }
  const queue = [source.id];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const feeder of incoming.get(id) ?? []) {
      const left = outgoing.get(feeder)! - 1;
      outgoing.set(feeder, left);
      const node = byId.get(feeder);
      if (left === 0 && node && !node.exec && feeder !== target && !moved.has(feeder)) {
        moved.add(feeder);
        queue.push(feeder);
      }
    }
  }
  return moved;
}

/** The nearest grid line to `value` inside `[low, high]`, else the nearest one. */
function snapWithin(value: number, low: number, high: number, grid: number): number {
  if (!grid) return value;
  const nearest = Math.round(value / grid) * grid;
  if (nearest >= low && nearest <= high) return nearest;
  const inside = nearest < low ? Math.ceil(low / grid) * grid : Math.floor(high / grid) * grid;
  return inside >= low && inside <= high ? inside : nearest;
}

/**
 * The first top at or below `top` where a box of `size` at `x` is clear of every box by `NODE_PLACEMENT_GAP`. The
 * boxes in its column are swept once by their tops: each push lands below every box met so far.
 */
function firstClearY(
  x: number,
  top: number,
  size: { width: number; height: number },
  boxes: readonly Box[],
  snapLower: (value: number) => number,
): number {
  const gap = NODE_PLACEMENT_GAP;
  const column = boxes
    .filter((box) => x < box.x + box.width + gap && box.x < x + size.width + gap)
    .sort((a, b) => a.y - b.y);
  let y = top;
  let index = 0;
  let lowest = -Infinity;
  for (;;) {
    while (index < column.length && column[index]!.y < y + size.height + gap) {
      const box = column[index]!;
      lowest = Math.max(lowest, box.y + box.height);
      index += 1;
    }
    if (lowest + gap <= y) return y;
    y = snapLower(lowest + gap);
  }
}
