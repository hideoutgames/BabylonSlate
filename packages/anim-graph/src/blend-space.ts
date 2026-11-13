/**
 * Blend Space weights: where a point on one or two axes falls among the samples, as one weight per sample that sums
 * to 1. Pure and allocation-light, so the game worker's evaluator and the editor's grid share it.
 */

export type BlendSpaceAxis = {
  min: number;
  max: number;
  /** Joins the ends: an input past one end comes in at the other (an angle). */
  wrap: boolean;
};

export type BlendSpacePoint = { x: number; y: number };

/** One axis, or two. A one-axis space reads only `x`. */
export type BlendSpaceLayout = {
  axes: readonly [BlendSpaceAxis] | readonly [BlendSpaceAxis, BlendSpaceAxis];
  samples: readonly BlendSpacePoint[];
};

export type BlendSpaceTriangle = readonly [number, number, number];

/** An input on `axis`: wrapped into its range when the axis wraps, else clamped to it. */
export function blendSpaceAxisValue(axis: BlendSpaceAxis, value: number): number {
  const span = axis.max - axis.min;
  if (!(span > 0) || !Number.isFinite(value)) return axis.min;
  if (axis.wrap) {
    const offset = (((value - axis.min) % span) + span) % span;
    // Exactly the top end stays there rather than wrapping to the bottom.
    return offset === 0 && value > axis.min ? axis.max : axis.min + offset;
  }
  return Math.min(axis.max, Math.max(axis.min, value));
}

/** The short way from `from` to `to` on a wrapping axis, else the plain difference. */
export function blendSpaceAxisDelta(axis: BlendSpaceAxis, from: number, to: number): number {
  const delta = to - from;
  const span = axis.max - axis.min;
  if (!axis.wrap || !(span > 0)) return delta;
  const wrapped = ((((delta + span / 2) % span) + span) % span) - span / 2;
  return wrapped;
}

function normalised(axis: BlendSpaceAxis, value: number): number {
  const span = axis.max - axis.min;
  return span > 0 ? (value - axis.min) / span : 0;
}

/** Weights along one axis: the two neighbours around `x` interpolate; past either end, the end sample plays alone. */
function weights1d(xs: readonly number[], x: number): number[] {
  const weights = xs.map(() => 0);
  if (xs.length === 0) return weights;
  const order = xs.map((_, index) => index).sort((a, b) => xs[a]! - xs[b]! || a - b);
  const first = order[0]!;
  const last = order[order.length - 1]!;
  if (x <= xs[first]!) {
    weights[first] = 1;
    return weights;
  }
  if (x >= xs[last]!) {
    weights[last] = 1;
    return weights;
  }
  for (let index = 0; index < order.length - 1; index++) {
    const a = order[index]!;
    const b = order[index + 1]!;
    const xa = xs[a]!;
    const xb = xs[b]!;
    if (x >= xa && x <= xb) {
      if (xb === xa) {
        weights[a] = 1;
        return weights;
      }
      const t = (x - xa) / (xb - xa);
      weights[a] = 1 - t;
      weights[b] = t;
      return weights;
    }
  }
  weights[last] = 1;
  return weights;
}

type P = { x: number; y: number };

function circumcircleContains(a: P, b: P, c: P, p: P): boolean {
  const ax = a.x - p.x;
  const ay = a.y - p.y;
  const bx = b.x - p.x;
  const by = b.y - p.y;
  const cx = c.x - p.x;
  const cy = c.y - p.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  const orientation = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return orientation > 0 ? det > 1e-12 : det < -1e-12;
}

function area2(a: P, b: P, c: P): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * The Delaunay triangulation of `points` (Bowyer–Watson), as index triples. Duplicate positions keep their first
 * sample; collinear points give no triangles.
 */
