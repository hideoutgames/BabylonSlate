import { describe, expect, it } from "vitest";
import { occluder2DShapes } from "./occluder-2d";
import type { ColliderDesc } from "./types";

const collider = (shape: ColliderDesc["shape"], extra: Partial<ColliderDesc> = {}): ColliderDesc => ({
  id: "c", bodyId: "b", shape, friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 1, ...extra,
});
const rounded = (points: number[]) => points.map((value) => Math.round(value * 1000) / 1000 + 0);

describe("occluder2DShapes", () => {
  it("outlines a box in its body's frame, its local pose applied", () => {
    const [box] = occluder2DShapes([collider({ kind: "box2d", halfExtents: { x: 1, y: 0.5 } }, {
      translation: { x: 3, y: 1, z: 0 },
      // A quarter turn about Z.
      rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
    })]);
    expect(box!.closed).toBe(true);
    expect(rounded(box!.points)).toEqual([3.5, 0, 3.5, 2, 2.5, 2, 2.5, 0]);
  });

  it("keeps a chain open unless it loops, and draws a circle as a closed ring", () => {
    const shapes = occluder2DShapes([
      collider({ kind: "chain", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }),
      collider({ kind: "chain", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], loop: true }),
      collider({ kind: "circle", radius: 2 }),
    ]);
    expect(shapes.map((shape) => shape.closed)).toEqual([false, true, true]);
    expect(shapes[2]!.points.length).toBe(32);
    expect(rounded(shapes[2]!.points.slice(0, 2))).toEqual([2, 0]);
  });

  it("casts nothing for a trigger, a 3D shape or a degenerate chain", () => {
    expect(occluder2DShapes([
      collider({ kind: "box2d", halfExtents: { x: 1, y: 1 } }, { isTrigger: true }),
      collider({ kind: "box", halfExtents: { x: 1, y: 1, z: 1 } }),
      collider({ kind: "chain", points: [{ x: 0, y: 0 }] }),
    ])).toEqual([]);
  });
});
