/**
 * Planar mirror passes shared by built-in water (Reflections = Planar) and Mirror components.
 *
 * A rigid camera at the view's eye reflected across a plane renders the scene into a leased target, with an oblique
 * near plane on the mirror plane (Lengyel), so nothing behind the mirror reflects and no material compiles a
 * clip-plane variant. The view x axis is flipped so the mirror view stays rigid: triangle winding and back-face
 * culling are unchanged, and the image is mirrored horizontally (a shader projects through the mirror camera's
 * view × projection, so it never needs to know). The pass is drawn capture-style (`drawBorrowedTarget`), never
 * through `scene.customRenderTargets`, which the Forward FrameGraph does not support.
 *
 * Readiness: the mirror camera and target never join the scene's cameras or textures (their construction blocks
 * entity collection), so allocating, resizing and releasing never changes scene membership.
 */
import {
  Camera, Constants, Frustum, Matrix, MultiMaterial, RenderTargetTexture, Texture, ThinTexture, Vector3,
  type AbstractEngine, type Color4, type AbstractMesh, type IParticleSystem, type Plane, type Scene,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import { drawBorrowedTarget } from "./framegraph-borrowed-draw";
import {
  beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease, type ManagedRenderResource,
} from "./managed-render-resources";
import { isRenderTargetCaptureCandidate, renderTargetCaptureDrawing } from "./render-target-capture-state";
import { renderTargetAllocationBytes } from "./render-target-resource-cost";
import { admittedSceneMeshes } from "./scene-stream-admission";

/** A world plane `n·x + d = 0` with unit normal n; the reflective side is `n·x + d > 0`. */
export interface MirrorPlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** Target sizes snap up to this many pixels, so small resizes do not reallocate. */
const SIZE_STEP = 8;
const NO_PARTICLES: IParticleSystem[] = [];

/** A rigid camera whose view matrix is written directly; its projection is frozen to an oblique matrix. */
export class PlanarMirrorCamera extends Camera {
  readonly mirrorView = Matrix.Identity();
  override _getViewMatrix(): Matrix { return this.mirrorView; }
  override getClassName(): string { return "PlanarMirrorCamera"; }
}

export class PlanarMirrorTarget extends RenderTargetTexture {
  configurePass(): void {
    this._objectRenderer.enableOutlineRendering = false;
    this._objectRenderer.disableDepthPrePass = true;
  }

  /** Frees the colour and depth storage; the target, its object renderer and its render pass stay for reuse. */
  releaseStorage(): void {
    this._renderTarget?.dispose();
    this._renderTarget = null;
    this._texture = null;
  }
}

/**
 * A mirror camera and target kept outside scene membership. `lease` is null while the target holds no GPU storage;
 * `thin` borrows the target's texture for sampling.
 */
export interface PlanarMirrorTargetState {
  texture: PlanarMirrorTarget;
  thin: ThinTexture;
  mirror: PlanarMirrorCamera;
  /** The mirror camera's frozen oblique projection, rewritten in place. */
  projection: Matrix;
  lease: ManagedRenderLease | null;
  width: number;
  height: number;
  type: number;
}

export function planarMirrorTargetBytes(width: number, height: number, type: number): number {
  return renderTargetAllocationBytes({ width, height, format: Constants.TEXTUREFORMAT_RGBA, type }) +
    // Conservative depth bound; actual WebGL renderbuffers and WebGPU depth textures commit their real size.
    renderTargetAllocationBytes({ width, height, format: Constants.TEXTUREFORMAT_DEPTH32FLOAT_STENCIL8, renderbuffer: true });
}

/**
 * The view's colour format: display colour on a bgra8unorm WebGPU swap chain is stored BGRA, and WebGPU depth
 * carries the main pass's stencil, so reflected materials reuse the view's WebGPU render pipelines.
 */
function targetFormat(engine: AbstractEngine, type: number): number {
  const swapChain = engine.isWebGPU ? (engine as unknown as { _options?: { swapChainFormat?: string } })._options?.swapChainFormat : undefined;
  return swapChain === "bgra8unorm" && type === Constants.TEXTURETYPE_UNSIGNED_BYTE ? Constants.TEXTUREFORMAT_BGRA : Constants.TEXTUREFORMAT_RGBA;
}

/** A target dimension: `scale` of the view's, snapped up to SIZE_STEP pixels. */
export function planarMirrorTargetSize(view: number, scale: number, maxSize: number): number {
  return Math.min(maxSize, Math.max(SIZE_STEP, Math.ceil(view * scale / SIZE_STEP) * SIZE_STEP));
}

/**
 * Creates a mirror camera and a target holding storage of this size and type, outside scene membership; null when
 * the managed ledger refuses the storage. `viewCamera` chooses levels of detail for the pass.
 */
export function createPlanarMirrorTarget(
  scene: Scene, name: string, viewCamera: Camera, width: number, height: number, type: number,
  resources: (texture: RenderTargetTexture) => ManagedRenderResource[],
  clearColor: Color4,
): PlanarMirrorTargetState | null {
  const engine = scene.getEngine();
  const lease = beginManagedRenderAllocation(engine, planarMirrorTargetBytes(width, height, type));
  if (!lease) return null;
  let mirror: PlanarMirrorCamera | undefined;
  let texture: PlanarMirrorTarget | undefined;
  try {
    // Neither joins scene.cameras or scene.textures: membership changes would re-probe strict readiness.
    const blocked = scene._blockEntityCollection;
    scene._blockEntityCollection = true;
    try {
      mirror = new PlanarMirrorCamera(name, Vector3.Zero(), scene, false);
      texture = new PlanarMirrorTarget(name, { width, height }, scene, {
        generateMipMaps: false, doNotChangeAspectRatio: true, type, format: targetFormat(engine, type),
        samplingMode: Texture.BILINEAR_SAMPLINGMODE, generateDepthBuffer: true,
        generateStencilBuffer: engine.isWebGPU && engine.isStencilEnable,
      });
    } finally {
      scene._blockEntityCollection = blocked;
    }
    mirror.doNotSerialize = true;
    const projection = Matrix.Identity();
    mirror.freezeProjectionMatrix(projection);
    texture.configurePass();
    texture.activeCamera = mirror;
    // Level of detail follows the view (and reuses its per-frame choice), never a mirror camera.
    texture.cameraForLOD = viewCamera;
    texture.ignoreCameraViewport = true;
    texture.useCameraPostProcesses = false;
    texture.renderParticles = false;
    texture.renderSprites = false;
    texture.particleSystemList = NO_PARTICLES;
    texture.noPrePassRenderer = true;
    texture.clearColor = clearColor;
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.renderList = [];
    lease.commit(resources(texture));
    const thin = new ThinTexture(texture.getInternalTexture());
    thin.wrapU = thin.wrapV = Texture.CLAMP_ADDRESSMODE;
    return { texture, thin, mirror, projection, lease, width, height, type };
  } catch (error) {
    texture?.dispose();
    mirror?.dispose();
    lease.release();
    throw error;
  }
}

/**
 * Gives `target` storage of this size (allocating or resizing it in place); false when the ledger refuses it, which
 * leaves the target without storage.
 */
export function resizePlanarMirrorTarget(
  scene: Scene, target: PlanarMirrorTargetState, width: number, height: number,
  resources: (texture: RenderTargetTexture) => ManagedRenderResource[],
): boolean {
  if (target.lease && target.width === width && target.height === height) return true;
  const engine = scene.getEngine();
  // Reserve the new storage while any current storage stays charged.
  const lease = beginManagedRenderAllocation(engine, planarMirrorTargetBytes(width, height, target.type));
  if (!lease) { releasePlanarMirrorStorage(scene, target); return false; }
  try {
    target.texture.resize({ width, height });
    lease.commit(resources(target.texture));
  } catch (error) {
    lease.release();
    releasePlanarMirrorStorage(scene, target);
    throw error;
  }
  if (target.lease) void releaseManagedRenderLeaseAfterDisposal(engine, target.lease);
  target.lease = lease;
  target.width = width;
  target.height = height;
  target.thin._texture = target.texture.getInternalTexture();
  return true;
}

/** Frees the target's GPU storage and charge; the mirror camera and target stay, outside scene membership. */
export function releasePlanarMirrorStorage(scene: Scene, target: PlanarMirrorTargetState): void {
  const lease = target.lease;
  if (!lease) return;
  target.lease = null;
  // The wrapper borrows the target's texture.
  target.thin._texture = null;
  target.texture.releaseStorage();
  void releaseManagedRenderLeaseAfterDisposal(scene.getEngine(), lease);
}

export function disposePlanarMirrorTarget(scene: Scene, target: PlanarMirrorTargetState): void {
  releasePlanarMirrorStorage(scene, target);
  target.texture.dispose();
  target.mirror.dispose();
}

/** The view camera's projection for `aspect`, as Babylon's Camera.getProjectionMatrix builds it. */
export function buildViewProjectionMatrix(scene: Scene, camera: Camera, aspect: number, out: Matrix): void {
  const engine = scene.getEngine();
  const reverse = engine.useReverseDepthBuffer;
  const minZ = camera.minZ <= 0 ? 0.1 : camera.minZ;
  const maxZ = camera.ignoreCameraMaxZ ? 0 : camera.maxZ;
  const vertical = camera.fovMode === Camera.FOVMODE_VERTICAL_FIXED;
  if (scene.useRightHandedSystem)
    Matrix.PerspectiveFovRHToRef(camera.fov, aspect, reverse ? maxZ : minZ, reverse ? minZ : maxZ, out, vertical, engine.isNDCHalfZRange, camera.projectionPlaneTilt, reverse);
  else
    Matrix.PerspectiveFovLHToRef(camera.fov, aspect, reverse ? maxZ : minZ, reverse ? minZ : maxZ, out, vertical, engine.isNDCHalfZRange, camera.projectionPlaneTilt, reverse);
}

/** One entry of the oblique projection's depth column: `plane` is a·C for the row, `w` the projection's w entry. */
function obliqueDepth(w: number, plane: number, reverse: boolean, half: boolean): number {
  // Near z = −w (full range) or 0 (half range); reverse depth has its near plane at z = w.
  return reverse ? w - plane : half ? plane : plane - w;
}

/**
 * Mirror camera math with its own scratch. `mirror` writes a rigid camera at the eye reflected across a plane and
 * an oblique projection whose near plane is that plane; `rotation` and `eye` keep the last mirror's basis for
 * origin-relative matrices.
 */
export class PlanarMirrorMath {
  /** Mirror view rotation, row-major: rows are world axes, columns the mirror camera's view axes. */
  readonly rotation = new Float64Array(9);
  /** The reflected eye. */
  readonly eye = new Float64Array(3);
  private readonly values = new Float64Array(16);
  private readonly inverse = new Matrix();

  /**
   * Writes `outView` (the view `view` from `eyePosition` reflected across `plane`, view x flipped so the basis stays
   * rigid) and `outProjection` (`projection` with its depth column replaced so the near plane is the mirror plane and
   * the far frustum corner toward the plane stays on the far plane). False when the plane cannot clip this frustum
   * (the eye on or behind the plane, or a degenerate projection).
   */
  mirror(
    view: Matrix, eyePosition: Vector3, plane: MirrorPlane, projection: Matrix, reverse: boolean, half: boolean,
    outView: Matrix, outProjection: Matrix,
  ): boolean {
    const v = view.m, n0 = plane.nx, n1 = plane.ny, n2 = plane.nz;
    const q = this.rotation, eye = this.eye, values = this.values;
    const distance = n0 * eyePosition.x + n1 * eyePosition.y + n2 * eyePosition.z + plane.d;
    if (!(distance > 1e-6)) return false;
    // Mirror view = reflect(world) · view · flipX, with reflect = I − 2nnᵀ.
    for (let j = 0; j < 3; j++) {
      const along = n0 * v[j]! + n1 * v[4 + j]! + n2 * v[8 + j]!;
      const sign = j === 0 ? -1 : 1;
      q[j] = sign * (v[j]! - 2 * n0 * along);
      q[3 + j] = sign * (v[4 + j]! - 2 * n1 * along);
      q[6 + j] = sign * (v[8 + j]! - 2 * n2 * along);
    }
    eye[0] = eyePosition.x - 2 * distance * n0;
    eye[1] = eyePosition.y - 2 * distance * n1;
    eye[2] = eyePosition.z - 2 * distance * n2;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) values[i * 4 + j] = q[i * 3 + j]!;
      values[i * 4 + 3] = 0;
    }
    for (let j = 0; j < 3; j++) values[12 + j] = -(eye[0] * q[j]! + eye[1] * q[3 + j]! + eye[2] * q[6 + j]!);
    values[15] = 1;
    Matrix.FromArrayToRef(values, 0, outView);
    // The plane in mirror view space, positive on the reflective side: (n in view axes, n·eye′ + d = −distance).
    const cx = n0 * q[0]! + n1 * q[3]! + n2 * q[6]!;
    const cy = n0 * q[1]! + n1 * q[4]! + n2 * q[7]!;
    const cz = n0 * q[2]! + n1 * q[5]! + n2 * q[8]!;
    const cw = -distance;
    const p = projection.m;
    projection.invertToRef(this.inverse);
    const inv = this.inverse.m;
    // The far frustum corner toward the plane (clip x, y signs of the plane), at far depth.
    const sx = cx < 0 ? -1 : 1, sy = cy < 0 ? -1 : 1, sz = reverse ? (half ? 0 : -1) : 1;
    const qx = sx * inv[0]! + sy * inv[4]! + sz * inv[8]! + inv[12]!;
    const qy = sx * inv[1]! + sy * inv[5]! + sz * inv[9]! + inv[13]!;
    const qz = sx * inv[2]! + sy * inv[6]! + sz * inv[10]! + inv[14]!;
    const qw = sx * inv[3]! + sy * inv[7]! + sz * inv[11]! + inv[15]!;
    const qC = qx * cx + qy * cy + qz * cz + qw * cw;
    const qW = qx * p[3]! + qy * p[7]! + qz * p[11]! + qw * p[15]!;
    if (!(qC > 1e-12)) return false;
    // Replace the depth column so the near plane is the mirror plane and that corner stays on the far plane.
    const a = (half ? 1 : 2) * qW / qC;
    if (!Number.isFinite(a) || a <= 0) return false;
    for (let i = 0; i < 16; i++) values[i] = p[i]!;
    values[2] = obliqueDepth(p[3]!, a * cx, reverse, half);
    values[6] = obliqueDepth(p[7]!, a * cy, reverse, half);
    values[10] = obliqueDepth(p[11]!, a * cz, reverse, half);
    values[14] = obliqueDepth(p[15]!, a * cw, reverse, half);
    Matrix.FromArrayToRef(values, 0, outProjection);
    return true;
  }

  /**
   * The last mirror's view × `projection` taking positions relative to `origin` (a shader's floating origin, or the
   * world origin): a fragment at relative position r on the mirror projects to clip c, and the texel holding what it
   * reflects is at uv = 0.5 + 0.5·c.xy/c.w on both backends (Babylon's WebGPU engine flips render-target rows to
   * WebGL's layout).
   */
  relativeViewProjection(origin: Vector3, projection: Matrix, scratch: Matrix, out: Matrix): void {
    const q = this.rotation, eye = this.eye, values = this.values;
    const dx = origin.x - eye[0]!, dy = origin.y - eye[1]!, dz = origin.z - eye[2]!;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) values[i * 4 + j] = q[i * 3 + j]!;
      values[i * 4 + 3] = 0;
    }
    for (let j = 0; j < 3; j++) values[12 + j] = dx * q[j]! + dy * q[3 + j]! + dz * q[6 + j]!;
    values[15] = 1;
    Matrix.FromArrayToRef(values, 0, scratch);
    scratch.multiplyToRef(projection, out);
  }
}