export function delaunayTriangles(points: readonly P[]): BlendSpaceTriangle[] {
  const unique: number[] = [];
  for (let index = 0; index < points.length; index++) {
    const p = points[index]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (unique.some((other) => Math.abs(points[other]!.x - p.x) < 1e-9 && Math.abs(points[other]!.y - p.y) < 1e-9)) continue;
    unique.push(index);
  }
  if (unique.length < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of unique) {
    const p = points[index]!;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const size = Math.max(maxX - minX, maxY - minY, 1e-6) * 20;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  // The super-triangle's corners are indices -1, -2, -3.
  const corner = (index: number): P =>
    index === -1
      ? { x: midX - size, y: midY - size }
      : index === -2
        ? { x: midX + size, y: midY - size }
        : index === -3
          ? { x: midX, y: midY + size }
          : points[index]!;
  let triangles: Array<[number, number, number]> = [[-1, -2, -3]];
  for (const index of unique) {
    const p = points[index]!;
    const bad = triangles.filter(([a, b, c]) => circumcircleContains(corner(a), corner(b), corner(c), p));
    const edges: Array<[number, number]> = [];
    for (const [a, b, c] of bad) {
      for (const edge of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
        const shared = bad.some((other) => {
          if (other[0] === a && other[1] === b && other[2] === c) return false;
          const vertices = new Set(other);
          return vertices.has(edge[0]) && vertices.has(edge[1]);
        });
        if (!shared) edges.push(edge);
      }
    }
    triangles = triangles.filter((triangle) => !bad.includes(triangle));
    for (const [a, b] of edges) {
      // Keep every triangle counter-clockwise.
      triangles.push(area2(corner(a), corner(b), p) > 0 ? [a, b, index] : [b, a, index]);
    }
  }
  return triangles
    .filter(([a, b, c]) => a >= 0 && b >= 0 && c >= 0)
    .filter(([a, b, c]) => Math.abs(area2(points[a]!, points[b]!, points[c]!)) > 1e-12)
    .map(([a, b, c]) => [a, b, c] as const);
}

/** The closest point to `p` on segment ab, as the fraction along it. */
function segmentT(a: P, b: P, p: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return 0;
  return Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
}

function distanceSq(a: P, b: P): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** Weights on two axes: barycentric in the triangle holding the point, else on the nearest outer edge. */
function weights2d(points: readonly P[], triangles: readonly BlendSpaceTriangle[], p: P): number[] {
  const weights = points.map(() => 0);
  if (points.length === 0) return weights;
  for (const [a, b, c] of triangles) {
    const pa = points[a]!;
    const pb = points[b]!;
    const pc = points[c]!;
    const total = area2(pa, pb, pc);
    const wa = area2(pb, pc, p) / total;
    const wb = area2(pc, pa, p) / total;
    const wc = 1 - wa - wb;
    if (wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9) {
      const ca = Math.max(0, wa);
      const cb = Math.max(0, wb);
      const cc = Math.max(0, wc);
      const sum = ca + cb + cc;
      weights[a] = ca / sum;
      weights[b] = cb / sum;
      weights[c] = cc / sum;
      return weights;
    }
  }
  // Outside the hull (or no triangles): the nearest point on an edge, or the nearest sample.
  const edges: Array<[number, number]> = [];
  if (triangles.length > 0) {
    const count = new Map<string, number>();
    for (const [a, b, c] of triangles) {
      for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
        const key = u < v ? `${u}:${v}` : `${v}:${u}`;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    for (const [key, uses] of count) {
      if (uses !== 1) continue;
      const [u, v] = key.split(":").map(Number) as [number, number];
      edges.push([u, v]);
    }
  } else {
    for (let u = 0; u < points.length; u++) {
      for (let v = u + 1; v < points.length; v++) edges.push([u, v]);
    }
  }
  // On a tie (collinear samples, where every pair is an edge), the shorter edge holds the point's neighbours.
  let best = { distance: Infinity, length: Infinity, a: 0, b: 0, t: 0 };
  for (const [a, b] of edges) {
    const t = segmentT(points[a]!, points[b]!, p);
    const q = { x: points[a]!.x + (points[b]!.x - points[a]!.x) * t, y: points[a]!.y + (points[b]!.y - points[a]!.y) * t };
    const distance = distanceSq(q, p);
    const length = distanceSq(points[a]!, points[b]!);
    const closer = distance < best.distance - 1e-12;
    const tied = Math.abs(distance - best.distance) <= 1e-12 && length < best.length;
    if (closer || tied) best = { distance, length, a, b, t };
  }
  if (best.distance === Infinity) {
    weights[0] = 1;
    return weights;
  }
  weights[best.a] = 1 - best.t;
  weights[best.b] = (weights[best.b] ?? 0) + best.t;
  return weights;
}

/** The triangulation of a two-axis space on its normalised grid, so axes in different units weigh alike. */
export function blendSpaceTriangles(layout: BlendSpaceLayout): BlendSpaceTriangle[] {
  if (layout.axes.length < 2) return [];
  const [xAxis, yAxis] = layout.axes as readonly [BlendSpaceAxis, BlendSpaceAxis];
  return delaunayTriangles(layout.samples.map((sample) => ({ x: normalised(xAxis, sample.x), y: normalised(yAxis, sample.y) })));
}

/**
 * One weight per sample for the input `point`, summing to 1 (all 0 with no samples). Inputs wrap or clamp to their
 * axes first. Pass `triangles` from `blendSpaceTriangles` to reuse them across calls.
 */
export function blendSpaceWeights(
  layout: BlendSpaceLayout,
  point: BlendSpacePoint,
  triangles?: readonly BlendSpaceTriangle[],
): number[] {
  const [xAxis, yAxis] = layout.axes;
  const x = blendSpaceAxisValue(xAxis, point.x);
  if (!yAxis) return weights1d(layout.samples.map((sample) => sample.x), x);
  const y = blendSpaceAxisValue(yAxis, point.y);
  const points = layout.samples.map((sample) => ({ x: normalised(xAxis, sample.x), y: normalised(yAxis, sample.y) }));
  return weights2d(points, triangles ?? blendSpaceTriangles(layout), { x: normalised(xAxis, x), y: normalised(yAxis, y) });
}

/** How far apart two points are in grid widths (each axis's range is 1), the short way round a wrapping axis. */
function gridDistance(layout: BlendSpaceLayout, a: BlendSpacePoint, b: BlendSpacePoint): number {
  const [xAxis, yAxis] = layout.axes;
  const dx = blendSpaceAxisDelta(xAxis, a.x, b.x) / Math.max(1e-9, xAxis.max - xAxis.min);
  const dy = yAxis ? blendSpaceAxisDelta(yAxis, a.y, b.y) / Math.max(1e-9, yAxis.max - yAxis.min) : 0;
  return Math.hypot(dx, dy);
}

/**
 * The sample a Sprite Blend Space plays at `point`: the nearest one, unless `current` is within `hysteresis` grid
 * widths of being as near, so an input on a boundary keeps playing what it played. -1 with no samples.
 */
export function nearestBlendSpaceSample(
  layout: BlendSpaceLayout,
  point: BlendSpacePoint,
  current: number | null,
  hysteresis: number,
): number {
  const [xAxis, yAxis] = layout.axes;
  const at = { x: blendSpaceAxisValue(xAxis, point.x), y: yAxis ? blendSpaceAxisValue(yAxis, point.y) : 0 };
  let best = -1;
  let bestDistance = Infinity;
  layout.samples.forEach((sample, index) => {
    const distance = gridDistance(layout, sample, at);
    if (distance < bestDistance - 1e-12) {
      best = index;
      bestDistance = distance;
    }
  });
  if (current !== null && current !== best && layout.samples[current]) {
    const held = gridDistance(layout, layout.samples[current], at);
    if (held - bestDistance <= Math.max(0, hysteresis)) return current;
  }
  return best;
}
