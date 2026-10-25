import { activeRenderFrameCapture } from "./render-frame-report";
import { isSceneGameTimePaused } from "./scene-game-time";
import { pinFloatingOrigin } from "./scene-readiness-signal";
import {
  Color4, Constants, Material, Matrix, MultiMaterial, Quaternion, RawTexture,
  RenderTargetTexture, Texture, UniversalCamera, Vector3,
  type AbstractMesh, type Camera, type FrameGraphObjectList, type InternalTexture, type IParticleSystem, type Node,
  type NodeMaterial, type Observer, type Scene,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import {
  normalizeRenderTargetCaptureProperties, normalizeRenderTargetPayload,
  type RenderTargetCaptureProperties, type RenderTargetCaptureQuality, type RenderTargetPayload,
  type RenderTargetTexturePayload, type SerializedScene, type SerializedTransform,
} from "@haptic/core";
import { authoredActorMatrices, authoredComponentActorTransform, authoredTransformMatrix } from "./authored-transform-matrices";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";
import { managedRenderTargetResources, renderTargetAllocationBytes } from "./render-target-resource-cost";
import { drawBorrowedTarget } from "./framegraph-borrowed-draw";
import { createRenderTargetDepthMaterial, createRenderTargetNormalMaterial } from "./render-target-normal-material";
import type { ResourceLease } from "./resource-cache";
import { isRenderTargetCaptureCandidate, renderTargetCaptureDrawing } from "./render-target-capture-state";
import { particleMaterialForSystem } from "./node-material-particles";
import { admittedSceneMeshes, admittedSceneParticles } from "./scene-stream-admission";
import { acquireAuthoredMaterialVariant, type AuthoredMaterialVariant } from "./material-compiler";
import { retireOwnedEffect } from "./owned-effect-retirement";
import type { AttachedPostProcessStack } from "./post-process-material";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { registerSceneAuxiliaryViews } from "./scene-auxiliary-views";
import { beginPipelineDeferral } from "./webgpu-pipeline-deferral";
import { findSceneShadowController, type ViewShadows } from "./shadow-controller";
import { isFirstDrawHeld, setFirstDrawsUrgent } from "./shadow-first-draw";

export { isRenderTargetCaptureCandidate } from "./render-target-capture-state";

/**
 * Attaches the scene's authored post-process stack to a Full Quality capture's
 * view, or null when the scene's own view runs none.
 */
export type RenderTargetCapturePostProcess = (renderer: SceneRenderCoordinator, camera: Camera) => AttachedPostProcessStack | null;
/** A Full Quality capture's attachment to the scene's gameplay outlines. */
export type RenderTargetCaptureOutlineView = {
  /** Republishes the outlines through the capture's current `includes`. */
  refresh(): void;
  detach(): void;
};
/**
 * Attaches the scene's gameplay outlines (Outline components and CEL outlines,
 * never the editor selection) to a Full Quality capture's view, keeping only
 * meshes `includes` accepts (the actors a Capture Only Actors capture draws).
 */
export type RenderTargetCaptureOutlines = (
  renderer: SceneRenderCoordinator,
  includes: (mesh: AbstractMesh) => boolean,
) => RenderTargetCaptureOutlineView;

/** One capture output's rendering state, for proofs and performance checks. */
export type RenderTargetCaptureDiagnostics = {
  actorId: string;
  renderTargetGuid: string;
  /** Effective quality: Depth Pass and World Normal targets always record with the fast pass. */
  quality: RenderTargetCaptureQuality;
  published: boolean;
  /** A Full Quality view's prepared graph tasks; [] for Fast or before preparation. */
  taskNames: string[];
  /** Render pass id of a Full Quality view's water scene copy, or null when it plans none. */
  waterSceneCopyPass: number | null;
  /** A Full Quality view's strict readiness probes so far; steady frames add none. */
  strictReadinessChecks: number;
};

const controllers = new WeakMap<Scene, RenderTargetCaptures>();
/** Above 512 × 512 a Full Quality capture warns once: it costs about a second camera at its size. */
const FULL_QUALITY_GUIDANCE_PIXELS = 512 * 512;
const drawing = renderTargetCaptureDrawing;

class CaptureTexture extends Texture {
  constructor(scene: Scene, name: string) {
    super(null, scene, true, false, Texture.NEAREST_SAMPLINGMODE);
    this.name = name;
    this.gammaSpace = false;
    this.wrapU = this.wrapV = Texture.CLAMP_ADDRESSMODE;
  }
  // Gamma belongs to this asset, not its InternalTexture: color and data
  // aliases share the transparent fallback before their first capture.
  override get gammaSpace(): boolean { return this._gammaSpace; }
  override set gammaSpace(value: boolean) { this._gammaSpace = value; }
  bind(texture: InternalTexture, gammaSpace: boolean): boolean {
    const changed = this._texture !== texture || this.gammaSpace !== gammaSpace;
    if (this._texture !== texture) {
      texture.incrementReferences();
      this._texture?.dispose();
      this._texture = texture;
    }
    this.gammaSpace = gammaSpace;
    return changed;
  }
}

class CaptureRenderTarget extends RenderTargetTexture {
  private drawingPrepared = false;
  configurePass(): void {
    this._objectRenderer.enableOutlineRendering = false;
    this._objectRenderer.disableDepthPrePass = true;
    // Babylon 9.29 installs only its clustered-light preparation observer on
    // this privately owned renderer. Readiness already runs that GPU work;
    // skip the same observer on the immediately following prepared draw.
    this._objectRenderer.onInitRenderingObservable.add((_renderer, state) => {
      if (this.drawingPrepared) state.skipNextObservers = true;
    }, -1, true);
  }
  renderPrepared(): void {
    this.drawingPrepared = true;
    try { this.render(false); } finally { this.drawingPrepared = false; }
  }
}

type Capture = {
  camera: UniversalCamera;
  settings: RenderTargetCaptureProperties;
  includeIds: ReadonlySet<string>;
  root: () => AbstractMesh | null;
  local: Matrix;
  fallback?: Matrix;
  requested: boolean;
  /** Its manual Fast request waited a frame for a shared shadow map's held first draw; it waits no more. */
  waitedForShadows: boolean;
};
type CaptureBuffer = { texture: CaptureRenderTarget; lease: ManagedRenderLease };
/**
 * A Full Quality capture's own forward view: the scene's FrameGraph pipeline
 * for the capture camera, drawing the target's candidate lists into `texture`.
 */
type FullQualityView = {
  renderer: SceneRenderCoordinator;
  camera: UniversalCamera;
  postProcess: AttachedPostProcessStack | null;
  /** The controller's post-process source revision this view attached; -1 before the first. */
  postProcessRevision: number;
  outlines: RenderTargetCaptureOutlineView | null;
  /** The controller's outline source revision this view attached; -1 before the first. */
  outlineRevision: number;
  /**
   * The view's own sun maps, fitted to its camera; null until the scene has a
   * shadow owner. Released with the view.
   */
  shadows: ViewShadows | null;
};
type Target = CaptureBuffer & {
  key: string;
  definition: RenderTargetPayload;
  quality: RenderTargetCaptureQuality;
  /** Allocated only after a capture needs to sample its published attachment. */
  spare?: CaptureBuffer;
  fullQuality?: FullQualityView;
  owner: string;
  depth?: NodeMaterial;
  normals?: NodeMaterial;
  normalMaterials: Map<Material, CaptureMaterial>;
  normalSlots: Map<AbstractMesh, MultiMaterial>;
  materialRetirement: Promise<void>;
  usedNormalSources: Set<Material>;
  overrides: Set<AbstractMesh>;
  pendingOverrides: Set<AbstractMesh>;
  meshes: AbstractMesh[];
  particles: IParticleSystem[];
  published: boolean;
};
type CaptureMaterial = { material: NodeMaterial; mask: Texture | null; uvIndex: number; authored?: AuthoredMaterialVariant };

/** One scene owns its captures and outputs. Materials only borrow ordinary
 * textures, so sampling cannot enqueue RTTs or recursively render the scene. */
export class RenderTargetCaptures {
  private definitions: ReadonlyMap<string, RenderTargetPayload> = new Map();
  private textureDefinitions: ReadonlyMap<string, RenderTargetTexturePayload> = new Map();
  private readonly captures = new Map<string, Capture>();
  private readonly actorRoots = new Map<string, () => AbstractMesh | null>();
  private readonly rootOwners = new Map<AbstractMesh, string>();
  private rootsDirty = true;
  private readonly addedMesh: Observer<AbstractMesh>;
  private readonly removedMesh: Observer<AbstractMesh>;
  private readonly targets = new Map<string, Target>();
  private readonly textures = new Map<string, CaptureTexture>();
  private readonly frameOwners = new Set<string>();
  private readonly checkedMaterials = new Set<Material>();
  private readonly consumerScenes = new Map<Scene, Observer<Scene>>();
  private fallback: RawTexture | undefined;
  private fallbackLease: ManagedRenderLease | undefined;
  private postProcess: RenderTargetCapturePostProcess | null = null;
  private postProcessRevision = 0;
  private outlines: RenderTargetCaptureOutlines | null = null;
  private outlineRevision = 0;
  /** Render Targets already warned about as too large for Full Quality. */
  private readonly warnedLargeTargets = new Set<string>();
  /** Emitter meshes of the particle systems the capture being collected draws. */
  private readonly emitters = new Set<AbstractMesh>();
  /** This frame's Full Quality captures, queued in `render()`. */
  private readonly pendingFullQuality: { actorId: string; guid: string; capture: Capture; target: Target }[] = [];
  /** Full Quality views awaiting confirmed native release before their output and lease go. */
  private readonly releases = new Set<Promise<void>>();
  /** Render Targets whose Full Quality draw failed and warned, until retired. */
  private readonly failedDraws = new Set<string>();
  private releaseFailure: unknown;
  private readonly beforeRender: Observer<Scene>;
  private readonly releaseAuxiliaryViews: () => void;
  private disposed = false;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly world = Matrix.Identity();
  private readonly scene: Scene;
  constructor(scene: Scene) {
    this.scene = scene;
    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.render())!;
    this.releaseAuxiliaryViews = registerSceneAuxiliaryViews(scene, this.drawPendingFullQuality);
    this.addedMesh = scene.onNewMeshAddedObservable.add(() => { this.rootsDirty = true; })!;
    this.removedMesh = scene.onMeshRemovedObservable.add(() => { this.rootsDirty = true; })!;
    scene.onDisposeObservable.addOnce(() => this.dispose());
  }
  setAssets(targets: ReadonlyMap<string, RenderTargetPayload> = new Map(), textures: ReadonlyMap<string, RenderTargetTexturePayload> = new Map()): void {
    if (this.definitions === targets && this.textureDefinitions === textures) return;
    this.definitions = targets;
    this.textureDefinitions = textures;
    // Clear incompatible outputs immediately; a manual target cannot keep an
    // old mode, old size or deleted asset alive until another capture request.
    for (const [guid, target] of this.targets) {
      const definition = targets.get(guid);
      if (!definition || target.key !== this.targetKey(definition, target.owner, target.quality)) this.retire(guid);
    }
    this.publishTextures();
  }
  /**
   * The scene view's authored post-process stack for Full Quality captures.
   * Each live view re-attaches on its next capture; null detaches.
   */
  setPostProcess(source: RenderTargetCapturePostProcess | null): void {
    this.postProcess = source;
    this.postProcessRevision += 1;
  }
  /** The scene's gameplay outlines for Full Quality captures; each live view re-attaches on its next capture. */
  setOutlines(source: RenderTargetCaptureOutlines | null): void {
    this.outlines = source;
    this.outlineRevision += 1;
  }
  /** Runtime parameter writes reach every Full Quality view's live stack, as they reach the scene view's. */
  setPostProcessParameter(...args: Parameters<AttachedPostProcessStack["setParameter"]>): void {
    for (const target of this.targets.values()) target.fullQuality?.postProcess?.setParameter(...args);
  }
  registerActor(actorId: string, root: () => AbstractMesh | null): void { this.actorRoots.set(actorId, root); this.rootsDirty = true; }
  removeActor(actorId: string): void {
    this.actorRoots.delete(actorId);
    this.rootsDirty = true;
    this.configure(actorId, null, () => null);
  }
  configure(actorId: string, properties: RenderTargetCaptureProperties | null, root: () => AbstractMesh | null, transform?: SerializedTransform, fallback?: Matrix): void {
    const previous = this.captures.get(actorId);
    if (!properties) {
      if (previous) {
        this.captures.delete(actorId);
        for (const [guid, target] of this.targets) if (target.owner === actorId) this.retire(guid);
        previous.camera.dispose();
      }
      return;
    }
    const settings = normalizeRenderTargetCaptureProperties(properties);
    const camera = previous?.camera ?? this.createCamera(actorId);
    const local = transform ? authoredTransformMatrix(transform) : Matrix.Identity();
    this.captures.set(actorId, {
      camera, settings, includeIds: new Set(settings.actorIds), root, local, fallback,
      requested: previous?.requested ?? false, waitedForShadows: previous?.waitedForShadows ?? false,
    });
    camera.fov = settings.fieldOfView * Math.PI / 180;
    camera.minZ = settings.nearClip;
    camera.maxZ = settings.farClip;
    if (!settings.enabled || previous?.settings.renderTargetGuid !== settings.renderTargetGuid ||
      previous?.settings.quality !== settings.quality) {
      for (const [guid, target] of this.targets) if (target.owner === actorId) this.retire(guid);
    } else if (previous && (previous.settings.captureOnlyActors !== settings.captureOnlyActors ||
      previous.settings.actorIds.join("\n") !== settings.actorIds.join("\n"))) {
      // The outlines a capture of chosen actors draws follow its actor list.
      for (const target of this.targets.values()) if (target.owner === actorId) target.fullQuality?.outlines?.refresh();
    }
  }
  syncAuthored(data: SerializedScene): void {
    const matrices = authoredActorMatrices(data.actors);
    const live = new Set<string>();
    this.actorRoots.clear();
    for (const actor of data.actors) {
      const root = () => this.scene.getMeshByName(`editorActor:${actor.id}`);
      this.registerActor(actor.id, root);
      const component = actor.components.find((entry) => entry.classId === "RenderTargetCaptureComponent");
      if (!component) continue;
      live.add(actor.id);
      this.configure(actor.id, normalizeRenderTargetCaptureProperties(component.properties), root,
        authoredComponentActorTransform(actor, component), matrices(actor));
    }
    for (const actorId of this.captures.keys()) if (!live.has(actorId)) this.configure(actorId, null, () => null);
  }
  request(actorId: string): void {
    const capture = this.captures.get(actorId);
    if (capture) capture.requested = true;
  }
  acquireTexture(guid: string, consumerScene: Scene = this.scene): ResourceLease<Texture> | null {
    if (!this.textureDefinitions.has(guid) || this.disposed || consumerScene.isDisposed || consumerScene.getEngine() !== this.scene.getEngine()) return null;
    if (!this.consumerScenes.has(consumerScene)) {
      this.consumerScenes.set(consumerScene, consumerScene.onDisposeObservable.addOnce(() => this.consumerScenes.delete(consumerScene))!);
    }
    let texture = this.textures.get(guid);
    if (!texture) {
      texture = new CaptureTexture(this.scene, `renderTargetTexture:${guid}`);
      this.textures.set(guid, texture);
      this.publishTextures();
    }
    // The scene owner retains this stable wrapper across asset edits and mode
    // changes; material disposal must never dispose a capture's GPU output.
    return { resource: texture, key: `renderTargetTexture:${guid}`, release() {} };
  }
  /**
   * Runs from the scene view's `onBeforeRender`: draws Fast captures now and
   * queues this frame's Full Quality captures, which the view's graph draws
   * after Babylon's evaluation (`drawSceneAuxiliaryViews`).
   */
  render(): void {
    this.pendingFullQuality.length = 0;
    // A nested call (inside a capture's own draw) keeps its frame's state.
    if (!drawing.has(this.scene)) setFirstDrawsUrgent(this.scene, false);
    if (this.disposed || drawing.has(this.scene) || isSceneGameTimePaused(this.scene)) return;
    this.frameOwners.clear();
    for (const [actorId, capture] of this.captures) {
      const settings = capture.settings;
      const guid = settings.renderTargetGuid;
      if (!settings.enabled || !guid || this.frameOwners.has(guid)) continue;
      const definition = this.definitions.get(guid);
      if (!definition) continue;
      const root = capture.root();
      if (!root && !capture.fallback) continue;
      // A staged producer cannot claim a loaded sibling's shared asset output.
      // Eligible producers retain stable actor insertion order.
      this.frameOwners.add(guid);
      if (!settings.captureEveryFrame && !capture.requested) continue;
      const actorWorld = root?.computeWorldMatrix(true) ?? capture.fallback!;
      capture.local.multiplyToRef(actorWorld, this.world);
      if (!this.world.decompose(this.scale, this.rotation, this.position)) continue;
      capture.camera.position.copyFrom(this.position);
      capture.camera.rotationQuaternion!.copyFrom(this.rotation);
      // Full Quality renders the lit scene; data passes always record with the fast pass.
      const quality = normalizeRenderTargetPayload(definition).mode === "SceneColor" ? settings.quality : "fast";
      const target = this.ensureTarget(guid, definition, actorId, capture.camera, quality);
      if (!target) continue;
      if (target.fullQuality) {
        // Here, before the scene view's graph runs: a new map dirties lighting
        // state the graph's own frame must not see change.
        target.fullQuality.shadows ??= findSceneShadowController(this.scene)?.attachView(capture.camera) ?? null;
        // A capture of chosen actors outlines only them; actor roots can change with any mesh.
        if (settings.captureOnlyActors && this.refreshRoots()) this.refreshOutlineFilters();
        this.pendingFullQuality.push({ actorId, guid, capture, target });
        // It draws after the frame's shadow maps and publishes what they show: a new map draws for it now, rather
        // than wait, neutral, for its casters' pipelines (`firstDrawsUrgent`).
        if (!settings.captureEveryFrame) setFirstDrawsUrgent(this.scene, true);
        continue;
      }
      // A manual Fast colour capture draws here, before the frame's shadow maps: one that would publish a new map
      // whose first draw a steady frame held back for its casters' pipelines waits one frame, in which that map draws.
      if (!settings.captureEveryFrame && !target.depth && !target.normals && !capture.waitedForShadows &&
        this.shadowFirstDrawHeld()) {
        capture.waitedForShadows = true;
        setFirstDrawsUrgent(this.scene, true);
        continue;
      }
      const meshes = this.collectCandidates(capture, target);
      if (!target.depth && !target.normals && !target.spare && this.samplesAttachment(target, target.texture)) {
        target.spare = this.createBuffer(`${guid}:history`, definition, capture.camera);
        // Keep the previous image and pending manual request if admission fails.
        if (!target.spare) continue;
      }
      const destination = target.spare?.texture ?? target.texture;
      // Public wrappers read the completed front buffer. Fail closed for a
      // foreign alias of the back buffer rather than submitting GPU feedback.
      if (target.spare && this.samplesAttachment(target, destination)) continue;
      if (!target.depth && !target.normals) destination.clearColor = this.scene.clearColor;
      destination.renderList = meshes;
      destination.particleSystemList = target.particles;
      if (target.normals || target.depth) {
        target.pendingOverrides.clear();
        for (const mesh of meshes) target.pendingOverrides.add(mesh);
        target.usedNormalSources.clear();
        for (const mesh of target.overrides) if (!target.pendingOverrides.has(mesh) && !mesh.isDisposed()) target.texture.setMaterialForRendering(mesh, undefined);
        for (const mesh of meshes) target.texture.setMaterialForRendering(mesh, this.normalMeshMaterial(target, mesh));
        const previousOverrides = target.overrides;
        target.overrides = target.pendingOverrides;
        target.pendingOverrides = previousOverrides;
        target.pendingOverrides.clear();
        for (const [mesh, material] of target.normalSlots) if (!target.overrides.has(mesh) || !(mesh.material instanceof MultiMaterial)) {
          target.normalSlots.delete(mesh);
          material.dispose(false, false);
        }
        for (const [source, material] of target.normalMaterials) if (!target.usedNormalSources.has(source)) {
          target.normalMaterials.delete(source);
          this.retireCaptureMaterial(target, material);
        }
      }
      // WebGPU, only inside a deferring view's frame: a draw whose pipeline is
      // still compiling is skipped. The capture then neither publishes nor
      // consumes a manual request, and that view holds its last image until a
      // complete draw. Any other owner's frame creates pipelines synchronously.
      const deferral = beginPipelineDeferral(this.scene.getEngine(),
        (renderPassId) => destination.renderPassIds.includes(renderPassId), { nested: true });
      let drawn: boolean;
      let skipped: number;
      try {
        drawn = this.stageDraw(target, guid, actorId, () => this.draw(() => this.drawReady(destination), !target.depth && !target.normals));
      } finally {
        skipped = deferral?.close() ?? 0;
      }
      if (!drawn || skipped) continue;
      if (target.spare) {
        const previous = { texture: target.texture, lease: target.lease };
        target.texture = target.spare.texture;
        target.lease = target.spare.lease;
        target.spare = previous;
      }
      this.published(capture, target);
    }
  }
  /**
   * Whether a Full Quality capture's own view is preparing its graph and variants. A view whose preparation failed (a
   * refused budget) is not: it retries only from its own draw, inside the scene view's.
   */
  preparing(): boolean {
    for (const target of this.targets.values()) if (target.fullQuality?.renderer.preparing) return true;
    return false;
  }
  /** Rendering state of every capture output, in insertion order. */
  diagnostics(): RenderTargetCaptureDiagnostics[] {
    return [...this.targets].map(([renderTargetGuid, target]) => ({
      actorId: target.owner, renderTargetGuid, quality: target.quality, published: target.published,
      taskNames: target.fullQuality?.renderer.taskNames() ?? [],
      waterSceneCopyPass: target.fullQuality?.renderer.waterSceneCopyDiagnostics()?.renderPassId ?? null,
      strictReadinessChecks: target.fullQuality?.renderer.strictReadinessChecks ?? 0,
    }));
  }
  /** Settles once every retired Full Quality view's native release confirmed and its output and lease are freed. */
  async whenReleased(): Promise<void> {
    while (this.releases.size) await Promise.allSettled([...this.releases]);
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
  }
  private stageDraw(target: Target, guid: string, actorId: string, draw: () => boolean): boolean {
    const frameCapture = activeRenderFrameCapture(this.scene.getEngine());
    if (!frameCapture) return draw();
    const { width, height } = target.texture.getSize();
    return frameCapture.stage(this.scene, { name: `Render Target Capture: ${guid}`, kind: "auxiliary",
      actorGuid: actorId, detail: `${width} × ${height}; ${target.fullQuality ? "Full Quality; " : ""}output asset ${guid}` }, draw);
  }
  /**
   * The queued Full Quality captures, drawn inside the scene view's graph after
   * Babylon's evaluation: skinning, LOD, particles and the view's shadow maps
   * are this frame's, and the view's own materials sample this frame's image.
   */
  private readonly drawPendingFullQuality = (): void => {
    if (this.disposed || drawing.has(this.scene)) return;
    for (const { actorId, guid, capture, target } of this.pendingFullQuality) {
      const view = target.fullQuality;
      // A command between the queue and the draw may have retired the target.
      if (!view || this.targets.get(guid) !== target || this.captures.get(actorId) !== capture) continue;
      // A failing capture keeps its last image; the scene view's frame and the
      // other captures go on, and it tries again next frame.
      try {
        this.collectCandidates(capture, target);
        if (this.stageDraw(target, guid, actorId, () => this.drawFullQuality(view, actorId))) {
          this.published(capture, target);
          // A capture that recovers warns again if it fails later.
          this.failedDraws.delete(guid);
        }
      } catch (error) {
        if (this.failedDraws.has(guid)) continue;
        this.failedDraws.add(guid);
        console.warn(`[render] Full Quality capture into Render Target ${guid} keeps its last image: ${String(error)}`);
      }
    }
    this.pendingFullQuality.length = 0;
  };
  /** The capture's eligible meshes and (for color passes) particle systems, into the target's reused lists. */
  private collectCandidates(capture: Capture, target: Target): AbstractMesh[] {
    if (capture.settings.captureOnlyActors) this.refreshRoots();
    // Even with renderParticles=false Babylon probes particleSystemList
    // during readiness. Keep non-color passes independent of particles.
    let particleCount = 0;
    this.emitters.clear();
    if (!target.depth && !target.normals) {
      for (const system of admittedSceneParticles(this.scene) ?? this.scene.particleSystems) {
        const emitter = system.emitter;
        if (capture.settings.captureOnlyActors) {
          if (!emitter || !("parent" in emitter) || !capture.includeIds.has(this.ownerOf(emitter as Node) ?? "")) continue;
        }
        target.particles[particleCount++] = system;
        if (emitter && "position" in emitter) this.emitters.add(emitter);
      }
    }
    target.particles.length = particleCount;
    return this.renderList(capture, target);
  }
  /** Rebuilds the actor roots after any registration or mesh change; true when it did. */
  private refreshRoots(): boolean {
    if (!this.rootsDirty) return false;
    this.rootOwners.clear();
    for (const [id, resolve] of this.actorRoots) {
      const root = resolve();
      if (root) this.rootOwners.set(root, id);
    }
    this.rootsDirty = false;
    return true;
  }
  /** Full Quality captures of chosen actors republish their outlines through the current roots. */
  private refreshOutlineFilters(): void {
    for (const target of this.targets.values()) {
      if (!target.fullQuality?.outlines) continue;
      if (this.captures.get(target.owner)?.settings.captureOnlyActors) target.fullQuality.outlines.refresh();
    }
  }
  /** Whether `mesh` belongs to the actors a capture draws. */
  private includes(actorId: string, mesh: AbstractMesh): boolean {
    const capture = this.captures.get(actorId);
    if (!capture?.settings.captureOnlyActors) return true;
    this.refreshRoots();
    const owner = this.ownerOf(mesh);
    return owner !== undefined && capture.includeIds.has(owner);
  }
  /** Whether an admitted shadow map awaits a first draw a steady frame held back for its casters' pipelines (WebGPU). */
  private shadowFirstDrawHeld(): boolean {
    const controller = findSceneShadowController(this.scene);
    if (!controller) return false;
    for (const light of this.scene.lights) {
      const map = controller.generator(light);
      if (map && isFirstDrawHeld(map)) return true;
    }
    return false;
  }
  /** A drawn frame consumes the manual request and publishes the front buffer. */
  private published(capture: Capture, target: Target): void {
    capture.requested = false;
    capture.waitedForShadows = false;
    const wasPublished = target.published;
    target.published = true;
    if (!wasPublished || target.spare) this.publishTextures(wasPublished);
  }
  /** Re-attach the scene's authored stack and outlines when they changed, then draw the view if it is ready. */
  private drawFullQuality(view: FullQualityView, actorId: string): boolean {
    if (view.postProcessRevision !== this.postProcessRevision) {
      view.postProcess?.dispose();
      view.postProcess = null;
      view.postProcessRevision = this.postProcessRevision;
      view.postProcess = this.postProcess?.(view.renderer, view.camera) ?? null;
    }
    if (view.outlineRevision !== this.outlineRevision) {
      view.outlines?.detach();
      view.outlines = null;
      view.outlineRevision = this.outlineRevision;
      view.outlines = this.outlines?.(view.renderer, (mesh) => this.includes(actorId, mesh)) ?? null;
    }
    // Shader and graph preparation run asynchronously; until the view is ready
    // the target keeps its last image (or the transparent fallback).
    return this.draw(() => view.renderer.render(false).rendered, false);
  }
  private createCamera(actorId: string): UniversalCamera {
    const previous = this.scene.activeCamera;
    const camera = new UniversalCamera(`renderTargetCapture:${actorId}`, Vector3.Zero(), this.scene);
    camera.rotationQuaternion = Quaternion.Identity();
    camera.inputs.clear();
    this.scene.activeCamera = previous;
    return camera;
  }
  private targetKey(definition: RenderTargetPayload, owner: string, quality: RenderTargetCaptureQuality): string {
    const value = normalizeRenderTargetPayload(definition);
    return JSON.stringify([owner, value.mode, value.width, value.height, quality]);
  }
  private ensureTarget(guid: string, definition: RenderTargetPayload, owner: string, camera: UniversalCamera,
    quality: RenderTargetCaptureQuality): Target | undefined {
    const previous = this.targets.get(guid);
    if (previous && previous.owner === owner && previous.definition === definition && previous.quality === quality) return previous;
    const key = this.targetKey(definition, owner, quality);
    if (previous?.key === key) { previous.definition = definition; return previous; }
    if (previous) this.retire(guid);
    if (quality === "fullQuality") return this.createFullQualityTarget(guid, definition, owner, camera, key);
    const buffer = this.createBuffer(guid, definition, camera);
    if (!buffer) return undefined;
    let normals: NodeMaterial | undefined;
    let depth: NodeMaterial | undefined;
    try {
      if (definition.mode === "DepthPass") depth = createRenderTargetDepthMaterial(this.scene);
      if (definition.mode === "WorldNormal") normals = createRenderTargetNormalMaterial(this.scene);
      const target: Target = {
        key, definition, quality, ...buffer, owner, depth, normals,
        normalMaterials: new Map(), normalSlots: new Map(), usedNormalSources: new Set(), materialRetirement: Promise.resolve(),
        overrides: new Set(), pendingOverrides: new Set(), meshes: [], particles: [], published: false,
      };
      this.targets.set(guid, target);
      return target;
    } catch (error) {
      depth?.dispose();
      normals?.dispose();
      buffer.texture.dispose();
      buffer.lease.release();
      throw error;
    }
  }
  /**
   * The output (display-encoded colour only: the view draws into its own scene
   * targets and copies colour) and the capture camera's own forward view, with
   * its own sun maps. Over budget or beyond the device's texture size, the
   * target keeps the transparent fallback.
   */
  private createFullQualityTarget(guid: string, definition: RenderTargetPayload, owner: string, camera: UniversalCamera, key: string): Target | undefined {
    const { width, height } = normalizeRenderTargetPayload(definition);
    const engine = this.scene.getEngine();
    const caps = engine.getCaps();
    if (width > caps.maxTextureSize || height > caps.maxTextureSize || !caps.depthTextureExtension) return undefined;
    if (width * height > FULL_QUALITY_GUIDANCE_PIXELS && !this.warnedLargeTargets.has(guid)) {
      this.warnedLargeTargets.add(guid);
      console.warn(`[render] Full Quality capture into a ${width} × ${height} Render Target costs about a second camera at that size; keep it at 512 × 512 or smaller, or turn off Capture Every Frame.`);
    }
    const lease = beginManagedRenderAllocation(engine,
      renderTargetAllocationBytes({ width, height, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE }));
    if (!lease) return undefined;
    let texture: CaptureRenderTarget | undefined;
    let renderer: SceneRenderCoordinator | undefined;
    let shadows: ViewShadows | null = null;
    try {
      texture = new CaptureRenderTarget(`renderTarget:${guid}`, { width, height }, this.scene, {
        generateMipMaps: false, doNotChangeAspectRatio: false, type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Texture.NEAREST_SAMPLINGMODE,
        generateDepthBuffer: false, generateStencilBuffer: false, gammaSpace: true,
      });
      // Only the view's graph writes this target; its own renderer never probes or draws the scene.
      texture.renderList = [];
      lease.commit(managedRenderTargetResources(texture.renderTarget!, { colorCategory: "sceneColor" }));
      const meshes: AbstractMesh[] = [];
      const particles: IParticleSystem[] = [];
      const objects: FrameGraphObjectList = { meshes, particleSystems: particles };
      camera.outputRenderTarget = texture;
      // Planar water mirrors are per scene view; capture water keeps its other reflections.
      // Drawn inside the scene view's frame; it defers only while that frame
      // does, which then holds, so a partly drawn capture is never presented.
      renderer = new SceneRenderCoordinator(this.scene, { waterPlanarReflections: false, auxiliary: { camera, objects }, deferPipelines: true });
      shadows = findSceneShadowController(this.scene)?.attachView(camera) ?? null;
      const target: Target = {
        key, definition, quality: "fullQuality", texture, lease, owner,
        fullQuality: { renderer, camera, postProcess: null, postProcessRevision: -1, outlines: null, outlineRevision: -1, shadows },
        normalMaterials: new Map(), normalSlots: new Map(), usedNormalSources: new Set(), materialRetirement: Promise.resolve(),
        overrides: new Set(), pendingOverrides: new Set(), meshes, particles, published: false,
      };
      this.targets.set(guid, target);
      return target;
    } catch (error) {
      void shadows?.release().catch(() => {});
      renderer?.dispose();
      if (texture && camera.outputRenderTarget === texture) camera.outputRenderTarget = null;
      texture?.dispose();
      lease.release();
      throw error;
    }
  }
  private createBuffer(guid: string, definition: RenderTargetPayload, camera: UniversalCamera): CaptureBuffer | undefined {
    const { width, height, mode } = normalizeRenderTargetPayload(definition);
    const engine = this.scene.getEngine();
    if (width > engine.getCaps().maxTextureSize || height > engine.getCaps().maxTextureSize) return undefined;
    // A scalar floating-point depth image avoids packed RGBA decoding in the
    // material graph. Unsupported devices fail closed to the blank output.
    const type = mode === "DepthPass" ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    if (mode === "DepthPass" && !engine.getCaps().textureHalfFloatRender) return undefined;
    const format = Constants.TEXTUREFORMAT_RGBA;
    const bytes = renderTargetAllocationBytes({ width, height, format, type }) +
      renderTargetAllocationBytes({ width, height, format: Constants.TEXTUREFORMAT_DEPTH32FLOAT_STENCIL8, renderbuffer: true });
    const lease = beginManagedRenderAllocation(engine, bytes);
    if (!lease) return undefined;
    let texture: CaptureRenderTarget | undefined;
    try {
      const captureTexture = new CaptureRenderTarget(`renderTarget:${guid}`, { width, height }, this.scene, {
        generateMipMaps: false, doNotChangeAspectRatio: false, type, format,
        samplingMode: Texture.NEAREST_SAMPLINGMODE, generateDepthBuffer: true, generateStencilBuffer: false,
        gammaSpace: mode === "SceneColor", enableClusteredLights: mode === "SceneColor",
      });
      captureTexture.configurePass();
      texture = captureTexture;
      texture.activeCamera = camera;
      texture.ignoreCameraViewport = true;
      texture.useCameraPostProcesses = false;
      texture.renderParticles = mode === "SceneColor";
      texture.particleSystemList = [];
      texture.renderSprites = false;
      texture.noPrePassRenderer = true;
      texture.clearColor = mode === "SceneColor" ? this.scene.clearColor.clone() : mode === "DepthPass" ? new Color4(1, 0, 0, 1) : new Color4(0, 0, 0, 0);
      lease.commit(managedRenderTargetResources(texture.renderTarget!, { colorCategory: mode === "SceneColor" ? "sceneColor" : "geometry" }));
      return { texture, lease };
    } catch (error) {
      texture?.dispose();
      lease.release();
      throw error;
    }
  }
  /** Runs every frame for each color target, so each shared material is inspected once. */
  private samplesAttachment(target: Target, destination: CaptureRenderTarget): boolean {
    const attachment = destination.getInternalTexture();
    const checked = this.checkedMaterials;
    const samples = (material: Material | null | undefined): boolean => {
      if (!material || checked.has(material)) return false;
      checked.add(material);
      return material.getActiveTextures().some((texture) => texture.getInternalTexture() === attachment);
    };
    try {
      for (const mesh of target.meshes) if (samples(mesh.material)) return true;
      for (const system of target.particles) {
        if (system.particleTexture?.getInternalTexture() === attachment || samples(particleMaterialForSystem(system))) return true;
      }
      return false;
    } finally { checked.clear(); }
  }
  private renderList(capture: Capture, target: Target): AbstractMesh[] {
    const meshes = admittedSceneMeshes(this.scene) ?? this.scene.meshes;
    let count = 0;
    for (const mesh of meshes) {
      if (this.isEligible(capture, target, mesh)) target.meshes[count++] = mesh;
    }
    target.meshes.length = count;
    return target.meshes;
  }
  private isEligible(capture: Capture, target: Target, mesh: AbstractMesh): boolean {
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || !(mesh.layerMask & capture.camera.layerMask)) return false;
    // Geometry-less meshes draw nothing, except that Babylon draws a particle
    // system only while its emitter mesh (geometry-less from the particle
    // service) is in the pass's list.
    if (mesh.getTotalVertices() === 0 && !this.emitters.has(mesh)) return false;
    if (!isRenderTargetCaptureCandidate(mesh)) return false;
    if (capture.settings.captureOnlyActors) {
      const actorId = this.ownerOf(mesh);
      if (!actorId || !capture.includeIds.has(actorId)) return false;
    }
    if (target.depth && mesh.infiniteDistance) return false;
    if ((target.normals || target.depth) && mesh.material) {
      let opaque = false;
      if (mesh.material instanceof MultiMaterial) {
        for (const material of mesh.material.subMaterials) {
          if (material && !material.needAlphaBlendingForMesh(mesh) && (!target.depth || !material.disableDepthWrite)) { opaque = true; break; }
        }
      } else opaque = !mesh.material.needAlphaBlendingForMesh(mesh) && (!target.depth || !mesh.material.disableDepthWrite);
      if (!opaque) return false;
    }
    return true;
  }
  private normalMeshMaterial(target: Target, mesh: AbstractMesh): Material {
    const source = mesh.material;
    if (!(source instanceof MultiMaterial)) return this.normalMaterial(target, source);
    let slots = target.normalSlots.get(mesh);
    if (!slots) {
      slots = new MultiMaterial("renderTarget:worldNormalSlots", this.scene);
      target.normalSlots.set(mesh, slots);
    }
    // Slot eligibility depends on this mesh's visibility/vertex alpha. Keep
    // containers per mesh, while sharing the opaque/cutout shader variants.
    // Null slots are skipped by Babylon's submesh rendering dispatch.
    const sourceSlots = source.subMaterials;
    let children: Array<Material | null> | null = sourceSlots.length === slots.subMaterials.length
      ? null
      : new Array<Material | null>(sourceSlots.length);
    for (let index = 0; index < sourceSlots.length; index++) {
      const child = sourceSlots[index];
      const material = child && !child.needAlphaBlendingForMesh(mesh) && (!target.depth || !child.disableDepthWrite)
        ? this.normalMaterial(target, child)
        : null;
      if (children) children[index] = material;
      else if (material !== slots.subMaterials[index]) {
        children = new Array<Material | null>(sourceSlots.length);
        for (let previous = 0; previous < index; previous++) children[previous] = slots.subMaterials[previous] ?? null;
        children[index] = material;
      }
    }
    if (children) slots.subMaterials = children;
    return slots;
  }
  private normalMaterial(target: Target, source: Material | null): Material {
    if (!source) return (target.normals ?? target.depth)!;
    target.usedNormalSources.add(source);
    const alpha = source.needAlphaTesting() ? source.getAlphaTestTexture() : null;
    const mask = alpha instanceof Texture ? alpha : null;
    const uvIndex = mask?.coordinatesIndex ?? 0;
    const existing = target.normalMaterials.get(source);
    if (existing && existing.mask === mask && existing.uvIndex === uvIndex) {
      existing.material.backFaceCulling = source.backFaceCulling;
      existing.material.cullBackFaces = source.cullBackFaces;
      return existing.material;
    }
    if (existing) this.retireCaptureMaterial(target, existing);
    const authored = acquireAuthoredMaterialVariant(source, target.depth ? "captureDepth" : "captureNormal");
    const material = authored?.compiled.material ?? (target.depth ? createRenderTargetDepthMaterial(this.scene, source) : createRenderTargetNormalMaterial(this.scene, source));
    material.backFaceCulling = source.backFaceCulling;
    material.cullBackFaces = source.cullBackFaces;
    target.normalMaterials.set(source, { material, mask, uvIndex, authored });
    return material;
  }
  private retireCaptureMaterial(target: Target, entry: CaptureMaterial): void {
    if (!entry.authored) { entry.material.dispose(false, false); return; }
    // The RTT owns pass wrappers; the compiled variant can be shared by other
    // captures. Release this pass's references before releasing its variant lease.
    // A source replacement is uncommon; retiring all this target's wrappers also
    // handles mixed slots whose source-to-wrapper association just changed.
    const pending: Promise<void>[] = [];
    for (const mesh of this.scene.meshes) for (const subMesh of mesh.subMeshes ?? []) {
      const wrapper = subMesh._getDrawWrapper(target.texture.renderPassId);
      if (!wrapper) continue;
      subMesh._removeDrawWrapper(target.texture.renderPassId, false);
      if (wrapper.effect) subMesh.getRenderingMesh().geometry?._releaseVertexArrayObject(wrapper.effect);
      pending.push(retireOwnedEffect(wrapper.effect, () => wrapper.dispose(true)).released);
    }
    target.materialRetirement = Promise.all([target.materialRetirement, ...pending]).then(() => entry.authored!.release());
    void target.materialRetirement.catch((error: unknown) => {
      console.warn(`[render] Capture material is retained until native release: ${String(error)}`);
    });
  }
  private ownerOf(mesh: Node): string | undefined {
    for (let node: Node | null = mesh; node; node = node.parent) {
      const id = this.rootOwners.get(node as AbstractMesh);
      if (id) return id;
    }
    return undefined;
  }
  private draw(run: () => boolean, materialImageProcessing: boolean): boolean {
    return drawOutsideSceneView(this.scene, run, materialImageProcessing);
  }
  private drawReady(destination: CaptureRenderTarget): boolean {
    let ready = false;
    // Readiness initializes the native renderer and may draw clustered-light
    // targets, so it needs the same framebuffer/state protection as the draw.
    drawBorrowedTarget(this.scene, destination, () => {
      const engine = this.scene.getEngine();
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setDepthBuffer(true);
      engine.setDepthWrite(true);
      engine.setColorWrite(true);
      ready = destination.isReadyForRendering();
      if (ready) destination.renderPrepared();
    }, {
      restoreAlpha: true, wrapDrawFailure: false, message: "Render target capture failed.",
    });
    return ready;
  }
  private publishTextures(rebindOnly = false): void {
    if (!this.textures.size) return;
    if (!this.fallback) {
      const lease = beginManagedRenderAllocation(this.scene.getEngine(), 4);
      if (!lease) throw new Error("Render target fallback exceeds the shared rendering budget.");
      try {
        this.fallback = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE);
        this.fallback.gammaSpace = false;
        lease.commit([{ handle: this.fallback.getInternalTexture()!, bytes: 4, category: "geometry" }]);
        this.fallbackLease = lease;
      } catch (error) { this.fallback?.dispose(); this.fallback = undefined; lease.release(); throw error; }
    }
    const fallback = this.fallback.getInternalTexture()!;
    const changed = new Set<CaptureTexture>();
    for (const [guid, texture] of this.textures) {
      const source = this.textureDefinitions.get(guid)?.renderTargetGuid;
      const target = source ? this.targets.get(source) : undefined;
      const gammaSpace = !!source && this.definitions.get(source)?.mode === "SceneColor";
      if (texture.bind(target?.published ? target.texture.getInternalTexture()! : fallback, gammaSpace)) changed.add(texture);
    }
    if (!changed.size) return;
    for (const scene of this.consumerScenes.keys()) {
      const rebound = new Set<Material>();
      for (const material of scene.materials) {
        if (!material.getActiveTextures().some((texture) => changed.has(texture as CaptureTexture))) continue;
        // Mode/size changes still invalidate defines. A history swap keeps the
        // shader contract and only refreshes frozen material texture bindings.
        if (rebindOnly) rebound.add(material);
        else material.markDirty(true);
      }
      if (!rebound.size) continue;
      scene.resetCachedMaterial();
      // WebGL has no material contexts. Resolve each pass/slot explicitly so
      // unrelated frozen materials retain their bindings on both backends.
      for (const mesh of scene.meshes) for (const subMesh of mesh.subMeshes ?? []) {
        const renderingMesh = subMesh.getRenderingMesh();
        for (let pass = 0; pass < subMesh._drawWrappers.length; pass++) {
          const wrapper = subMesh._drawWrappers[pass];
          if (!wrapper) continue;
          const root = renderingMesh.getMaterialForRenderPass(pass) ?? renderingMesh.material;
          const material = root instanceof MultiMaterial ? root.getSubMaterial(subMesh.materialIndex) : root;
          if (material && rebound.has(material)) wrapper._forceRebindOnNextCall = true;
        }
      }
    }
  }
  private retire(guid: string): void {
    const target = this.targets.get(guid);
    if (!target) return;
    this.targets.delete(guid);
    this.failedDraws.delete(guid);
    this.publishTextures();
    if (target.fullQuality) { this.retireFullQuality(target, target.fullQuality); return; }
    for (const mesh of target.overrides) if (!mesh.isDisposed()) target.texture.setMaterialForRendering(mesh, undefined);
    target.depth?.dispose();
    for (const material of target.normalSlots.values()) material.dispose(false, false);
    for (const variant of target.normalMaterials.values()) this.retireCaptureMaterial(target, variant);
    target.normals?.dispose();
    target.texture.dispose();
    target.lease.release();
    target.spare?.texture.dispose();
    target.spare?.lease.release();
  }
  /**
   * The view's graph borrows the output: free the output and its lease only
   * after the graph confirms native release (WebGPU destroys at frame end).
   * An uncertain release keeps both, quarantined.
   */
  private retireFullQuality(target: Target, view: FullQualityView): void {
    if (view.camera.outputRenderTarget === target.texture) view.camera.outputRenderTarget = null;
    const engine = this.scene.getEngine();
    let released: Promise<void>;
    try {
      view.postProcess?.dispose();
      view.outlines?.detach();
      view.renderer.dispose();
      // The view's sun maps are bound by their generators, never by the graph: they go now.
      const shadows = view.shadows?.release() ?? Promise.resolve();
      view.shadows = null;
      released = Promise.all([view.renderer.whenReleased().then(() => {
        // Scene disposal already released every texture it owns.
        if (!this.scene.isDisposed) target.texture.dispose();
        return releaseManagedRenderLeaseAfterDisposal(engine, target.lease);
      }), shadows]).then(() => {});
    } catch (error) {
      released = Promise.reject(error);
    }
    this.releases.add(released);
    void released.then(() => { this.releases.delete(released); }, (error: unknown) => {
      this.releases.delete(released);
      this.releaseFailure ??= error;
      console.warn(`[render] Full Quality capture resources are retained until native release: ${String(error)}`);
    });
  }
  clear(): void {
    for (const guid of [...this.targets.keys()]) this.retire(guid);
    for (const capture of this.captures.values()) capture.camera.dispose();
    this.captures.clear();
    this.actorRoots.clear();
    this.rootOwners.clear();
    this.rootsDirty = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.releaseAuxiliaryViews();
    this.pendingFullQuality.length = 0;
    setFirstDrawsUrgent(this.scene, false);
    this.scene.onNewMeshAddedObservable.remove(this.addedMesh);
    this.scene.onMeshRemovedObservable.remove(this.removedMesh);
    this.clear();
    for (const [scene, observer] of this.consumerScenes) scene.onDisposeObservable.remove(observer);
    this.consumerScenes.clear();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.fallback?.dispose();
    this.fallbackLease?.release();
  }
}

