import { Matrix, Vector3, type Camera } from "@babylonjs/core";

/**
 * Light clusters for the light block: the rendering camera's view volume cut into screen tiles and exponential view
 * depth slices, each holding a bitmask of the local lights whose range can reach it (word 0: point lights by record
 * index; word 1: spot lights in bits 0-15, rect lights in bits 16-19). A surface finds its cluster by projecting its
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
export const CLUSTER_SPOT_BIT = 0;
export const CLUSTER_RECT_BIT = 16;

/** A local light as the clusters see it: its record's kind and index, and a sphere bounding its reach. */
export type ClusterLight = { kind: "point" | "spot" | "rect"; index: number; x: number; y: number; z: number; radius: number };

const relativeView = new Matrix();
const viewProjection = new Matrix();
const center = new Vector3();
const corner = new Vector3();

/**
 * Fills `masks` (two words per cluster) and `header` for `camera` from `lights`, whose positions are relative to the
 * floating origin `offset`, as the block's records are. A rect light reaches every cluster: its records have no range.
 */
export function buildLightClusters(
  masks: Uint32Array,
  header: Float32Array,
  lights: readonly ClusterLight[],
  camera: Camera | null,
  offset: Vector3,
): void {
  masks.fill(0);
  header.fill(0);
  if (!camera) return;
  // Block positions are relative to the floating origin; the camera's matrices are absolute.
  Matrix.TranslationToRef(offset.x, offset.y, offset.z, relativeView);
  relativeView.multiplyToRef(camera.getViewMatrix(), relativeView);
  const projection = camera.getProjectionMatrix();
  relativeView.multiplyToRef(projection, viewProjection);
  const near = Math.max(camera.minZ, 1e-4);
  const far = Math.max(near * 2, Math.min(camera.maxZ > 0 ? camera.maxZ : CLUSTER_FAR_LIMIT, CLUSTER_FAR_LIMIT));
  const logScale = CLUSTER_SLICES / Math.log(far / near);
  const view = relativeView.m;
  header.set(viewProjection.m, 0);
  // A position's view depth: dot((x, y, z, 1), this row).
  header.set([view[2]!, view[6]!, view[10]!, view[14]!], 16);
  header.set([near, logScale, 1, 0], 20);
  const slice = (depth: number) => Math.min(CLUSTER_SLICES - 1, Math.max(0, Math.floor(Math.log(depth / near) * logScale)));
  for (const light of lights) {
    const bit = light.kind === "point" ? light.index : light.kind === "spot" ? CLUSTER_SPOT_BIT + light.index : CLUSTER_RECT_BIT + light.index;
    const word = light.kind === "point" ? 0 : 1;
    const flag = (1 << bit) >>> 0;
    if (light.kind === "rect") {
      for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) masks[cluster * 2 + word] = (masks[cluster * 2 + word]! | flag) >>> 0;
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
      const tile = (ndc: number, count: number) => Math.min(count - 1, Math.max(0, Math.floor((ndc * 0.5 + 0.5) * count)));
      tx0 = tile(minX, CLUSTER_TILES_X); tx1 = tile(maxX, CLUSTER_TILES_X);
      ty0 = tile(minY, CLUSTER_TILES_Y); ty1 = tile(maxY, CLUSTER_TILES_Y);
    }
    const s0 = center.z - r <= near ? 0 : slice(center.z - r);
    const s1 = slice(center.z + r);
    for (let s = s0; s <= s1; s++)
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          const cluster = (s * CLUSTER_TILES_Y + ty) * CLUSTER_TILES_X + tx;
          masks[cluster * 2 + word] = (masks[cluster * 2 + word]! | flag) >>> 0;
        }
  }
}
