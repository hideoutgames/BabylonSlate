/**
 * Planar reflection infrastructure for built-in water (project Water quality Reflections = Planar).
 *
 * One dominant flat water body per view is mirrored: a rigid camera at the eye reflected across the body's rest
 * plane renders the opaque scene into a leased target, with an oblique near plane on that plane, so nothing below
 * the water reflects and no material compiles a clip-plane variant. The pass is drawn capture-style from
 * `onBeforeRender` (`drawBorrowedTarget`), never through `scene.customRenderTargets`, so it works on the Forward
 * FrameGraph and classic paths alike and never forces the classic path.
 *
 * Cost model (mobile first): nothing runs until a view's water asks for a reflection
 * (`waterPlanarReflectionForCamera`) while the device-effective Reflections are Planar; only views of a scene
 * retained by `retainWaterPlanarReflections` (SceneRenderCoordinator) can ever draw one, so previews,
 * thumbnails and Render Target Captures never do. A view allocates its target only when an eligible body is
 * visible, draws every frame while its camera moves and every other frame while it is static, and releases the
 * target after it has been unused for `RELEASE_FRAMES`. Per-frame work allocates nothing.
 *
 * Colour space: the pass keeps the view's image-processing setting, so reflected materials reuse the view's
 * shader variants and target formats. Scene Linear views (`applyByPostProcess`) store linear HDR colour in
 * RGBA16F; display views store display-encoded (sRGB gamma) colour in RGBA8, which the water shader decodes with
 * `toLinearSpace` (`gammaSpace: true`). Alpha is coverage: the target clears to transparent black and opaque
 * geometry writes 1, so a shader can keep its sky/environment reflection where no geometry was reflected.
 */
import {
  Camera, Color4, Constants, Frustum, Matrix, MultiMaterial, RenderTargetTexture, Texture, ThinTexture, Vector3,
  type AbstractMesh, type IParticleSystem, type Node, type Observer, type Scene,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import { clusteredLightTarget } from "./clustered-light-policy";
import { drawBorrowedTarget } from "./framegraph-borrowed-draw";
import {
  beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease, type ManagedRenderResource,
} from "./managed-render-resources";
import { sceneWaterQualityDeviceClamp, sceneWaterQualityRevision } from "./render-settings";
import { isRenderTargetCaptureCandidate } from "./render-target-capture";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { managedRenderTargetResources, renderTargetAllocationBytes } from "./render-target-resource-cost";
import { admittedSceneMeshes } from "./scene-stream-admission";
import type { WaterMaterialPlugin } from "./water-material";

/** One view's planar reflection, valid for the engine frame in which it was returned. */
export interface WaterPlanarReflection {
  /**
   * The reflected opaque scene, CLAMP and bilinear: RGBA16F linear colour for Scene Linear views, otherwise RGBA8
   * display-encoded colour (`gammaSpace`). Alpha is coverage (0 where nothing was reflected).
   */
  readonly texture: ThinTexture;
  /**
   * Mirrored camera view × oblique projection, taking positions relative to the origin the water shader uses
   * (`slateWaterOrigin`: the view camera's position under floating origin, otherwise the world origin). A water
   * fragment at that relative position projects to the clip-space position whose texel holds what it reflects;
   * flip clip y for texture v on WebGL as for any render target.
   */
  readonly viewProjection: Matrix;
  /** World height of the reflecting rest plane. */
  readonly planeY: number;
  /** The water mesh that reflects; other water in the view keeps its fallback. */
  readonly mesh: AbstractMesh;
  /** True when `texture` holds display-encoded colour (decode with `toLinearSpace`); false for linear colour. */
  readonly gammaSpace: boolean;
}

/** Counters for proofs and tests; null when the scene has no retained planar owner. */
export interface WaterPlanarReflectionDiagnostics {
  /** Cameras whose water asked for a reflection recently. */
  readonly views: number;
  /** Views holding an allocated target. */
  readonly targets: number;
  /** Mirror passes drawn. */
  readonly draws: number;
  /** Frames a static view reused its previous draw. */
  readonly reusedFrames: number;
}

const PLUGIN_NAME = "SlateWater";
/** A lookup within this many engine frames keeps a view drawing (tolerates frames a view skips). */
const DEMAND_FRAMES = 4;
/** Frames a view keeps its target after its last valid reflection, so brief occlusion never reallocates. */
const RELEASE_FRAMES = 120;
/** A static view redraws every this many frames (scene content may still move). */
const STATIC_REDRAW_INTERVAL = 2;
/** Eyes closer than this to the rest plane (or below it) get no reflection: the mirror degenerates. */
const MIN_EYE_HEIGHT = 1e-3;
/** Coverage within this tolerance ties; the nearer plane, then the older mesh, wins. */
const COVERAGE_EPSILON = 1e-6;
/** Target sizes snap up to this many pixels, so small resizes do not reallocate. */
const SIZE_STEP = 8;
/** Minimum clip-space w kept by the coverage clip (points at or behind the eye are cut away). */
const CLIP_W_EPSILON = 1e-5;

const TRANSPARENT = new Color4(0, 0, 0, 0);
const DRAW_POLICY = { restoreAlpha: true, wrapDrawFailure: false, message: "Water planar reflection failed." };
const NO_PARTICLES: IParticleSystem[] = [];
/** Clip planes as coefficients of (x, y, w) plus a constant: w ≥ ε, then |x| ≤ w and |y| ≤ w. */
const CLIP_PLANES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 1, -CLIP_W_EPSILON], [-1, 0, 1, 0], [1, 0, 1, 0], [0, -1, 1, 0], [0, 1, 1, 0],
];

