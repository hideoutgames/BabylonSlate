/**
 * Mirror components: a flat surface (Width × Height in its local X–Y plane, reflective side toward local −Z, as a
 * Plane mesh faces) that shows the scene reflected across its plane from the current view's camera.
 *
 * Each surface is an ordinary scene mesh drawing the built-in mirror material (or the component's Material override,
 * which can read the reflection through a Mirror Reflection node). One owner per scene draws the reflections from
 * `onBeforeRender` through the planar mirror pass water uses (`planar-mirror.ts`): an oblique mirror camera renders
 * the opaque scene into the surface's own leased target, never the mirror surfaces themselves or water, so no
 * surface ever samples the target it is drawing into.
 *
 * Budget (`mirror-selection.ts`): a reflection is one more scene draw on the main thread, so a render draws at most
 * `MIRROR_RENDERS_PER_FRAME` surfaces that the view sees from their reflective side, never-drawn first, then nearest;
 * the others keep their last image. A surface whose reflection is current is not drawn again: the view's camera, the
 * surface and its target are as they were drawn, and nothing the pass draws has changed (`ReflectedContent`: the culled
 * meshes, their placement, geometry and materials, and the scene's lights, shadow passes that change a shadow it shows, environment, fog and render
 * settings). A pass culls with the mirrored frustum cropped to the surface's footprint on screen (where its Material can
 * sample the reflection), so content no reflection can show is neither drawn nor followed. Content that changes on its own (skinning, time-driven materials, textures updated in place) keeps its
 * surface due on every render while it is reflected, within the same budget. A target allocates on a surface's first draw and lives with the surface (resized
 * when the size the view draws at, which FSR Upscaling lowers, or Resolution Scale changes), so a skipped surface always has its last image to show.
 *
 * Update Rate (Play only, `sceneHonoursUpdateRates`): a surface at Every 2nd or 4th Frame is a candidate only on the
 * renders its stable phase falls on; on the others it keeps its last image and costs nothing: no cull, content ask,
 * readiness ask or draw. It is a candidate at once, whatever its phase, until it has drawn, when it comes into view,
 * when its target's size or colour type changes, when the quality level changes what it reflects, and while its last
 * draw left a mesh out. A due surface the budget passes over stays due on later renders until it draws or is current.
 *
 * Shadows: a pass shows the scene view's spot and point light shadows. The sun's, only with Reflection Shadows: then a
 * drawing surface's mirror camera holds the sun's cascades as maps of its own, fitted to its mirrored view and drawn
 * just before its pass when they changed (`ReflectionSunShadows`); a surface whose maps would draw differently is not
 * current. Without them the pass draws the sun unshadowed, as the scene view's cascades cover only its own view.
 *
 * Views that draw no reflections (their surfaces keep their last image): orthographic, rig/XR and multi-camera views,
 * Scene Linear without half-float targets, and Render Target Captures, which show what the scene view drew.
 */
import { Camera } from "@babylonjs/core/Cameras/camera";
import { reflectionDrewWhole } from "./reflection-pass-readiness";
import { sceneReadinessRevision } from "./scene-readiness-signal";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { capMirrorReflects, updateRateInterval, type MirrorProperties, type MirrorReflects } from "@haptic/core";
import { dueAtUpdateRate, sceneHonoursUpdateRates, takeUpdateRatePhase, updateRateTick } from "./update-rate-gate";
import type { ManagedRenderResource } from "./managed-render-resources";
import { MirrorReflectionBlock } from "./mirror-reflection-block";
import { offsetReach } from "./mirror-offset-bound";
import { MIRROR_RENDERS_PER_FRAME, selectMirrorsToRender, type MirrorCandidate } from "./mirror-selection";
import {
  createMirrorReflectionBinding, isBuiltInMirrorMaterial, isMirrorSurfaceMesh, markBuiltInMirrorMaterial, mirrorFallbackTexture, type MirrorReflectionBinding,
} from "./mirror-surface-state";
import {
  beginPlanarMirrorPassState, buildViewProjectionMatrix, clipFrustumAtMirror, collectPlanarMirrorCandidates, collectPlanarMirrorMeshes,
  createPlanarMirrorTarget, cropToFootprint, cullPlanarMirrorCandidates, disposePlanarMirrorTarget, drawPlanarMirrorPass, planarFootprintCulling, planarMirrorTargetSize, PlanarMirrorMath,
  projectHullInFront, resizePlanarMirrorTarget,
  type MirrorPlane, type PlanarMirrorTargetState,
} from "./planar-mirror";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { ReflectedContent } from "./reflected-content";
import { reflectionShadowsEnabled } from "./reflection-sun-shadows";
import { shadowChangeSequence } from "./shadow-change-journal";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { enterDrawPass, leaveDrawPass } from "./draw-passes";
import { managedRenderTargetResources } from "./render-target-resource-cost";
import { connectGeometrySurfaceOutput, GeometrySurfaceOutputBlock } from "./geometry-surface-output-block";
import { createSurfacePlumbing } from "./surface-material-plumbing";
import type { MaterialPlumbing } from "./material-block-registry";
import { sceneViewRenderSize } from "./scene-output-scale";
import { upscaledRenderSize } from "./scene-effects";
import { sceneRenderingSettings } from "./render-settings";
import { isWaterSurfaceMesh } from "./water-mesh-surface";
import { isSceneStaticMesh } from "./scene-static-meshes";
import { isSkyboxMesh } from "./skybox";

const DRAW_POLICY = { restoreAlpha: true, wrapDrawFailure: false, message: "Mirror reflection failed." };

