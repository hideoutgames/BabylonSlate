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

  it("lets the earlier caster take a crossing it shares exactly with a later one", () => {
    // A wall along a box's near edge, drawn the same way round, crosses each ray at the very same distance.
    const wall = outline(false, [2, 0.5, 2, -0.5]);
    const solid = box(2, -0.5, 3, 0.5);
    // The box first: the ray is inside solid when it meets the wall, so shadow starts where it leaves the box.
    expect(along([solid, wall], 0)).toBe(0.3);
    // The wall first: shadow starts at the wall.
    expect(along([wall, solid], 0)).toBe(0.2);
    // And whatever else crosses the ray nearer or farther keeps that order.
    expect(along([box(6, -1, 7, 1), solid, outline(false, [8, -1, 8, 1]), wall], 0)).toBe(0.3);
    expect(along([box(6, -1, 7, 1), wall, outline(false, [8, -1, 8, 1]), solid], 0)).toBe(0.2);
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
    expectSameRing("negative radius", 0.5, 0.5, -3, tiles);
    expectSameRing("NaN radius", 0.5, 0.5, Number.NaN, tiles);
    expectSameRing("far light", 30_000, 12_000, 60_000, tiles);
    const far = [box(20_000, -1, 20_001, 1), box(-50_000, 3, -49_990, 4), outline(false, [1, -5, 1, 5])];
    expectSameRing("far casters", 0, 0, 100_000, far);
    expectSameRing("unplaced caster", 0, 0, 10, [box(2, -1, 3, 1), outline(true, [Number.NaN, 0, 4, 1, 4, -1]), outline(false, [Infinity, 2, 5, 2])]);
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring for segments on and just past the edge of the light's reach", () => {
    // Walls and boxes with an edge at the radius, at the margin the bucketing leaves out beyond, and either side of
    // both by a little; lights on whole, half and arbitrary coordinates with whole, half and arbitrary radii.
    const lights: Array<[number, number, number]> = [
      [0, 0, 10], [0, 0, 1], [3, -2, 2.5], [0.5, 0.5, 0.5], [-7.5, 2, 7], [1000.25, -2000.5, 3.5], [1.3, 2.7, 4.2], [0, 0, 1e-3],
    ];
    const offsets = [-1e-6, -1e-9, -1e-12, 0, 1e-12, 5e-10, 1e-9, 1.5e-9, 2e-9, 1e-8, 1e-6, 1e-3];
    let shadowedBins = 0;
    for (const [lx, ly, radius] of lights) {
      const edge = radius * (1 + 1e-9) + 1e-9;
      const reaches = [radius, edge, radius * (1 + 1e-9), ...offsets.map((offset) => radius + offset), ...offsets.map((offset) => edge + offset)];
      const occluders: WorldOccluder2D[] = [];
      for (const reach of reaches) {
        // On each side: a wall across the light's square, a wall from just past it outwards, a box with a face there,
        // and a slanted wall from the face out and back in.
        for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const at = (along: number, across: number): [number, number] =>
            sx ? [lx + sx * along, ly + across] : [lx + across, ly + sy * along];
          occluders.push(outline(false, [...at(reach, -2 * radius), ...at(reach, 2 * radius)]));
          occluders.push(outline(false, [...at(reach, 0.01 * radius), ...at(reach * 3, 0.5 * radius)]));
          const [x0, y0] = at(reach, -0.3 * radius), [x1, y1] = at(reach + radius, 0.3 * radius);
          occluders.push(box(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)));
          occluders.push(outline(false, [...at(reach, 0.7 * radius), ...at(reach * 2, 0.9 * radius), ...at(reach * 0.5, 0.3 * radius)]));
        }
      }
      // Each wall alone, so nothing nearer hides a crossing at the edge, and all of them together.
      occluders.forEach((occluder, at) => expectSameRing(`light (${lx}, ${ly}) radius ${radius}, edge caster ${at}`, lx, ly, radius, [occluder]));
      expectSameRing(`light (${lx}, ${ly}) radius ${radius}, every edge caster`, lx, ly, radius, occluders);
      const ring = new Float32Array(SHADOW_2D_BINS);
      polarShadow2D(lx, ly, radius, occluders, ring);
      shadowedBins += ring.filter((value) => value < 1).length;
    }
    // The slanted walls come back within the radius: the edges are compared beside real shadow.
    expect(shadowedBins).toBeGreaterThan(100);
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring for a segment past the edge lying nearly along a ray, which that ray's arithmetic can still cross within the radius", () => {
    // A wall from just past the light's square outwards, turned a hair off a direction's ray about a point just short
    // of the radius on it: the crossing is ill-conditioned, and the reference accepts some inside the radius.
    const random = seeded(31);
    let crossedInside = 0;
    let count = 0;
    for (const bin of [255, 256, 127, 128, 383, 384, 0, 511, 64, 320]) {
      const angle = shadow2DBinAngle(bin);
      for (const radius of [10, 1, 100, 0.5, 3.5]) {
        for (let at = 0; at < 60; at++) {
          const turn = angle + (random() - 0.5) * 10 ** (-11 - random() * 5);
          const dx = Math.cos(turn), dy = Math.sin(turn);
          const reach = radius * (1 - 10 ** (-4 - random() * 5));
          const px = Math.cos(angle) * reach, py = Math.sin(angle) * reach;
          const edge = radius * (1 + 1e-9) + 1e-9 + random() * 4e-9;
          const xFace = Math.abs(dx) > Math.abs(dy);
          const start = xFace ? (Math.sign(dx) * edge - px) / dx : (Math.sign(dy) * edge - py) / dy;
          const length = 10 ** (random() * 3.5);
          const ax = px + dx * start, ay = py + dy * start, bx = px + dx * (start + length), by = py + dy * (start + length);
          // Led in from outside the square too, so the caster's bounds reach the light and it is not skipped whole.
          const lead = xFace ? [-5 * radius, 5 * radius, ax, 5 * radius] : [5 * radius, -5 * radius, 5 * radius, ay];
          const caster = outline(false, [...lead, ax, ay, bx, by]);
          const reference = new Float32Array(SHADOW_2D_BINS);
          polarShadow2DTestingEverySegment(0, 0, radius, [caster], reference);
          if (reference.some((value) => value < 1)) crossedInside++;
          expectSameRing(`near-parallel wall ${count++}`, 0, 0, radius, [caster]);
        }
      }
    }
    // The case the bucketing keeps such a segment for does happen.
    expect(crossedInside).toBeGreaterThan(5);
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring for a long chain through the radius", () => {
    const wavy: number[] = [], straight: number[] = [], radial: number[] = [];
    for (let at = 0; at <= 5000; at++) {
      wavy.push(-2500 + at, 3 + Math.sin(at * 0.7) * 0.4);
      straight.push(-2500 + at, 0.5);
      // In line with the light at the origin, from far behind it to far ahead.
      radial.push((at - 2500) * 0.6, (at - 2500) * 0.8);
    }
    const chains = [outline(false, wavy), outline(false, straight), outline(false, radial)];
    for (const [lx, ly] of [[0, 0], [10, 1], [0.5, 0.5], [-3, 2.25], [2400, 3]] as const) {
      for (const radius of [12, 4, 0.75]) {
        for (const chain of chains) expectSameRing(`chain through (${lx}, ${ly}) radius ${radius}`, lx, ly, radius, [chain]);
      }
    }
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring for open chains along box edges, in either caster order", () => {
    // Tiles whose edges walls also run along, both ways round, listed before and after the tiles.
    const tiles: WorldOccluder2D[] = [];
    const walls: WorldOccluder2D[] = [];
    for (let tx = -4; tx < 4; tx += 2) for (let ty = -4; ty < 4; ty += 3) tiles.push(box(tx, ty, tx + 1, ty + 1));
    for (const tile of tiles) {
      walls.push(outline(false, [tile.minX, tile.maxY, tile.minX, tile.minY]));
      walls.push(outline(false, [tile.minX, tile.minY, tile.maxX, tile.minY]));
      walls.push(outline(false, [tile.maxX, tile.maxY, tile.maxX, tile.minY, tile.minX, tile.minY]));
    }
    for (const [lx, ly] of [[0, 0], [-5, -5], [0.5, -1.5], [5, 0.25], [-1.5, 6], [2.25, -0.75]] as const) {
      for (const radius of [3, 8, 15.5]) {
        expectSameRing(`tiles then walls from (${lx}, ${ly})`, lx, ly, radius, [...tiles, ...walls]);
        expectSameRing(`walls then tiles from (${lx}, ${ly})`, lx, ly, radius, [...walls, ...tiles]);
        expectSameRing(`interleaved from (${lx}, ${ly})`, lx, ly, radius, tiles.flatMap((tile, at) => [walls[at * 3]!, tile, walls[at * 3 + 1]!, walls[at * 3 + 2]!]));
      }
    }
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring for a light inside closed solids", () => {
    const holder = box(-1, -1, 1, 1), overlapping = box(-0.5, -2, 3, 0.5), around = outline(true, [-3, -3, 4, -2, 3, 5, -2, 3]);
    const outside = [box(2, -0.5, 3, 0.5), box(-6, 2, -4, 4), outline(false, [-2, -5, 4, -5]), box(1, 1, 2, 2)];
    for (const [lx, ly] of [[0, 0], [0.5, 0.5], [0.25, -0.25], [-0.5, 0]] as const) {
      for (const radius of [2, 6.5, 30]) {
        expectSameRing(`inside one (${lx}, ${ly})`, lx, ly, radius, [holder, ...outside]);
        expectSameRing(`inside two (${lx}, ${ly})`, lx, ly, radius, [...outside, holder, overlapping]);
        expectSameRing(`inside three (${lx}, ${ly})`, lx, ly, radius, [around, holder, ...outside, overlapping]);
      }
    }
  }, REFERENCE_TIMEOUT_MS);

  it("gives the identical ring over thousands of small seeded scenes, unplaced casters among them", () => {
    const random = seeded(20261122);
    const between = (low: number, high: number) => low + random() * (high - low);
    /** Whole, half or arbitrary. */
    const grid = (low: number, high: number) => {
      const kind = random();
      const value = between(low, high);
      return kind < 0.3 ? Math.round(value) : kind < 0.6 ? Math.round(value * 2) / 2 : value;
    };
    let shadowedBins = 0;
    for (let scene = 0; scene < 3000; scene++) {
      const lx = grid(-6, 6), ly = grid(-6, 6);
      const radius = scene % 11 === 0 ? grid(0.25, 2) : grid(2, 14);
      const occluders: WorldOccluder2D[] = [];
      const count = 1 + Math.floor(random() * 10);
      for (let at = 0; at < count; at++) {
        const kind = random();
        const cx = grid(-14, 14), cy = grid(-14, 14);
        if (kind < 0.35) occluders.push(box(cx, cy, cx + grid(0.5, 4), cy + grid(0.5, 4)));
        else if (kind < 0.5) {
          // A segment with an end on or just past the light's square.
          const side = Math.floor(random() * 4);
          const reach = radius * (1 + 1e-9) + 1e-9 + [-1e-9, 0, 1e-9, 1e-6, between(0, 0.1)][Math.floor(random() * 5)]!;
          const along = between(-radius, radius);
          const end: [number, number] = side === 0 ? [lx + reach, ly + along] : side === 1 ? [lx - reach, ly + along] : side === 2 ? [lx + along, ly + reach] : [lx + along, ly - reach];
          occluders.push(outline(false, [...end, end[0] + between(-6, 6), end[1] + between(-6, 6)]));
        } else if (kind < 0.92) {
          const corners = 2 + Math.floor(random() * 5);
          const points: number[] = [];
          for (let corner = 0; corner < corners; corner++) points.push(grid(cx - 4, cx + 4), grid(cy - 4, cy + 4));
          occluders.push(outline(kind < 0.7 && corners > 2, points));
        } else {
          // A caster with a point that is not finite, bounds round the light so it is not skipped.
          const points = [cx, cy, between(-8, 8), between(-8, 8), between(-8, 8), between(-8, 8)];
          points[Math.floor(random() * points.length)] = [Number.NaN, Infinity, -Infinity][Math.floor(random() * 3)]!;
          occluders.push({ closed: random() < 0.5, points: Float64Array.from(points), minX: -20, minY: -20, maxX: 20, maxY: 20 });
        }
      }
      expectSameRing(`small scene ${scene}`, lx, ly, radius, occluders);
      const ring = new Float32Array(SHADOW_2D_BINS);
      polarShadow2D(lx, ly, radius, occluders, ring);
      shadowedBins += ring.filter((value) => value < 1).length;
    }
    expect(shadowedBins).toBeGreaterThan(100_000);
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
