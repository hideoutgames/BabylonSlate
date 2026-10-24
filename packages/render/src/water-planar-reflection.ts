/**
 * Planar reflection infrastructure for built-in water (project Water quality Reflections = Planar).
 *
 * One dominant flat water body per view is mirrored: a rigid camera at the eye reflected across the body's rest
 * plane renders the opaque scene into a leased target, with an oblique near plane on that plane, so nothing below
 * the water reflects and no material compiles a clip-plane variant. The camera, target and capture-style pass are
 * shared with Mirror components (`planar-mirror.ts`); this owner draws from `onBeforeRender`.
 *
 * Cost model (mobile first): nothing runs until a view's water asks for a reflection
 * (`waterPlanarReflectionForCamera`) while the device-effective Reflections are Planar; only views of a scene
 * retained by `retainWaterPlanarReflections` (SceneRenderCoordinator) can ever draw one, so previews,
 * thumbnails and Render Target Captures never do. A view allocates its target only when an eligible body is
 * visible, draws on every render while its camera moves and every other render while it is static, and frees the
 * target's storage after `RELEASE_RENDERS` renders unused. Every window counts the owner's own renders, never
 * engine frames, so frame caps, paused views and display refresh rates do not change them. The owner's per-frame
 * work allocates nothing; once every view is idle its observers detach.
 *
 * Readiness: the mirror camera and target never join the scene's cameras or textures (their construction blocks
 * entity collection), and idle release frees only GPU storage, so allocating, releasing and reallocating never
 * changes scene membership, never re-probes strict readiness and never drops a presented frame. They are
 * disposed only with their view (camera disposal, Reflections leaving Planar, a colour-type change, owner release).
 *
 * Colour space: the pass keeps the view's image-processing setting, so reflected materials reuse the view's
 * shader variants and target formats. Scene Linear views (`applyByPostProcess`) store linear HDR colour in
 * RGBA16F; display views store display-encoded (sRGB gamma) colour in RGBA8, which the water shader decodes with
 * `toLinearSpace` (`gammaSpace: true`). Alpha is coverage: the target clears to transparent black and opaque
 * geometry writes 1, so a shader can keep its sky/environment reflection where no geometry was reflected.
 */
import {
  Camera, Color4, Constants, Frustum, Matrix, RenderTargetTexture, ThinTexture, Vector3,
  type AbstractMesh, type Mesh, type Node, type Observer, type Scene,
} from "@babylonjs/core";
import { clusteredLightTarget } from "./clustered-light-policy";
import type { ManagedRenderResource } from "./managed-render-resources";
import {
  beginPlanarMirrorPassState, buildViewProjectionMatrix, clipFrustumAtMirror, collectPlanarMirrorMeshes, createPlanarMirrorTarget,
  disposePlanarMirrorTarget, drawPlanarMirrorPass, planarMirrorTargetSize, PlanarMirrorMath, releasePlanarMirrorStorage,
  resizePlanarMirrorTarget, type MirrorPlane, type PlanarMirrorTargetState,
} from "./planar-mirror";
import { sceneWaterQualityDeviceClamp, sceneWaterQualityRevision } from "./render-settings";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { managedRenderTargetResources } from "./render-target-resource-cost";
import type { WaterMaterialPlugin } from "./water-material";
import { waterMeshRestVaries } from "./water-mesh";

/** One view's planar reflection, valid for the scene render in which it was returned. */
export interface WaterPlanarReflection {
  /**
   * The reflected opaque scene, CLAMP and bilinear: RGBA16F linear colour for Scene Linear views, otherwise 8-bit
   * display-encoded colour (`gammaSpace`; stored BGRA on a bgra8unorm WebGPU swap chain, sampled as RGBA). Alpha
   * is coverage (0 where nothing was reflected).
   */
  readonly texture: ThinTexture;
  /**
   * Mirrored camera view × oblique projection, taking positions relative to the origin the water shader uses
   * (`slateWaterOrigin`: the view camera's position under floating origin, otherwise the world origin). A water
   * fragment at that relative position projects to clip position c, and the texel holding what it reflects is at
   * uv = 0.5 + 0.5·c.xy/c.w on both backends (GLSL and WGSL alike: Babylon's WebGPU engine flips render-target rows
   * to WebGL's layout). Clip depth follows the engine's NDC depth range and reverse depth; the water plane is the
   * near plane.
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
  /** Cameras whose water asked for a reflection (idle views keep their mirror camera and target, without storage). */
  readonly views: number;
  /** Views holding GPU storage for their target. */
  readonly targets: number;
  /** Mirror passes drawn. */
  readonly draws: number;
  /** Renders a static view reused its previous draw. */
  readonly reusedFrames: number;
}

