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

/**
 * Writes the light's ring into `out` (`SHADOW_2D_BINS` values): for each direction, where shadow starts as a share of
 * `radius`, at most 1. `occluders` are every caster; those not within the radius, or containing the light, are skipped.
 */
export function polarShadow2D(x: number, y: number, radius: number, occluders: readonly WorldOccluder2D[], out: Float32Array): void {
  const casters: WorldOccluder2D[] = [];
  for (const occluder of occluders) {
    if (occluder.maxX < x - radius || occluder.minX > x + radius || occluder.maxY < y - radius || occluder.minY > y + radius) continue;
    if (occluderContains(occluder, x, y)) continue;
    casters.push(occluder);
  }
  if (insideFlags.length < casters.length) insideFlags = new Uint8Array(casters.length * 2);
  for (let bin = 0; bin < SHADOW_2D_BINS; bin++) {
    const angle = shadow2DBinAngle(bin);
    out[bin] = casters.length ? shadowStart(x, y, Math.cos(angle), Math.sin(angle), radius, casters) / radius : 1;
  }
}

/** Where shadow starts along the ray (x, y) + t (dx, dy), at most `radius`. */
function shadowStart(x: number, y: number, dx: number, dy: number, radius: number, casters: readonly WorldOccluder2D[]): number {
  hits.length = 0;
  let pooled = 0;
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
      // Half-open along the segment, so a ray through a shared vertex crosses its outline once.
      const u = (ox * dy - oy * dx) / denominator;
      if (t <= 1e-6 || t > radius || u < 0 || u >= 1) continue;
      const hit = hitPool[pooled] ?? (hitPool[pooled] = { t: 0, caster: 0 });
      pooled++;
      hit.t = t;
      hit.caster = caster;
      hits.push(hit);
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
