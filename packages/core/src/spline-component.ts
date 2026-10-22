export const SPLINE_COMPONENT_CLASS_ID = "SplineComponent";
/** Sub-segments per curved control segment, shared with river authoring. */
export const SPLINE_SUBDIVISIONS = 8;

export type SplinePoint = [number, number, number];

export interface SplineProperties {
  /** Control points in component-local metres. */
  points: SplinePoint[];
  /** 0 is straight segments; 1 is a centripetal Catmull-Rom curve. */
  curvature: number;
  /** Connect the last point to the first; requires at least three points. */
  closed: boolean;
}

export function parseSplineProperties(value: unknown): SplineProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const authored = Array.isArray(source.points) ? source.points.slice(0, 128).filter((point) =>
    Array.isArray(point) && point.length === 3 && [0, 1, 2].every((axis) => typeof point[axis] === "number" && Number.isFinite(point[axis])),
  ).map((point) => point.map((coordinate: number) => Math.max(-100000, Math.min(100000, coordinate))) as SplinePoint) : [];
  const points: SplinePoint[] = authored.length >= 2 ? authored : [[0, 0, -5], [0, 0, 5]];
  return {
    points,
    curvature: typeof source.curvature === "number" && Number.isFinite(source.curvature)
      ? Math.max(0, Math.min(1, source.curvature)) : 1,
    closed: source.closed === true && points.length >= 3,
  };
}

export interface SplinePathSample {
  position: SplinePoint;
  /** Start control point of this sample's segment. */
  segmentIndex: number;
  /** Linear progress within the control segment, for associated point data. */
  fraction: number;
}

/**
 * Sample a normalized path. Water retains planar knots and linear elevation so
 * sharing the curve math cannot introduce uphill overshoot into a river.
 */