const PLUGIN_NAME = "SlateWater";
/**
 * A view keeps drawing while its water looked the reflection up within this many of the view's own renders, so a
 * render that skips the water (shaders still compiling) does not stop it.
 */
const DEMAND_RENDERS = 4;
/** Scene renders a target may go unused before its storage is freed, so brief occlusion never reallocates. */
const RELEASE_RENDERS = 120;
/** A static view redraws every this many of its renders (scene content may still move). */
const STATIC_REDRAW_INTERVAL = 2;
/** Eyes closer than this to the rest plane (or below it) get no reflection: the mirror degenerates. */
const MIN_EYE_HEIGHT = 1e-3;
/** Coverage within this tolerance ties; the nearer plane, then the older mesh, wins. */
const COVERAGE_EPSILON = 1e-6;
/** Minimum clip-space w kept by the coverage clip (points at or behind the eye are cut away). */
const CLIP_W_EPSILON = 1e-5;

const TRANSPARENT = new Color4(0, 0, 0, 0);
const DRAW_POLICY = { restoreAlpha: true, wrapDrawFailure: false, message: "Water planar reflection failed." };
/** Clip planes as coefficients of (x, y, w) plus a constant: w ≥ ε, then |x| ≤ w and |y| ≤ w. */
const CLIP_PLANES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 1, -CLIP_W_EPSILON], [-1, 0, 1, 0], [1, 0, 1, 0], [0, -1, 1, 0], [0, 1, 1, 0],
];

type Result = { texture: ThinTexture; viewProjection: Matrix; planeY: number; mesh: AbstractMesh; gammaSpace: boolean };
/**
 * A view's mirror camera and target, kept for the view's lifetime outside scene membership. `lease` is null while
 * the target holds no GPU storage.
 */