/** Counters for proofs and tests; null when the scene has no Mirror surface. */
export interface MirrorDiagnostics {
  /** Registered Mirror surfaces. */
  readonly surfaces: number;
  /** Surfaces holding GPU storage for their reflection. */
  readonly targets: number;
  /** Reflections drawn. */
  readonly draws: number;
  /** Reflections drawn in the last scene render that drew any. */
  readonly lastRenderDraws: number;
  /** Visible surfaces that kept their current reflection instead of drawing it again. */
  readonly reuses: number;
  /** Visible surfaces that kept their last reflection unasked because their Update Rate skipped the render. */
  readonly rateSkips: number;
  /** Meshes the drawn reflections' passes drew, summed over draws. */
  readonly drawnMeshes: number;
  /** Shadow map passes the Scene's surfaces sample, recorded so far (`shadowChangeSequence`). */
  readonly shadowPasses: number;
  /** Surfaces whose reflection holds sun maps of its own (Reflection Shadows). */
  readonly sunShadowViews: number;
  /** Renders in which a visible surface's view had moved since its draw, so its content was not asked (`current`). */
  readonly skippedPolls: number;
  /**
   * While `verifyMirrorContentPolls` is on: renders whose keep-or-draw decision the skipped asks would have changed,
   * found by a second `ReflectedContent` that asks on every render as before. Must stay 0.
   */
  readonly pollMismatches: number;
  /** While `verifyMirrorFootprintCrops` is on: cropped culls also culled with the whole mirrored frustum. */
  readonly cropChecks: number;
  /**
   * Meshes those uncropped culls listed and the crop left out whose bounds, through the mirror view, reach the
   * surface's footprint widened by its sampling reach. Must stay 0.
   */
  readonly cropMisses: number;
  /** While `verifyMirrorSharedCulls` is on: culls made from the render's shared candidates also made by the whole walk. */
  readonly cullChecks: number;
  /** Those whose list differed from the whole walk's, in content or order. Must stay 0. */
  readonly cullMismatches: number;
  /** Culls so far, and the candidate walks of the Scene they made: one per render and kind when shared, one per cull when not. */
  readonly culls: number;
  readonly candidateWalks: number;
}

let verifyingPolls = false;

/**
 * Debugging aid: each Mirror surface also follows its content on every render, as it did before a moved view skipped
 * asking, and counts each render where that would have decided otherwise (`MirrorDiagnostics.pollMismatches`).
 */
export function verifyMirrorContentPolls(enabled: boolean): void {
  verifyingPolls = enabled;
}

let verifyingCrops = false;

/**
 * Debugging aid: each Mirror cull cropped to its footprint also culls with the whole mirrored frustum, and counts the
 * meshes only that one lists whose bounds reach the widened footprint (`MirrorDiagnostics.cropMisses`). It checks the
 * crop's own geometry for the reach it was given, not the reach.
 */
export function verifyMirrorFootprintCrops(enabled: boolean): void {
  verifyingCrops = enabled;
}

let verifyingCulls = false;

/**
 * Debugging aid: each Mirror cull made from the candidates its render shares (`collectPlanarMirrorCandidates`) also
 * walks the whole Scene as each cull did before, and counts each list that differs (`MirrorDiagnostics.cullMismatches`).
 */
export function verifyMirrorSharedCulls(enabled: boolean): void {
  verifyingCulls = enabled;
}

let unshared = false;

/** Test and proof hook: each Mirror cull walks the whole Scene again, as before its render shared the candidates. */
export function walkMirrorCullsUnshared(enabled: boolean): void {
  unshared = enabled;
}

let redrawGeneration = 0;

/**
 * Test and proof hook: every Mirror surface draws its reflection again on its next render, whatever it shows, so a
 * paused frame compared across two paths draws the reflections on each (`MirrorDiagnostics.draws` counts them).
 */
export function redrawMirrorReflections(): void {
  redrawGeneration++;
}

/** NDC slack before a left-out mesh's bounds count as reaching the footprint: a box touching its edge is either side. */
const CROP_CHECK_SLACK = 1e-5;

/** The verifier's own record of a surface: what the poll on every render follows, and the dirty flag it keeps. */
type PollCheck = { content: ReflectedContent; dirty: boolean };

type Surface = MirrorCandidate & {
  readonly mesh: Mesh;
  readonly properties: MirrorProperties;
  readonly binding: MirrorReflectionBinding;
  readonly plane: MirrorPlane;
  target: PlanarMirrorTargetState | null;
  /** The first draw waits for every reflected material; later draws skip any mesh that is not ready. */
  ready: boolean;
  failed: boolean;
  /** What the pass draws, followed while the surface is visible; `dirty` holds a change until a draw shows it. */
  readonly content: ReflectedContent;
  /** Something the pass draws may have changed since the last draw, or the last draw skipped a mesh not yet ready. */
  dirty: boolean;
  /** The mirror view-projection of the last draw. */
  readonly drawnViewProjection: Matrix;
  /** Whether the last draw listed nothing: its image is open everywhere, whatever the view. */
  drawnEmpty: boolean;
  /** The owner's `listEpoch` when the pass's list was last culled, and the target it was culled into. */
  culledAt: number;
  culledInto: PlanarMirrorTargetState | null;
  /** While verifying (`verifyMirrorContentPolls`); null otherwise, and until the surface's first draw after it is on. */
  check: PollCheck | null;
  /** Renders between candidacies at its Update Rate (1, 2 or 4), and its stable offset among them. */
  readonly interval: number;
  readonly phase: number;
  /** Whether the surface was in view (`place`) at the owner's last render. */
  inView: boolean;
  /** Owed a draw: its rate (or a change) made it a candidate and it has not drawn or been found current since. */
  due: boolean;
};

