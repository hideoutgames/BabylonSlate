import { Camera, Vector3, type AbstractEngine, type AbstractMesh, type Scene } from "@babylonjs/core";
import { effectDrawnOn } from "./first-draw-stats";
import { isEditorHelperMesh } from "./helper-mesh";
import { drawingMesh } from "./instance-source";
import { OcclusionBuffer } from "./occlusion-raster";
import { keepsDrawingOutsideView } from "./play-view-culling";
import { sceneRenderingSettings } from "./render-settings";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";
import { RENDERING_GROUP } from "./sorting";

/**
 * Occlusion culling for a world view's camera: after the camera's frustum cull, meshes wholly hidden behind occluders
 * leave the list the view's colour, geometry and water passes draw (`ViewOcclusion.filter`). The test is conservative
 * (`occlusion-raster.ts`): it never removes a mesh any part of which is in view.
 *
 * - Occluders are meshes with a registered shape (`registerOccluderShape`; primitives register theirs as they are
 *   built): a convex box that lies inside the mesh. One draws as an occluder only while it is in the view's list and
 *   opaque: not blended or alpha-tested, not deforming (`hasDeformingShadowBounds`), not an editor helper, in
 *   the world rendering group. A single-sided plane occludes only with back-face culling off. Occluders are ranked by their
 *   size on screen up to `OCCLUDER_TRIANGLE_BUDGET`.
 * - Every mesh in the list is an occludee, tested by its world bounding box, except those the view must draw whatever
 *   it shows: the always-drawn (`keepsDrawingOutsideView`, `alwaysSelectAsActiveMesh`), editor helpers, meshes in a
 *   rendering group after the world's (it may clear depth first) or with their own depth function (they draw over what
 *   is in front), and, on WebGL2, a mesh whose
 *   colour pass Effect has not drawn yet: its first draw links the program, which must not wait for it to come into view.
 * - Only perspective cameras, and never in a frame drawn without view culling (`skipFrustumClipping`).
 * - Nothing of Babylon's state changes: the filter writes its own list, so shadows, captures, mirrors, probes, picking
 *   and outline masks, which build their own lists, still see every mesh.
 */

/** A convex box inside an occluder mesh, in its local space; `singleSided` for a flat plane that hides only from its front. */
export interface OccluderShape {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly singleSided?: boolean;
}

/** Triangles drawn as occluders per frame, the largest on screen first. */
export const OCCLUDER_TRIANGLE_BUDGET = 3000;
/**
 * An occluder whose bounding sphere's radius spans fewer buffer texels is not drawn: small ones cost a raster and an
 * erosion each and seldom hide a whole box (until the tuning pass measures it on device).
 */
const MIN_OCCLUDER_TEXELS = 16;
const BUFFER_WIDTH = 256;
const BUFFER_HEIGHT = 128;

const shapes = new WeakMap<AbstractMesh, OccluderShape>();
const enabledScenes = new WeakSet<Scene>();
/** Each Scene's world view's last filtered frame (`sceneOcclusionDiagnostics`). */
const sceneDiagnostics = new WeakMap<Scene, ViewOcclusionDiagnostics>();

/** Makes `mesh` an occluder with `shape`; null makes it none. */
export function registerOccluderShape(mesh: AbstractMesh, shape: OccluderShape | null): void {
  if (shape) shapes.set(mesh, shape);
  else shapes.delete(mesh);
}

/** The occluder shape of `mesh`, or of the source it is an instance of. */
export function occluderShape(mesh: AbstractMesh): OccluderShape | undefined {
  return shapes.get(mesh) ?? shapes.get(drawingMesh(mesh));
}

/**
 * The shape of a primitive of `kind` whose local bounds are [min, max]: the box itself, a cube inside a sphere, a box
 * inside a cylinder, or a flat single-sided plane. Others (a ground, a sprite, a marker) occlude nothing.
 */