type Target = PlanarMirrorTargetState & {
  /** Absolute mirror view × projection of the last draw. */
  drawn: Matrix;
  /** The view's render count at the last draw. */
  drawnRender: number;
  /** Body of the last draw; null forces the next render to draw (new, resized or reallocated storage). */
  drawnMesh: AbstractMesh | null;
  ready: boolean;
  meshes: AbstractMesh[];
  result: Result | null;
};
type View = {
  camera: Camera;
  disposeObserver: Observer<Node> | null;
  /** Renders of this view: owner updates while its camera is the active camera. */
  renders: number;
  /** `renders` at the latest lookup. */
  requested: number;
  /** Owner render of the latest lookup. */
  seen: number;
  /** Owner render whose lookups may use the target's result; -1 for none. */
  valid: number;
  /** Owner render in which the target's storage was last in use (drawn, reused or waiting for shaders). */
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

/** Sutherland–Hodgman clip of an (x, y, w) polygon against `a·x + b·y + c·w + k ≥ 0`. */
function clipPolygon(source: Float64Array, count: number, target: Float64Array, plane: readonly [number, number, number, number]): number {
  const a = plane[0], b = plane[1], c = plane[2], k = plane[3];
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
  /** The owner's own render count (one per scene render while attached); windows never count engine frames. */
  private tick = 0;
  /** Set while sweeping when some view still needs per-render updates. */
  private busy = false;
  private readonly sweepView = (view: View) => {
    if (view.camera.isDisposed()) { this.removeView(view); return; }
    const target = view.target;
    if (target?.lease && this.tick - view.active > RELEASE_RENDERS) this.releaseStorage(view, target);
    if (target?.lease || this.tick - view.seen <= RELEASE_RENDERS) this.busy = true;
    // A view that never allocated holds nothing worth keeping; one with a target keeps it (without storage) so
    // returning to the water never changes scene membership.
    else if (!target) this.removeView(view);
  };
  private readonly releaseView = (view: View) => this.removeView(view);
  private drawTarget: Target | null = null;
  private drew = false;
  /** Runs inside drawBorrowedTarget, which restores the framebuffer and depth/alpha state. */
  private readonly drawPass = () => {
    const target = this.drawTarget!;
    beginPlanarMirrorPassState(this.scene.getEngine());
    // The first draw waits for every reflected material; later draws skip any mesh that is not ready.
    if (!target.ready) target.ready = target.texture.isReadyForRendering();
    if (target.ready) { target.texture.render(false); this.drew = true; }
  };
  // Scratch, reused every frame.
  private readonly projection = new Matrix();
  private readonly viewProjection = new Matrix();
  private readonly cullViewProjection = new Matrix();
  private readonly nextViewProjection = new Matrix();
  private readonly relativeView = new Matrix();
  private readonly mainPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly reflectionPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly math = new PlanarMirrorMath();
  private readonly plane: MirrorPlane = { nx: 0, ny: 1, nz: 0, d: 0 };
  private readonly excluded = isWaterMesh;
  private readonly polygonA = new Float64Array(36);
  private readonly polygonB = new Float64Array(36);
  private planeY = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.sceneDispose = scene.onDisposeObservable.add(() => this.dispose())!;
  }

  diagnostics(): WaterPlanarReflectionDiagnostics {
    let targets = 0;
    this.views.forEach((view) => { if (view.target?.lease) targets++; });
    return { views: this.views.size, targets, draws: this.draws, reusedFrames: this.reusedFrames };
  }

  forCamera(camera: Camera): WaterPlanarReflection | null {
    const scene = this.scene;
    if (this.disposed || this.drawing || renderTargetCaptureDrawing.has(scene) || camera.getScene() !== scene) return null;
    // After a failed draw nothing is created per lookup until Water quality changes.
    if (sceneWaterQualityRevision(scene) === this.failedRevision) return null;
    let view = this.views.get(camera);
    if (!view) {
      if (camera.isDisposed() || sceneWaterQualityDeviceClamp(scene).quality.reflections !== "planar") return null;
      view = { camera, disposeObserver: null, renders: 0, requested: 0, seen: 0, valid: -1, active: 0, target: null };
      const created = view;
      view.disposeObserver = camera.onDisposeObservable.add(() => this.releaseView(created));
      this.views.set(camera, view);
    }
    view.requested = view.renders;
    view.seen = this.tick;
    if (!this.beforeRender) this.attach();
    const target = view.target;
    return view.valid === this.tick && target?.lease && target.result ? target.result : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.views.forEach(this.releaseView);
    this.detach();
    this.scene.onDisposeObservable.remove(this.sceneDispose);
  }

  /** Per-render observers exist only while some view has asked for a reflection recently or holds storage. */
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
    const tick = ++this.tick;
    const quality = sceneWaterQualityDeviceClamp(scene).quality;
    const revision = sceneWaterQualityRevision(scene);
    if (quality.reflections === "planar" && revision !== this.failedRevision) {
      const camera = scene.activeCamera;
      const view = camera ? this.views.get(camera) : undefined;
      if (view && ++view.renders - view.requested <= DEMAND_RENDERS) {
        try {
          if (this.renderView(view, quality.planarScale, tick)) view.valid = tick;
        } catch (error) {
          // An optional effect must not break the frame: drop every view and retry after a quality change.
          this.failedRevision = revision;
          console.warn(`[render] Water planar reflections are off until Water quality changes: ${String(error)}`);
        }
      }
    }
    if (quality.reflections !== "planar" || revision === this.failedRevision) this.views.forEach(this.releaseView);
    this.busy = false;
    this.views.forEach(this.sweepView);
    if (!this.busy) this.detach();
  }

  /** Draws (or reuses) `view`'s reflection for this render; false when it has none. */
  private renderView(view: View, scale: number, tick: number): boolean {
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
    buildViewProjectionMatrix(scene, camera, viewWidth / viewHeight, this.projection);
    camera.getViewMatrix().multiplyToRef(this.projection, this.viewProjection);
    Frustum.GetPlanesToRef(this.viewProjection, this.mainPlanes);
    const mesh = this.dominantWater(camera);
    if (!mesh) return false;
    const planeY = this.planeY;
    const maxSize = engine.getCaps().maxTextureSize;
    const type = linear ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    const target = this.ensureTarget(view, planarMirrorTargetSize(viewWidth, scale, maxSize), planarMirrorTargetSize(viewHeight, scale, maxSize), type);
    if (!target) return false;
    // In use (drawn or waiting for shaders) keeps the storage; only an unused target is released.
    view.active = tick;
    if (!this.mirror(camera, planeY, target)) return false;
    target.mirror.mirrorView.multiplyToRef(target.projection, this.nextViewProjection);
    if (target.result && target.drawnMesh === mesh && target.drawn.equals(this.nextViewProjection) &&
      view.renders - target.drawnRender < STATIC_REDRAW_INTERVAL) {
      this.reusedFrames++;
      return true;
    }
    // Cull with the mirror camera's ordinary frustum, its near plane replaced by the water plane.
    target.mirror.mirrorView.multiplyToRef(this.projection, this.cullViewProjection);
    clipFrustumAtMirror(this.cullViewProjection, this.plane, this.reflectionPlanes);
    collectPlanarMirrorMeshes(scene, target.meshes, camera.layerMask, this.reflectionPlanes, this.excluded);
    target.mirror.minZ = camera.minZ;
    target.mirror.maxZ = camera.maxZ;
    target.mirror.getViewMatrix(true);
    if (!this.draw(target)) return false;
    this.draws++;
    target.drawn.copyFrom(this.nextViewProjection);
    target.drawnRender = view.renders;
    target.drawnMesh = mesh;
    // The shader's positions are relative to the floating origin (the view's eye) when it is on.
    const origin = scene.floatingOriginMode ? camera.globalPosition : Vector3.ZeroReadOnly;
    let result = target.result;
    if (!result) {
      result = { texture: target.thin, viewProjection: new Matrix(), planeY, mesh, gammaSpace: !linear };
      target.result = result;
    }
    this.math.relativeViewProjection(origin, target.projection, this.relativeView, result.viewProjection);
    result.planeY = planeY;
    result.mesh = mesh;
    result.gammaSpace = !linear;
    return true;
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
    // Flat as WaterField and contacts define it (not a river or a volume tilted out of level).
    if (!plugin || !plugin.water.objectReflections || waterMeshRestVaries(mesh as Mesh) !== false) return NaN;
    // A level body rests on its local y = 0 plane.
    return mesh.computeWorldMatrix().m[13]!;
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
   * Writes the rigid mirror camera (eye reflected across y = planeY) and its oblique projection, whose near plane is
   * the water plane. False when the plane cannot clip this frustum.
   */
  private mirror(camera: Camera, planeY: number, target: Target): boolean {
    const engine = this.scene.getEngine();
    this.plane.d = -planeY;
    if (!this.math.mirror(camera.getViewMatrix(), camera.globalPosition, this.plane, this.projection,
      engine.useReverseDepthBuffer, engine.isNDCHalfZRange, target.mirror.mirrorView, target.projection)) return false;
    const eye = this.math.eye;
    target.mirror.position.set(eye[0]!, eye[1]!, eye[2]!);
    return true;
  }

  /** The view's target holding storage of this size and type, allocating or resizing it in place; null over budget. */
  private ensureTarget(view: View, width: number, height: number, type: number): Target | null {
    let target = view.target;
    // A colour-type change (Scene Linear on or off) is a settings change: rebuild the target for its new format.
    if (target && target.type !== type) { this.disposeTarget(view); target = null; }
    if (!target) return this.createTarget(view, width, height, type);
    if (target.lease && target.width === width && target.height === height) return target;
    if (!resizePlanarMirrorTarget(this.scene, target, width, height, waterResources)) { view.valid = -1; return null; }
    target.drawnMesh = null;
    return target;
  }

  private createTarget(view: View, width: number, height: number, type: number): Target | null {
    const base = createPlanarMirrorTarget(this.scene, `waterPlanarReflection:${view.camera.name}`, view.camera,
      width, height, type, waterResources, TRANSPARENT);
    if (!base) return null;
    const target: Target = Object.assign(base, {
      drawn: new Matrix(), drawnRender: -Infinity, drawnMesh: null, ready: false,
      meshes: base.texture.renderList!, result: null,
    });
    view.target = target;
    return target;
  }

  /** Frees the target's GPU storage and charge; the mirror camera and target stay, outside scene membership. */
  private releaseStorage(view: View, target: Target): void {
    view.valid = -1;
    releasePlanarMirrorStorage(this.scene, target);
  }

  private disposeTarget(view: View): void {
    const target = view.target;
    if (!target) return;
    view.valid = -1;
    view.target = null;
    disposePlanarMirrorTarget(this.scene, target);
  }

  private removeView(view: View): void {
    this.disposeTarget(view);
    view.camera.onDisposeObservable.remove(view.disposeObserver);
    view.disposeObserver = null;
    this.views.delete(view.camera);
  }

  /** Capture-style borrowed draw; restores the view's camera, matrices, UBO, pass and viewport. */
  private draw(target: Target): boolean {
    this.drawing = true;
    this.drawTarget = target;
    this.drew = false;
    try {
      drawPlanarMirrorPass(this.scene, target.texture, this.drawPass, DRAW_POLICY);
    } finally {
      this.drawing = false;
      this.drawTarget = null;
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
 * The planar reflection `camera`'s view drew in this scene render, or null: Reflections are not Planar on this
 * device, no eligible body (built-in, Object Reflections on, flat: not a river or tilted volume) is visible below
 * the eye, the view is excluded (orthographic, rig/XR, several active cameras, clustered lighting, Scene Linear
 * without half-float targets), the scene is not a retained view (previews, thumbnails), the camera belongs to a
 * Render Target Capture or the mirror pass itself, a draw failed (until Water quality changes), or the reflection
 * is not ready yet. Each lookup also requests the reflection for the view's next renders: a view's first request
 * returns null, and a view whose water stops looking it up for `DEMAND_RENDERS` renders stops drawing. The
 * returned object is reused and updated in place; check `mesh` before sampling.
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