/** Replaces `planes`' near plane (index 0, as Frustum.GetPlanesToRef orders them) with the mirror plane. */
export function clipFrustumAtMirror(viewProjection: Matrix, plane: MirrorPlane, planes: Plane[]): void {
  Frustum.GetPlanesToRef(viewProjection, planes);
  const near = planes[0]!;
  near.normal.set(plane.nx, plane.ny, plane.nz);
  near.d = plane.d;
}

/**
 * Pre-culled opaque list for a mirror pass (ObjectRenderer does not cull an explicit list): enabled, visible meshes
 * in the view's layers with geometry and an opaque material, inside `planes` (the skybox and always-active meshes
 * follow the camera and always pass), never helpers, lines, blended meshes or what `excluded` names.
 */
export function collectPlanarMirrorMeshes(
  scene: Scene, list: AbstractMesh[], layerMask: number, planes: Plane[], excluded: (mesh: AbstractMesh) => boolean,
): void {
  const meshes = admittedSceneMeshes(scene) ?? scene.meshes;
  let count = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]!;
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0 ||
      !(mesh.layerMask & layerMask) || excluded(mesh) || !isRenderTargetCaptureCandidate(mesh)) continue;
    const material = mesh.material;
    if (material) {
      let opaque = false;
      if (material instanceof MultiMaterial) {
        // Like captures: a multi-material mesh reflects when any slot is opaque.
        const slots = material.subMaterials;
        for (let s = 0; s < slots.length && !opaque; s++) opaque = slots[s] ? !slots[s]!.needAlphaBlendingForMesh(mesh) : false;
      } else opaque = !material.needAlphaBlendingForMesh(mesh);
      if (!opaque) continue;
    }
    // Transforms set before this frame's render are applied first.
    if (!mesh.infiniteDistance && !mesh.alwaysSelectAsActiveMesh) {
      mesh.computeWorldMatrix();
      if (!mesh.isInFrustum(planes)) continue;
    }
    list[count++] = mesh;
  }
  list.length = count;
}

