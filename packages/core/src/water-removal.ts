import type { Transform, Vec3 } from "./math-rng";
import { inverseQuat, quatRotateVector } from "./euler";
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

export function worldToLocal(transform: Transform, point: Vec3): Vec3 | null {
  const { x: sx, y: sy, z: sz } = transform.scale;
  if (Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz)) < 1e-9) return null;
  const local = quatRotateVector(inverseQuat(transform.rotation), {
    x: point.x - transform.position.x, y: point.y - transform.position.y, z: point.z - transform.position.z,
  });
  return { x: local.x / sx, y: local.y / sy, z: local.z / sz };
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

/** World-space terrain height below a point, or null when the point is outside the landscape. */
export function landscapeWorldHeightAt(data: LandscapeProperties, transform: Transform, x: number, z: number): number | null {
  // The world vertical through (x, z) is the local line `base + s * step`, where
  // `s` is the world height above the actor. A pitched or rolled landscape
  // moves along local X/Z as `s` changes, so the crossing is solved for rather
  // than sampled at the local point level with the actor's origin.
  const base = worldToLocal(transform, { x, y: transform.position.y, z });
  if (!base) return null;
  const up = quatRotateVector(inverseQuat(transform.rotation), { x: 0, y: 1, z: 0 });
  const { x: sx, y: sy, z: sz } = transform.scale;
  const step = { x: up.x / sx, y: up.y / sy, z: up.z / sz };
  if (Math.abs(step.y) < 1e-9) return null;
  let s = 0;
  for (let i = 0; i < 16; i++) {
    const height = landscapeHeightAt(data, base.x + s * step.x, base.z + s * step.z);
    if (height === null) return null;
    const next = (height - base.y) / step.y;
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
    const local = worldToLocal(transform, point);
    if (local && waterRemovalDistance(volume, local) < 0) return true;
  }
  for (const { data, transform } of cutters.landscapes) {
    const ground = landscapeWorldHeightAt(data, transform, point.x, point.z);
    if (ground !== null && ground >= point.y) return true;
  }
  return false;
}
