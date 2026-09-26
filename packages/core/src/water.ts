import type { Transform, Vec3 } from "./math-rng";
import { identityTransform } from "./math-rng";
import { inverseQuat, quatRotateVector } from "./euler";

export type WaterStyle = "realistic" | "stylized";
export type WaterKind = "global" | "ocean" | "lake" | "river" | "puddle";
export type WaterColor = [number, number, number];

/** Version 1 Water asset. Distances are metres and time is simulation seconds. */
export interface WaterDefinition {
  style: WaterStyle;
  shallowColor: WaterColor;
  deepColor: WaterColor;
  foamColor: WaterColor;
  opacity: number;
  roughness: number;
  reflectionStrength: number;
  depthColorDistance: number;
  waveHeight: number;
  waveLength: number;
  waveSpeed: number;
  waveDirection: number;
  /** 0 is rounded sine swell; 1 is sharp crests with flat troughs. */
  choppiness: number;
  /** Angular spread of the swell components: 0 is one heading, 1 is a confused sea. */
  waveSpread: number;
  rippleStrength: number;
  rippleScale: number;
  foamAmount: number;
  foamWidth: number;
  /** Whitecaps on steep crests. */
  crestFoam: number;
  /** Metres of foam around objects and terrain that intersect the surface. */
  contactFoamWidth: number;
  colorBands: number;
  /** Twinkling sun glints, mostly for Stylized water. */
  sparkles: number;
  density: number;
  materialGuid: string | null;
}

export interface WaterBodyProperties {
  kind: WaterKind;
  assetGuid: string | null;
  enabled: boolean;
  width: number;
  length: number;
  depth: number;
  waveScale: number;
  flowSpeed: number;
  flowDirection: number;
  /** River control points in component-local coordinates, including elevation. */
  points: [number, number, number][];
  /** Per-point multipliers of Width, aligned with `points`. */
  widthScales: number[];
  /** River path smoothing: 0 is straight segments, 1 is a centripetal Catmull-Rom spline. */
  curvature: number;
  resolution: number;
}