/** A rigid camera whose view matrix is written directly; its projection is frozen to an oblique matrix. */
class WaterMirrorCamera extends Camera {
  readonly mirrorView = Matrix.Identity();
  override _getViewMatrix(): Matrix { return this.mirrorView; }
  override getClassName(): string { return "WaterMirrorCamera"; }
}

class MirrorTarget extends RenderTargetTexture {
  configurePass(): void {
    this._objectRenderer.enableOutlineRendering = false;
    this._objectRenderer.disableDepthPrePass = true;
  }
}

type Result = { texture: ThinTexture; viewProjection: Matrix; planeY: number; mesh: AbstractMesh; gammaSpace: boolean };
type Target = {
  texture: MirrorTarget;
  thin: ThinTexture;
  mirror: WaterMirrorCamera;
  lease: ManagedRenderLease;
  width: number;
  height: number;
  type: number;
  /** The mirror camera's frozen oblique projection, rewritten in place. */
  projection: Matrix;
  /** Absolute mirror view × projection of the last draw. */
  drawn: Matrix;
  drawnFrame: number;
  /** Body of the last draw; null forces the next frame to draw (new or resized target). */
  drawnMesh: AbstractMesh | null;
  ready: boolean;
  meshes: AbstractMesh[];
  result: Result | null;
};
type View = {
  camera: Camera;
  disposeObserver: Observer<Node> | null;
  /** Engine frame of the latest lookup. */
  requested: number;
  /** Engine frame whose lookups may use the target's result. */
  valid: number;
  /** Engine frame of the latest valid result. */
  active: number;
  target: Target | null;
};

const owners = new WeakMap<Scene, WaterPlanarReflections>();

function isWaterMesh(mesh: AbstractMesh): boolean {
  return (mesh.metadata as { slateWater?: unknown } | null)?.slateWater === true;
}

function waterResources(texture: RenderTargetTexture): ManagedRenderResource[] {
  // Colour and depth are both the reflection's cost; charge them to one category.
  return managedRenderTargetResources(texture.renderTarget!, { colorCategory: "water" })
    .map((resource) => ({ ...resource, category: "water" as const }));
}

function targetBytes(width: number, height: number, type: number): number {
  return renderTargetAllocationBytes({ width, height, format: Constants.TEXTUREFORMAT_RGBA, type }) +
    // Conservative depth bound; actual WebGL renderbuffers and WebGPU depth textures commit their real size.
    renderTargetAllocationBytes({ width, height, format: Constants.TEXTUREFORMAT_DEPTH32FLOAT_STENCIL8, renderbuffer: true });
}

/** A target dimension: `scale` of the view's, snapped up to SIZE_STEP pixels. */
function targetSize(view: number, scale: number, maxSize: number): number {
  return Math.min(maxSize, Math.max(SIZE_STEP, Math.ceil(view * scale / SIZE_STEP) * SIZE_STEP));
}

