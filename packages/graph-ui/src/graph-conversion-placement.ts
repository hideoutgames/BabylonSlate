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
 * 2. Otherwise, when the source is wholly left of the target, the source and the nodes that only feed it (its
 *    upstream nodes whose every wire stays inside that set and that have no exec pin; an exec source moves alone)
 *    move left by the shortfall, and the converter goes one gap left of the target. The source's other wires stretch.
 * 3. When that move would bring a moved node onto another node, the converter's spot would still be taken, or the
 *    source is not wholly left of the target, nothing moves: the converter goes one gap left of the target.
 *
 * In every case the converter is then pushed straight down, never up, to the first spot clear of every node.
 * With a snap grid, the converter and every moved node land on it, moved nodes going left by at least the shortfall.
 *
 * Cost: O(nodes + edges) to find the feeders, O(moved × nodes) to check the move, O(nodes log nodes) to push down.
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
  const shortfall = fitsLeft - x;
  const moved = privateFeeders(from, target, byId, edges);
  const moves = [...moved].map((id) => {
    const node = byId.get(id)!;
    return { id, position: { x: snap(node.x - shortfall, "floor"), y: snap(node.y, "round") } };
  });
  const after = new Map(moves.map(({ id, position }) => [id, { ...byId.get(id)!, ...position }]));
  const blocked = nodes.some(
    (other) =>
      !moved.has(other.id) &&
      moves.some(({ id }) => boxesMeet(after.get(id)!, other, NODE_PLACEMENT_GAP) && !boxesMeet(byId.get(id)!, other, NODE_PLACEMENT_GAP)),
  );
  const shifted = nodes.map((node) => after.get(node.id) ?? node);
  const spot = { x, y: levelY, width: converter.width, height: converter.height };
  if (blocked || shifted.some((node) => boxesMeet(spot, node, NODE_PLACEMENT_GAP))) {
    return { position: below(x, nodes), moves: [] };
  }
  return { position: { x, y: levelY }, moves };
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
