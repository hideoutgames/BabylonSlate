/**
 * Which Mirror surfaces draw their reflection in a scene render (Babylon-free, so the policy is testable on its own).
 *
 * Each reflection is one more scene draw on the main thread, so a render draws at most `MIRROR_RENDERS_PER_FRAME`
 * of them; every other surface keeps the image it last drew. Only a surface the view can see (its bounds meet the
 * frustum) from its reflective side is eligible. Surfaces that have never drawn come first, so every visible mirror
 * gets an image; after that the nearest surfaces (by the closest point of their rectangle to the eye) draw, ties
 * going to the older surface.
 */

/** Reflections drawn per scene render; the rest keep their last image. */
export const MIRROR_RENDERS_PER_FRAME = 2;
/** An eye closer than this to a mirror's plane, or behind it, sees no reflection: the mirror camera degenerates. */
export const MIN_MIRROR_EYE_DISTANCE = 1e-3;

export interface MirrorCandidate {
  /** World centre of the surface. */
  cx: number; cy: number; cz: number;
  /** Unit world normal of the reflective side. */
  nx: number; ny: number; nz: number;
  /** World half-extent vectors along the surface's width and height. */
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
  /** Whether the surface's bounds meet the view frustum this render. */
  visible: boolean;
  /** Whether the surface holds a reflection it drew earlier. */
  drawn: boolean;
  /** Registration order: the older surface wins a tie. */
  order: number;
  /** Written by selection: eye distance to the surface's closest point. */
  distance: number;
}

/** The offset along half axis a, clamped to the rectangle, of a point at d from the centre. */
function along(dx: number, dy: number, dz: number, ax: number, ay: number, az: number): number {
  const length = ax * ax + ay * ay + az * az;
  return length > 0 ? Math.min(1, Math.max(-1, (dx * ax + dy * ay + dz * az) / length)) : 0;
}

/** Distance from the eye to the closest point of the candidate's rectangle (half axes taken as perpendicular). */
function rectangleDistance(x: number, y: number, z: number, c: MirrorCandidate): number {
  const dx = x - c.cx, dy = y - c.cy, dz = z - c.cz;
  const u = along(dx, dy, dz, c.ux, c.uy, c.uz), v = along(dx, dy, dz, c.vx, c.vy, c.vz);
  return Math.hypot(dx - u * c.ux - v * c.vx, dy - u * c.uy - v * c.vy, dz - u * c.uz - v * c.vz);
}

function compareCandidates(a: MirrorCandidate, b: MirrorCandidate): number {
  if (a.drawn !== b.drawn) return a.drawn ? 1 : -1;
  return a.distance - b.distance || a.order - b.order;
}

/**
 * Writes into `out` the candidates that draw this render, in draw order: visible ones whose reflective side faces the
 * eye, never-drawn first, then nearest first, at most `budget` of them.
 */
export function selectMirrorsToRender<T extends MirrorCandidate>(
  eye: { readonly x: number; readonly y: number; readonly z: number },
  candidates: readonly T[], budget: number, out: T[],
): void {
  out.length = 0;
  for (const candidate of candidates) {
    if (!candidate.visible) continue;
    const facing = (eye.x - candidate.cx) * candidate.nx + (eye.y - candidate.cy) * candidate.ny + (eye.z - candidate.cz) * candidate.nz;
    if (!(facing > MIN_MIRROR_EYE_DISTANCE)) continue;
    candidate.distance = rectangleDistance(eye.x, eye.y, eye.z, candidate);
    out.push(candidate);
  }
  out.sort(compareCandidates);
  if (out.length > budget) out.length = Math.max(0, budget);
}