/** One entry of the oblique projection's depth column: `plane` is a·C for the row, `w` the projection's w entry. */
function obliqueDepth(w: number, plane: number, reverse: boolean, half: boolean): number {
  // Near z = −w (full range) or 0 (half range); reverse depth has its near plane at z = w.
  return reverse ? w - plane : half ? plane : plane - w;
}

/** Sutherland–Hodgman clip of an (x, y, w) polygon against `a·x + b·y + c·w + k ≥ 0`. */
function clipPolygon(source: Float64Array, count: number, target: Float64Array, plane: readonly [number, number, number, number]): number {
  const [a, b, c, k] = plane;
  let out = 0;
  for (let i = 0; i < count; i++) {
    const j = i + 1 === count ? 0 : i + 1;
    const ax = source[i * 3]!, ay = source[i * 3 + 1]!, aw = source[i * 3 + 2]!;
    const bx = source[j * 3]!, by = source[j * 3 + 1]!, bw = source[j * 3 + 2]!;
    const fa = a * ax + b * ay + c * aw + k, fb = a * bx + b * by + c * bw + k;
    if (fa >= 0) {
      target[out * 3] = ax; target[out * 3 + 1] = ay; target[out * 3 + 2] = aw; out++;
    }
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      target[out * 3] = ax + (bx - ax) * t; target[out * 3 + 1] = ay + (by - ay) * t; target[out * 3 + 2] = aw + (bw - aw) * t; out++;
    }
  }
  return out;
}