export interface WaterBuoyancyProperties {
  enabled: boolean;
  /** Zero selects twice the body's mass divided by water density. */
  volume: number;
  width: number;
  length: number;
  height: number;
  offset: [number, number, number];
  drag: number;
  angularDrag: number;
  waterActorId: string | null;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;
const guid = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const tuple = (value: unknown, fallback: WaterColor, min: number, max: number): WaterColor => {
  const point = record(value);
  const v = Array.isArray(value) ? value : [point.x, point.y, point.z];
  return Array.isArray(v) && v.length === 3
    ? [number(v[0], fallback[0], min, max), number(v[1], fallback[1], min, max), number(v[2], fallback[2], min, max)]
    : [...fallback];
};

export function createDefaultWaterDefinition(style: WaterStyle = "realistic"): WaterDefinition {
  const stylized = style === "stylized";
  return {
    style,
    shallowColor: stylized ? [0.3, 0.76, 0.95] : [0.14, 0.42, 0.34],
    deepColor: stylized ? [0.03, 0.27, 0.66] : [0.02, 0.1, 0.13],
    foamColor: stylized ? [1, 1, 1] : [0.86, 0.9, 0.9],
    opacity: stylized ? 0.92 : 0.97, roughness: stylized ? 0.18 : 0.05,
    reflectionStrength: 1, depthColorDistance: stylized ? 1.6 : 3,
    waveHeight: 0.35, waveLength: 12, waveSpeed: 1.3, waveDirection: 25,
    choppiness: stylized ? 0.2 : 0.45, waveSpread: 0.5,
    rippleStrength: stylized ? 0.35 : 0.6, rippleScale: stylized ? 1 : 1.4,
    foamAmount: stylized ? 1 : 0.35, foamWidth: stylized ? 0.7 : 0.8,
    crestFoam: stylized ? 0.3 : 0.12, contactFoamWidth: stylized ? 0.6 : 1.2,
    colorBands: stylized ? 3 : 0, sparkles: stylized ? 0.7 : 0, density: 1000, materialGuid: null,
  };
}

export function normalizeWaterDefinition(value: unknown): WaterDefinition {
  const v = record(value);
  const d = createDefaultWaterDefinition(v.style === "stylized" ? "stylized" : "realistic");
  return {
    ...d,
    shallowColor: tuple(v.shallowColor, d.shallowColor, 0, 1),
    deepColor: tuple(v.deepColor, d.deepColor, 0, 1),
    foamColor: tuple(v.foamColor, d.foamColor, 0, 1),
    opacity: number(v.opacity, d.opacity, 0, 1),
    roughness: number(v.roughness, d.roughness, 0.02, 1),
    reflectionStrength: number(v.reflectionStrength, d.reflectionStrength, 0, 2),
    depthColorDistance: number(v.depthColorDistance, d.depthColorDistance, 0.01, 1000),
    waveHeight: number(v.waveHeight, d.waveHeight, 0, 20),
    waveLength: number(v.waveLength, d.waveLength, 0.1, 1000),
    waveSpeed: number(v.waveSpeed, d.waveSpeed, 0, 20),
    waveDirection: number(v.waveDirection, d.waveDirection, -360, 360),
    choppiness: number(v.choppiness, d.choppiness, 0, 1),
    waveSpread: number(v.waveSpread, d.waveSpread, 0, 1),
    rippleStrength: number(v.rippleStrength, d.rippleStrength, 0, 1),
    rippleScale: number(v.rippleScale, d.rippleScale, 0.1, 100),
    foamAmount: number(v.foamAmount, d.foamAmount, 0, 1),
    foamWidth: number(v.foamWidth, d.foamWidth, 0, 20),
    crestFoam: number(v.crestFoam, d.crestFoam, 0, 1),
    contactFoamWidth: number(v.contactFoamWidth, d.contactFoamWidth, 0, 8),
    colorBands: Math.round(number(v.colorBands, d.colorBands, 0, 12)),
    sparkles: number(v.sparkles, d.sparkles, 0, 1),
    density: number(v.density, d.density, 1, 20000),
    materialGuid: guid(v.materialGuid),
  };
}

export function waterKindForClass(classId: string): WaterKind | null {
  switch (classId) {
    case "GlobalWaterVolumeComponent": return "global";
    case "WaterOceanComponent": return "ocean";
    case "WaterLakeComponent": return "lake";
    case "WaterRiverComponent": return "river";
    case "WaterPuddleComponent": return "puddle";
    default: return null;
  }
}

export function normalizeWaterBody(value: unknown, kind: WaterKind = "lake"): WaterBodyProperties {
  const v = record(value);
  const openWater = kind === "ocean" || kind === "global";
  const points = Array.isArray(v.points) ? v.points.slice(0, 128).filter((p) =>
    Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number" && Number.isFinite(n)),
  ).map((p) => tuple(p, [0, 0, 0], -100000, 100000)) : [];
  const riverPoints: [number, number, number][] = points.length >= 2 ? points : [[0, 0, -15], [0, 0, 15]];
  const scales = Array.isArray(v.widthScales) ? v.widthScales : [];
  return {
    kind, assetGuid: guid(v.assetGuid), enabled: v.enabled !== false,
    width: number(v.width, openWater ? 256 : kind === "river" ? 6 : kind === "puddle" ? 3 : 30, 0.1, 10000),
    length: number(v.length, openWater ? 256 : kind === "puddle" ? 2 : 30, 0.1, 10000),
    depth: number(v.depth, kind === "puddle" ? 0.1 : openWater ? 1000 : 5, 0.01, 10000),
    waveScale: number(v.waveScale, kind === "puddle" ? 0.03 : kind === "lake" ? 0.35 : kind === "river" ? 0.15 : 1, 0, 10),
    flowSpeed: number(v.flowSpeed, kind === "river" ? 1.5 : 0, -100, 100),
    flowDirection: number(v.flowDirection, 0, -360, 360),
    points: riverPoints,
    widthScales: riverPoints.map((_, i) => number(scales[i], 1, 0.05, 20)),
    curvature: number(v.curvature, 1, 0, 1),
    resolution: Math.round(number(v.resolution, openWater ? 96 : 48, 8, 128)),
  };
}

export function normalizeWaterBuoyancy(value: unknown): WaterBuoyancyProperties {
  const v = record(value);
  return {
    enabled: v.enabled !== false,
    volume: number(v.volume, 0, 0, 100000),
    width: number(v.width, 1, 0.01, 10000),
    length: number(v.length, 1, 0.01, 10000),
    height: number(v.height, 1, 0.01, 10000),
    offset: tuple(v.offset, [0, 0, 0], -10000, 10000),
    drag: number(v.drag, 2.5, 0, 50),
    angularDrag: number(v.angularDrag, 1, 0, 50),
    waterActorId: guid(v.waterActorId),
  };
}

export interface WaterSample {
  found: boolean;
  height: number;
  depth: number;
  normal: Vec3;
  velocity: Vec3;
  edgeDistance: number;
}

export const emptyWaterSample = (): WaterSample => ({
  found: false, height: 0, depth: 0,
  normal: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, edgeDistance: 0,
});

/** Identical analytic waves drive the visible mesh, queries and buoyancy. */
export const waterWaveComponents = [
  [0, 1, 0.5, 0], [0.62, 1.37, 0.27, 1.2], [-0.81, 1.93, 0.16, 2.7], [1.47, 2.71, 0.09, 4.1], [-1.72, 3.53, 0.05, 0.6],
] as const;

/** Mean and half-range of `exp(sin p - 1)`, used to centre the sharp-crest profile. */
export const WATER_CREST_MEAN = 0.465760;
export const WATER_CREST_RANGE = 0.534240;

/**
 * Wave profile blended from a sine towards sharp crests, and its phase derivative.
 * The same expression drives rendered geometry, per-pixel normals, queries and buoyancy.
 */
export function waterWaveProfile(p: number, choppiness: number): { value: number; slope: number } {
  const sin = Math.sin(p), cos = Math.cos(p), crest = Math.exp(sin - 1);
  return {
    value: sin + ((crest - WATER_CREST_MEAN) / WATER_CREST_RANGE - sin) * choppiness,
    slope: cos + (crest * cos / WATER_CREST_RANGE - cos) * choppiness,
  };
}

/** World-space metres, independent of the volume's transform. Spacing filters distant geometry only. */
export function sampleWaterWaves(water: WaterDefinition, x: number, z: number, time: number, scale = 1, spacing = 0) {
  const angle = water.waveDirection * Math.PI / 180;
  let height = 0, dx = 0, dz = 0, velocity = 0;
  for (const [turn, frequency, amplitude, phase] of waterWaveComponents) {
    const k = 2 * Math.PI * frequency! / water.waveLength;
    const heading = angle + turn! * water.waveSpread * 2;
    const ax = Math.cos(heading), az = Math.sin(heading);
    const omega = Math.sqrt(9.81 * k) * water.waveSpeed;
    const filter = clamp(2 - spacing * frequency * 4 / water.waveLength, 0, 1);
    const a = water.waveHeight * scale * amplitude! * filter * filter * (3 - 2 * filter);
    const p = k * (ax * x + az * z) - omega * time + phase!;
    const wave = waterWaveProfile(p, water.choppiness);
    height += a * wave.value;
    dx += a * k * ax * wave.slope;
    dz += a * k * az * wave.slope;
    velocity -= a * omega * wave.slope;
  }
  const n = Math.hypot(dx, 1, dz);
  return { height, normal: { x: -dx / n, y: 1 / n, z: -dz / n }, velocity };
}

/** Local footprint, bank distance and sloped river elevation. */
export function waterFootprint(body: WaterBodyProperties, x: number, z: number) {
  const plane = { height: 0, slopeX: 0, slopeZ: 0, flowY: 0, flowX: Math.cos(body.flowDirection * Math.PI / 180), flowZ: Math.sin(body.flowDirection * Math.PI / 180) };
  if (body.kind === "global") return { ...plane, inside: true, edge: Infinity, edgeX: 0, edgeZ: 0 };
  if (body.kind === "ocean") {
    const ex = body.width / 2 - Math.abs(x), ez = body.length / 2 - Math.abs(z);
    return { ...plane, inside: ex >= -1e-6 && ez >= -1e-6, edge: Math.min(ex, ez), edgeX: ex < ez ? Math.sign(x) : 0, edgeZ: ex < ez ? 0 : Math.sign(z) };
  }
  if (body.kind !== "river") {
    const radius = Math.hypot(x / (body.width / 2), z / (body.length / 2));
    const gx = x / (body.width * body.width / 4), gz = z / (body.length * body.length / 4), gradient = Math.hypot(gx, gz);
    return { ...plane, inside: radius <= 1 + 1e-7, edge: gradient > 1e-6 ? (1 - radius) * radius / gradient : Math.min(body.width, body.length) / 2, edgeX: gradient > 1e-6 ? gx / gradient : 1, edgeZ: gradient > 1e-6 ? gz / gradient : 0 };
  }
  const line = waterRiverCentreline(body);
  let edge = -Infinity, height = 0, flowX = 0, flowZ = 1, slopeX = 0, slopeZ = 0, flowY = 0, edgeX = 1, edgeZ = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const vx = b.x - a.x, vz = b.z - a.z, length = Math.hypot(vx, vz);
    if (length < 1e-6) continue;
    const t = clamp(((x - a.x) * vx + (z - a.z) * vz) / (length * length), 0, 1);
    const distance = Math.hypot(x - a.x - t * vx, z - a.z - t * vz);
    // Deepest inside the swept banks, so a narrow reach beside a wide one keeps its own edge.
    const inset = a.halfWidth + t * (b.halfWidth - a.halfWidth) - distance;
    if (inset > edge) {
      edge = inset; height = a.y + t * (b.y - a.y); flowX = vx / length; flowZ = vz / length;
      edgeX = distance > 1e-6 ? (x - a.x - t * vx) / distance : -flowZ;
      edgeZ = distance > 1e-6 ? (z - a.z - t * vz) / distance : flowX;
      flowY = (b.y - a.y) / length;
      const slope = (t > 0 || i > 1) && (t < 1 || i < line.length - 1) ? flowY : 0;
      slopeX = slope * flowX; slopeZ = slope * flowZ;
    }
  }
  return { inside: edge >= -1e-7, height, edge, edgeX, edgeZ, flowX, flowY, flowZ, slopeX, slopeZ };
}

