import type { Transform, Vec3 } from "./math-rng";
import { identityTransform } from "./math-rng";
import { inverseQuat, quatRotateVector } from "./euler";

export type WaterStyle = "realistic" | "stylized";
export type WaterKind = "ocean" | "lake" | "river" | "puddle";
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
  rippleStrength: number;
  rippleScale: number;
  foamAmount: number;
  foamWidth: number;
  colorBands: number;
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
  /** River centreline in component-local coordinates, including elevation. */
  points: [number, number, number][];
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
  return {
    style,
    shallowColor: style === "stylized" ? [0.08, 0.72, 0.76] : [0.08, 0.38, 0.42],
    deepColor: style === "stylized" ? [0.015, 0.22, 0.44] : [0.015, 0.065, 0.12],
    foamColor: [0.9, 0.98, 1],
    opacity: 0.86, roughness: style === "stylized" ? 0.28 : 0.09,
    reflectionStrength: 1, depthColorDistance: 5,
    waveHeight: 0.35, waveLength: 12, waveSpeed: 1.3, waveDirection: 25,
    rippleStrength: 0.12, rippleScale: 2.5,
    foamAmount: style === "stylized" ? 0.55 : 0.2, foamWidth: 0.6,
    colorBands: style === "stylized" ? 4 : 0, density: 1000, materialGuid: null,
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
    rippleStrength: number(v.rippleStrength, d.rippleStrength, 0, 1),
    rippleScale: number(v.rippleScale, d.rippleScale, 0.1, 100),
    foamAmount: number(v.foamAmount, d.foamAmount, 0, 1),
    foamWidth: number(v.foamWidth, d.foamWidth, 0, 20),
    colorBands: Math.round(number(v.colorBands, d.colorBands, 0, 12)),
    density: number(v.density, d.density, 1, 20000),
    materialGuid: guid(v.materialGuid),
  };
}

export function waterKindForClass(classId: string): WaterKind | null {
  switch (classId) {
    case "WaterOceanComponent": return "ocean";
    case "WaterLakeComponent": return "lake";
    case "WaterRiverComponent": return "river";
    case "WaterPuddleComponent": return "puddle";
    default: return null;
  }
}

