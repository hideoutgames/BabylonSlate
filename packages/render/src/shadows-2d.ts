/**
 * 2D light shadows: for each shadowed Point light, a ring of `SHADOW_2D_BINS` directions (a row of the Scene's 2D
 * shadow map), each holding where shadow starts along that direction as a share of the light's radius (1: none within
 * it). Casters are the solid outlines of 2D colliders, in world XY.
 *
 * Solid (closed) outlines union: a ray that enters solid is shadowed from where it next leaves all solid, so a
 * caster's own surface is lit and what lies behind it is not; an open chain is a thin wall, shadowed from where the ray
 * crosses it. An outline that contains the light casts nothing for it (a lamp carried inside its holder's collider).
 */

/** Directions per shadowed light. */
export const SHADOW_2D_BINS = 512;

/** A caster outline in world XY: flat XY pairs, and its bounds. */
export type WorldOccluder2D = {
  closed: boolean;
  points: Float64Array;
  minX: number; minY: number; maxX: number; maxY: number;
};

/** The world XY direction of bin `bin`'s centre: angles from -π, as `atan(y, x)` reads them. */
export function shadow2DBinAngle(bin: number): number {
  return ((bin + 0.5) / SHADOW_2D_BINS) * Math.PI * 2 - Math.PI;
}

/** Whether (x, y) lies inside a closed outline (even-odd). */
export function occluderContains(occluder: WorldOccluder2D, x: number, y: number): boolean {
  if (!occluder.closed || x < occluder.minX || x > occluder.maxX || y < occluder.minY || y > occluder.maxY) return false;
  const points = occluder.points;
  const count = points.length / 2;
  let inside = false;
  for (let index = 0, previous = count - 1; index < count; previous = index++) {
    const xi = points[index * 2]!, yi = points[index * 2 + 1]!;
    const xj = points[previous * 2]!, yj = points[previous * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type Hit = { t: number; caster: number };
const hits: Hit[] = [];
const hitPool: Hit[] = [];
let insideFlags = new Uint8Array(64);

/** Each bin's segments, as (caster, segment index) pairs in caster then segment order: bin `b`'s are `binStart[b]` to `binStart[b + 1]`. */
const binStart = new Int32Array(SHADOW_2D_BINS + 1);
const binFill = new Int32Array(SHADOW_2D_BINS);
let binCasters = new Int32Array(1024);
let binSegments = new Int32Array(1024);
/** The bins of the segment being sorted (`segmentBins`), and per bin the last segment that took it. */
const segmentBinList = new Int16Array(SHADOW_2D_BINS);
const binStamp = new Float64Array(SHADOW_2D_BINS);
let stampCounter = 0;
/** Past this distance from the light the rounding bound behind the bin margin no longer holds. */
const BUCKETED_REACH = 1e4;

/** The bin whose directions hold `angle` (radians, any turn). */
function binOfAngle(angle: number): number {
  const turns = (angle + Math.PI) / (Math.PI * 2);
  const bin = Math.floor((turns - Math.floor(turns)) * SHADOW_2D_BINS);
  // A fraction that rounds up to a whole turn belongs to the first bin.
  return bin >= 0 && bin < SHADOW_2D_BINS ? bin : 0;
}

/**
 * Lists in `segmentBinList` every bin whose ray can cross the segment from (ax, ay) to (bx, by), given relative to
 * the light, each once, and returns how many: a superset of the bins `shadowStart` finds a crossing in, so testing
 * a segment only for these gives the ring that testing it for every bin gives.
 *
 * A ray crosses a segment only in a direction between its two ends, the short way round, so the bins are those
 * holding the ends and the ones between, plus one bin either side. That leaves every other ray at least 1.5 bins
 * (0.018 rad) outside the segment's span, which covers what rounding can admit when:
 * - the ray is not nearly parallel to the segment, so the computed crossing lies within about 10⁻¹³ of the true one
 *   per unit of distance from the light: the bins around the segment's own direction, both ways, are always listed;
 * - the segment's ends are within `BUCKETED_REACH` of the light (crossings count from 10⁻⁶ out, so the angle that
 *   error subtends stays under a tenth of a bin) and finite: any other segment takes every bin;
 * - the short way round is decided: a segment whose ends are (nearly) opposite as seen from the light takes every bin.
 */
function segmentBins(ax: number, ay: number, bx: number, by: number): number {
  const from = Math.atan2(ay, ax);
  let sweep = Math.atan2(by, bx) - from;
  if (sweep > Math.PI) sweep -= Math.PI * 2;
  else if (sweep < -Math.PI) sweep += Math.PI * 2;
  const reach = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by));
  if (!(Math.abs(sweep) < Math.PI - 1e-6) || !(reach <= BUCKETED_REACH)) {
    for (let bin = 0; bin < SHADOW_2D_BINS; bin++) segmentBinList[bin] = bin;
    return SHADOW_2D_BINS;
  }
  const stamp = ++stampCounter;
  let listed = 0;
  const low = binOfAngle(sweep < 0 ? from + sweep : from);
  const high = binOfAngle(sweep < 0 ? from : from + sweep);
  const along = Math.atan2(by - ay, bx - ax);
  // From one bin before the lower end to one after the upper, going up round the ring; then the segment's own
  // direction and its opposite, each with a bin either side.
  for (let run = 0; run < 3; run++) {
    const first = run === 0 ? low - 1 : binOfAngle(run === 1 ? along : along + Math.PI) - 1;
    const count = run === 0 ? ((high - low + SHADOW_2D_BINS) % SHADOW_2D_BINS) + 3 : 3;
    for (let step = 0; step < count; step++) {
      const bin = (first + step + SHADOW_2D_BINS) % SHADOW_2D_BINS;
      if (binStamp[bin] === stamp) continue;
      binStamp[bin] = stamp;
      segmentBinList[listed++] = bin;
    }
  }
  return listed;
}

/** Sorts every caster segment into the bins whose ray can cross it (`segmentBins`), keeping caster and segment order within a bin. */
function bucketSegments(x: number, y: number, casters: readonly WorldOccluder2D[]): void {
  binStart.fill(0);
  // Count each bin's segments, turn the counts into each bin's first slot, then fill in the same order.
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      let at = 0;
      for (let bin = 0; bin < SHADOW_2D_BINS; bin++) {
        const count = binStart[bin]!;
        binStart[bin] = at;
        binFill[bin] = at;
        at += count;
      }
      binStart[SHADOW_2D_BINS] = at;
      if (binCasters.length < at) {
        binCasters = new Int32Array(at * 2);
        binSegments = new Int32Array(at * 2);
      }
    }
    for (let caster = 0; caster < casters.length; caster++) {
      const occluder = casters[caster]!;
      const points = occluder.points;
      const count = points.length / 2;
      const segments = occluder.closed ? count : count - 1;
      for (let index = 0; index < segments; index++) {
        const next = (index + 1) % count;
        const listed = segmentBins(points[index * 2]! - x, points[index * 2 + 1]! - y, points[next * 2]! - x, points[next * 2 + 1]! - y);
        for (let at = 0; at < listed; at++) {
          const bin = segmentBinList[at]!;
          if (pass === 0) binStart[bin]!++;
          else {
            const slot = binFill[bin]!++;
            binCasters[slot] = caster;
            binSegments[slot] = index;
          }
        }
      }
    }
  }
}