export interface WaterRiverSample { x: number; y: number; z: number; halfWidth: number }

/** Sub-segments per control segment of a curved river. */
export const WATER_RIVER_SUBDIVISIONS = 8;
const riverLines = new WeakMap<WaterBodyProperties, { points: unknown; scales: unknown; width: number; curvature: number; line: WaterRiverSample[] }>();

/**
 * Sampled river centreline shared by rendering, queries and editor handles.
 * Elevation and width interpolate linearly between control points so water never overshoots uphill.
 */
export function waterRiverCentreline(body: WaterBodyProperties): WaterRiverSample[] {
  const cached = riverLines.get(body);
  if (cached && cached.points === body.points && cached.scales === body.widthScales && cached.width === body.width && cached.curvature === body.curvature) return cached.line;
  const points = body.points, count = points.length, line: WaterRiverSample[] = [];
  const half = (i: number) => body.width * (body.widthScales?.[i] ?? 1) / 2;
  const at = (i: number): [number, number, number] => {
    if (i >= 0 && i < count) return points[i]!;
    // Reflected phantom ends keep the first and last segments' tangents.
    const [a, b] = i < 0 ? [points[0]!, points[1]!] : [points[count - 1]!, points[count - 2]!];
    return [2 * a[0] - b[0], a[1], 2 * a[2] - b[2]];
  };
  const steps = body.curvature > 0 && count > 2 ? WATER_RIVER_SUBDIVISIONS : 1;
  for (let i = 0; i < count - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    // Centripetal knots avoid cusps and loops on unevenly spaced points.
    const knot = (a: [number, number, number], b: [number, number, number]) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[2] - a[2])));
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let s = 0; s < steps; s++) {
      const u = s / steps, t = t1 + (t2 - t1) * u;
      const lerp = (a: number, b: number, ta: number, tb: number, value: number) => ta === tb ? a : (a * (tb - value) + b * (value - ta)) / (tb - ta);
      const spline = [0, 2].map((axis) => {
        const a1 = lerp(p0[axis]!, p1[axis]!, 0, t1, t), a2 = lerp(p1[axis]!, p2[axis]!, t1, t2, t), a3 = lerp(p2[axis]!, p3[axis]!, t2, t3, t);
        const b1 = lerp(a1, a2, 0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
        return lerp(b1, b2, t1, t2, t);
      });
      const linearX = p1[0] + (p2[0] - p1[0]) * u, linearZ = p1[2] + (p2[2] - p1[2]) * u;
      line.push({
        x: linearX + (spline[0]! - linearX) * body.curvature,
        y: p1[1] + (p2[1] - p1[1]) * u,
        z: linearZ + (spline[1]! - linearZ) * body.curvature,
        halfWidth: half(i) + (half(i + 1) - half(i)) * u,
      });
    }
  }
  const last = points[count - 1]!;
  line.push({ x: last[0], y: last[1], z: last[2], halfWidth: half(count - 1) });
  riverLines.set(body, { points: body.points, scales: body.widthScales, width: body.width, curvature: body.curvature, line });
  return line;
}

