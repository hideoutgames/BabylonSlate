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
  options: { linearElevation?: boolean } = {},
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
  const steps = curvature > 0 && count > 2 ? SPLINE_SUBDIVISIONS : 1;
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