export function primitiveOccluderShape(kind: string | null | undefined, min: readonly number[], max: readonly number[]): OccluderShape | null {
  const centre = [0, 1, 2].map((axis) => (min[axis]! + max[axis]!) / 2) as [number, number, number];
  const half = [0, 1, 2].map((axis) => (max[axis]! - min[axis]!) / 2);
  const box = (hx: number, hy: number, hz: number, singleSided = false): OccluderShape => ({
    min: [centre[0] - hx, centre[1] - hy, centre[2] - hz], max: [centre[0] + hx, centre[1] + hy, centre[2] + hz], singleSided,
  });
  switch (kind) {
    case "box":
    case undefined:
    case null:
      return box(half[0]!, half[1]!, half[2]!);
    // The cube's corners on a sphere 0.95 of the radius: inside the tessellated sphere, whose faces lie within 1 %.
    case "sphere": {
      const h = (Math.min(...half) * 0.95) / Math.sqrt(3);
      return box(h, h, h);
    }
    // The square inside a circle 0.95 of the radius, the full height.
    case "cylinder": {
      const h = (Math.min(half[0]!, half[2]!) * 0.95) / Math.SQRT2;
      return box(h, half[1]!, h);
    }
    case "plane":
    case "quad":
      return box(half[0]!, half[1]!, half[2]!, true);
    default:
      return null;
  }
}

/**
 * Lets `scene`'s world views cull by occlusion while its Occlusion Culling quality setting is on (create-engine's Play
 * and player Scenes); a Scene never allowed never culls, whatever the setting.
 */
export function allowSceneOcclusionCulling(scene: Scene, allowed: boolean): void {
  if (allowed) enabledScenes.add(scene);
  else enabledScenes.delete(scene);
}

/** Whether `scene`'s world views cull by occlusion now: allowed, and the setting on. */
export function sceneOcclusionCulling(scene: Scene): boolean {
  return enabledScenes.has(scene) && sceneRenderingSettings(scene).occlusionCulling;
}

/** The last frame `scene`'s world view culled by occlusion; null while it does not. */
export function sceneOcclusionDiagnostics(scene: Scene): Readonly<ViewOcclusionDiagnostics> | null {
  return sceneOcclusionCulling(scene) ? sceneDiagnostics.get(scene) ?? null : null;
}

export interface ViewOcclusionDiagnostics {
  /** Meshes tested and of them those culled, in the last filtered frame. */
  tested: number;
  culled: number;
  occluders: number;
  triangles: number;
  /** The filter's time in the last frame, in milliseconds. */
  ms: number;
}

/**
 * A box's twelve triangles over corners numbered x + 2y + 4z, each wound counter-clockwise seen from outside the box
 * (its edges' cross product points out), so a face toward the camera has one screen winding: clockwise for Babylon's
 * left-handed view and projection and an unmirrored world matrix, flipped by each mirror (`ViewOcclusion.frontWinding`).
 * Only front faces draw: they cover the box's silhouette, nearer than its back.
 */
const BOX_INDICES = boxIndices();

function boxIndices(): number[] {
  const corner = (index: number) => [index & 1, (index >> 1) & 1, (index >> 2) & 1];
  const indices: number[] = [];
  for (const [a, b, c, d, axis, sign] of [
    [0, 2, 6, 4, 0, -1], [1, 3, 7, 5, 0, 1], [0, 1, 5, 4, 1, -1], [2, 3, 7, 6, 1, 1], [0, 1, 3, 2, 2, -1], [4, 5, 7, 6, 2, 1],
  ] as const) {
    const [pa, pb, pc] = [corner(a), corner(b), corner(c)];
    const u = pb.map((value, index) => value - pa[index]!), v = pc.map((value, index) => value - pa[index]!);
    const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    indices.push(...(normal[axis]! * sign > 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c]));
  }
  return indices;
}

/** One world view's occlusion buffer and filtered list (no allocation per frame once warm). */
export class ViewOcclusion {
  private readonly buffer = new OcclusionBuffer(BUFFER_WIDTH, BUFFER_HEIGHT);
  private readonly kept: AbstractMesh[] = [];
  private readonly candidates: AbstractMesh[] = [];
  private readonly coverage: number[] = [];
  private readonly order: number[] = [];
  private readonly matrix = new Float64Array(16);
  /** The sign the view and projection give a world triangle's screen winding (positive: Babylon's left-handed own). */
  private viewParity = 1;
  private readonly corners = new Float64Array(24);
  private readonly flat = new Float64Array(24);
  readonly diagnostics: ViewOcclusionDiagnostics = { tested: 0, culled: 0, occluders: 0, triangles: 0, ms: 0 };
  /** The meshes the last filtered frame left out. */
  readonly culled = new Set<AbstractMesh>();

