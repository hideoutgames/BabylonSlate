import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { rewriteUnreadRenderList } from "./observed-render-list";
import { isRevealPending } from "./reveal-pending";

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
 * Whether a member measured into `bounds` can show nothing this frame: all of it behind the camera, or beside the
 * screen by more than its stroke (`padX`, `padY` in NDC). Bounds crossing the camera plane are kept. Never true for a
 * mesh drawn whatever the view (`alwaysSelectAsActiveMesh`, `infiniteDistance`): it follows the camera, or its
 * vertices leave its bounds, as the view's own cull takes it.
 */
function cannotShow(mesh: AbstractMesh, measured: ScreenBounds, padX: number, padY: number): boolean {
  if (mesh.alwaysSelectAsActiveMesh || mesh.infiniteDistance) return false;
  if (!measured.front) return true;
  if (measured.behind) return false;
  return measured.maxX < -1 - padX || measured.minX > 1 + padX || measured.maxY < -1 - padY || measured.minY > 1 + padY;
}

/**
 * Babylon observes the object renderer's list. `out` is left alone when the meshes are unchanged, and rewritten in
 * place when they change, by index alone (`rewriteUnreadRenderList`): what a mask draws comes and goes with the view,
 * and Babylon answers a list that fills by dirtying every mesh's lights, which no mask's list feeds.
 */
function commit(fresh: readonly AbstractMesh[], out: AbstractMesh[]): AbstractMesh[] {
  let same = fresh.length === out.length;
  for (let index = 0; same && index < fresh.length; index++) same = fresh[index] === out[index];
  return same ? out : rewriteUnreadRenderList(out, fresh);
}

/**
 * Whether the view's colour pass writes `mesh`'s depth, so a pass seeded from the scene's depth already holds it (the
 * strict mask as an occluder, a depth-only geometry pass as its surface): every Material it draws with writes depth
 * and is opaque or alpha tested, or blended with a depth pre-pass or a forced depth write. A blended surface without
 * either leaves the scene's depth as it was.
 */
export function writesSceneDepth(mesh: AbstractMesh): boolean {
  const material = mesh.material ?? mesh.getScene().defaultMaterial;
  if (!(material instanceof MultiMaterial)) return writesDepthWith(material, mesh);
  for (const part of material.subMaterials) if (!writesDepthWith(part, mesh)) return false;
  return true;
}

/** Whether `material` draws `mesh` into the scene's depth (`writesSceneDepth`); no Material is the default's. */
function writesDepthWith(material: Material | null | undefined, mesh: AbstractMesh): boolean {
  return !material ||
    (!material.disableDepthWrite && (!material.needAlphaBlendingForMesh(mesh) || material.needDepthPrePass || material.forceDepthWrite));
}

/**
 * A through or selection group's members worth drawing this frame: those that can show, their stroke (`paddingPx`,
 * the group's widest) included (`cannotShow`). `out` and `scratch` as for `cullStrictOccluders`.
 */
export function cullOutlineMembers(
  members: readonly AbstractMesh[], camera: Camera, widthPx: number, heightPx: number, paddingPx: number,
  out: AbstractMesh[] = [], scratch: AbstractMesh[] = [],
): AbstractMesh[] {
  const fresh = scratch;
  fresh.length = 0;
  const view = camera.getViewMatrix().m;
  camera.getProjectionMatrix();
  const viewProjection = camera.getTransformationMatrix().m;
  const handedness = camera.getScene().useRightHandedSystem ? -1 : 1;
  const padX = (2 * paddingPx) / Math.max(1, widthPx), padY = (2 * paddingPx) / Math.max(1, heightPx);
  for (const mesh of members) {
    measure(mesh, viewProjection, view, handedness, bounds);
    if (!cannotShow(mesh, bounds, padX, padY)) fresh.push(mesh);
  }
  return commit(fresh, out);
}

/** The strict group's candidates split by membership, each part in the candidates' order (`partitionStrictCandidates`). */
export type StrictCandidates = { readonly members: readonly AbstractMesh[]; readonly others: readonly AbstractMesh[] };

/** Splits `candidates` into the strict group's members and the rest, in their order, into `members` and `others`. */
export function partitionStrictCandidates(
  candidates: readonly AbstractMesh[], isMember: (mesh: AbstractMesh) => boolean,
  members: AbstractMesh[] = [], others: AbstractMesh[] = [],
): StrictCandidates {
  members.length = 0; others.length = 0;
  for (const mesh of candidates) (isMember(mesh) ? members : others).push(mesh);
  return { members, others };
}

