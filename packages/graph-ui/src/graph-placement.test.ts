import { describe, expect, it } from "vitest";
import { NODE_PLACEMENT_GAP, freeNodePosition } from "./graph-placement";

const size = { width: 320, height: 96 };

describe("freeNodePosition", () => {
  it("centres a node on the point when nothing is there", () => {
    expect(freeNodePosition({ x: 0, y: 0 }, size, [])).toEqual({ x: -160, y: -48 });
  });

  it("steps below a node that holds the centre", () => {
    const taken = [{ id: "a", position: { x: -160, y: -48 }, measured: size }];
    expect(freeNodePosition({ x: 0, y: 0 }, size, taken)).toEqual({
      x: -160,
      y: -48 + size.height + NODE_PLACEMENT_GAP,
    });
  });

  it("keeps a new node out of a covered area such as the one under the toolbar", () => {
    // The centre and the slot below it are taken, so the next nearest slot is the one above,
    // which a canvas overlay covers: the node goes beside the centre instead.
    const taken = [
      { id: "a", position: { x: -160, y: -48 }, measured: size },
      { id: "b", position: { x: -160, y: 72 }, measured: size },
    ];
    const above = { x: -160, y: -168 };
    expect(freeNodePosition({ x: 0, y: 0 }, size, taken)).toEqual(above);
    const covered = [{ x: -400, y: -260, width: 800, height: 120 }];
    const placed = freeNodePosition({ x: 0, y: 0 }, size, taken, covered);
    expect(placed).not.toEqual(above);
    expect(placed.y + size.height + NODE_PLACEMENT_GAP <= covered[0]!.y || placed.y >= covered[0]!.y + covered[0]!.height + NODE_PLACEMENT_GAP).toBe(true);
  });
});
