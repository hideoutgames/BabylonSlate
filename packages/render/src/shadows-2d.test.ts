import { describe, expect, it } from "vitest";
import { occluderContains, polarShadow2D, shadow2DBinAngle, SHADOW_2D_BINS, type WorldOccluder2D } from "./shadows-2d";

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

/**
 * The ring as it was computed before segments were sorted by direction: every segment of every caster in reach
 * tested against every direction. Kept here, word for word, as the reference the sorted version must reproduce.
 */
function polarShadow2DTestingEverySegment(x: number, y: number, radius: number, occluders: readonly WorldOccluder2D[], out: Float32Array): void {
  const casters: WorldOccluder2D[] = [];
  for (const occluder of occluders) {
    if (occluder.maxX < x - radius || occluder.minX > x + radius || occluder.maxY < y - radius || occluder.minY > y + radius) continue;
    if (occluderContains(occluder, x, y)) continue;
    casters.push(occluder);
  }
  const insideFlags = new Uint8Array(casters.length + 1);
  const shadowStart = (dx: number, dy: number): number => {
    const hits: Array<{ t: number; caster: number }> = [];
    for (let caster = 0; caster < casters.length; caster++) {
      const occluder = casters[caster]!;
      const points = occluder.points;
      const count = points.length / 2;
      const segments = occluder.closed ? count : count - 1;
      for (let index = 0; index < segments; index++) {
        const ax = points[index * 2]!, ay = points[index * 2 + 1]!;
        const next = (index + 1) % count;
        const ex = points[next * 2]! - ax, ey = points[next * 2 + 1]! - ay;
        const denominator = dx * ey - dy * ex;
        if (Math.abs(denominator) < 1e-12) continue;
        const ox = ax - x, oy = ay - y;
        const t = (ox * ey - oy * ex) / denominator;
        const u = (ox * dy - oy * dx) / denominator;
        if (t <= 1e-6 || t > radius || u < 0 || u >= 1) continue;
        hits.push({ t, caster });
      }
    }
    if (!hits.length) return radius;
    hits.sort((a, b) => a.t - b.t);
    insideFlags.fill(0, 0, casters.length);
    let solid = 0;
    let entered = false;
    for (let start = 0; start < hits.length;) {
      let end = start + 1;
      while (end < hits.length && hits[end]!.t - hits[start]!.t < 1e-6) end++;
      for (let index = start; index < end; index++) {
        const caster = hits[index]!.caster;
        if (!casters[caster]!.closed) {
          if (solid === 0) return hits[index]!.t;
          continue;
        }
        if (insideFlags[caster] === 0) { insideFlags[caster] = 2; solid++; entered = true; }
      }
      for (let index = start; index < end; index++) {
        const caster = hits[index]!.caster;
        if (!casters[caster]!.closed) continue;
        if (insideFlags[caster] === 1) { insideFlags[caster] = 0; solid--; }
        else if (insideFlags[caster] === 2) insideFlags[caster] = 1;
      }
      if (entered && solid === 0) return hits[start]!.t;
      start = end;
    }
    return radius;
  };
  for (let bin = 0; bin < SHADOW_2D_BINS; bin++) {
    const angle = shadow2DBinAngle(bin);
    out[bin] = casters.length ? shadowStart(Math.cos(angle), Math.sin(angle)) / radius : 1;
  }
}

/** A small seeded generator (mulberry32), so every run draws the same scenes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The reference tests every segment for every direction, which is slow under coverage instrumentation. */
const REFERENCE_TIMEOUT_MS = 30_000;

