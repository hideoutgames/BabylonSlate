import type { AbstractMesh, Camera } from "@babylonjs/core";

/** Screen rectangle (NDC) and view-depth span of one mesh's world bounds. */
type ScreenBounds = { minX: number; maxX: number; minY: number; maxY: number; near: number; far: number; front: number; behind: number };

const EPSILON = 1e-6;

function measure(mesh: AbstractMesh, viewProjection: ArrayLike<number>, view: ArrayLike<number>, handedness: number, out: ScreenBounds): void {
  out.minX = out.minY = out.near = Infinity;
  out.maxX = out.maxY = out.far = -Infinity;
  out.front = out.behind = 0;
  const p = viewProjection, v = view;
  for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
    const { x, y, z } = corner;
    const depth = handedness * (x * v[2]! + y * v[6]! + z * v[10]! + v[14]!);
    out.near = Math.min(out.near, depth);
    out.far = Math.max(out.far, depth);
    const w = x * p[3]! + y * p[7]! + z * p[11]! + p[15]!;
    if (w <= EPSILON) { out.behind++; continue; }
    out.front++;
    const ndcX = (x * p[0]! + y * p[4]! + z * p[8]! + p[12]!) / w;
    const ndcY = (x * p[1]! + y * p[5]! + z * p[9]! + p[13]!) / w;
    out.minX = Math.min(out.minX, ndcX); out.maxX = Math.max(out.maxX, ndcX);
    out.minY = Math.min(out.minY, ndcY); out.maxY = Math.max(out.maxY, ndcY);
  }
}

const bounds: ScreenBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, near: 0, far: 0, front: 0, behind: 0 };

/**
 * Babylon observes the object renderer's list and, on the first push into an empty list, marks every Scene mesh's
 * lights dirty. Leave `out` alone when the occluders are unchanged so that happens only when they change.
 */
function commit(fresh: readonly AbstractMesh[], out: AbstractMesh[]): AbstractMesh[] {
  let same = fresh.length === out.length;
  for (let index = 0; same && index < fresh.length; index++) same = fresh[index] === out[index];
  if (same) return out;
  out.length = 0;
  for (const mesh of fresh) out.push(mesh);
  return out;
}

/**
 * Strict-group occluders worth drawing this frame. The strict mask only needs
 * depth where a member or its stroke can appear: every member is kept, and any
 * other mesh whose screen bounds overlap the members' bounds (padded by the
 * widest stroke) and that starts nearer than the members' farthest point. A
 * mesh beside the members on screen or entirely behind them hides neither a
 * member pixel nor a stroke pixel. Bounds crossing the camera plane are kept.
 *
 * `out` is the array Babylon observes and is written only when the result
 * differs from what it holds. `scratch` is the working list, reused so a frame
 * allocates nothing; it is not `out`, and it keeps the last cull's meshes alive,
 * so its owner clears it together with `out`.
 */
export function cullStrictOccluders(
  candidates: readonly AbstractMesh[],
  isMember: (mesh: AbstractMesh) => boolean,
  camera: Camera,
  widthPx: number,
  heightPx: number,
  paddingPx: number,
  out: AbstractMesh[] = [],
  scratch: AbstractMesh[] = [],
): AbstractMesh[] {
  const fresh = scratch;
  fresh.length = 0;
  // getTransformationMatrix only multiplies the cached view and projection.
  const view = camera.getViewMatrix().m;
  camera.getProjectionMatrix();
  const viewProjection = camera.getTransformationMatrix().m;
  const handedness = camera.getScene().useRightHandedSystem ? -1 : 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, far = -Infinity;
  for (const mesh of candidates) {
    if (!isMember(mesh) || !mesh.isEnabled() || !mesh.isVisible) continue;
    fresh.push(mesh);
    measure(mesh, viewProjection, view, handedness, bounds);
    if (!bounds.front) continue;
    far = Math.max(far, bounds.far);
    if (bounds.behind) { minX = minY = -Infinity; maxX = maxY = Infinity; continue; }
    minX = Math.min(minX, bounds.minX); maxX = Math.max(maxX, bounds.maxX);
    minY = Math.min(minY, bounds.minY); maxY = Math.max(maxY, bounds.maxY);
  }
  if (far === -Infinity) return commit(fresh, out);
  const padX = (2 * paddingPx) / Math.max(1, widthPx), padY = (2 * paddingPx) / Math.max(1, heightPx);
  minX = Math.max(-1, minX - padX); maxX = Math.min(1, maxX + padX);
  minY = Math.max(-1, minY - padY); maxY = Math.min(1, maxY + padY);
  if (minX > maxX || minY > maxY) return commit(fresh, out);
  for (const mesh of candidates) {
    if (isMember(mesh) || !mesh.isEnabled() || !mesh.isVisible) continue;
    measure(mesh, viewProjection, view, handedness, bounds);
    if (!bounds.front || bounds.near >= far) continue;
    if (!bounds.behind && (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY)) continue;
    fresh.push(mesh);
  }
  return commit(fresh, out);
}