/**
 * Strict-group occluders worth drawing this frame. The strict mask only needs
 * depth where a member or its stroke can appear: every member that can show is kept (`cannotShow`), and any
 * other mesh whose screen bounds overlap those members' bounds (padded by the
 * widest stroke) and that starts nearer than the members' farthest point. A
 * mesh beside the members on screen or entirely behind them hides neither a
 * member pixel nor a stroke pixel. Bounds crossing the camera plane are kept.
 *
 * `out` is the array Babylon observes and is written only when the result
 * differs from what it holds. `scratch` is the working list, reused so a frame
 * allocates nothing; it is not `out`, and it keeps the last cull's meshes alive,
 * so its owner clears it together with `out`.
 *
 * `occludes` narrows the non-members further: a mask seeded from the scene's depth draws only the occluders that
 * depth lacks (`writesSceneDepth`); it never narrows the members.
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
  occludes?: (mesh: AbstractMesh) => boolean,
): AbstractMesh[] {
  return cullPartitionedStrictOccluders(partitionStrictCandidates(candidates, isMember), camera, widthPx, heightPx, paddingPx,
    out, scratch, occludes);
}

/**
 * `cullStrictOccluders` over candidates already split by membership, which keeps the members' work to the members and
 * the occluders' to the rest. With `strokes`, a frame in which no member that can show strokes (`strokes` false for
 * each) walks no occluder: the list is the members that can show, and `outcome.strokes` is false, since such a mask
 * holds no identity the composition draws a stroke from, whatever the occluders. Otherwise `outcome.strokes` is true and
 * the list is `cullStrictOccluders`'s.
 */
export function cullPartitionedStrictOccluders(
  candidates: StrictCandidates,
  camera: Camera,
  widthPx: number,
  heightPx: number,
  paddingPx: number,
  out: AbstractMesh[] = [],
  scratch: AbstractMesh[] = [],
  occludes?: (mesh: AbstractMesh) => boolean,
  strokes?: (mesh: AbstractMesh) => boolean,
  outcome?: { strokes: boolean },
): AbstractMesh[] {
  const fresh = scratch;
  fresh.length = 0;
  // getTransformationMatrix only multiplies the cached view and projection.
  const view = camera.getViewMatrix().m;
  camera.getProjectionMatrix();
  const viewProjection = camera.getTransformationMatrix().m;
  const handedness = camera.getScene().useRightHandedSystem ? -1 : 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, far = -Infinity;
  const padX = (2 * paddingPx) / Math.max(1, widthPx), padY = (2 * paddingPx) / Math.max(1, heightPx);
  let stroked = !strokes;
  for (const mesh of candidates.members) {
    // A mesh a world view does not draw yet (`isRevealPending`) neither outlines nor occludes.
    if (!mesh.isEnabled() || !mesh.isVisible || isRevealPending(mesh)) continue;
    measure(mesh, viewProjection, view, handedness, bounds);
    if (cannotShow(mesh, bounds, padX, padY)) continue;
    fresh.push(mesh);
    if (!stroked && strokes!(mesh)) stroked = true;
    if (!bounds.front) continue;
    far = Math.max(far, bounds.far);
    if (bounds.behind) { minX = minY = -Infinity; maxX = maxY = Infinity; continue; }
    minX = Math.min(minX, bounds.minX); maxX = Math.max(maxX, bounds.maxX);
    minY = Math.min(minY, bounds.minY); maxY = Math.max(maxY, bounds.maxY);
  }
  if (outcome) outcome.strokes = stroked;
  if (!stroked || far === -Infinity) return commit(fresh, out);
  minX = Math.max(-1, minX - padX); maxX = Math.min(1, maxX + padX);
  minY = Math.max(-1, minY - padY); maxY = Math.min(1, maxY + padY);
  if (minX > maxX || minY > maxY) return commit(fresh, out);
  for (const mesh of candidates.others) {
    if (!mesh.isEnabled() || !mesh.isVisible || isRevealPending(mesh)) continue;
    if (occludes && !occludes(mesh)) continue;
    measure(mesh, viewProjection, view, handedness, bounds);
    if (!bounds.front || bounds.near >= far) continue;
    if (!bounds.behind && (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY)) continue;
    fresh.push(mesh);
  }
  return commit(fresh, out);
}