/** What a Moving Actors reflection is cleared to: no colour, and alpha 1, which a drawn fragment turns to 0. */
const OPEN = new Color4(0, 0, 0, 1);
/** Blend factors as the Engine's alpha state takes them: the GL values. */
const BLEND_ZERO = 0;
const BLEND_ONE = 1;

const owners = new WeakMap<Scene, SceneMirrors>();

/** Target texels of margin around a footprint: bilinear sampling at its edge reads the next texel out. */
const FOOTPRINT_TEXELS = 2;
const reach = { x: 0, y: 0 };

const nodeReach = { x: 0, y: 0 };

/**
 * How far (texture units per axis) `material` samples a surface's reflection from the surface's own screen position,
 * into `reach`; null when it cannot be bounded. The built-in surface samples it in place; an authored Mirror Reflection
 * node reaches by the bound on what drives its Offset (`offsetReach`: interval rules over the compiled blocks, read
 * every render, so a parameter edit applies), and an Offset no rule bounds is unbounded.
 */
function sampleReach(material: Material | null): { x: number; y: number } | null {
  reach.x = reach.y = 0;
  if (!material || isBuiltInMirrorMaterial(material)) return reach;
  if (!(material instanceof NodeMaterial)) return null;
  for (const block of material.attachedBlocks) {
    if (!(block instanceof MirrorReflectionBlock)) continue;
    if (!offsetReach(block.offset, nodeReach)) return null;
    reach.x = Math.max(reach.x, nodeReach.x);
    reach.y = Math.max(reach.y, nodeReach.y);
  }
  return reach;
}
const builtInMaterials = new WeakMap<Scene, NodeMaterial>();

function excludedFromMirrors(mesh: AbstractMesh): boolean {
  return isMirrorSurfaceMesh(mesh) || isWaterSurfaceMesh(mesh);
}

function mirrorResources(texture: RenderTargetTexture): ManagedRenderResource[] {
  return managedRenderTargetResources(texture.renderTarget!, { colorCategory: "sceneColor" });
}

class SceneMirrors {
  readonly surfaces: Surface[] = [];
  draws = 0;
  lastRenderDraws = 0;
  reuses = 0;
  rateSkips = 0;
  drawnMeshes = 0;
  skippedPolls = 0;
  pollMismatches = 0;
  cropChecks = 0;
  cropMisses = 0;
  cullChecks = 0;
  cullMismatches = 0;
  candidateCulls = 0;
  candidateWalks = 0;
  /** The `redrawMirrorReflections` request each surface last took. */
  private readonly redrawsSeen = new WeakMap<Surface, number>();
  private readonly scene: Scene;
  private beforeRender: Observer<Scene> | null = null;
  /** The owner's renders, and whether Reflection Shadows is on in this one. */
  private renders = 0;
  private sunShadows = false;
  /**
   * Bumped as an update starts and before a surface's sun maps and pass run: a pass list culled under the same value
   * was made for this view, and nothing that can change what it lists (a shadow map or mirror pass, which run render
   * hooks) has run since. A draw that stops before them (no target, an eye that cannot see the surface) leaves it, so
   * the lists culled before it still stand. Not a count: `candidateCulls` counts the culls.
   */
  private listEpoch = 0;
  private order = 0;
  private drawing = false;
  private drawTarget: PlanarMirrorTargetState | null = null;
  private drawSurface: Surface | null = null;
  private drew = false;
  private readonly selected: Surface[] = [];
  private readonly math = new PlanarMirrorMath();
  private readonly projection = new Matrix();
  private readonly viewProjection = new Matrix();
  private readonly cullViewProjection = new Matrix();
  private readonly cropViewProjection = new Matrix();
  /** The widened footprint (NDC min x, min y, max x, max y) of the last crop, and the crop check's scratch. */
  private readonly footprint = new Float64Array(4);
  private readonly checkRect = new Float64Array(4);
  private readonly checkPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly checkList: AbstractMesh[] = [];
  private readonly checkListed = new Set<AbstractMesh>();
  /**
   * The candidates of the culls (`collectPlanarMirrorCandidates`), for Everything and for Moving Actors surfaces, and the
   * `listEpoch` they were collected under: the culls of one render share them until a pass draws.
   */
  private readonly candidates: AbstractMesh[] = [];
  private readonly stillCandidates: AbstractMesh[] = [];
  private candidatesAt = -1;
  private stillCandidatesAt = -1;
  private readonly corners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly relativeView = new Matrix();
  private readonly planes = Frustum.GetPlanes(Matrix.Identity());
  private readonly reflectionPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly nextViewProjection = new Matrix();
  private readonly scratch = new Vector3();
  /** Not drawn into a Moving Actors reflection: what a Mirror never draws, the sky, and the actors that never move. */
  private readonly excludedStill = (mesh: AbstractMesh) =>
    excludedFromMirrors(mesh) || mesh.infiniteDistance || isSkyboxMesh(mesh) || isSceneStaticMesh(this.scene, mesh);
  private readonly drawPass = () => {
    const surface = this.drawSurface!, target = this.drawTarget!;
    beginPlanarMirrorPassState(this.scene.getEngine());
    // The first draw waits for every reflected material; later draws skip any mesh that is not ready, and stay dirty
    // until a draw has drawn every one.
    let complete = false;
    const revision = sceneReadinessRevision(this.scene);
    if (!surface.ready) complete = surface.ready = target.texture.isReadyForRendering();
    if (!surface.ready) return;
    const engine = this.scene.getEngine();
    // A Moving Actors reflection keeps each fragment's colour and writes alpha 0 over the cleared 1, whatever alpha its
    // Material outputs: the surface reads the alpha as where nothing drew, and filtered edges as partly so.
    const alpha = this.mode(surface) === "movingActors" ? engine._alphaState : null;
    if (alpha) {
      alpha.setAlphaBlendFunctionParameters(BLEND_ONE, BLEND_ZERO, BLEND_ZERO, BLEND_ZERO);
      alpha.setAlphaEquationParameters(Constants.GL_ALPHA_EQUATION_ADD, Constants.GL_ALPHA_EQUATION_ADD);
      alpha.alphaBlend = true;
    }
    enterDrawPass(engine, "mirrors", true);
    try {
      target.texture.render(false);
    } finally {
      leaveDrawPass(engine);
      if (alpha) alpha.alphaBlend = false;
    }
    this.drew = true;
    surface.dirty = !reflectionDrewWhole(target.texture, revision, complete);
  };