/** Intersect the transformed volume's base, then add world-vertical waves. */
export function sampleWaterSurface(
  water: WaterDefinition, body: WaterBodyProperties, position: Vec3, time: number,
  transform: Transform = identityTransform(),
): WaterSample {
  if (!body.enabled || ![time, position.x, position.y, position.z].every(Number.isFinite)) return emptyWaterSample();
  const { x: sx, y: sy, z: sz } = transform.scale;
  if (Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz)) < 1e-6) return emptyWaterSample();
  const inverse = inverseQuat(transform.rotation);
  const local = quatRotateVector(inverse, { x: position.x - transform.position.x, y: position.y - transform.position.y, z: position.z - transform.position.z });
  const up = quatRotateVector(inverse, { x: 0, y: 1, z: 0 });
  const origin = { x: local.x / sx, y: local.y / sy, z: local.z / sz };
  const ray = { x: up.x / sx, y: up.y / sy, z: up.z / sz };
  if (Math.abs(ray.y) < 1e-6) return emptyWaterSample();
  let distance = -origin.y / ray.y;
  // Newton iteration preserves actor/component pitch, roll and signed scales.
  for (let i = 0; i < 12; i++) {
    const x = origin.x + ray.x * distance, z = origin.z + ray.z * distance;
    const footprint = waterFootprint(body, x, z);
    const residual = origin.y + ray.y * distance - footprint.height;
    if (Math.abs(residual) < 1e-5) break;
    const derivative = ray.y - footprint.slopeX * ray.x - footprint.slopeZ * ray.z;
    if (Math.abs(derivative) < 1e-6) return emptyWaterSample();
    distance -= residual / derivative;
  }
  const x = origin.x + ray.x * distance, z = origin.z + ray.z * distance;
  const footprint = waterFootprint(body, x, z);
  const wave = sampleWaterWaves(water, position.x, position.z, time, body.waveScale);
  if (!footprint.inside || !Number.isFinite(distance) || Math.abs(origin.y + ray.y * distance - footprint.height) > 0.001) return emptyWaterSample();
  const normal = quatRotateVector(transform.rotation, {
    x: -footprint.slopeX / sx,
    y: 1 / sy,
    z: -footprint.slopeZ / sz,
  });
  if (Math.abs(normal.y) < 1e-6) return emptyWaterSample();
  normal.x = normal.x / normal.y + wave.normal.x / wave.normal.y;
  normal.z = normal.z / normal.y + wave.normal.z / wave.normal.y;
  normal.y = 1;
  const magnitude = Math.hypot(normal.x, 1, normal.z);
  const velocity = quatRotateVector(transform.rotation, {
    x: footprint.flowX * body.flowSpeed * sx,
    y: footprint.flowY * body.flowSpeed * sy,
    z: footprint.flowZ * body.flowSpeed * sz,
  });
  const flowLength = Math.hypot(velocity.x, velocity.z);
  if (flowLength > 1e-6) {
    const speed = Math.abs(body.flowSpeed) / flowLength;
    velocity.x *= speed; velocity.y *= speed; velocity.z *= speed;
  }
  velocity.y += wave.velocity;
  distance += wave.height;
  return {
    found: true, height: position.y + distance, depth: distance,
    normal: { x: normal.x / magnitude, y: normal.y / magnitude, z: normal.z / magnitude },
    velocity, edgeDistance: footprint.edge / (Math.hypot(footprint.edgeX / sx, footprint.edgeZ / sz) || 1),
  };
}
