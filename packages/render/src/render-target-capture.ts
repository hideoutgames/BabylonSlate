import {
  Color4, Constants, DepthRenderer, LinesMesh, Material, Matrix, MultiMaterial, Quaternion, RawTexture,
  RenderTargetTexture, Texture, UniversalCamera, Vector3,
  type AbstractMesh, type InternalTexture, type Mesh, type Node, type NodeMaterial, type Observer, type Scene,
} from "@babylonjs/core";
import {
  normalizeRenderTargetCaptureProperties, normalizeRenderTargetPayload,
  type RenderTargetCaptureProperties, type RenderTargetPayload,
  type RenderTargetTexturePayload, type SerializedScene, type SerializedTransform,
} from "@babylonslate/core";
import { authoredActorMatrices, authoredComponentActorTransform, authoredTransformMatrix } from "./authored-transform-matrices";
import { beginManagedRenderAllocation, type ManagedRenderLease } from "./managed-render-resources";
import { managedRenderTargetResources, renderTargetAllocationBytes } from "./render-target-resource-cost";
import { drawBorrowedTarget } from "./framegraph-borrowed-draw";
import { createRenderTargetNormalMaterial } from "./render-target-normal-material";
import type { ResourceLease } from "./resource-cache";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { isViewportShadingTarget } from "./viewport-shading-mode";

const controllers = new WeakMap<Scene, RenderTargetCaptures>();
const drawing = renderTargetCaptureDrawing;

class CaptureTexture extends Texture {
  constructor(scene: Scene, name: string) {
    super(null, scene, true, false, Texture.NEAREST_SAMPLINGMODE);
    this.name = name;
    this.gammaSpace = false;
    this.wrapU = this.wrapV = Texture.CLAMP_ADDRESSMODE;
  }
  bind(texture: InternalTexture): void {
    if (this._texture === texture) return;
    texture.incrementReferences();
    this._texture?.dispose();
    this._texture = texture;
  }
}

class CaptureRenderTarget extends RenderTargetTexture {
  configurePass(): void {
    this._objectRenderer.enableOutlineRendering = false;
    this._objectRenderer.disableDepthPrePass = true;
  }
}

