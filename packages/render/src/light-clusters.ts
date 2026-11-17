import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Light clusters for the light block: the rendering camera's view volume cut into screen tiles and exponential view
 * depth slices, each holding a bitmask of the local lights whose range can reach it (word 0: point lights by record
 * index; word 1: spot lights in bits 0-15, rect lights in bits 16-19; a rect light reaches the clusters not wholly behind
 * its emitting side). A surface finds its cluster by projecting its
 * world position with the matrix the clusters were built with, so any view reads correct masks; a position outside
 * them (another camera's view, a mirror's) reads every light. The shape is fixed, so no light or camera change compiles.
 */
export const CLUSTER_TILES_X = 16;
export const CLUSTER_TILES_Y = 8;
export const CLUSTER_SLICES = 15;
export const CLUSTER_COUNT = CLUSTER_TILES_X * CLUSTER_TILES_Y * CLUSTER_SLICES;
/** The far end of the last finite slice; the last slice extends past it. */
const CLUSTER_FAR_LIMIT = 500;
/**
 * The block's words: a header of six vec4s (the clusters' view-projection, the view depth row, then near, log scale and
 * an enabled flag), then two mask words per cluster. 15456 bytes: within WebGL2's 16 KiB uniform block minimum.
 */
export const CLUSTER_HEADER_FLOATS = 24;
export const CLUSTER_BLOCK_WORDS = CLUSTER_HEADER_FLOATS + CLUSTER_COUNT * 2;
const CLUSTER_SPOT_BIT = 0;
const CLUSTER_RECT_BIT = 16;

/** The view the clusters cut: its absolute view and projection matrices and its depth range. */
type ClusterView = { view: Matrix; projection: Matrix; near: number; far: number };

/**
 * A local light as the clusters see it: its record's kind and index, and a sphere bounding its reach (a point or spot
 * light's), or a plane its light reaches only in front of (a rect light's: its centre and its emitting side's normal,
 * `nx`, `ny`, `nz`, of any length; zero for a sphere).
 */
export type ClusterLight = {
  kind: "point" | "spot" | "rect"; index: number; x: number; y: number; z: number; radius: number; nx: number; ny: number; nz: number;
};
/**
 * How far behind a rect light's plane a cluster must lie to drop the light, per unit of the plane normal's length and of
 * distance from the view and the light: far wider than the float32 rounding of the shader's plane test and cluster
 * lookup, so a position the shader lights is never in a cluster without the light.
 */
const PLANE_TOLERANCE = 1e-4;

const relativeView = new Matrix();
const inverseView = new Matrix();
const viewProjection = new Matrix();
const center = new Vector3();
const corner = new Vector3();
/** A build's slices' near view depths; each slice ends at the next one's, the last one past the far limit. */
const sliceDepths = new Float64Array(CLUSTER_SLICES);
/** A build's tile edges in view space per unit of depth: each tile's low then high edge, x then y. */
const tileEdgesX = new Float64Array(CLUSTER_TILES_X * 2);
const tileEdgesY = new Float64Array(CLUSTER_TILES_Y * 2);

/** The view slice `depth` lies in, for a build's near plane and log scale. */
function slice(depth: number, near: number, logScale: number): number {
  return Math.min(CLUSTER_SLICES - 1, Math.max(0, Math.floor(Math.log(depth / near) * logScale)));
}

/** The screen tile an NDC coordinate lies in, of `count` across. */
function tile(ndc: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor((ndc * 0.5 + 0.5) * count)));
}

/** Fills `edges` with each of `count` tiles' two edges for a projection's scale and shift on that axis. */
function fillTileEdges(edges: Float64Array, count: number, scale: number, shift: number): void {
  for (let index = 0; index < count; index++) {
    edges[index * 2] = ((index / count) * 2 - 1 - shift) / scale;
    edges[index * 2 + 1] = (((index + 1) / count) * 2 - 1 - shift) / scale;
  }
}

/**
 * The distance from `centre` to a tile's view-space extent on one axis over the depths z0 to zFar: the box spans the
 * extremes of its two edges (`low`, `high`) at the two depths.
 */
function axisDistance(low: number, high: number, z0: number, zFar: number, centre: number): number {
  const min = Math.min(low * z0, low * zFar, high * z0, high * zFar);
  const max = Math.max(low * z0, low * zFar, high * z0, high * zFar);
  return centre < min ? min - centre : centre > max ? centre - max : 0;
}

/**
 * Whether a perspective cluster (tile tx, ty of slice s) reaches the sphere at view-space (x, y, z) of radius r: the
 * cluster's view-space box, its x and y over the slice's depth range (finite: the last slice tests up to the sphere's
 * far side), against the sphere.
 */