  constructor(scene: Scene) {
    this.scene = scene;
  }

  add(mesh: Mesh, properties: MirrorProperties): void {
    const interval = updateRateInterval(properties.updateRate);
    const surface: Surface = {
      interval, phase: takeUpdateRatePhase(this.scene, interval), inView: false, due: false,
      mesh, properties, binding: createMirrorReflectionBinding(mesh, properties.tint, properties.reflects), plane: { nx: 0, ny: 0, nz: -1, d: 0 },
      target: null, ready: false, failed: false, content: new ReflectedContent(), dirty: true, drawnViewProjection: new Matrix(),
      drawnEmpty: false, culledAt: 0, culledInto: null, check: null, drawn: false, visible: false, order: this.order++, distance: 0,
      cx: 0, cy: 0, cz: 0, nx: 0, ny: 0, nz: -1, ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0,
    };
    this.surfaces.push(surface);
    // Two surfaces sharing a Material and Effect would otherwise skip the second one's bind (its texture).
    mesh.onBeforeBindObservable.add(() => this.scene.resetCachedMaterial());
    mesh.onDisposeObservable.addOnce(() => this.remove(surface));
    this.beforeRender ??= this.scene.onBeforeRenderObservable.add(() => this.update());
  }

  diagnostics(): MirrorDiagnostics {
    return {
      surfaces: this.surfaces.length, targets: this.surfaces.filter((surface) => surface.target?.lease).length,
      draws: this.draws, lastRenderDraws: this.lastRenderDraws, reuses: this.reuses, rateSkips: this.rateSkips, drawnMeshes: this.drawnMeshes,
      shadowPasses: shadowChangeSequence(this.scene),
      sunShadowViews: this.surfaces.filter((surface) => surface.target?.sunShadows.holdsMaps).length,
      skippedPolls: this.skippedPolls, pollMismatches: this.pollMismatches, cropChecks: this.cropChecks, cropMisses: this.cropMisses,
      cullChecks: this.cullChecks, cullMismatches: this.cullMismatches, culls: this.candidateCulls, candidateWalks: this.candidateWalks,
    };
  }

  /** What `surface` draws live: what its Mirror asks for, or what the quality level allows when that is less. */
  private mode(surface: Surface): MirrorReflects {
    return capMirrorReflects(surface.properties.reflects, sceneRenderingSettings(this.scene).mirrorReflections);
  }