class WaterPlanarReflections {
  references = 0;
  disposed = false;
  draws = 0;
  reusedFrames = 0;
  private readonly scene: Scene;
  private readonly views = new Map<Camera, View>();
  private readonly sceneDispose: Observer<Scene>;
  private beforeRender: Observer<Scene> | null = null;
  private meshAdded: Observer<AbstractMesh> | null = null;
  private meshRemoved: Observer<AbstractMesh> | null = null;
  private readonly water: AbstractMesh[] = [];
  private waterDirty = true;
  private drawing = false;
  /** Water quality revision of a failed draw: retried only after the quality changes. */
  private failedRevision = -1;
  private frame = 0;
  private readonly floatingOriginScene: () => Scene | undefined;
  private readonly sweepView = (view: View) => {
    if (view.camera.isDisposed()) { this.removeView(view); return; }
    if (view.target && this.frame - view.active > RELEASE_FRAMES) this.releaseTarget(view);
    if (!view.target && this.frame - view.requested > RELEASE_FRAMES) this.removeView(view);
  };
  private readonly releaseView = (view: View) => this.removeView(view);
  private drawTarget: Target | null = null;
  private drew = false;
  /** Runs inside drawBorrowedTarget, which restores the framebuffer and depth/alpha state. */
  private readonly drawPass = () => {
    const target = this.drawTarget!, engine = this.scene.getEngine();
    engine.setAlphaMode(Constants.ALPHA_DISABLE);
    engine.setDepthBuffer(true);
    engine.setDepthWrite(true);
    engine.setColorWrite(true);
    // The first draw waits for every reflected material; later draws skip any mesh that is not ready.
    if (!target.ready) target.ready = target.texture.isReadyForRendering();
    if (target.ready) { target.texture.render(false); this.drew = true; }
  };
  // Scratch, reused every frame.
  private readonly projection = new Matrix();
  private readonly inverse = new Matrix();
  private readonly viewProjection = new Matrix();
  private readonly cullViewProjection = new Matrix();
  private readonly nextViewProjection = new Matrix();
  private readonly relativeView = new Matrix();
  private readonly mainPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly reflectionPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly values = new Float64Array(16);
  private readonly rotation = new Float64Array(9);
  private readonly mirrorEye = new Float64Array(3);
  private readonly polygonA = new Float64Array(36);
  private readonly polygonB = new Float64Array(36);
  private planeY = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.floatingOriginScene = () => scene.floatingOriginMode ? scene : undefined;
    this.sceneDispose = scene.onDisposeObservable.add(() => this.dispose())!;
  }

  diagnostics(): WaterPlanarReflectionDiagnostics {
    let targets = 0;
    this.views.forEach((view) => { if (view.target) targets++; });
    return { views: this.views.size, targets, draws: this.draws, reusedFrames: this.reusedFrames };
  }

  forCamera(camera: Camera): WaterPlanarReflection | null {
    const scene = this.scene;
    if (this.disposed || this.drawing || renderTargetCaptureDrawing.has(scene) || camera.getScene() !== scene) return null;
    const frame = scene.getEngine().frameId;
    let view = this.views.get(camera);
    if (!view) {
      if (camera.isDisposed() || sceneWaterQualityDeviceClamp(scene).quality.reflections !== "planar") return null;
      view = { camera, disposeObserver: null, requested: frame, valid: -1, active: frame, target: null };
      const created = view;
      view.disposeObserver = camera.onDisposeObservable.add(() => this.releaseView(created));
      this.views.set(camera, view);
      this.attach();
    }
    view.requested = frame;
    return view.valid === frame && view.target?.result ? view.target.result : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.views.forEach(this.releaseView);
    this.detach();
    this.scene.onDisposeObservable.remove(this.sceneDispose);
  }

  /** Per-frame observers exist only while some view has asked for a reflection. */
  private attach(): void {
    if (this.beforeRender) return;
    const scene = this.scene;
    this.waterDirty = true;
    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.update());
    this.meshAdded = scene.onNewMeshAddedObservable.add(() => { this.waterDirty = true; });
    this.meshRemoved = scene.onMeshRemovedObservable.add(() => { this.waterDirty = true; });
  }

  private detach(): void {
    const scene = this.scene;
    scene.onBeforeRenderObservable.remove(this.beforeRender);
    scene.onNewMeshAddedObservable.remove(this.meshAdded);
    scene.onMeshRemovedObservable.remove(this.meshRemoved);
    this.beforeRender = this.meshAdded = this.meshRemoved = null;
    this.water.length = 0;
  }

  private update(): void {
    const scene = this.scene;
    if (this.disposed || this.drawing || renderTargetCaptureDrawing.has(scene)) return;
    const frame = scene.getEngine().frameId;
    this.frame = frame;
    const quality = sceneWaterQualityDeviceClamp(scene).quality;
    const revision = sceneWaterQualityRevision(scene);
    if (quality.reflections !== "planar" || revision === this.failedRevision) {
      this.views.forEach(this.releaseView);
    } else {
      const camera = scene.activeCamera;
      const view = camera ? this.views.get(camera) : undefined;
      if (view && frame - view.requested <= DEMAND_FRAMES) {
        try {
          if (this.renderView(view, quality.planarScale, frame)) view.valid = frame;
        } catch (error) {
          // An optional effect must not break the frame: drop every target and retry after a quality change.
          this.failedRevision = revision;
          this.views.forEach(this.releaseView);
          console.warn(`[render] Water planar reflections are off until Water quality changes: ${String(error)}`);
        }
      }
      this.views.forEach(this.sweepView);
    }
    if (!this.views.size) this.detach();
  }

  /** Draws (or reuses) `view`'s reflection for this frame; false when it has none. */
  private renderView(view: View, scale: number, frame: number): boolean {
    const scene = this.scene, engine = scene.getEngine(), camera = view.camera;
    // Rig/XR and multi-camera frames draw with other matrices; clustered views use another light binding.
    if (camera.mode !== Camera.PERSPECTIVE_CAMERA || camera.rigCameras.length > 0 || (scene.activeCameras?.length ?? 0) > 1) return false;
    if (clusteredLightTarget(scene, camera)) return false;
    const linear = scene.imageProcessingConfiguration.applyByPostProcess;
    if (linear && !engine.getCaps().textureHalfFloatRender) return false;
    const output = camera.outputRenderTarget;
    const viewWidth = (output ? output.getRenderWidth() : engine.getRenderWidth(true)) * camera.viewport.width;
    const viewHeight = (output ? output.getRenderHeight() : engine.getRenderHeight(true)) * camera.viewport.height;
    if (!(viewWidth >= 1 && viewHeight >= 1)) return false;
    // The view's own projection, built from the camera's settings rather than read back, so a bound
    // framebuffer of another size cannot change the camera's cached matrix here.
    this.buildProjection(camera, viewWidth / viewHeight);
    camera.getViewMatrix().multiplyToRef(this.projection, this.viewProjection);
    Frustum.GetPlanesToRef(this.viewProjection, this.mainPlanes);
    const mesh = this.dominantWater(camera);
    if (!mesh) return false;
    const planeY = this.planeY;
    const maxSize = engine.getCaps().maxTextureSize;
    const type = linear ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    const target = this.ensureTarget(view, targetSize(viewWidth, scale, maxSize), targetSize(viewHeight, scale, maxSize), type);
    if (!target) return false;
    // In use (drawn or waiting for shaders) keeps the target; only an unused one is released.
    view.active = frame;
    if (!this.mirror(camera, planeY, target)) return false;
    target.mirror.mirrorView.multiplyToRef(target.projection, this.nextViewProjection);
    if (target.result && target.drawnMesh === mesh && target.drawn.equals(this.nextViewProjection) &&
      frame - target.drawnFrame < STATIC_REDRAW_INTERVAL) {
      this.reusedFrames++;
      return true;
    }
    // Cull with the mirror camera's ordinary frustum, its near plane replaced by the water plane.
    target.mirror.mirrorView.multiplyToRef(this.projection, this.cullViewProjection);
    Frustum.GetPlanesToRef(this.cullViewProjection, this.reflectionPlanes);
    const near = this.reflectionPlanes[0]!;
    near.normal.set(0, 1, 0);
    near.d = -planeY;
    this.collectReflected(target, camera.layerMask);
    target.mirror.minZ = camera.minZ;
    target.mirror.maxZ = camera.maxZ;
    target.mirror.getViewMatrix(true);
    if (!this.draw(target)) return false;
    this.draws++;
    target.drawn.copyFrom(this.nextViewProjection);
    target.drawnFrame = frame;
    target.drawnMesh = mesh;
    // The shader's positions are relative to the floating origin (the view's eye) when it is on.
    const origin = scene.floatingOriginMode ? camera.globalPosition : Vector3.ZeroReadOnly;
    const q = this.rotation, eye = this.mirrorEye, values = this.values;
    const dx = origin.x - eye[0]!, dy = origin.y - eye[1]!, dz = origin.z - eye[2]!;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) values[i * 4 + j] = q[i * 3 + j]!;
      values[i * 4 + 3] = 0;
    }
    for (let j = 0; j < 3; j++) values[12 + j] = dx * q[j]! + dy * q[3 + j]! + dz * q[6 + j]!;
    values[15] = 1;
    Matrix.FromArrayToRef(values, 0, this.relativeView);
    let result = target.result;
    if (!result) {
      result = { texture: target.thin, viewProjection: new Matrix(), planeY, mesh, gammaSpace: !linear };
      target.result = result;
    }
    this.relativeView.multiplyToRef(target.projection, result.viewProjection);
    result.planeY = planeY;
    result.mesh = mesh;
    result.gammaSpace = !linear;
    return true;
  }

  /** The view camera's projection for `aspect`, as Babylon's Camera.getProjectionMatrix builds it. */
  private buildProjection(camera: Camera, aspect: number): void {
    const engine = this.scene.getEngine();
    const reverse = engine.useReverseDepthBuffer;
    const minZ = camera.minZ <= 0 ? 0.1 : camera.minZ;
    const maxZ = camera.ignoreCameraMaxZ ? 0 : camera.maxZ;
    const vertical = camera.fovMode === Camera.FOVMODE_VERTICAL_FIXED;
    if (this.scene.useRightHandedSystem)
      Matrix.PerspectiveFovRHToRef(camera.fov, aspect, reverse ? maxZ : minZ, reverse ? minZ : maxZ, this.projection, vertical, engine.isNDCHalfZRange, camera.projectionPlaneTilt, reverse);
    else
      Matrix.PerspectiveFovLHToRef(camera.fov, aspect, reverse ? maxZ : minZ, reverse ? minZ : maxZ, this.projection, vertical, engine.isNDCHalfZRange, camera.projectionPlaneTilt, reverse);
  }

  /**
   * The visible eligible body covering most of the view (its rest rectangle's projected area), sets `planeY`.
   * Ties go to the plane nearest the eye, then the lower uniqueId, so the choice never depends on scene order.
   */
  private dominantWater(camera: Camera): AbstractMesh | null {
    if (this.waterDirty) {
      this.water.length = 0;
      const meshes = this.scene.meshes;
      for (let i = 0; i < meshes.length; i++) if (isWaterMesh(meshes[i]!)) this.water.push(meshes[i]!);
      this.waterDirty = false;
    }
    const eyeY = camera.globalPosition.y;
    let best: AbstractMesh | null = null, bestCoverage = 0, bestHeight = 0, bestPlane = 0;
    for (let i = 0; i < this.water.length; i++) {
      const mesh = this.water[i]!;
      const planeY = this.reflectingPlane(mesh, camera.layerMask);
      if (Number.isNaN(planeY)) continue;
      const height = eyeY - planeY;
      if (!(height > MIN_EYE_HEIGHT) || !mesh.isInFrustum(this.mainPlanes)) continue;
      const coverage = this.coverage(mesh, planeY);
      if (coverage <= 0) continue;
      const better = best === null || coverage > bestCoverage + COVERAGE_EPSILON ||
        (coverage >= bestCoverage - COVERAGE_EPSILON && (height < bestHeight || (height === bestHeight && mesh.uniqueId < best.uniqueId)));
      if (!better) continue;
      best = mesh; bestCoverage = coverage; bestHeight = height; bestPlane = planeY;
    }
    this.planeY = bestPlane;
    return best;
  }

  /** Rest-plane height of an enabled, visible built-in body that asks for object reflections and is flat; NaN otherwise. */
  private reflectingPlane(mesh: AbstractMesh, layerMask: number): number {
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || !(mesh.layerMask & layerMask)) return NaN;
    const plugin = mesh.material?.pluginManager?.getPlugin<WaterMaterialPlugin>(PLUGIN_NAME);
    if (!plugin || !plugin.water.objectReflections || plugin.body.kind === "river") return NaN;
    // Rivers and volumes tilted out of the horizontal have a rest height that varies across the body
    // (water-mesh restVaries); a level body's rest surface is its local y = 0 plane.
    const m = mesh.computeWorldMatrix().m;
    if (Math.abs(m[1]!) > 1e-9 || Math.abs(m[9]!) > 1e-9) return NaN;
    return m[13]!;
  }

  /** Fraction of the view covered by the body's rest rectangle (its bounds at `planeY`), clipped to the frustum. */
  private coverage(mesh: AbstractMesh, planeY: number): number {
    const box = mesh.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
    const m = this.viewProjection.m;
    let source = this.polygonA, target = this.polygonB;
    for (let corner = 0; corner < 4; corner++) {
      const x = corner === 0 || corner === 3 ? min.x : max.x, z = corner < 2 ? min.z : max.z;
      source[corner * 3] = x * m[0]! + planeY * m[4]! + z * m[8]! + m[12]!;
      source[corner * 3 + 1] = x * m[1]! + planeY * m[5]! + z * m[9]! + m[13]!;
      source[corner * 3 + 2] = x * m[3]! + planeY * m[7]! + z * m[11]! + m[15]!;
    }
    let count = 4;
    for (let p = 0; p < CLIP_PLANES.length && count > 0; p++) {
      count = clipPolygon(source, count, target, CLIP_PLANES[p]!);
      const swap = source; source = target; target = swap;
    }
    let area = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 === count ? 0 : i + 1;
      const ax = source[i * 3]! / source[i * 3 + 2]!, ay = source[i * 3 + 1]! / source[i * 3 + 2]!;
      const bx = source[j * 3]! / source[j * 3 + 2]!, by = source[j * 3 + 1]! / source[j * 3 + 2]!;
      area += ax * by - bx * ay;
    }
    // The clip square spans [-1, 1]², area 4.
    return Math.abs(area) / 8;
  }

  /**
   * Writes the rigid mirror camera (eye reflected across y = planeY; view x flipped so the basis stays
   * right-handed, which keeps triangle winding and back-face culling) and its oblique projection, whose near plane
   * is the water plane (Lengyel). False when the plane cannot clip this frustum.
   */
  private mirror(camera: Camera, planeY: number, target: Target): boolean {
    const v = camera.getViewMatrix().m, e = camera.globalPosition;
    const q = this.rotation, eye = this.mirrorEye, values = this.values;
    // Mirror view = reflect(world) · view · flipX: rotation rows are world axes (y negated), columns view axes (x negated).
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      q[i * 3 + j] = (i === 1 ? -1 : 1) * (j === 0 ? -1 : 1) * v[i * 4 + j]!;
    eye[0] = e.x; eye[1] = 2 * planeY - e.y; eye[2] = e.z;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) values[i * 4 + j] = q[i * 3 + j]!;
      values[i * 4 + 3] = 0;
    }
    for (let j = 0; j < 3; j++) values[12 + j] = -(eye[0] * q[j]! + eye[1] * q[3 + j]! + eye[2] * q[6 + j]!);
    values[15] = 1;
    Matrix.FromArrayToRef(values, 0, target.mirror.mirrorView);
    target.mirror.position.set(eye[0], eye[1], eye[2]);
    // The water plane in mirror view space, positive above the water: (world up in view axes, planeY − eye y).
    const cx = q[3]!, cy = q[4]!, cz = q[5]!, cw = planeY - e.y;
    const engine = this.scene.getEngine();
    const reverse = engine.useReverseDepthBuffer, half = engine.isNDCHalfZRange;
    const p = this.projection.m;
    this.projection.invertToRef(this.inverse);
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
    // Replace the depth column so the near plane is the water plane and that corner stays on the far plane.
    const a = (half ? 1 : 2) * qW / qC;
    if (!Number.isFinite(a) || a <= 0) return false;
    for (let i = 0; i < 16; i++) values[i] = p[i]!;
    values[2] = obliqueDepth(p[3]!, a * cx, reverse, half);
    values[6] = obliqueDepth(p[7]!, a * cy, reverse, half);
    values[10] = obliqueDepth(p[11]!, a * cz, reverse, half);
    values[14] = obliqueDepth(p[15]!, a * cw, reverse, half);
    Matrix.FromArrayToRef(values, 0, target.projection);
    return true;
  }

  /** Pre-culled opaque list (ObjectRenderer does not cull an explicit list): no water, helpers, lines or blended meshes. */
  private collectReflected(target: Target, layerMask: number): void {
    const meshes = admittedSceneMeshes(this.scene) ?? this.scene.meshes;
    const list = target.meshes;
    let count = 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0 ||
        !(mesh.layerMask & layerMask) || isWaterMesh(mesh) || !isRenderTargetCaptureCandidate(mesh)) continue;
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
      // The skybox and always-active meshes follow the camera; everything else must reach the mirrored frustum
      // above the water. Transforms set before this frame's render are applied first.
      if (!mesh.infiniteDistance && !mesh.alwaysSelectAsActiveMesh) {
        mesh.computeWorldMatrix();
        if (!mesh.isInFrustum(this.reflectionPlanes)) continue;
      }
      list[count++] = mesh;
    }
    list.length = count;
  }

  private ensureTarget(view: View, width: number, height: number, type: number): Target | null {
    let target = view.target;
    if (target && target.type !== type) { this.releaseTarget(view); target = null; }
    if (!target) return this.createTarget(view, width, height, type);
    if (target.width === width && target.height === height) return target;
    const engine = this.scene.getEngine();
    // Reserve the resized target while the current one stays charged.
    const lease = beginManagedRenderAllocation(engine, targetBytes(width, height, type));
    if (!lease) { this.releaseTarget(view); return null; }
    try {
      target.texture.resize({ width, height });
      lease.commit(waterResources(target.texture));
    } catch (error) {
      lease.release();
      this.releaseTarget(view);
      throw error;
    }
    void releaseManagedRenderLeaseAfterDisposal(engine, target.lease);
    target.lease = lease;
    target.width = width;
    target.height = height;
    target.thin._texture = target.texture.getInternalTexture();
    target.drawnMesh = null;
    return target;
  }

  private createTarget(view: View, width: number, height: number, type: number): Target | null {
    const scene = this.scene, engine = scene.getEngine();
    const lease = beginManagedRenderAllocation(engine, targetBytes(width, height, type));
    if (!lease) return null;
    let mirror: WaterMirrorCamera | undefined;
    let texture: MirrorTarget | undefined;
    try {
      const name = `waterPlanarReflection:${view.camera.name}`;
      mirror = new WaterMirrorCamera(name, Vector3.Zero(), scene, false);
      mirror.doNotSerialize = true;
      const projection = Matrix.Identity();
      mirror.freezeProjectionMatrix(projection);
      texture = new MirrorTarget(name, { width, height }, scene, {
        generateMipMaps: false, doNotChangeAspectRatio: true, type, format: Constants.TEXTUREFORMAT_RGBA,
        samplingMode: Texture.BILINEAR_SAMPLINGMODE, generateDepthBuffer: true, generateStencilBuffer: false,
      });
      texture.configurePass();
      texture.activeCamera = mirror;
      texture.ignoreCameraViewport = true;
      texture.useCameraPostProcesses = false;
      texture.renderParticles = false;
      texture.renderSprites = false;
      texture.particleSystemList = NO_PARTICLES;
      texture.noPrePassRenderer = true;
      texture.clearColor = TRANSPARENT;
      texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      const meshes: AbstractMesh[] = [];
      texture.renderList = meshes;
      lease.commit(waterResources(texture));
      const thin = new ThinTexture(texture.getInternalTexture());
      thin.wrapU = thin.wrapV = Texture.CLAMP_ADDRESSMODE;
      const target: Target = {
        texture, thin, mirror, lease, width, height, type, projection, drawn: new Matrix(), drawnFrame: -Infinity,
        drawnMesh: null, ready: false, meshes, result: null,
      };
      view.target = target;
      return target;
    } catch (error) {
      texture?.dispose();
      mirror?.dispose();
      lease.release();
      throw error;
    }
  }

  private releaseTarget(view: View): void {
    const target = view.target;
    if (!target) return;
    view.target = null;
    view.valid = -1;
    // The wrapper borrows the target's texture; the target disposes it.
    target.thin._texture = null;
    target.texture.dispose();
    target.mirror.dispose();
    void releaseManagedRenderLeaseAfterDisposal(this.scene.getEngine(), target.lease);
  }

  private removeView(view: View): void {
    this.releaseTarget(view);
    view.camera.onDisposeObservable.remove(view.disposeObserver);
    view.disposeObserver = null;
    this.views.delete(view.camera);
  }

  /** Capture-style borrowed draw; restores the view's camera, matrices, UBO, pass and viewport. */
  private draw(target: Target): boolean {
    const scene = this.scene, engine = scene.getEngine();
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
    FloatingOriginCurrentScene.getScene = this.floatingOriginScene;
    FloatingOriginCurrentScene.eyeAtCamera = true;
    // Same readiness exemption as Render Target Captures: the mirror camera never stales the view's graph.
    renderTargetCaptureDrawing.add(scene);
    this.drawing = true;
    this.drawTarget = target;
    this.drew = false;
    try {
      drawBorrowedTarget(scene, target.texture, this.drawPass, DRAW_POLICY);
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
        this.drawing = false;
        this.drawTarget = null;
      }
    }
    return this.drew;
  }
}