  /**
   * `meshes` without those hidden behind the occluders among them, as seen by `camera` (its view and projection as
   * last computed); `meshes` itself when nothing is hidden or the view is not culled. `renderPassId` is the colour
   * pass whose first draws keep a mesh drawn.
   */
  filter(meshes: readonly AbstractMesh[], camera: Camera, renderPassId: number): readonly AbstractMesh[] {
    const diagnostics = this.diagnostics;
    diagnostics.tested = diagnostics.culled = diagnostics.occluders = diagnostics.triangles = 0;
    diagnostics.ms = 0;
    this.culled.clear();
    const scene = camera.getScene();
    if (!sceneOcclusionCulling(scene) || camera.mode !== Camera.PERSPECTIVE_CAMERA || scene.skipFrustumClipping) return meshes;
    sceneDiagnostics.set(scene, diagnostics);
    const start = performance.now();
    try {
      if (!this.drawOccluders(meshes, camera)) return meshes;
      return this.cull(meshes, scene.getEngine(), renderPassId);
    } finally {
      diagnostics.ms = performance.now() - start;
    }
  }

  private drawOccluders(meshes: readonly AbstractMesh[], camera: Camera): boolean {
    const { candidates, coverage, order } = this;
    candidates.length = coverage.length = order.length = 0;
    const eye = camera.globalPosition;
    const projection = camera.getProjectionMatrix().m;
    // Buffer texels per unit of radius over distance.
    const texelScale = projection[5]! * BUFFER_HEIGHT * 0.5;
    for (const mesh of meshes) {
      if (!occluderShape(mesh) || !occludes(mesh)) continue;
      const sphere = mesh.getBoundingInfo().boundingSphere;
      const distance = Math.max(Vector3.Distance(sphere.centerWorld, eye) - sphere.radiusWorld, camera.minZ);
      const size = (sphere.radiusWorld / distance) * texelScale;
      if (size < MIN_OCCLUDER_TEXELS) continue;
      order.push(candidates.length);
      candidates.push(mesh);
      coverage.push(size);
    }
    if (candidates.length === 0) return false;
    order.sort((a, b) => coverage[b]! - coverage[a]!);
    this.viewProjection(camera);
    this.buffer.begin(this.matrix, camera.minZ);
    const diagnostics = this.diagnostics;
    for (const index of order) {
      if (diagnostics.triangles + 12 > OCCLUDER_TRIANGLE_BUDGET) break;
      const mesh = candidates[index]!;
      diagnostics.triangles += this.drawOccluder(mesh, occluderShape(mesh)!);
      diagnostics.occluders += 1;
    }
    this.buffer.finish();
    candidates.length = 0;
    return true;
  }

  /** Draws `shape` with `mesh`'s world matrix; returns the triangles drawn. */
  private drawOccluder(mesh: AbstractMesh, shape: OccluderShape): number {
    const world = mesh.getWorldMatrix().m;
    const corners = this.corners;
    for (let corner = 0; corner < 8; corner++) {
      corners[corner * 3] = corner & 1 ? shape.max[0] : shape.min[0];
      corners[corner * 3 + 1] = corner & 2 ? shape.max[1] : shape.min[1];
      corners[corner * 3 + 2] = corner & 4 ? shape.max[2] : shape.min[2];
    }
    if (!shape.singleSided) {
      this.buffer.rasterize(corners, BOX_INDICES, world, this.viewParity * determinant3(world) > 0 ? "clockwise" : "counterClockwise");
      return 12;
    }
    // A plane: its two largest axes span it, at the middle of the third.
    const flat = this.flat;
    const ex = shape.max[0] - shape.min[0], ey = shape.max[1] - shape.min[1], ez = shape.max[2] - shape.min[2];
    const thin = ex <= ey && ex <= ez ? 0 : ey <= ez ? 1 : 2;
    const u = (thin + 1) % 3, v = (thin + 2) % 3;
    const middle = (shape.min[thin]! + shape.max[thin]!) / 2;
    for (let corner = 0; corner < 4; corner++) {
      flat[corner * 3 + thin] = middle;
      flat[corner * 3 + u] = corner & 1 ? shape.max[u]! : shape.min[u]!;
      flat[corner * 3 + v] = corner & 2 ? shape.max[v]! : shape.min[v]!;
    }
    this.buffer.rasterize(flat, PLANE_INDICES, world);
    return 2;
  }