  private remove(surface: Surface): void {
    const index = this.surfaces.indexOf(surface);
    if (index >= 0) this.surfaces.splice(index, 1);
    surface.binding.texture = null;
    if (surface.target) disposePlanarMirrorTarget(this.scene, surface.target);
    surface.target = surface.culledInto = null;
    surface.content.dispose();
    surface.check?.content.dispose();
    surface.check = null;
    if (!this.surfaces.length) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRender);
      this.beforeRender = null;
    }
  }

  private update(): void {
    const scene = this.scene, engine = scene.getEngine();
    if (this.drawing || renderTargetCaptureDrawing.has(scene)) return;
    const camera = scene.activeCamera;
    if (!camera || camera.mode !== Camera.PERSPECTIVE_CAMERA || camera.rigCameras.length > 0 || (scene.activeCameras?.length ?? 0) > 1) return;
    const linear = scene.imageProcessingConfiguration.applyByPostProcess;
    if (linear && !engine.getCaps().textureHalfFloatRender) return;
    const view = sceneViewRenderSize(scene, camera.outputRenderTarget);
    const viewWidth = view.width * camera.viewport.width;
    const viewHeight = view.height * camera.viewport.height;
    if (!(viewWidth >= 1 && viewHeight >= 1)) return;
    // Everything the reflections cost counts to them: placement, currency checks, culls and content asks too, not only
    // their passes (which nest in this).
    enterDrawPass(engine, "mirrors", true);
    try {
      this.updateSurfaces(camera, view, viewWidth / viewHeight, linear);
    } finally {
      leaveDrawPass(engine);
    }
  }

  /** `update` for a view whose camera and size (`view`, its output's) draw reflections. */
  private updateSurfaces(camera: Camera, view: { width: number; height: number }, aspect: number, linear: boolean): void {
    const scene = this.scene, engine = scene.getEngine();
    buildViewProjectionMatrix(scene, camera, aspect, this.projection);
    camera.getViewMatrix().multiplyToRef(this.projection, this.viewProjection);
    Frustum.GetPlanesToRef(this.viewProjection, this.planes);
    // Targets follow the size the view's scene draws at: its output's, or less under FSR Upscaling's render scale.
    const drawn = upscaledRenderSize(sceneRenderingSettings(scene).effectsPlan, view.width, view.height);
    const drawnWidth = drawn.width * camera.viewport.width;
    const drawnHeight = drawn.height * camera.viewport.height;
    const maxSize = engine.getCaps().maxTextureSize;
    const type = linear ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    const tick = ++this.renders;
    this.listEpoch++;
    this.sunShadows = reflectionShadowsEnabled(scene);
    const rates = sceneHonoursUpdateRates(scene), frame = updateRateTick(scene);
    for (const surface of this.surfaces) {
      // Off, every surface gives its maps back now; a current one then draws again, unshadowed.
      if (!this.sunShadows) surface.target?.sunShadows.release();
      const wasInView = surface.inView;
      this.place(surface, camera.layerMask);
      surface.inView = surface.visible;
      const mode = this.mode(surface);
      if (mode !== surface.binding.reflects) {
        // The quality level changed what the surface shows: its Material compiles the other variant. The image drawn
        // for the old one is drawn again, as after any change of the render settings (`ReflectedContent`).
        surface.binding.reflects = mode;
        surface.due = true;
        this.recompile(surface.mesh.material);
      }
      // An Environment surface draws no reflection and holds no storage for one: its Material shows the environment.
      if (mode === "environment") {
        surface.visible = false;
        if (surface.target) this.release(surface);
        continue;
      }
      // Off its Update Rate's renders the surface keeps its last image without asking anything about it.
      if (surface.visible && rates && this.skipsByRate(surface, frame, wasInView, drawnWidth, drawnHeight, type, maxSize)) {
        surface.visible = false;
        this.rateSkips++;
        continue;
      }
      // A current reflection is not a candidate: the budget goes to surfaces whose image is due.
      if (surface.visible && this.current(surface, camera, drawnWidth, drawnHeight, type, maxSize)) {
        surface.visible = false;
        surface.due = false;
        this.reuses++;
      }
    }
    selectMirrorsToRender(camera.globalPosition, this.surfaces, MIRROR_RENDERS_PER_FRAME, this.selected);
    let draws = 0;
    for (const surface of this.selected) {
      try {
        if (this.renderSurface(surface, camera, drawnWidth, drawnHeight, linear)) draws++;
      } catch (error) {
        // An optional effect must not break the frame: this surface keeps its last image from now on.
        surface.failed = true;
        surface.target?.sunShadows.release();
        console.warn(`[render] Mirror reflection is off for "${surface.mesh.name}": ${String(error)}`);
      }
    }
    // A surface that has stopped drawing gives its sun maps back.
    for (const surface of this.surfaces) surface.target?.sunShadows.releaseIdle(tick);
    if (draws) this.lastRenderDraws = draws;
    this.selected.length = 0;
  }

  /** The surface's world rectangle, plane and eligibility for this render. */
  private place(surface: Surface, layerMask: number): void {
    const mesh = surface.mesh;
    surface.visible = false;
    if (surface.failed || !surface.properties.enabled || mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible ||
      mesh.visibility <= 0 || !(mesh.layerMask & layerMask)) return;
    // Forced: a transform written earlier in this render id (a snapshot, an edit) must not read a cached matrix.
    const m = mesh.computeWorldMatrix(true).m;
    const halfWidth = surface.properties.width / 2, halfHeight = surface.properties.height / 2;
    surface.cx = m[12]!; surface.cy = m[13]!; surface.cz = m[14]!;
    surface.ux = m[0]! * halfWidth; surface.uy = m[1]! * halfWidth; surface.uz = m[2]! * halfWidth;
    surface.vx = m[4]! * halfHeight; surface.vy = m[5]! * halfHeight; surface.vz = m[6]! * halfHeight;
    // The reflective side is local −Z; under a mirrored (negative-determinant) transform it is the cross product.
    const normal = this.scratch.set(
      surface.vy * surface.uz - surface.vz * surface.uy,
      surface.vz * surface.ux - surface.vx * surface.uz,
      surface.vx * surface.uy - surface.vy * surface.ux,
    );
    const length = normal.length();
    if (!(length > 0)) return;
    surface.nx = normal.x / length; surface.ny = normal.y / length; surface.nz = normal.z / length;
    surface.binding.normal.set(surface.nx, surface.ny, surface.nz);
    const plane = surface.plane;
    plane.nx = surface.nx; plane.ny = surface.ny; plane.nz = surface.nz;
    plane.d = -(surface.nx * surface.cx + surface.ny * surface.cy + surface.nz * surface.cz);
    surface.visible = mesh.isInFrustum(this.planes);
  }

  /**
   * Whether a drawn surface's reflection still shows what a draw would: the same target size and colour type, the same
   * mirror view-projection, and nothing the pass draws changed (`ReflectedContent`, followed on every visible render).
   * Leaves the mirror camera and the pass's list as a draw this render would set them. `drawnWidth` × `drawnHeight` is
   * the size the view's scene draws at.
   */
  private current(surface: Surface, camera: Camera, drawnWidth: number, drawnHeight: number, type: number, maxSize: number): boolean {
    const target = surface.target;
    if (!surface.drawn || !target || !this.fits(surface, drawnWidth, drawnHeight, type, maxSize)) return false;
    if (!this.mirrorAndCull(surface, camera, target)) return false;
    target.mirror.mirrorView.multiplyToRef(target.projection, this.nextViewProjection);
    const moved = !surface.drawnViewProjection.equals(this.nextViewProjection);
    const list = target.texture.renderList!;
    const check = this.check(surface);
    // A moved view draws the reflection again whatever it shows, so asking what changed decides nothing now. The ask is
    // not lost: the next one (this render's draw, or a later render's) reports every change since the last, and the
    // draw's own ask is what a still view compares with. An empty last draw is kept from any view: it asks.
    // Its sun maps are asked at most once a render (the ask follows their casters).
    let due: boolean | undefined;
    const sunDue = () => (due ??= target.sunShadows.due(this.sunShadows, this.projection));
    /**
     * Whether the surface keeps its reflection when its content is `dirty`: nothing drew and nothing would (a mesh
     * entering the list is a change), so the image is open everywhere from any view; or its sun maps would draw as they
     * did and the view has not moved. A surface found due through its sun maps stays dirty (`mark`).
     */
    const keeps = (dirty: boolean, mark: (sun: boolean) => void) => {
      if (surface.drawnEmpty && !dirty) return true;
      const sun = sunDue();
      mark(sun);
      return !dirty && !sun && !moved;
    };
    // A surface first seen takes the requests made so far as taken; a later one draws it again.
    const seen = this.redrawsSeen.get(surface);
    if (seen !== redrawGeneration) {
      this.redrawsSeen.set(surface, redrawGeneration);
      if (seen !== undefined) surface.dirty = true;
    }
    let current: boolean;
    if (moved && !surface.drawnEmpty) {
      this.skippedPolls++;
      if (sunDue()) surface.dirty = true;
      current = false;
    } else {
      if (surface.content.changed(this.scene, list)) surface.dirty = true;
      current = keeps(surface.dirty, (sun) => { if (sun) surface.dirty = true; });
    }
    if (check) {
      // The decision a poll on every render makes, with its own record of what changed since the draw.
      if (check.content.changed(this.scene, list)) check.dirty = true;
      const polled = keeps(check.dirty, (sun) => { if (sun) check.dirty = true; });
      if (polled !== current) this.pollMismatches++;
    }
    return current;
  }

  /** Whether the surface's target holds storage of the size and colour type a draw this render would use. */
  private fits(surface: Surface, drawnWidth: number, drawnHeight: number, type: number, maxSize: number): boolean {
    const target = surface.target;
    if (!target?.lease || target.type !== type) return false;
    const scale = surface.properties.resolutionScale;
    return target.width === planarMirrorTargetSize(drawnWidth, scale, maxSize) && target.height === planarMirrorTargetSize(drawnHeight, scale, maxSize);
  }

  /**
   * Whether a visible surface sits this render out at its Update Rate. It does not while it has never drawn, has just
   * come into view, needs another target, is owed a draw (its rate's render or a change made it a candidate and it has
   * neither drawn nor been found current since) or its last draw left a mesh out (`dirty` after a draw); a render on its
   * phase makes it owed.
   */
  private skipsByRate(surface: Surface, tick: number, wasInView: boolean, drawnWidth: number, drawnHeight: number, type: number, maxSize: number): boolean {
    if (surface.interval <= 1) return false;
    if (!surface.due && surface.drawn && wasInView && !surface.dirty && this.fits(surface, drawnWidth, drawnHeight, type, maxSize) &&
      !dueAtUpdateRate(tick, surface.interval, surface.phase)) return true;
    surface.due = true;
    return false;
  }

  /** The surface's verifier record while verifying; gives it up once verifying stops. */
  private check(surface: Surface): PollCheck | null {
    if (verifyingPolls) return surface.check;
    surface.check?.content.dispose();
    surface.check = null;
    return null;
  }

  /**
   * Places the surface's mirror camera for the view and culls the pass's list, unless `listed` (the list is already
   * the one this placement culls); false when the eye cannot see it.
   */
  private mirrorAndCull(surface: Surface, camera: Camera, target: PlanarMirrorTargetState, listed = false): boolean {
    const engine = this.scene.getEngine();
    if (!this.math.mirror(camera.getViewMatrix(), camera.globalPosition, surface.plane, this.projection,
      engine.useReverseDepthBuffer, target.mirror.mirrorView, target.projection)) return false;
    const eye = this.math.eye;
    const mirror = target.mirror;
    mirror.position.set(eye[0]!, eye[1]!, eye[2]!);
    // Its sun maps split and fit by the view's clip range (`ReflectionSunShadows`).
    mirror.minZ = camera.minZ;
    mirror.maxZ = camera.maxZ;
    mirror.getViewMatrix(true);
    if (listed) return true;
    // Cull with the mirror camera's ordinary frustum, cropped to the surface's footprint, its near plane replaced by the
    // mirror plane.
    target.mirror.mirrorView.multiplyToRef(this.projection, this.cullViewProjection);
    const cropped = this.cropToSurface(surface, target);
    clipFrustumAtMirror(cropped ? this.cropViewProjection : this.cullViewProjection, surface.plane, this.reflectionPlanes);
    const still = this.mode(surface) === "movingActors";
    const excluded = still ? this.excludedStill : excludedFromMirrors;
    const list = target.texture.renderList!;
    cullPlanarMirrorCandidates(this.scene, this.candidatesFor(still, camera.layerMask, excluded), list, this.reflectionPlanes);
    if (verifyingCulls) this.checkCull(list, camera.layerMask, excluded);
    if (cropped && verifyingCrops) this.checkCrop(list, camera.layerMask, surface.plane, excluded);
    surface.culledAt = this.listEpoch;
    surface.culledInto = target;
    return true;
  }

  /**
   * The candidates a cull keeps from: collected at the render's first cull of that kind and shared by its later ones
   * until a pass draws (`listEpoch` moves), since nothing between them writes what they test; collected afresh every cull
   * when unshared (`walkMirrorCullsUnshared`). One camera draws a render, so its layer mask is the same throughout.
   */
  private candidatesFor(still: boolean, layerMask: number, excluded: (mesh: AbstractMesh) => boolean): readonly AbstractMesh[] {
    const list = still ? this.stillCandidates : this.candidates;
    this.candidateCulls++;
    if (unshared || (still ? this.stillCandidatesAt : this.candidatesAt) !== this.listEpoch) {
      this.candidateWalks++;
      collectPlanarMirrorCandidates(this.scene, list, layerMask, excluded);
      if (still) this.stillCandidatesAt = this.listEpoch;
      else this.candidatesAt = this.listEpoch;
    }
    return list;
  }

  /** The shared-cull verifier: the whole walk at the same moment, whose list must equal `listed` in order. */
  private checkCull(listed: readonly AbstractMesh[], layerMask: number, excluded: (mesh: AbstractMesh) => boolean): void {
    this.cullChecks++;
    const walked = this.checkList;
    collectPlanarMirrorMeshes(this.scene, walked, layerMask, this.reflectionPlanes, excluded, false);
    if (walked.length !== listed.length || walked.some((mesh, index) => mesh !== listed[index])) this.cullMismatches++;
    walked.length = 0;
  }

  /**
   * Crops the culling view-projection to where the surface's Material can sample its reflection: the rectangle's
   * projection (the mirror view projects a point on the plane where the view does, mirrored), widened by its reach and
   * the bilinear margin. False (no crop) when that cannot be bounded: an unbounded Offset or a lattice-deformed surface.
   */
  private cropToSurface(surface: Surface, target: PlanarMirrorTargetState): boolean {
    const mesh = surface.mesh;
    if (!planarFootprintCulling(this.scene) || hasMeshLatticeDeformer(mesh)) return false;
    const sampled = sampleReach(mesh.material);
    if (!sampled) return false;
    const [a, b, c, d] = this.corners as [Vector3, Vector3, Vector3, Vector3];
    a.set(surface.cx - surface.ux - surface.vx, surface.cy - surface.uy - surface.vy, surface.cz - surface.uz - surface.vz);
    b.set(surface.cx + surface.ux - surface.vx, surface.cy + surface.uy - surface.vy, surface.cz + surface.uz - surface.vz);
    c.set(surface.cx + surface.ux + surface.vx, surface.cy + surface.uy + surface.vy, surface.cz + surface.uz + surface.vz);
    d.set(surface.cx - surface.ux + surface.vx, surface.cy - surface.uy + surface.vy, surface.cz - surface.uz + surface.vz);
    // Texture units are half the NDC range.
    const marginX = 2 * sampled.x + 2 * FOOTPRINT_TEXELS / target.width;
    const marginY = 2 * sampled.y + 2 * FOOTPRINT_TEXELS / target.height;
    return cropToFootprint(this.cullViewProjection, this.corners, marginX, marginY, this.cropViewProjection, this.footprint);
  }

  /**
   * The crop verifier: culls again with the whole mirrored frustum (`cullViewProjection`) and counts each mesh only it
   * lists whose bounds, through the mirror view, reach the widened footprint the crop was made for.
   */
  private checkCrop(listed: readonly AbstractMesh[], layerMask: number, plane: MirrorPlane, excluded: (mesh: AbstractMesh) => boolean): void {
    this.cropChecks++;
    clipFrustumAtMirror(this.cullViewProjection, plane, this.checkPlanes);
    collectPlanarMirrorMeshes(this.scene, this.checkList, layerMask, this.checkPlanes, excluded, false);
    const kept = this.checkListed;
    for (const mesh of listed) kept.add(mesh);
    const footprint = this.footprint, rect = this.checkRect;
    for (const mesh of this.checkList) {
      if (kept.has(mesh)) continue;
      projectHullInFront(this.cullViewProjection, mesh.getBoundingInfo().boundingBox.vectorsWorld, rect);
      if (rect[0]! < footprint[2]! - CROP_CHECK_SLACK && rect[2]! > footprint[0]! + CROP_CHECK_SLACK &&
        rect[1]! < footprint[3]! - CROP_CHECK_SLACK && rect[3]! > footprint[1]! + CROP_CHECK_SLACK) this.cropMisses++;
    }
    kept.clear();
    this.checkList.length = 0;
  }

  private renderSurface(surface: Surface, camera: Camera, drawnWidth: number, drawnHeight: number, linear: boolean): boolean {
    const scene = this.scene, engine = scene.getEngine();
    const maxSize = engine.getCaps().maxTextureSize;
    const scale = surface.properties.resolutionScale;
    const width = planarMirrorTargetSize(drawnWidth, scale, maxSize), height = planarMirrorTargetSize(drawnHeight, scale, maxSize);
    const type = linear ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    // The list `current` culled this update is still the pass's while no sun map or pass has run since: the same view,
    // plane, mode and target (`current` checked its size and type, so `ensureTarget` keeps it as it is). A cull here
    // shares the candidates collected since then too.
    const listed = surface.culledAt === this.listEpoch;
    const target = this.ensureTarget(surface, camera, width, height, type);
    if (!target) return false;
    if (!this.mirrorAndCull(surface, camera, target, listed && surface.culledInto === target)) return false;
    // A view without its own clear colour clears like the scene view does.
    target.texture.clearColor = this.mode(surface) === "movingActors" ? OPEN : this.scene.clearColor ?? new Color4(0, 0, 0, 1);
    // From here render hooks run (its sun maps, its pass): no list culled before stands for a later surface.
    this.listEpoch++;
    // Its own sun maps first: the shadow passes the content follows from on are then those after them.
    target.sunShadows.prepare(this.sunShadows, this.projection, "mirrors", this.renders);
    // Follows the drawn list from this draw on (a surface's first draw starts following it here). A change since the
    // last ask keeps the surface due if this draw does not happen: `current` may not have asked this render.
    if (surface.content.changed(scene, target.texture.renderList!)) surface.dirty = true;
    const check = this.check(surface) ?? (verifyingPolls ? (surface.check = { content: new ReflectedContent(), dirty: surface.dirty }) : null);
    check?.content.changed(scene, target.texture.renderList!);
    if (!this.draw(surface, target)) return false;
    if (check) check.dirty = surface.dirty;
    this.draws++;
    this.drawnMeshes += target.texture.renderList!.length;
    surface.drawn = true;
    surface.due = false;
    surface.drawnEmpty = this.mode(surface) === "movingActors" && !target.texture.renderList!.length;
    target.mirror.mirrorView.multiplyToRef(target.projection, surface.drawnViewProjection);
    const binding = surface.binding;
    // The shader's positions are relative to the floating origin (the view's eye) when it is on.
    binding.origin.copyFrom(scene.floatingOriginMode ? camera.globalPosition : Vector3.ZeroReadOnly);
    this.math.relativeViewProjection(binding.origin, target.projection, this.relativeView, binding.viewProjection);
    binding.gammaSpace = !linear;
    binding.texture = target.thin;
    return true;
  }

  /** The surface's target holding storage of this size and type; null when the ledger refuses it. */
  private ensureTarget(surface: Surface, camera: Camera, width: number, height: number, type: number): PlanarMirrorTargetState | null {
    let target = surface.target;
    // A colour-type change (Scene Linear on or off) is a settings change: rebuild the target for its new format.
    if (target && target.type !== type) {
      this.release(surface);
      target = null;
    }
    if (!target) {
      target = createPlanarMirrorTarget(this.scene, `mirror:${surface.mesh.name}`, camera, width, height, type,
        mirrorResources, this.scene.clearColor ?? new Color4(0, 0, 0, 1));
      surface.target = target;
      surface.ready = false;
      return target;
    }
    if (resizePlanarMirrorTarget(this.scene, target, width, height, mirrorResources)) return target;
    surface.binding.texture = null;
    surface.drawn = false;
    return null;
  }

  /**
   * Has `material` prepare its defines again, a frozen one too, whatever blocks the Scene's dirty mechanism now (as a
   * Reflection Probe's first publish does for the cube its meshes read).
   */
  private recompile(material: Material | null): void {
    if (!material) return;
    const scene = this.scene, blocked = scene.blockMaterialDirtyMechanism;
    scene.blockMaterialDirtyMechanism = false;
    try {
      material.markAsDirty(Material.MiscDirtyFlag);
      material.markDirty(true);
    } finally {
      scene.blockMaterialDirtyMechanism = blocked;
    }
  }

  /** Gives up the surface's target and what it drew. */
  private release(surface: Surface): void {
    surface.binding.texture = null;
    surface.drawn = surface.drawnEmpty = false;
    if (surface.target) disposePlanarMirrorTarget(this.scene, surface.target);
    surface.target = surface.culledInto = null;
  }

  private draw(surface: Surface, target: PlanarMirrorTargetState): boolean {
    this.drawing = true;
    this.drawSurface = surface;
    this.drawTarget = target;
    this.drew = false;
    try {
      drawPlanarMirrorPass(this.scene, target.texture, this.drawPass, DRAW_POLICY);
    } finally {
      this.drawing = false;
      this.drawSurface = null;
      this.drawTarget = null;
    }
    return this.drew;
  }
}