type Capture = {
  camera: UniversalCamera;
  settings: RenderTargetCaptureProperties;
  root: () => AbstractMesh | null;
  local: Matrix;
  fallback?: Matrix;
  requested: boolean;
};
type Target = {
  key: string;
  texture: RenderTargetTexture;
  owner: string;
  depth?: DepthRenderer;
  normals?: NodeMaterial;
  normalMaterials: Map<Material, Material>;
  usedNormalSources: Set<Material>;
  lease: ManagedRenderLease;
  overrides: Set<AbstractMesh>;
  meshes: AbstractMesh[];
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
  private fallback: RawTexture | undefined;
  private fallbackLease: ManagedRenderLease | undefined;
  private readonly beforeRender: Observer<Scene>;
  private disposed = false;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly world = Matrix.Identity();
  constructor(private readonly scene: Scene) {
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
    this.captures.set(actorId, { camera, settings, root, local, fallback, requested: previous?.requested ?? false });
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
  acquireTexture(guid: string): ResourceLease<Texture> | null {
    if (!this.textureDefinitions.has(guid) || this.disposed) return null;
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
    const owners = new Set<string>();
    for (const [actorId, capture] of this.captures) {
      const settings = capture.settings;
      const guid = settings.renderTargetGuid;
      if (!settings.enabled || !guid || owners.has(guid)) continue;
      const definition = this.definitions.get(guid);
      if (!definition) continue;
      // A target has one producer per frame, in stable actor insertion order.
      owners.add(guid);
      if (!settings.captureEveryFrame && !capture.requested) continue;
      const actorWorld = capture.root()?.computeWorldMatrix(true) ?? capture.fallback;
      if (!actorWorld) continue;
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
      target.texture.particleSystemList = !target.depth && !target.normals
        ? this.scene.particleSystems.filter((system) => {
          if (!capture.settings.captureOnlyActors) return true;
          const emitter = system.emitter;
          if (!emitter || !("parent" in emitter)) return false;
          return capture.settings.actorIds.includes(this.ownerOf(emitter as Node) ?? "");
        }) : [];
      if (target.normals) {
        const current = new Set(meshes);
        target.usedNormalSources.clear();
        for (const mesh of target.overrides) if (!current.has(mesh) && !mesh.isDisposed()) target.texture.setMaterialForRendering(mesh, undefined);
        for (const mesh of meshes) target.texture.setMaterialForRendering(mesh, this.normalMaterial(target, mesh.material));
        target.overrides = current;
        for (const [source, material] of target.normalMaterials) if (!target.usedNormalSources.has(source)) {
          target.normalMaterials.delete(source);
          material.dispose(false, false);
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
    const key = this.targetKey(definition, owner);
    const previous = this.targets.get(guid);
    if (previous?.key === key) return previous;
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
    try {
      const captureTexture = new CaptureRenderTarget(`renderTarget:${guid}`, { width, height }, this.scene, {
        generateMipMaps: false, doNotChangeAspectRatio: false, type, format,
        samplingMode: Texture.NEAREST_SAMPLINGMODE, generateDepthBuffer: true, generateStencilBuffer: false,
        gammaSpace: false, enableClusteredLights: mode === "SceneColor",
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
      texture.clearColor = mode === "SceneColor" ? this.scene.clearColor.clone() : new Color4(0, 0, 0, 0);
      const depth = mode === "DepthPass" ? new DepthRenderer(this.scene, type, camera, false, Texture.NEAREST_SAMPLINGMODE, false, `captureDepth:${guid}`, texture) : undefined;
      if (mode === "WorldNormal") normals = createRenderTargetNormalMaterial(this.scene);
      lease.commit(managedRenderTargetResources(texture.renderTarget!, { colorCategory: mode === "SceneColor" ? "sceneColor" : "geometry" }));
      const target: Target = { key, texture, owner, depth, normals, lease, normalMaterials: new Map(), usedNormalSources: new Set(), overrides: new Set(), meshes: [], published: false };
      this.targets.set(guid, target);
      return target;
    } catch (error) {
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
    const include = new Set(capture.settings.actorIds);
    const internal = target.texture.getInternalTexture();
    const eligible = (mesh: AbstractMesh): boolean => {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0 || !(mesh.layerMask & capture.camera.layerMask)) return false;
      if (mesh instanceof LinesMesh || !isViewportShadingTarget(mesh as Mesh)) return false;
      const metadata = mesh.metadata as Record<string, unknown> | null;
      if (metadata?.editorPickProxy || metadata?.editorCameraModel || metadata?.editorBillboard || metadata?.editorVolume || metadata?.playHelperVisual || metadata?.playActorOrigin || metadata?.playDebugOverlay || metadata?.editorColliderVisual) return false;
      if (capture.settings.captureOnlyActors) {
        const actorId = this.ownerOf(mesh);
        if (!actorId || !include.has(actorId)) return false;
      }
      if (target.normals && mesh.material?.needAlphaBlendingForMesh(mesh) && !mesh.material.needAlphaTesting()) return false;
      // Scene color must never read the same attachment it is writing.
      if (!target.depth && !target.normals && mesh.material?.getActiveTextures().some((texture) => texture.getInternalTexture() === internal)) return false;
      return true;
    };
    const candidates = capture.settings.captureOnlyActors ? new Set(capture.settings.actorIds.flatMap((id) => {
      const root = this.actorRoots.get(id)?.();
      return root ? [root, ...root.getChildMeshes()] : [];
    })) : this.scene.meshes;
    let count = 0;
    for (const mesh of candidates) if (eligible(mesh)) target.meshes[count++] = mesh;
    target.meshes.length = count;
    return target.meshes;
  }
  private normalMaterial(target: Target, source: Material | null): Material {
    if (!source) return target.normals!;
    target.usedNormalSources.add(source);
    const existing = target.normalMaterials.get(source);
    let material: Material;
    if (source instanceof MultiMaterial) {
      const multi = existing instanceof MultiMaterial ? existing : new MultiMaterial("renderTarget:worldNormalSlots", this.scene);
      const children = source.subMaterials.map((child) => child ? this.normalMaterial(target, child) : null);
      if (multi.subMaterials.length !== children.length || children.some((child, index) => child !== multi.subMaterials[index])) multi.subMaterials = children;
      material = multi;
    } else {
      if (existing) return existing;
      material = createRenderTargetNormalMaterial(this.scene, source);
    }
    target.normalMaterials.set(source, material);
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
    const view = scene.getViewMatrix();
    const projection = scene.getProjectionMatrix();
    const engine = scene.getEngine();
    const renderPass = engine.currentRenderPassId;
    drawing.add(scene);
    try {
      return this.drawReady(target);
    } finally {
      scene.activeCamera = camera;
      scene.activeCameras = cameras;
      scene.setSceneUniformBuffer(ubo);
      scene.setTransformMatrix(view, projection);
      engine.currentRenderPassId = renderPass;
      scene.resetCachedMaterial();
      drawing.delete(scene);
    }
  }
  private drawReady(target: Target): boolean {
    if (!target.texture.isReadyForRendering()) return false;
    drawBorrowedTarget(this.scene, target.texture, () => target.texture.render(false), {
      restoreAlpha: true, wrapDrawFailure: false, message: "Render target capture failed.",
    });
    return true;
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
    for (const [guid, texture] of this.textures) {
      const source = this.textureDefinitions.get(guid)?.renderTargetGuid;
      const target = source ? this.targets.get(source) : undefined;
      texture.bind(target?.published ? target.texture.getInternalTexture()! : fallback);
    }
    for (const material of this.scene.materials) material.markAsDirty(Material.TextureDirtyFlag);
  }
  private retire(guid: string): void {
    const target = this.targets.get(guid);
    if (!target) return;
    this.targets.delete(guid);
    this.publishTextures();
    for (const mesh of target.overrides) if (!mesh.isDisposed()) target.texture.setMaterialForRendering(mesh, undefined);
    target.depth?.dispose();
    for (const material of target.normalMaterials.values()) material.dispose(false, false);
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
