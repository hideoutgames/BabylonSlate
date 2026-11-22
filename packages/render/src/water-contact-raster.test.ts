import { describe, expect, it } from "vitest";
import {
  contactRasterReach, contactRasterTarget, contactSmoothRadius, rasterContactWindow, WATER_CONTACT_LAYER_OFFSETS,
  type ContactRasterGrid, type ContactRasterPiece, type ContactWindow,
} from "./water-contact-raster";

/** A closed polygon section per layer: a cone of radius `radius(k)` around (cx, cz), as segments x0, z0, x1, z1. */
function cone(cx: number, cz: number, radius: (layer: number) => number, sides = 48): ContactRasterPiece {
  const contours = WATER_CONTACT_LAYER_OFFSETS.map((_, k) => {
    const r = radius(k), segments: number[] = [];
    // Shared corners computed once, so the section closes exactly.
    const corners = Array.from({ length: sides }, (_, i) => [cx + Math.cos(i / sides * Math.PI * 2) * r, cz + Math.sin(i / sides * Math.PI * 2) * r]);
    for (let i = 0; i < sides; i++) segments.push(...corners[i]!, ...corners[(i + 1) % sides]!);
    return new Float64Array(segments);
  });
  return { contours, closed: contours.map(() => true), triangles: new Float64Array() };
}

/** An open plank: one section per layer (a line), plus two sloped triangles near the waterline. */
function plank(x0: number, z0: number, x1: number, z1: number): ContactRasterPiece {
  const contours = WATER_CONTACT_LAYER_OFFSETS.map((_, k) => new Float64Array([x0, z0 + k * 0.05, x1, z1 + k * 0.05]));
  const triangles = new Float64Array([
    x0, -0.05, z0, x1, 0.12, z1, x1, 0.08, z1 + 0.6,
    x0, -0.05, z0, x1, 0.08, z1 + 0.6, x0, -0.1, z0 + 0.6,
  ]);
  return { contours, closed: contours.map(() => false), triangles };
}

/** World bounds of a piece's sections and triangles, as `WaterContactField` keeps them to filter by reach. */
function boundsOf(piece: ContactRasterPiece): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const segments of piece.contours) for (let i = 0; i < segments.length; i += 2) {
    minX = Math.min(minX, segments[i]!); maxX = Math.max(maxX, segments[i]!); minZ = Math.min(minZ, segments[i + 1]!); maxZ = Math.max(maxZ, segments[i + 1]!);
  }
  for (let i = 0; i < piece.triangles.length; i += 3) {
    minX = Math.min(minX, piece.triangles[i]!); maxX = Math.max(maxX, piece.triangles[i]!);
    minZ = Math.min(minZ, piece.triangles[i + 2]!); maxZ = Math.max(maxZ, piece.triangles[i + 2]!);
  }
  return { minX, minZ, maxX, maxZ };
}

/** The whole allocation's texels, built as tiles of `tile` cells a side (each from the pieces within its reach). */
function tiled(grid: ContactRasterGrid, pieces: ContactRasterPiece[], tile: number): Uint8Array {
  const data = new Uint8Array(grid.width * grid.height * 4).fill(7);
  for (let z0 = 0; z0 < grid.height; z0 += tile) for (let x0 = 0; x0 < grid.width; x0 += tile) {
    const write: ContactWindow = { x0, z0, x1: Math.min(grid.width, x0 + tile), z1: Math.min(grid.height, z0 + tile) };
    const target = contactRasterTarget(grid, write), reach = contactRasterReach(grid, target);
    const near = pieces.filter((piece) => {
      const b = boundsOf(piece);
      return b.maxX >= reach.minX && b.minX <= reach.maxX && b.maxZ >= reach.minZ && b.minZ <= reach.maxZ;
    });
    const out = new Uint8Array((write.x1 - write.x0) * (write.z1 - write.z0) * 4);
    rasterContactWindow({ ...grid, target, write, pieces: near }, out);
    const row = (write.x1 - write.x0) * 4;
    for (let z = write.z0; z < write.z1; z++) data.set(out.subarray((z - write.z0) * row, (z - write.z0 + 1) * row), (z * grid.width + write.x0) * 4);
  }
  return data;
}

describe("Water contact raster", () => {
  // Two bodies close enough that their distances meet (the rounded crease), a plank between them, and open water
  // far from all of them, which tiles without any piece in reach fill without filtering.
  const pieces = [cone(4, 4, (k) => 1.6 - k * 0.3), cone(8.2, 5, (k) => 1.2 - k * 0.2), plank(5.5, 8, 9.5, 9.4)];

  for (const range of [1, 3]) {
    it(`builds the same bytes in tiles of any size as in one window (range ${range} m)`, () => {
      const cell = 0.06;
      const grid: ContactRasterGrid = {
        width: 300, height: 230, rectMinX: -1.2, rectMinZ: -0.6, cell, range, amplitude: 0.3, smoothRadius: contactSmoothRadius(range, cell),
      };
      const everything = { x0: 0, z0: 0, x1: grid.width, z1: grid.height };
      const whole = new Uint8Array(grid.width * grid.height * 4);
      rasterContactWindow({ ...grid, target: everything, write: everything, pieces }, whole);
      // The fixture meets the water: some texels are inside, some on a waterline, some far.
      expect(whole.some((value) => value < 100)).toBe(true);
      expect(whole.some((value) => value > 120 && value < 135)).toBe(true);
      expect(whole.some((value) => value === 255)).toBe(true);
      // The main thread's blocks, the worker's larger ones, and an odd size that cuts every feature somewhere.
      for (const tile of [64, 256, 37]) {
        const built = tiled(grid, pieces, tile);
        let differing = 0;
        for (let i = 0; i < whole.length; i++) if (built[i] !== whole[i]) differing++;
        expect(differing, `${tile}-cell tiles`).toBe(0);
      }
    });
  }

  it("writes only the write window, as rows of its own width, all far where no piece is in reach", () => {
    const grid: ContactRasterGrid = { width: 40, height: 30, rectMinX: 0, rectMinZ: 0, cell: 0.1, range: 1, amplitude: 0.3, smoothRadius: contactSmoothRadius(1, 0.1) };
    const write = { x0: 5, z0: 4, x1: 12, z1: 9 };
    const out = new Uint8Array(7 * 5 * 4 + 8).fill(3);
    rasterContactWindow({ ...grid, target: contactRasterTarget(grid, write), write, pieces: [] }, out);
    expect(Array.from(out.subarray(0, 7 * 5 * 4)).every((value) => value === 255)).toBe(true);
    expect(Array.from(out.subarray(7 * 5 * 4))).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    // A post at the window's corner: its waterline (0.5, 128) lies within the window's rows, at its own offset.
    const post = cone(0.85, 0.65, () => 0.2);
    rasterContactWindow({ ...grid, target: contactRasterTarget(grid, write), write, pieces: [post] }, out);
    // Cell (5, 4)'s centre (0.55, 0.45) is about 0.15 m outside the 0.2 m post: just over the waterline.
    expect(out[0]).toBeGreaterThan(128);
    expect(out[0]).toBeLessThan(128 + 0.25 * 127);
    // Cell (8, 6), the post's centre, is inside on every layer.
    for (let k = 0; k < 4; k++) expect(out[(2 * 7 + 3) * 4 + k]).toBeLessThan(128);
  });
});