function ownerFor(scene: Scene): SceneMirrors {
  let owner = owners.get(scene);
  if (!owner) {
    owner = new SceneMirrors(scene);
    owners.set(scene, owner);
    scene.onDisposeObservable.addOnce(() => owners.delete(scene));
  }
  return owner;
}

/**
 * The scene's built-in mirror surface material: the reflection times the surface's Tint, unlit. Like an authored
 * Material it writes the scene effects' geometry outputs (depth and normal, no reflectivity, so Real-Time Reflections
 * add none to the reflection): a geometry pass binds every attachment for it, and a draw that leaves one unwritten is
 * a WebGL error that fails the session's next scene presentation.
 */
function builtInMirrorMaterial(scene: Scene): NodeMaterial {
  const existing = builtInMaterials.get(scene);
  if (existing) return existing;
  const material = new NodeMaterial("mirrorSurface", scene, {
    shaderLanguage: ShaderLanguage.GLSL,
  });
  const created: NodeMaterialBlock[] = [];
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing("mirrorSurface", created, plumbing);
  const reflection = new MirrorReflectionBlock("mirrorSurfaceReflection", true);
  plumbing.worldPosition!.connectTo(reflection.worldPosition);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const fragment = new GeometrySurfaceOutputBlock("mirrorSurfaceOutput");
  connectGeometrySurfaceOutput(fragment, plumbing, null, created);
  reflection.color.connectTo(fragment.rgb);
  material.addOutputNode(outputs[0]!);
  material.addOutputNode(fragment);
  material.build(false);
  material.doNotSerialize = true;
  markBuiltInMirrorMaterial(material);
  builtInMaterials.set(scene, material);
  material.onDisposeObservable.addOnce(() => { if (builtInMaterials.get(scene) === material) builtInMaterials.delete(scene); });
  return material;
}

/**
 * Creates a Mirror component's surface: a Width × Height plane facing local −Z drawing the built-in mirror material,
 * registered with the scene's mirror owner. A Material override replaces the material afterwards; clearing it (a
 * null material) restores the built-in one. A disabled Mirror's surface is hidden and never draws a reflection.
 */
export function createMirrorSurfaceMesh(scene: Scene, name: string, properties: MirrorProperties): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { width: properties.width, height: properties.height }, scene);
  // The fallback texel exists before any pass binds it.
  mirrorFallbackTexture(scene);
  const builtIn = builtInMirrorMaterial(scene);
  mesh.material = builtIn;
  mesh.onMaterialChangedObservable.add(() => { if (!mesh.material && !mesh.isDisposed()) mesh.material = builtIn; });
  mesh.setEnabled(properties.enabled);
  ownerFor(scene).add(mesh, properties);
  return mesh;
}

export function mirrorDiagnostics(scene: Scene): MirrorDiagnostics | null {
  const owner = owners.get(scene);
  return owner?.surfaces.length ? owner.diagnostics() : null;
}