function clusterReaches(tx: number, ty: number, s: number, x: number, y: number, z: number, r: number): boolean {
  const z0 = sliceDepths[s]!;
  const z1 = s === CLUSTER_SLICES - 1 ? Infinity : sliceDepths[s + 1]!;
  const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
  if (dz >= r) return false;
  const zFar = Math.min(z1, z + r);
  const dx = axisDistance(tileEdgesX[tx * 2]!, tileEdgesX[tx * 2 + 1]!, z0, zFar, x);
  const dy = axisDistance(tileEdgesY[ty * 2]!, tileEdgesY[ty * 2 + 1]!, z0, zFar, y);
  return dx * dx + dy * dy + dz * dz < r * r;
}

/** Whether a cluster lies wholly behind a plane test: at every corner `f(v) + tolerance * (reach + |v|) < 0`. */
function cornerBehind(ax: number, ay: number, az: number, b: number, tolerance: number, reach: number, x: number, y: number, z: number): boolean {
  return ax * x + ay * y + az * z + b + tolerance * (reach + Math.sqrt(x * x + y * y + z * z)) < 0;
}

/**
 * Sets a rect light's `flag` in every cluster not wholly behind its plane. The shader's rect light (`hapticLtcEvaluate`)
 * is exactly zero behind it, so a cluster wholly behind may drop it. The plane in view space is f(v) = a·v + b (f >= 0
 * in front), through the view's inverse, so a mirrored view keeps its sides. A perspective cluster is the frustum piece
 * between its slice's depths and its tile's edges, an orthographic one the box between them; f plus the tolerance is
 * convex, so its corners bound it. The last slice has no far end: it is behind only where each of its edges also runs
 * away from the plane. A projection of another form marks every cluster.
 */
function markRect(masks: Uint32Array, word: number, flag: number, light: ClusterLight, perspective: boolean, standard: boolean): void {
  const inv = inverseView.m;
  const nx = light.nx, ny = light.ny, nz = light.nz;
  const ax = inv[0]! * nx + inv[1]! * ny + inv[2]! * nz;
  const ay = inv[4]! * nx + inv[5]! * ny + inv[6]! * nz;
  const az = inv[8]! * nx + inv[9]! * ny + inv[10]! * nz;
  const b = inv[12]! * nx + inv[13]! * ny + inv[14]! * nz - (nx * light.x + ny * light.y + nz * light.z);
  const tolerance = PLANE_TOLERANCE * Math.sqrt(ax * ax + ay * ay + az * az);
  Vector3.TransformCoordinatesFromFloatsToRef(light.x, light.y, light.z, relativeView, center);
  const v = relativeView.m;
  const reach = 1 + center.length() + Math.sqrt(v[12]! * v[12]! + v[13]! * v[13]! + v[14]! * v[14]!);
  for (let s = 0; s < CLUSTER_SLICES; s++) {
    const last = s === CLUSTER_SLICES - 1;
    const z0 = sliceDepths[s]!;
    const z1 = last ? z0 : sliceDepths[s + 1]!;
    for (let ty = 0; ty < CLUSTER_TILES_Y; ty++)
      for (let tx = 0; tx < CLUSTER_TILES_X; tx++) {
        let behind = standard && tolerance > 0;
        for (let corner = 0; behind && corner < 8; corner++) {
          const ex = tileEdgesX[tx * 2 + (corner & 1)]!;
          const ey = tileEdgesY[ty * 2 + ((corner >> 1) & 1)]!;
          const z = corner & 4 ? z1 : z0;
          if (corner & 4 && last) {
            // The edge's direction: f must not rise along it.
            const dx = perspective ? ex : 0, dy = perspective ? ey : 0;
            behind = ax * dx + ay * dy + az + tolerance * Math.sqrt(dx * dx + dy * dy + 1) < 0;
          } else behind = cornerBehind(ax, ay, az, b, tolerance, reach, perspective ? ex * z : ex, perspective ? ey * z : ey, z);
        }
        if (behind) continue;
        const cluster = (s * CLUSTER_TILES_Y + ty) * CLUSTER_TILES_X + tx;
        masks[cluster * 2 + word] = (masks[cluster * 2 + word]! | flag) >>> 0;
      }
  }
}

/**
 * Fills `masks` (two words per cluster) and `header` for `view` from `lights`, whose positions are relative to the
 * floating origin `offset`, as the block's records are. A rect light reaches every cluster not wholly behind its
 * emitting side (`markRect`). Without a view the header sends every position to every light. The slice depths and tile
 * edges are computed once per build, not per cluster tested.
 */
