import type { Quat, Transform, Vec3 } from "./math-rng";
import type { LandscapeProperties } from "./landscape";

export type WaterRemovalShape = "box" | "sphere" | "cylinder" | "capsule";
export const WATER_REMOVAL_SHAPES: readonly WaterRemovalShape[] = ["box", "sphere", "cylinder", "capsule"];

/**
 * Removes water inside a primitive, in component-local metres. Sphere, cylinder and capsule
 * use Width as their diameter; cylinder and capsule stand along local Y with total Height.
 */
export interface WaterRemovalProperties {
  enabled: boolean;
  shape: WaterRemovalShape;
  width: number;
  height: number;
  length: number;
}

const finite = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;

export function normalizeWaterRemoval(value: unknown): WaterRemovalProperties {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    enabled: v.enabled !== false,
    shape: WATER_REMOVAL_SHAPES.includes(v.shape as WaterRemovalShape) ? v.shape as WaterRemovalShape : "box",
    width: finite(v.width, 4, 0.01, 10000),
    height: finite(v.height, 4, 0.01, 10000),
    length: finite(v.length, 4, 0.01, 10000),
  };
}

/** Signed distance to the primitive surface in local units; negative inside. */
export function waterRemovalDistance(volume: WaterRemovalProperties, p: Vec3): number {
  if (volume.shape === "sphere") return Math.hypot(p.x, p.y, p.z) - volume.width / 2;
  if (volume.shape === "capsule") {
    const radius = volume.width / 2, half = Math.max(0, volume.height / 2 - radius);
    return Math.hypot(p.x, p.y - Math.max(-half, Math.min(half, p.y)), p.z) - radius;
  }
  if (volume.shape === "cylinder") {
    const dx = Math.hypot(p.x, p.z) - volume.width / 2, dy = Math.abs(p.y) - volume.height / 2;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  const qx = Math.abs(p.x) - volume.width / 2, qy = Math.abs(p.y) - volume.height / 2, qz = Math.abs(p.z) - volume.length / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

/**
 * `quatRotateVector(inverseQuat(rotation), (x, y, z))` written into `out`: the same arithmetic, including an
 * all-zero quaternion reading as identity, without the intermediate objects.
 */
function rotateByInverseInto(rotation: Partial<Quat>, x: number, y: number, z: number, out: Vec3): void {
  let qx = Number(rotation.x ?? 0), qy = Number(rotation.y ?? 0), qz = Number(rotation.z ?? 0), qw = Number(rotation.w ?? 1);
  if (qx === 0 && qy === 0 && qz === 0 && qw === 0) { qx = qy = qz = 0; qw = 1; }
  qx = -qx; qy = -qy; qz = -qz;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}

/** `worldToLocal` of (x, y, z) into `out`; false (leaving `out` unchanged) when a scale axis is degenerate. */
function worldToLocalInto(transform: Transform, x: number, y: number, z: number, out: Vec3): boolean {
  const { x: sx, y: sy, z: sz } = transform.scale;
  if (Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz)) < 1e-9) return false;
  rotateByInverseInto(transform.rotation, x - transform.position.x, y - transform.position.y, z - transform.position.z, out);
  out.x /= sx; out.y /= sy; out.z /= sz;
  return true;
}

export function worldToLocal(transform: Transform, point: Vec3): Vec3 | null {
  const local: Vec3 = { x: 0, y: 0, z: 0 };
  return worldToLocalInto(transform, point.x, point.y, point.z, local) ? local : null;
}

/** Terrain height in landscape-local space, matching the rendered and collision triangles. Null outside. */
export function landscapeHeightAt(data: LandscapeProperties, x: number, z: number): number | null {
  const gx = (x + data.width / 2) / data.width * data.subdivisions;
  const gz = (z + data.depth / 2) / data.depth * data.subdivisions;
  if (!(gx >= 0 && gz >= 0 && gx <= data.subdivisions && gz <= data.subdivisions)) return null;
  const ix = Math.min(data.subdivisions - 1, Math.floor(gx)), iz = Math.min(data.subdivisions - 1, Math.floor(gz));
  const fx = gx - ix, fz = gz - iz, side = data.subdivisions + 1;
  const a = iz * side + ix, b = a + side;
  const ha = data.heights[a]!, h1 = data.heights[a + 1]!, hb = data.heights[b]!, hb1 = data.heights[b + 1]!;
  // Triangles (a, a+1, b) and (a+1, b+1, b) share the a+1 -> b diagonal.
  return fx + fz <= 1
    ? ha + (h1 - ha) * fx + (hb - ha) * fz
    : hb1 + (hb - hb1) * (1 - fx) + (h1 - hb1) * (1 - fz);
}

// Scratch for the queries below, which run per water sample and finish before returning.
const baseScratch: Vec3 = { x: 0, y: 0, z: 0 }, upScratch: Vec3 = { x: 0, y: 0, z: 0 }, localScratch: Vec3 = { x: 0, y: 0, z: 0 };

/** World-space terrain height below a point, or null when the point is outside the landscape. */
export function landscapeWorldHeightAt(data: LandscapeProperties, transform: Transform, x: number, z: number): number | null {
  // The world vertical through (x, z) is the local line `base + s * step`, where
  // `s` is the world height above the actor. A pitched or rolled landscape
  // moves along local X/Z as `s` changes, so the crossing is solved for rather
  // than sampled at the local point level with the actor's origin.
  const base = baseScratch;
  if (!worldToLocalInto(transform, x, transform.position.y, z, base)) return null;
  const up = upScratch;
  rotateByInverseInto(transform.rotation, 0, 1, 0, up);
  const { x: sx, y: sy, z: sz } = transform.scale;
  const stepX = up.x / sx, stepY = up.y / sy, stepZ = up.z / sz;
  if (Math.abs(stepY) < 1e-9) return null;
  let s = 0;
  for (let i = 0; i < 16; i++) {
    const height = landscapeHeightAt(data, base.x + s * stepX, base.z + s * stepZ);
    if (height === null) return null;
    const next = (height - base.y) / stepY;
    const settled = Math.abs(next - s) < 1e-6;
    s = next;
    if (settled) break;
  }
  return transform.position.y + s;
}

export interface WaterCutters {
  removals: ReadonlyArray<{ volume: WaterRemovalProperties; transform: Transform }>;
  landscapes: ReadonlyArray<{ data: LandscapeProperties; transform: Transform }>;
}

/** True where a removal volume contains the surface point, or terrain rises to or above it. */
export function waterCutAt(cutters: WaterCutters, point: Vec3): boolean {
  for (const { volume, transform } of cutters.removals) {
    if (!volume.enabled) continue;
    if (worldToLocalInto(transform, point.x, point.y, point.z, localScratch) && waterRemovalDistance(volume, localScratch) < 0) return true;
  }
  for (const { data, transform } of cutters.landscapes) {
    const ground = landscapeWorldHeightAt(data, transform, point.x, point.z);
    if (ground !== null && ground >= point.y) return true;
  }
  return false;
}