export function normalizeWaterBody(value: unknown, kind: WaterKind = "lake"): WaterBodyProperties {
  const v = record(value);
  const points = Array.isArray(v.points) ? v.points.slice(0, 128).filter((p) =>
    Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number" && Number.isFinite(n)),
  ).map((p) => tuple(p, [0, 0, 0], -100000, 100000)) : [];
  return {
    kind, assetGuid: guid(v.assetGuid), enabled: v.enabled !== false,
    width: number(v.width, kind === "ocean" ? 256 : kind === "river" ? 6 : kind === "puddle" ? 3 : 30, 0.1, 10000),
    length: number(v.length, kind === "ocean" ? 256 : kind === "puddle" ? 2 : 30, 0.1, 10000),
    depth: number(v.depth, kind === "puddle" ? 0.1 : kind === "ocean" ? 1000 : 5, 0.01, 10000),
    waveScale: number(v.waveScale, kind === "puddle" ? 0.03 : kind === "lake" ? 0.35 : kind === "river" ? 0.15 : 1, 0, 10),
    flowSpeed: number(v.flowSpeed, kind === "river" ? 1.5 : 0, -100, 100),
    flowDirection: number(v.flowDirection, 0, -360, 360),
    points: points.length >= 2 ? points : [[0, 0, -15], [0, 0, 15]],
    resolution: Math.round(number(v.resolution, kind === "ocean" ? 96 : 48, 8, 128)),
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
const waveComponents = [[0, 1, 0.65, 0], [1.1, 1.73, 0.25, 1.2], [-0.7, 2.41, 0.1, 2.7]] as const;

export function sampleWaterWaves(water: WaterDefinition, x: number, z: number, time: number, scale = 1) {
  const angle = water.waveDirection * Math.PI / 180;
  let height = 0, dx = 0, dz = 0, velocity = 0;
  for (const [turn, frequency, amplitude, phase] of waveComponents) {
    const k = 2 * Math.PI * frequency! / water.waveLength;
    const ax = Math.cos(angle + turn!), az = Math.sin(angle + turn!);
    const omega = Math.sqrt(9.81 * k) * water.waveSpeed;
    const a = water.waveHeight * scale * amplitude!;
    const p = k * (ax * x + az * z) - omega * time + phase!;
    height += a * Math.sin(p);
    dx += a * k * ax * Math.cos(p);
    dz += a * k * az * Math.cos(p);
    velocity -= a * omega * Math.cos(p);
  }
  const n = Math.hypot(dx, 1, dz);
  return { height, normal: { x: -dx / n, y: 1 / n, z: -dz / n }, velocity };
}

/** Local footprint, bank distance and sloped river elevation. */
export function waterFootprint(body: WaterBodyProperties, x: number, z: number) {
  if (body.kind === "ocean") return { inside: true, height: 0, edge: Infinity, slopeX: 0, slopeZ: 0, flowY: 0, flowX: Math.cos(body.flowDirection * Math.PI / 180), flowZ: Math.sin(body.flowDirection * Math.PI / 180) };
  if (body.kind !== "river") {
    const radius = Math.hypot(x / (body.width / 2), z / (body.length / 2));
    return { inside: radius <= 1, height: 0, edge: (1 - radius) * Math.min(body.width, body.length) / 2, slopeX: 0, slopeZ: 0, flowY: 0, flowX: Math.cos(body.flowDirection * Math.PI / 180), flowZ: Math.sin(body.flowDirection * Math.PI / 180) };
  }
  let best = Infinity, height = 0, flowX = 0, flowZ = 1, slopeX = 0, slopeZ = 0, flowY = 0;
  for (let i = 1; i < body.points.length; i++) {
    const a = body.points[i - 1]!, b = body.points[i]!;
    const vx = b[0] - a[0], vz = b[2] - a[2], length = Math.hypot(vx, vz);
    if (length < 1e-6) continue;
    const t = clamp(((x - a[0]) * vx + (z - a[2]) * vz) / (length * length), 0, 1);
    const distance = Math.hypot(x - a[0] - t * vx, z - a[2] - t * vz);
    if (distance < best) {
      best = distance; height = a[1] + t * (b[1] - a[1]); flowX = vx / length; flowZ = vz / length;
      flowY = (b[1] - a[1]) / length;
      const slope = t > 0 && t < 1 ? flowY : 0;
      slopeX = slope * flowX; slopeZ = slope * flowZ;
    }
  }
  return { inside: best <= body.width / 2, height, edge: body.width / 2 - best, flowX, flowY, flowZ, slopeX, slopeZ };
}

/** Intersect a world-vertical line with the transformed, displaced surface. */
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
    const wave = sampleWaterWaves(water, x, z, time, body.waveScale);
    const dx = footprint.slopeX - wave.normal.x / wave.normal.y;
    const dz = footprint.slopeZ - wave.normal.z / wave.normal.y;
    const residual = origin.y + ray.y * distance - footprint.height - wave.height;
    if (Math.abs(residual) < 1e-5) break;
    const derivative = ray.y - dx * ray.x - dz * ray.z;
    if (Math.abs(derivative) < 1e-6) return emptyWaterSample();
    distance -= residual / derivative;
  }
  const x = origin.x + ray.x * distance, z = origin.z + ray.z * distance;
  const footprint = waterFootprint(body, x, z);
  const wave = sampleWaterWaves(water, x, z, time, body.waveScale);
  if (!footprint.inside || !Number.isFinite(distance) || Math.abs(origin.y + ray.y * distance - footprint.height - wave.height) > 0.001) return emptyWaterSample();
  const normal = quatRotateVector(transform.rotation, {
    x: (wave.normal.x / wave.normal.y - footprint.slopeX) / sx,
    y: 1 / sy,
    z: (wave.normal.z / wave.normal.y - footprint.slopeZ) / sz,
  });
  const magnitude = Math.hypot(normal.x, normal.y, normal.z) * (normal.y < 0 ? -1 : 1);
  const velocity = quatRotateVector(transform.rotation, {
    x: footprint.flowX * body.flowSpeed * sx,
    y: (footprint.flowY * body.flowSpeed + wave.velocity) * sy,
    z: footprint.flowZ * body.flowSpeed * sz,
  });
  return {
    found: true, height: position.y + distance, depth: distance,
    normal: { x: normal.x / magnitude, y: normal.y / magnitude, z: normal.z / magnitude },
    velocity, edgeDistance: footprint.edge * Math.min(Math.abs(sx), Math.abs(sz)),
  };
}