  private cull(meshes: readonly AbstractMesh[], engine: AbstractEngine, renderPassId: number): readonly AbstractMesh[] {
    const kept = this.kept;
    kept.length = 0;
    const diagnostics = this.diagnostics;
    for (let index = 0; index < meshes.length; index++) {
      const mesh = meshes[index]!;
      if (occludable(mesh) && !firstDrawPending(mesh, engine, renderPassId)) {
        diagnostics.tested += 1;
        const box = mesh.getBoundingInfo().boundingBox;
        const min = box.minimumWorld, max = box.maximumWorld;
        if (this.buffer.occluded(min.x, min.y, min.z, max.x, max.y, max.z)) {
          // The first hidden mesh starts the own list with every mesh before it.
          if (diagnostics.culled === 0) for (let before = 0; before < index; before++) kept.push(meshes[before]!);
          diagnostics.culled += 1;
          this.culled.add(mesh);
          continue;
        }
      }
      if (diagnostics.culled > 0) kept.push(mesh);
    }
    return diagnostics.culled > 0 ? kept : meshes;
  }

  /** The camera's view times its projection, in doubles, and the winding parity they give. */
  private viewProjection(camera: Camera): void {
    const view = camera.getViewMatrix().m, projection = camera.getProjectionMatrix().m, out = this.matrix;
    this.viewParity = Math.sign(determinant3(view) * projection[0]! * projection[5]! * projection[11]!) || 1;
    for (let row = 0; row < 4; row++)
      for (let column = 0; column < 4; column++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += view[row * 4 + k]! * projection[k * 4 + column]!;
        out[row * 4 + column] = sum;
      }
  }
}

const PLANE_INDICES = [0, 1, 3, 0, 3, 2];

/** The determinant of a Babylon matrix's upper 3 × 3 (negative for a mirror). */
function determinant3(m: ArrayLike<number>): number {
  return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
}

/** Whether `mesh`, an occluder in the view's list, hides what is behind it this frame. */
function occludes(mesh: AbstractMesh): boolean {
  if (mesh.renderingGroupId !== RENDERING_GROUP.world || mesh.visibility < 1 || isEditorHelperMesh(mesh)) return false;
  const source = drawingMesh(mesh);
  if (source.hasThinInstances || hasDeformingShadowBounds(source)) return false;
  const material = mesh.material;
  if (!material) return true;
  if (material.needAlphaBlendingForMesh(mesh) || material.needAlphaTesting() || material.depthFunction !== 0) return false;
  if (material.disableDepthWrite || material.wireframe || material.pointsCloud) return false;
  const shape = occluderShape(mesh)!;
  return !shape.singleSided || !material.backFaceCulling;
}

/** Whether `mesh` may leave the list when hidden. */
function occludable(mesh: AbstractMesh): boolean {
  if (mesh.alwaysSelectAsActiveMesh || mesh.renderingGroupId > RENDERING_GROUP.world || isEditorHelperMesh(mesh)) return false;
  if (keepsDrawingOutsideView(mesh)) return false;
  return (mesh.material?.depthFunction ?? 0) === 0;
}

/** WebGL2: some colour pass Effect of `mesh` has not drawn yet (its first draw links it); undefined on WebGPU. */
function firstDrawPending(mesh: AbstractMesh, engine: AbstractEngine, renderPassId: number): boolean {
  const source = drawingMesh(mesh);
  for (const subMesh of source.subMeshes ?? []) {
    const effect = subMesh._getDrawWrapper(renderPassId)?.effect;
    if (!effect || effectDrawnOn(engine, effect) === false) return true;
  }
  return false;
}