/**
 * Writes the light's ring into `out` (`SHADOW_2D_BINS` values): for each direction, where shadow starts as a share of
 * `radius`, at most 1. `occluders` are every caster; those not within the radius, or containing the light, are skipped.
 * Each direction tests only the segments its ray can cross (`bucketSegments`), in the order it would test them all.
 */
export function polarShadow2D(x: number, y: number, radius: number, occluders: readonly WorldOccluder2D[], out: Float32Array): void {
  const casters: WorldOccluder2D[] = [];
  for (const occluder of occluders) {
    if (occluder.maxX < x - radius || occluder.minX > x + radius || occluder.maxY < y - radius || occluder.minY > y + radius) continue;
    if (occluderContains(occluder, x, y)) continue;
    casters.push(occluder);
  }
  if (!casters.length) {
    out.fill(1, 0, SHADOW_2D_BINS);
    return;
  }
  if (insideFlags.length < casters.length) insideFlags = new Uint8Array(casters.length * 2);
  bucketSegments(x, y, casters);
  for (let bin = 0; bin < SHADOW_2D_BINS; bin++) {
    const angle = shadow2DBinAngle(bin);
    out[bin] = shadowStart(x, y, Math.cos(angle), Math.sin(angle), radius, casters, binStart[bin]!, binStart[bin + 1]!) / radius;
  }
}

/** Where shadow starts along the ray (x, y) + t (dx, dy), at most `radius`, among the bucketed segments `from` to `to`. */
function shadowStart(
  x: number, y: number, dx: number, dy: number, radius: number, casters: readonly WorldOccluder2D[], from: number, to: number,
): number {
  hits.length = 0;
  let pooled = 0;
  for (let slot = from; slot < to; slot++) {
    const caster = binCasters[slot]!;
    const index = binSegments[slot]!;
    const points = casters[caster]!.points;
    const count = points.length / 2;
    const ax = points[index * 2]!, ay = points[index * 2 + 1]!;
    const next = (index + 1) % count;
    const ex = points[next * 2]! - ax, ey = points[next * 2 + 1]! - ay;
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-12) continue;
    const ox = ax - x, oy = ay - y;
    const t = (ox * ey - oy * ex) / denominator;
    // Half-open along the segment, so a ray through a shared vertex crosses its outline once.
    const u = (ox * dy - oy * dx) / denominator;
    if (t <= 1e-6 || t > radius || u < 0 || u >= 1) continue;
    const hit = hitPool[pooled] ?? (hitPool[pooled] = { t: 0, caster: 0 });
    pooled++;
    hit.t = t;
    hit.caster = caster;
    hits.push(hit);
  }
  if (!hits.length) return radius;
  hits.sort((a, b) => a.t - b.t);
  insideFlags.fill(0, 0, casters.length);
  let solid = 0;
  let entered = false;
  for (let start = 0; start < hits.length;) {
    let end = start + 1;
    while (end < hits.length && hits[end]!.t - hits[start]!.t < 1e-6) end++;
    // Coincident crossings (two touching tiles' shared edge) enter before they exit, so the union stays solid.
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
}