/**
 * Runs a capture draw outside the scene view's own pass, then restores that
 * view's camera, matrices, UBO, pass, viewport and floating-origin context.
 */
export function drawOutsideSceneView(scene: Scene, run: () => boolean, materialImageProcessing: boolean): boolean {
  const camera = scene.activeCamera;
  const cameras = scene.activeCameras;
  const ubo = scene.getSceneUniformBuffer();
  // Manual captures can precede the scene's first main-camera render, when
  // its cached matrices are still unset. Restore the camera's valid matrices
  // in that case instead of handing undefined to setTransformMatrix.
  const view = scene.getViewMatrix() ?? camera?.getViewMatrix();
  const projection = scene.getProjectionMatrix() ?? camera?.getProjectionMatrix();
  const engine = scene.getEngine();
  const renderPass = engine.currentRenderPassId;
  const colorWrite = engine.getColorWrite();
  const viewport = engine.currentViewport ?? camera?.viewport;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const outlines = scene.getOutlineRenderer?.();
  const outlinesEnabled = outlines?.enabled;
  const imageProcessing = scene.imageProcessingConfiguration;
  const applyByPostProcess = imageProcessing.applyByPostProcess;
  // Manual RTT draws bypass Scene.render(), which normally selects this
  // global context. A sibling scene may still own it (or have no matrices).
  const unpin = pinFloatingOrigin(scene);
  drawing.add(scene);
  try {
    // Match authored unlit surfaces: Scene Color is display/gamma encoded.
    // Like Babylon's ObjectRenderer, avoid the setter's scene-wide shader
    // invalidation; the capture has its own material render-pass defines.
    // A Full Quality view keeps the scene's pipeline and its Display Color stage.
    if (materialImageProcessing) imageProcessing._applyByPostProcess = false;
    return run();
  } finally {
    try {
      imageProcessing._applyByPostProcess = applyByPostProcess;
      scene.activeCamera = camera;
      scene.activeCameras = cameras;
      FloatingOriginCurrentScene.eyeAtCamera = true;
      scene.setSceneUniformBuffer(ubo);
      if (view && projection) scene.setTransformMatrix(view, projection);
      engine.currentRenderPassId = renderPass;
      engine.setColorWrite(colorWrite);
      scene.resetCachedMaterial();
      if (outlines) outlines.enabled = outlinesEnabled!;
      if (viewport) engine.setViewport(viewport, width, height);
    } finally {
      unpin();
      drawing.delete(scene);
    }
  }
}

export function sceneRenderTargetCaptures(scene: Scene): RenderTargetCaptures {
  let controller = controllers.get(scene);
  if (!controller) { controller = new RenderTargetCaptures(scene); controllers.set(scene, controller); }
  return controller;
}
