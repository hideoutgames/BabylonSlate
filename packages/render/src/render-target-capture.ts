import {
  Color4, Constants, LinesMesh, Material, Matrix, MultiMaterial, Quaternion, RawTexture,
  RenderTargetTexture, Texture, UniversalCamera, Vector3,
  type AbstractMesh, type InternalTexture, type IParticleSystem, type Mesh, type Node, type NodeMaterial, type Observer, type Scene,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import {
  normalizeRenderTargetCaptureProperties, normalizeRenderTargetPayload,
  type RenderTargetCaptureProperties, type RenderTargetPayload,
  type RenderTargetTexturePayload, type SerializedScene, type SerializedTransform,
} from "@babylonslate/core";
import { authoredActorMatrices, authoredComponentActorTransform, authoredTransformMatrix } from "./authored-transform-matrices";
import { beginManagedRenderAllocation, type ManagedRenderLease } from "./managed-render-resources";
import { managedRenderTargetResources, renderTargetAllocationBytes } from "./render-target-resource-cost";
import { drawBorrowedTarget } from "./framegraph-borrowed-draw";
import { createRenderTargetDepthMaterial, createRenderTargetNormalMaterial } from "./render-target-normal-material";
import type { ResourceLease } from "./resource-cache";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { isViewportShadingTarget } from "./viewport-shading-mode";
import { particleMaterialForSystem } from "./node-material-particles";
import { admittedSceneMeshes, admittedSceneParticles } from "./scene-stream-admission";

/**
 * Whether a mesh may appear in a Render Target Capture: world geometry only,
 * never lines, editor helpers or Play debug visuals. The editor's capture
 * preview uses the same rule so it shows what the capture lens records.
 */
export function isRenderTargetCaptureCandidate(mesh: AbstractMesh): boolean {
  if (mesh instanceof LinesMesh || !isViewportShadingTarget(mesh as Mesh)) return false;
  const metadata = mesh.metadata as Record<string, unknown> | null;
  return !(metadata?.editorPickProxy || metadata?.editorCameraModel || metadata?.editorBillboard || metadata?.editorVolume || metadata?.playHelperVisual || metadata?.playActorOrigin || metadata?.playDebugOverlay || metadata?.editorColliderVisual);
}

const controllers = new WeakMap<Scene, RenderTargetCaptures>();
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
    // Babylon 9.20 installs only its clustered-light preparation observer on
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
};
type Target = {
  key: string;
  definition: RenderTargetPayload;
  texture: CaptureRenderTarget;
  owner: string;
  depth?: NodeMaterial;
  normals?: NodeMaterial;
  normalMaterials: Map<Material, { material: NodeMaterial; mask: Texture | null; uvIndex: number }>;
  normalSlots: Map<AbstractMesh, MultiMaterial>;
  usedNormalSources: Set<Material>;
  lease: ManagedRenderLease;
  overrides: Set<AbstractMesh>;
  pendingOverrides: Set<AbstractMesh>;
  meshes: AbstractMesh[];
  particles: IParticleSystem[];
  published: boolean;
};

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
  private readonly consumerScenes = new Map<Scene, Observer<Scene>>();
  private fallback: RawTexture | undefined;
  private fallbackLease: ManagedRenderLease | undefined;
  private readonly beforeRender: Observer<Scene>;
  private disposed = false;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly world = Matrix.Identity();
  private readonly scene: Scene;
  constructor(scene: Scene) {
    this.scene = scene;
    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.render())!;
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
      if (!definition || target.key !== this.targetKey(definition, target.owner)) this.retire(guid);
    }
    this.publishTextures();
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
      requested: previous?.requested ?? false,
    });
    camera.fov = settings.fieldOfView * Math.PI / 180;
    camera.minZ = settings.nearClip;
    camera.maxZ = settings.farClip;
    if (!settings.enabled || previous?.settings.renderTargetGuid !== settings.renderTargetGuid)
      for (const [guid, target] of this.targets) if (target.owner === actorId) this.retire(guid);
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
  render(): void {
    if (this.disposed || drawing.has(this.scene)) return;
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
      const target = this.ensureTarget(guid, definition, actorId, capture.camera);
      if (!target) continue;
      if (!target.depth && !target.normals) target.texture.clearColor = this.scene.clearColor;
      const meshes = this.renderList(capture, target);
      target.texture.renderList = meshes;
      // Even with renderParticles=false Babylon probes particleSystemList
      // during readiness. Keep non-color passes independent of particles.
      const attachment = target.texture.getInternalTexture();
      let particleCount = 0;
      if (!target.depth && !target.normals) {
        for (const system of admittedSceneParticles(this.scene) ?? this.scene.particleSystems) {
          let samplesAttachment = system.particleTexture?.getInternalTexture() === attachment;
          if (!samplesAttachment) {
            const activeTextures = particleMaterialForSystem(system)?.getActiveTextures();
            if (activeTextures) for (const texture of activeTextures) {
              if (texture.getInternalTexture() === attachment) { samplesAttachment = true; break; }
            }
          }
          if (samplesAttachment) continue;
          if (capture.settings.captureOnlyActors) {
            const emitter = system.emitter;
            if (!emitter || !("parent" in emitter) || !capture.includeIds.has(this.ownerOf(emitter as Node) ?? "")) continue;
          }
          target.particles[particleCount++] = system;
        }
      }
      target.particles.length = particleCount;
      target.texture.particleSystemList = target.particles;
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
          material.material.dispose(false, false);
        }
      }
      if (!this.draw(target)) continue;
      capture.requested = false;
      if (!target.published) { target.published = true; this.publishTextures(); }
    }
  }
  private createCamera(actorId: string): UniversalCamera {
    const previous = this.scene.activeCamera;
    const camera = new UniversalCamera(`renderTargetCapture:${actorId}`, Vector3.Zero(), this.scene);
    camera.rotationQuaternion = Quaternion.Identity();
    camera.inputs.clear();
    this.scene.activeCamera = previous;
    return camera;
  }
  private targetKey(definition: RenderTargetPayload, owner: string): string {
    const value = normalizeRenderTargetPayload(definition);
    return JSON.stringify([owner, value.mode, value.width, value.height]);
  }
  private ensureTarget(guid: string, definition: RenderTargetPayload, owner: string, camera: UniversalCamera): Target | undefined {
    const previous = this.targets.get(guid);
    if (previous && previous.owner === owner && previous.definition === definition) return previous;
    const key = this.targetKey(definition, owner);
    if (previous?.key === key) { previous.definition = definition; return previous; }
    if (previous) this.retire(guid);
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
    let texture: RenderTargetTexture | undefined;
    let normals: NodeMaterial | undefined;
    let depth: NodeMaterial | undefined;
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
      if (mode === "DepthPass") depth = createRenderTargetDepthMaterial(this.scene);
      if (mode === "WorldNormal") normals = createRenderTargetNormalMaterial(this.scene);
      lease.commit(managedRenderTargetResources(texture.renderTarget!, { colorCategory: mode === "SceneColor" ? "sceneColor" : "geometry" }));
      const target: Target = {
        key, definition, texture: captureTexture, owner, depth, normals, lease,
        normalMaterials: new Map(), normalSlots: new Map(), usedNormalSources: new Set(),
        overrides: new Set(), pendingOverrides: new Set(), meshes: [], particles: [], published: false,
      };
      this.targets.set(guid, target);
      return target;
    } catch (error) {
      depth?.dispose();
      normals?.dispose();
      texture?.dispose();
      lease.release();
      throw error;
    }
  }
  private renderList(capture: Capture, target: Target): AbstractMesh[] {
    if (capture.settings.captureOnlyActors && this.rootsDirty) {
      this.rootOwners.clear();
      for (const [id, resolve] of this.actorRoots) {
        const root = resolve();
        if (root) this.rootOwners.set(root, id);
      }
      this.rootsDirty = false;
    }
    const meshes = admittedSceneMeshes(this.scene) ?? this.scene.meshes;
    const internal = target.texture.getInternalTexture();
    let count = 0;
    for (const mesh of meshes) {
      if (this.isEligible(capture, target, internal, mesh)) target.meshes[count++] = mesh;
    }
    target.meshes.length = count;
    return target.meshes;
  }
  private isEligible(capture: Capture, target: Target, internal: InternalTexture | null, mesh: AbstractMesh): boolean {
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0 || !(mesh.layerMask & capture.camera.layerMask)) return false;
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
    // Scene color must never read the same attachment it is writing.
    if (!target.depth && !target.normals && mesh.material) {
      for (const texture of mesh.material.getActiveTextures()) if (texture.getInternalTexture() === internal) return false;
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
    existing?.material.dispose(false, false);
    const material = target.depth ? createRenderTargetDepthMaterial(this.scene, source) : createRenderTargetNormalMaterial(this.scene, source);
    target.normalMaterials.set(source, { material, mask, uvIndex });
    return material;
  }
  private ownerOf(mesh: Node): string | undefined {
    for (let node: Node | null = mesh; node; node = node.parent) {
      const id = this.rootOwners.get(node as AbstractMesh);
      if (id) return id;
    }
    return undefined;
  }
  private draw(target: Target): boolean {
    const scene = this.scene;
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
    const previousScene = FloatingOriginCurrentScene.getScene;
    const previousEyeAtCamera = FloatingOriginCurrentScene.eyeAtCamera;
    // Manual RTT draws bypass Scene.render(), which normally selects this
    // global context. A sibling scene may still own it (or have no matrices).
    FloatingOriginCurrentScene.getScene = () => scene.floatingOriginMode ? scene : undefined;
    FloatingOriginCurrentScene.eyeAtCamera = true;
    drawing.add(scene);
    try {
      // Match authored unlit surfaces: Scene Color is display/gamma encoded.
      // Like Babylon's ObjectRenderer, avoid the setter's scene-wide shader
      // invalidation; the capture has its own material render-pass defines.
      if (!target.depth && !target.normals) imageProcessing._applyByPostProcess = false;
      return this.drawReady(target);
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
        FloatingOriginCurrentScene.getScene = previousScene;
        FloatingOriginCurrentScene.eyeAtCamera = previousEyeAtCamera;
        drawing.delete(scene);
      }
    }
  }
  private drawReady(target: Target): boolean {
    let ready = false;
    // Readiness initializes the native renderer and may draw clustered-light
    // targets, so it needs the same framebuffer/state protection as the draw.
    drawBorrowedTarget(this.scene, target.texture, () => {
      const engine = this.scene.getEngine();
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setDepthBuffer(true);
      engine.setDepthWrite(true);
      engine.setColorWrite(true);
      ready = target.texture.isReadyForRendering();
      if (ready) target.texture.renderPrepared();
    }, {
      restoreAlpha: true, wrapDrawFailure: false, message: "Render target capture failed.",
    });
    return ready;
  }
  private publishTextures(): void {
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
    // SceneLayer materials share the world's output. Invalidate their defines
    // and frozen bindings when the attachment or its color/data contract changes.
    for (const scene of this.consumerScenes.keys()) for (const material of scene.materials)
      if (material.getActiveTextures().some((texture) => changed.has(texture as CaptureTexture))) material.markDirty(true);
  }
  private retire(guid: string): void {
    const target = this.targets.get(guid);
    if (!target) return;
    this.targets.delete(guid);
    this.publishTextures();
    for (const mesh of target.overrides) if (!mesh.isDisposed()) target.texture.setMaterialForRendering(mesh, undefined);
    target.depth?.dispose();
    for (const material of target.normalSlots.values()) material.dispose(false, false);
    for (const variant of target.normalMaterials.values()) variant.material.dispose(false, false);
    target.normals?.dispose();
    target.texture.dispose();
    target.lease.release();
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

export function sceneRenderTargetCaptures(scene: Scene): RenderTargetCaptures {
  let controller = controllers.get(scene);
  if (!controller) { controller = new RenderTargetCaptures(scene); controllers.set(scene, controller); }
  return controller;
}
