/**
 * The sun's cascade split. Babylon splits [near + minDistance · (far − near), shadowMaxZ] by mixing a logarithmic and a
 * uniform split with `lambda`; with a 0.1 m near plane its log split puts almost nothing in the first cascade, so a
 * mix that stays usable is close to uniform and spends the near cascade's texels on tens of metres. Haptic anchors a
 * pure log split at `anchor` instead: cascade i ends at anchor · (D / anchor)^((i + 1) / N), which keeps the far end
 * where it was and concentrates texels near the camera.
 *
 * Cascade 0 is drawn for the slice [anchor, end 0], not from the near plane; a stabilized cascade's bounding sphere
 * still covers everything nearer when it contains the camera's eye, which holds when k² · q ≥ 1 (k: the frustum's
 * corner slope, hypot(tanX, tanY); q: end 0 / anchor). Below LOG_SPLIT_MARGIN, and for orthographic cameras, the split
 * stays Babylon's mix from the near plane.
 */

/** The near distance the log split starts from, in metres. */
export const CASCADE_LOG_ANCHOR = 4;
/** The mix Babylon's split keeps where the log split does not apply. */
export const CASCADE_UNIFORM_LAMBDA = 0.7;
/** k² · q above which cascade 0's sphere contains the eye with room to spare (1 is the boundary). */
const LOG_SPLIT_MARGIN = 1.2;

export interface CascadeSplitInput {
  /** Vertical field of view in radians; null for an orthographic camera. */
  fov: number | null;
  /** Width over height of the view. */
  aspect: number;
  near: number;
  /** The camera's far plane; 0 is infinite. */
  far: number;
  /** Shadow distance (`shadowMaxZ`). */
  distance: number;
  cascades: number;
  /** One cascade tile's edge in texels. */
  tile: number;
  /** Where the log split starts; null keeps Babylon's mix from the near plane. */
  anchor: number | null;
}

export interface CascadeSplit {
  /** Babylon's `setMinMaxDistance` minimum, as a fraction of [near, far]. */
  minDistance: number;
  lambda: number;
  /** Per cascade, its far end in view depth (Babylon's `viewFrustumZ`). */
  ends: number[];
  /** Per cascade, map texels per world metre of a stabilized cascade. */
  texelsPerMetre: number[];
}

/**
 * The split Babylon 9.29's `_splitFrustum` draws for `input`, with the log split anchored at `input.anchor` where it
 * applies. Ends mirror Babylon's own computation, so they equal its `_viewSpaceFrustumsZ` for the same camera.
 */
export function cascadeSplit(input: CascadeSplitInput): CascadeSplit {
  const { near, cascades, tile } = input;
  const far = input.far || input.distance;
  const end = input.distance < far && input.distance >= near ? input.distance : far;
  const tanY = input.fov === null ? 0 : Math.tan(input.fov / 2);
  const k = Math.hypot(tanY * input.aspect, tanY);
  const anchor = input.anchor;
  const logSplit = input.fov !== null && anchor !== null && anchor > near && anchor < end
    && k * k * (end / anchor) ** (1 / cascades) >= LOG_SPLIT_MARGIN;
  const minDistance = logSplit ? (anchor - near) / (far - near) : 0;
  const lambda = logSplit ? 1 : CASCADE_UNIFORM_LAMBDA;
  const start = near + minDistance * (far - near);
  const ends: number[] = [];
  const texelsPerMetre: number[] = [];
  for (let index = 0; index < cascades; index++) {
    const p = (index + 1) / cascades;
    const log = start * (end / start) ** p;
    const uniform = start + (end - start) * p;
    const z = lambda * (log - uniform) + uniform;
    const from = index === 0 ? start : ends[index - 1]!;
    ends.push(z);
    texelsPerMetre.push(tile / (2 * stabilizedRadius(from, z, k)));
  }
  return { minDistance, lambda, ends, texelsPerMetre };
}

/** Babylon's stabilized cascade radius: the bounding sphere of the slice [from, to] about its corners' centroid, up to 1/16 m. */
function stabilizedRadius(from: number, to: number, k: number): number {
  return Math.ceil(Math.hypot((to - from) / 2, k * to) * 16) / 16;
}