const floatingOriginScenes = new WeakMap<Scene, () => Scene | undefined>();

/**
 * Draws `pass` into `texture` capture-style and restores the view's camera, matrices, UBO, render pass, colour
 * writes, outlines and viewport. The mirror camera never stales the view's graph: the scene carries the Render
 * Target Capture readiness exemption while it draws.
 */
export function drawPlanarMirrorPass(
  scene: Scene, texture: RenderTargetTexture, pass: () => void,
  policy: { restoreAlpha: boolean; wrapDrawFailure: boolean; message: string },
): void {
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  const ubo = scene.getSceneUniformBuffer();
  const view = scene.getViewMatrix() ?? camera?.getViewMatrix();
  const projection = scene.getProjectionMatrix() ?? camera?.getProjectionMatrix();
  const renderPass = engine.currentRenderPassId;
  const colorWrite = engine.getColorWrite();
  const viewport = engine.currentViewport ?? camera?.viewport;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const outlines = scene.getOutlineRenderer?.();
  const outlinesEnabled = outlines?.enabled;
  const previousScene = FloatingOriginCurrentScene.getScene;
  const previousEyeAtCamera = FloatingOriginCurrentScene.eyeAtCamera;
  let floatingOriginScene = floatingOriginScenes.get(scene);
  if (!floatingOriginScene) {
    floatingOriginScene = () => scene.floatingOriginMode ? scene : undefined;
    floatingOriginScenes.set(scene, floatingOriginScene);
  }
  FloatingOriginCurrentScene.getScene = floatingOriginScene;
  FloatingOriginCurrentScene.eyeAtCamera = true;
  renderTargetCaptureDrawing.add(scene);
  try {
    drawBorrowedTarget(scene, texture, pass, policy);
  } finally {
    try {
      scene.activeCamera = camera;
      scene.setSceneUniformBuffer(ubo);
      if (view && projection) scene.setTransformMatrix(view, projection);
      engine.currentRenderPassId = renderPass;
      engine.setColorWrite(colorWrite);
      scene.resetCachedMaterial();
      if (outlines) outlines.enabled = outlinesEnabled!;
      if (viewport) engine.setViewport(viewport, width, height);
    } finally {
      FloatingOriginCurrentScene.getScene = previousScene;
      FloatingOriginCurrentScene.eyeAtCamera = previousEyeAtCamera;
      renderTargetCaptureDrawing.delete(scene);
    }
  }
}

/** Opaque pass state for a mirror pass: runs inside drawBorrowedTarget, which restores it. */
export function beginPlanarMirrorPassState(engine: AbstractEngine): void {
  engine.setAlphaMode(Constants.ALPHA_DISABLE);
  engine.setDepthBuffer(true);
  engine.setDepthWrite(true);
  engine.setColorWrite(true);
}