describe("polarShadow2D against testing every segment for every direction", () => {
  const expectSameRing = (label: string, x: number, y: number, radius: number, occluders: WorldOccluder2D[]) => {
    const ring = new Float32Array(SHADOW_2D_BINS).fill(-7);
    const reference = new Float32Array(SHADOW_2D_BINS).fill(-9);
    polarShadow2D(x, y, radius, occluders, ring);
    polarShadow2DTestingEverySegment(x, y, radius, occluders, reference);
    for (let bin = 0; bin < SHADOW_2D_BINS; bin++) {
      if (!Object.is(ring[bin], reference[bin])) throw new Error(`${label}: bin ${bin} is ${ring[bin]}, expected ${reference[bin]}`);
    }
  };

  it("gives the identical ring over seeded random scenes of boxes, turned polygons and open chains", () => {
    const random = seeded(20261116);
    const between = (low: number, high: number) => low + random() * (high - low);
    let shadowedBins = 0;
    for (let scene = 0; scene < 200; scene++) {
      const occluders: WorldOccluder2D[] = [];
      const count = 1 + Math.floor(random() * 40);
      for (let at = 0; at < count; at++) {
        const cx = between(-30, 30), cy = between(-30, 30);
        const kind = random();
        if (kind < 0.4) {
          const w = between(0.2, 4), h = between(0.2, 4);
          occluders.push(box(cx, cy, cx + w, cy + h));
        } else {
          // A polygon (or, open, a chain of walls) of 2 to 7 points round (cx, cy).
          const corners = 2 + Math.floor(random() * 6);
          const turn = between(0, Math.PI * 2);
          const points: number[] = [];
          for (let corner = 0; corner < corners; corner++) {
            const angle = turn + (corner / corners) * Math.PI * 2;
            const reach = between(0.3, 5);
            points.push(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
          }
          occluders.push(outline(kind < 0.8 && corners > 2, points));
        }
      }
      const radius = scene % 7 === 0 ? between(0.05, 2) : between(4, 60);
      expectSameRing(`scene ${scene}`, between(-25, 25), between(-25, 25), radius, occluders);
      const ring = new Float32Array(SHADOW_2D_BINS);
      polarShadow2D(0, 0, 40, occluders, ring);
      shadowedBins += ring.filter((value) => value < 1).length;
    }
    // The scenes do cast shadows: the comparison is not of empty rings.
    expect(shadowedBins).toBeGreaterThan(10_000);
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring for a tile grid lit from its own lines, corners, edges and far outside", () => {
    // Unit tiles on whole coordinates, as a Tilemap's merged solids: touching neighbours, shared vertices and
    // edges exactly in line with the light.
    const random = seeded(7);
    const tiles: WorldOccluder2D[] = [];
    for (let tx = -8; tx < 8; tx++) for (let ty = -8; ty < 8; ty++) if (random() < 0.35) tiles.push(box(tx, ty, tx + 1, ty + 1));
    tiles.push(outline(false, [-8, -9, 8, -9]), outline(false, [3, 3, 3, 3]), outline(true, [5, 5]), outline(false, []));
    const places: Array<[number, number]> = [];
    for (let px = -9; px <= 9; px += 6) for (let py = -9; py <= 9; py += 6) places.push([px, py], [px + 0.5, py], [px + 2, py + 1.5], [px + 1.25, py + 0.75]);
    for (const [px, py] of places) {
      for (const radius of [0.5, 3, 40]) expectSameRing(`light (${px}, ${py}) radius ${radius}`, px, py, radius, tiles);
    }
    // A degenerate radius, a light a long way off, and casters beyond the distance directions are sorted within.
    expectSameRing("zero radius", 0.5, 0.5, 0, tiles);
    expectSameRing("far light", 30_000, 12_000, 60_000, tiles);
    const far = [box(20_000, -1, 20_001, 1), box(-50_000, 3, -49_990, 4), outline(false, [1, -5, 1, 5])];
    expectSameRing("far casters", 0, 0, 100_000, far);
    expectSameRing("unplaced caster", 0, 0, 10, [box(2, -1, 3, 1), outline(true, [Number.NaN, 0, 4, 1, 4, -1]), outline(false, [Infinity, 2, 5, 2])]);
  }, REFERENCE_TIMEOUT_MS);

  it("tests a caster only in the directions around it", () => {
    // A small box 8 units to the right: it spans about 14° of the ring (20 of 512 directions).
    const caster = box(8, -1, 9, 1);
    let reads = 0;
    const points = caster.points;
    Object.defineProperty(caster, "points", { get: () => (reads++, points) });
    const ring = new Float32Array(SHADOW_2D_BINS);
    polarShadow2D(0, 0, 20, [caster], ring);
    // Each of its four segments is read where its directions are (and round its own line), not once per direction.
    expect(reads).toBeLessThan(160);
    expect(ring.filter((value) => value < 1).length).toBe(20);
    expect(Number(ring[SHADOW_2D_BINS / 2]!.toFixed(2))).toBe(0.45);
  });
});
