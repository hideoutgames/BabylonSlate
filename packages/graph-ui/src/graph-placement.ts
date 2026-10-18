import { graphNodeSize, type GraphVirtualizeNode } from "./graph-virtualize";

/** Clear space kept between a new node and its neighbours, in flow units. */
export const NODE_PLACEMENT_GAP = 24;
/** Slots searched on each side of the centre before the centre is used anyway. */
const SLOT_RADIUS = 8;

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/**
 * Top-left position for a new node of `size` centred on `center`. When that
 * spot is taken, the grid of footprint-sized slots around it is searched
 * nearest first (below, above, right, left, then outward) for one clear of
 * every existing node. Existing nodes count at their measured size, else the
 * pin-row estimate.
 */
export function freeNodePosition(
  center: Point,
  size: Size,
  existing: readonly GraphVirtualizeNode[],
): Point {
  const boxes = existing.map((node) => ({ ...node.position, ...graphNodeSize(node) }));
  const origin = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
  const stepX = size.width + NODE_PLACEMENT_GAP;
  const stepY = size.height + NODE_PLACEMENT_GAP;
  const isClear = ({ x, y }: Point) =>
    !boxes.some(
      (box) =>
        x < box.x + box.width + NODE_PLACEMENT_GAP &&
        box.x < x + size.width + NODE_PLACEMENT_GAP &&
        y < box.y + box.height + NODE_PLACEMENT_GAP &&
        box.y < y + size.height + NODE_PLACEMENT_GAP,
    );
  const slots: Array<{ column: number; row: number }> = [];
  for (let row = -SLOT_RADIUS; row <= SLOT_RADIUS; row++) {
    for (let column = -SLOT_RADIUS; column <= SLOT_RADIUS; column++) {
      slots.push({ column, row });
    }
  }
  const distance = ({ column, row }: { column: number; row: number }) =>
    Math.hypot(column * stepX, row * stepY);
  slots.sort(
    (a, b) => distance(a) - distance(b) || b.row - a.row || b.column - a.column,
  );
  for (const { column, row } of slots) {
    const slot = { x: origin.x + column * stepX, y: origin.y + row * stepY };
    if (isClear(slot)) return slot;
  }
  return origin;
}
