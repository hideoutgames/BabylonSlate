import { describe, expect, it } from "vitest";
import { polarShadow2D, shadow2DBinAngle, SHADOW_2D_BINS, type WorldOccluder2D } from "./shadows-2d";

const outline = (closed: boolean, points: number[]): WorldOccluder2D => {
  const xs = points.filter((_, index) => index % 2 === 0), ys = points.filter((_, index) => index % 2 === 1);
  return { closed, points: Float64Array.from(points), minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};
const box = (x0: number, y0: number, x1: number, y1: number) => outline(true, [x0, y0, x1, y0, x1, y1, x0, y1]);

/** The ring value along world direction `angle` from a light at the origin. */
function along(occluders: WorldOccluder2D[], angle: number, radius = 10, from: [number, number] = [0, 0]): number {
  const ring = new Float32Array(SHADOW_2D_BINS);
  polarShadow2D(from[0], from[1], radius, occluders, ring);
  let best = 0;
  for (let bin = 1; bin < SHADOW_2D_BINS; bin++)
    if (Math.abs(shadow2DBinAngle(bin) - angle) < Math.abs(shadow2DBinAngle(best) - angle)) best = bin;
  return Number(ring[best]!.toFixed(3));
}

describe("polarShadow2D", () => {
  it("is unshadowed to the radius with nothing in reach", () => {
    expect(along([], 0)).toBe(1);
    expect(along([box(20, -1, 21, 1)], 0)).toBe(1);
  });

  it("lights a solid caster's own surface and shadows from where the ray leaves it", () => {
    // Enters at x = 2, leaves at x = 3: shadow starts at 3 of 10.
    expect(along([box(2, -0.5, 3, 0.5)], 0)).toBe(0.3);
    // The other way is clear.
    expect(along([box(2, -0.5, 3, 0.5)], Math.PI - 0.01)).toBe(1);
  });

  it("unions touching casters, as a tilemap's neighbouring solids are one block of rock", () => {
    expect(along([box(2, -0.5, 3, 0.5), box(3, -0.5, 4, 0.5)], 0)).toBe(0.4);
  });

  it("shadows from where the ray crosses an open chain, a thin wall", () => {
    expect(along([outline(false, [2, -1, 2, 1])], 0)).toBe(0.2);
  });

  it("ignores a caster that contains the light, as a lamp inside its holder's collider", () => {
    expect(along([box(-1, -1, 1, 1)], 0)).toBe(1);
    expect(along([box(-1, -1, 1, 1), box(5, -1, 6, 1)], 0)).toBe(0.6);
  });

  it("measures from the light's own position", () => {
    expect(along([box(2, -0.5, 3, 0.5)], 0, 10, [1, 0])).toBe(0.2);
  });
});