/**
 * Lets the views of `scene` draw planar water reflections (SceneRenderCoordinator retains each scene it renders).
 * Retaining allocates nothing; the returned release disposes the owner when its last holder releases it.
 */
export function retainWaterPlanarReflections(scene: Scene): () => void {
  let owner = owners.get(scene);
  if (!owner || owner.disposed) {
    owner = new WaterPlanarReflections(scene);
    owners.set(scene, owner);
  }
  const retained = owner;
  retained.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--retained.references > 0) return;
    retained.dispose();
    if (owners.get(scene) === retained) owners.delete(scene);
  };
}

/**
 * The planar reflection `camera`'s view drew this frame, or null: Reflections are not Planar on this device, no
 * eligible body (built-in, Object Reflections on, flat: not a river or tilted volume) is visible above the eye's
 * plane, the scene is not a retained view (previews, thumbnails), the camera belongs to a Render Target Capture or
 * the mirror pass itself, or the reflection is not ready yet. Each lookup also requests the reflection for the
 * following frames, so a view's first request returns null and later frames return its result. The returned object
 * is reused and updated in place; check `mesh` before sampling.
 */
export function waterPlanarReflectionForCamera(scene: Scene, camera: Camera | null | undefined): WaterPlanarReflection | null {
  if (!camera) return null;
  const owner = owners.get(scene);
  return owner && !owner.disposed ? owner.forCamera(camera) : null;
}

export function waterPlanarReflectionDiagnostics(scene: Scene): WaterPlanarReflectionDiagnostics | null {
  const owner = owners.get(scene);
  return owner && !owner.disposed ? owner.diagnostics() : null;
}