export function buildLightClusters(
  masks: Uint32Array,
  header: Float32Array,
  lights: readonly ClusterLight[],
  clusterView: ClusterView | null,
  offset: Vector3,
): void {
  masks.fill(0);
  header.fill(0);
  if (!clusterView) return;
  // Block positions are relative to the floating origin; the view's matrices are absolute.
  Matrix.TranslationToRef(offset.x, offset.y, offset.z, relativeView);
  relativeView.multiplyToRef(clusterView.view, relativeView);
  relativeView.invertToRef(inverseView);
  const projection = clusterView.projection;
  relativeView.multiplyToRef(projection, viewProjection);
  const near = Math.max(clusterView.near, 1e-4);
  const far = Math.max(near * 2, Math.min(clusterView.far > 0 ? clusterView.far : CLUSTER_FAR_LIMIT, CLUSTER_FAR_LIMIT));
  const logScale = CLUSTER_SLICES / Math.log(far / near);
  const view = relativeView.m;
  header.set(viewProjection.m, 0);
  // A position's view depth: dot((x, y, z, 1), this row).
  header[16] = view[2]!;
  header[17] = view[6]!;
  header[18] = view[10]!;
  header[19] = view[14]!;
  header[20] = near;
  header[21] = logScale;
  header[22] = 1;
  // A perspective camera's clusters are frustum pieces: each is tested against the light's sphere through its view
  // space box. An orthographic camera's keep the screen and depth bounds alone.
  const p = projection.m;
  const perspective = p[11] !== 0;
  for (let s = 0; s < CLUSTER_SLICES; s++) sliceDepths[s] = near * Math.exp(s / logScale);
  // Tile edges per unit of depth (perspective) or in view space (orthographic), for the projections they describe:
  // a perspective one whose clip w is the view depth, an orthographic one without skew. Rect lights test them.
  const standard = perspective
    ? p[11] === 1 && p[15] === 0 && p[1] === 0 && p[3] === 0 && p[4] === 0 && p[7] === 0 && p[12] === 0 && p[13] === 0
    : p[15] === 1 && p[1] === 0 && p[3] === 0 && p[4] === 0 && p[7] === 0 && p[8] === 0 && p[9] === 0;
  fillTileEdges(tileEdgesX, CLUSTER_TILES_X, p[0]!, perspective ? p[8]! : p[12]!);
  fillTileEdges(tileEdgesY, CLUSTER_TILES_Y, p[5]!, perspective ? p[9]! : p[13]!);
  for (const light of lights) {
    const bit = light.kind === "point" ? light.index : light.kind === "spot" ? CLUSTER_SPOT_BIT + light.index : CLUSTER_RECT_BIT + light.index;
    const word = light.kind === "point" ? 0 : 1;
    const flag = (1 << bit) >>> 0;
    if (light.kind === "rect") {
      markRect(masks, word, flag, light, perspective, standard);
      continue;
    }
    Vector3.TransformCoordinatesFromFloatsToRef(light.x, light.y, light.z, relativeView, center);
    const r = light.radius;
    if (center.z + r < near) continue;
    let tx0 = 0, tx1 = CLUSTER_TILES_X - 1, ty0 = 0, ty1 = CLUSTER_TILES_Y - 1;
    // A sphere crossing the near plane may cover any tile; otherwise its view-space box's corners bound its tiles.
    if (center.z - r > near) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let index = 0; index < 8; index++) {
        corner.set(center.x + (index & 1 ? r : -r), center.y + (index & 2 ? r : -r), center.z + (index & 4 ? r : -r));
        Vector3.TransformCoordinatesToRef(corner, projection, corner);
        minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      }
      if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) continue;
      tx0 = tile(minX, CLUSTER_TILES_X); tx1 = tile(maxX, CLUSTER_TILES_X);
      ty0 = tile(minY, CLUSTER_TILES_Y); ty1 = tile(maxY, CLUSTER_TILES_Y);
    }
    const s0 = center.z - r <= near ? 0 : slice(center.z - r, near, logScale);
    const s1 = slice(center.z + r, near, logScale);
    for (let s = s0; s <= s1; s++)
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          if (perspective && !clusterReaches(tx, ty, s, center.x, center.y, center.z, r)) continue;
          const cluster = (s * CLUSTER_TILES_Y + ty) * CLUSTER_TILES_X + tx;
          masks[cluster * 2 + word] = (masks[cluster * 2 + word]! | flag) >>> 0;
        }
  }
}
