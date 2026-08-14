import type { NavPoint } from "./types";

/** 2D world (x, y, _) → Recast (x, 0, y). Recast Y is up. */
export function worldToRecast(point: NavPoint): NavPoint {
  return { x: point.x, y: 0, z: point.y };
}

/** Recast (x, _, z) → 2D world (x, z, 0). */
export function recastToWorld(point: NavPoint): NavPoint {
  return { x: point.x, y: point.z, z: 0 };
}