export function sampleSplinePath(
  body: SplineProperties,
  options: { linearElevation?: boolean; subdivisions?: number } = {},
): SplinePathSample[] {
  const { points, curvature } = body;
  const count = points.length;
  if (!count) return [];
  if (count === 1) return [{ position: [...points[0]!], segmentIndex: 0, fraction: 0 }];
  const closed = body.closed && count >= 3;
  const linearElevation = options.linearElevation === true;
  const at = (index: number): SplinePoint => {
    if (closed) return points[(index + count) % count]!;
    if (index >= 0 && index < count) return points[index]!;
    // Reflected phantom endpoints keep the first and last segment tangents.
    const [a, b] = index < 0 ? [points[0]!, points[1]!] : [points[count - 1]!, points[count - 2]!];
    return [2 * a[0] - b[0], linearElevation ? a[1] : 2 * a[1] - b[1], 2 * a[2] - b[2]];
  };
  const steps = curvature > 0 && count > 2
    ? Math.max(1, Math.floor(options.subdivisions ?? SPLINE_SUBDIVISIONS)) : 1;
  const segments = closed ? count : count - 1;
  const samples: SplinePathSample[] = [];
  const knot = (a: SplinePoint, b: SplinePoint) => Math.max(1e-4, Math.sqrt(linearElevation
    ? Math.hypot(b[0] - a[0], b[2] - a[2])
    : Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  const lerp = (a: number, b: number, ta: number, tb: number, value: number) => ta === tb ? a : (a * (tb - value) + b * (value - ta)) / (tb - ta);
  for (let index = 0; index < segments; index++) {
    const p0 = at(index - 1), p1 = at(index), p2 = at(index + 1), p3 = at(index + 2);
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let step = 0; step < steps; step++) {
      const fraction = step / steps, t = t1 + (t2 - t1) * fraction;
      const position = [0, 1, 2].map((axis) => {
        const linear = p1[axis]! + (p2[axis]! - p1[axis]!) * fraction;
        if (linearElevation && axis === 1) return linear;
        const a1 = lerp(p0[axis]!, p1[axis]!, 0, t1, t), a2 = lerp(p1[axis]!, p2[axis]!, t1, t2, t), a3 = lerp(p2[axis]!, p3[axis]!, t2, t3, t);
        const b1 = lerp(a1, a2, 0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
        return linear + (lerp(b1, b2, t1, t2, t) - linear) * curvature;
      }) as SplinePoint;
      samples.push({ position, segmentIndex: index, fraction });
    }
  }
  samples.push({ position: [...points[closed ? 0 : count - 1]!], segmentIndex: segments - 1, fraction: 1 });
  return samples;
}

/** Component-local curve, including the endpoint (the first point for a loop). */
export function splineCentreline(body: SplineProperties): SplinePoint[] {
  return sampleSplinePath(body).map((sample) => sample.position);
}

/** Sub-segments per curved control segment when scripts travel a Spline by distance. */
export const SPLINE_DISTANCE_SUBDIVISIONS = 32;

/** A Spline resampled for travel by arc length. */
export interface SplineArcPath {
  points: SplinePoint[];
  /** Arc length from the first point to each point. */
  distances: number[];
  /** Unit tangent at each point, averaged across the neighbouring segments so it turns smoothly. */
  tangents: SplinePoint[];
  length: number;
  closed: boolean;
}

export interface SplineDistanceSample {
  position: SplinePoint;
  /** Unit travel direction; zero for a path with no length. */
  direction: SplinePoint;
}

/**
 * Arc-length path through `points`, an already sampled curve (for a loop, ending
 * on its first point). Repeated points are dropped so every segment has length.
 */
export function splineArcPath(points: readonly SplinePoint[], closed: boolean): SplineArcPath {
  const kept: SplinePoint[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1], point[2] - last[2]) > 1e-6) kept.push([...point]);
  }
  const loop = closed && kept.length >= 3 && Math.hypot(...[0, 1, 2].map((axis) => kept[0]![axis]! - kept.at(-1)![axis]!)) <= 1e-6;
  const distances = [0];
  const directions: SplinePoint[] = [];
  for (let index = 1; index < kept.length; index++) {
    const a = kept[index - 1]!, b = kept[index]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    distances.push(distances[index - 1]! + length);
    directions.push([(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length]);
  }
  const unit = (a: SplinePoint | undefined, b: SplinePoint | undefined): SplinePoint => {
    const sum: SplinePoint = [(a?.[0] ?? 0) + (b?.[0] ?? 0), (a?.[1] ?? 0) + (b?.[1] ?? 0), (a?.[2] ?? 0) + (b?.[2] ?? 0)];
    const length = Math.hypot(...sum);
    // Opposite neighbours (a hairpin) keep the incoming direction.
    return length > 1e-9 ? [sum[0] / length, sum[1] / length, sum[2] / length] : a ?? b ?? [0, 0, 0];
  };
  const tangents = kept.map((_, index) => {
    if (loop && (index === 0 || index === kept.length - 1)) return unit(directions.at(-1), directions[0]);
    return unit(directions[index - 1], directions[index]);
  });
  return { points: kept, distances, tangents, length: distances.at(-1)!, closed: loop };
}

/** Position and direction `distance` along the path: a loop wraps, an open path clamps to its ends. */
export function sampleSplineArcPath(path: SplineArcPath, distance: number): SplineDistanceSample {
  const { points, distances, tangents, length } = path;
  if (points.length < 2 || !(length > 0)) {
    return { position: [...(points[0] ?? [0, 0, 0])], direction: [0, 0, 0] };
  }
  const travelled = Number.isFinite(distance) ? distance : 0;
  const at = path.closed ? ((travelled % length) + length) % length : Math.max(0, Math.min(length, travelled));
  let low = 0, high = distances.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (distances[middle]! <= at) low = middle; else high = middle;
  }
  const fraction = (at - distances[low]!) / (distances[high]! - distances[low]!);
  const a = points[low]!, b = points[high]!, ta = tangents[low]!, tb = tangents[high]!;
  const position = [0, 1, 2].map((axis) => a[axis]! + (b[axis]! - a[axis]!) * fraction) as SplinePoint;
  const blend = [0, 1, 2].map((axis) => ta[axis]! + (tb[axis]! - ta[axis]!) * fraction) as SplinePoint;
  const size = Math.hypot(...blend);
  return { position, direction: size > 1e-9 ? [blend[0] / size, blend[1] / size, blend[2] / size] : [...ta] };
}
