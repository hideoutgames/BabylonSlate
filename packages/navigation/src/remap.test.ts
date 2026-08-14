import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recastToWorld, worldToRecast } from "./remap";

const finite = fc.float({ noNaN: true, noDefaultInfinity: true });

describe("2D XY ↔ Recast XZ remap", () => {
  it("maps world XY onto Recast XZ with Y up", () => {
    expect(worldToRecast({ x: 3, y: 7, z: 99 })).toEqual({ x: 3, y: 0, z: 7 });
  });

  it("maps Recast XZ back onto world XY", () => {
    expect(recastToWorld({ x: 3, y: 1.5, z: 7 })).toEqual({ x: 3, y: 7, z: 0 });
  });

  it("round-trips finite world XY ignoring world Z", () => {
    fc.assert(
      fc.property(finite, finite, finite, (x, y, z) => {
        const back = recastToWorld(worldToRecast({ x, y, z }));
        expect(back.x).toBe(x);
        expect(back.y).toBe(y);
        expect(back.z).toBe(0);
      }),
    );
  });
});
