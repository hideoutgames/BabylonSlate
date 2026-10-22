import { activeRenderFrameCapture } from "./render-frame-report";
import { PostProcessParameterState } from "./post-process-parameter-state";
import { overlayClipAllowsPoint } from "./overlay-layout-render";
import { pickBufferSize } from "./pick-coords";
import type { AttachedPostProcessStack } from "./post-process-material";
import {
  Camera,
  Color3,
  Color4,
  Constants,
  MeshBuilder,
  Quaternion,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
} from "@babylonjs/core";
import type { CommandMessage } from "@haptic/bridge";
import {
  parseSceneLayerHitTest,
  sceneLayerCanvasToLayer,
  sceneLayerOrthoBounds,
  sceneLayerViewBounds,
  walkOverlayPointerHits,
  SCENE_LAYER_DEFAULT_CAMERA,
  type OverlayPointerHit,
  type SceneLayerCamera,
  type SceneLayerHitTest,
  type ScenePostProcessEntry,
  type MaterialParameterValue,
} from "@haptic/core";
import { installEngineDefaultMaterial } from "./default-material";
import { isSceneFrameReady } from "./scene-perf";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { PostProcessRetirement } from "./post-process-retirement";
import { configureCutoutSorting } from "./sorting";
import {
  overlayMinTargetWorldSize,
  pointInInflatedWorldAabb,
} from "./overlay-touch-target";

export type SceneLayerCreateCommand = Extract<
  CommandMessage,
  { type: "sceneLayerCreate" }
>;

export type SceneLayerPostProcessEntry = ScenePostProcessEntry;

export interface SceneLayerView {
  layerId: string;
  assetGuid: string;
  zOrder: number;
  scene: Scene;
  camera: UniversalCamera;
  /** The ortho extent at zoom 1: Layer Width × Height widened to the output aspect. */
  viewBounds: { width: number; height: number };
  /** The camera centre, roll and zoom scripts set; with `viewBounds` it maps the canvas into the layer (`sceneLayerCanvasToLayer`). */
  cameraState: SceneLayerCamera;
}

export interface SceneLayerCompositorOptions {
  engine: AbstractEngine;
  postProcessingEnabled?: () => boolean;
  isLayerReady?: (layerId: string) => boolean;
  attachLayerPostProcess?: (
    layer: SceneLayerView,
    stack: SceneLayerPostProcessEntry[],
    renderer: SceneRenderCoordinator,
  ) => Pick<AttachedPostProcessStack, "dispose"> & Partial<Pick<AttachedPostProcessStack, "setParameter">> | null;
}

const scratchTarget = new Vector3();

/** The pose bindHudCamera leaves; any other reading means another owner moved the camera. */
interface HudCameraPose {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  quaternion: readonly [number, number, number, number] | null;
}

type LayerRecord = SceneLayerView & {
  /** The authored Layer Width × Height. */
  designBounds: { width: number; height: number };
  /** Null until the first bind. */
  hudPose: HudCameraPose | null;
  renderer: SceneRenderCoordinator;
  postProcessStack: SceneLayerPostProcessEntry[];
  rtt: RenderTargetTexture | null;
  blitMaterial: StandardMaterial | null;
  blitScene: Scene | null;
  parameters: PostProcessParameterState;
  retirements: PostProcessRetirement;
  presented: boolean;
  /** Cached strict layer readiness; invalidated by renderer dirtiness/rebuild. */
  probedReady: boolean;
  blitReady: boolean;
  fallback: { scene: Scene; release(): void } | null;
  attachedPostProcess: ReturnType<NonNullable<SceneLayerCompositorOptions["attachLayerPostProcess"]>>;
};

/**
 * Play-only overlay stack: extra unlit orthographic Scenes on the shared
 * Engine, drawn after the world camera (and its post-process).
 */
export class SceneLayerCompositor {
  private readonly engine: AbstractEngine;
  private readonly isLayerReady: (layerId: string) => boolean;
  private readonly postProcessingEnabled: () => boolean;
  private readonly attachLayerPostProcess?: SceneLayerCompositorOptions["attachLayerPostProcess"];
  private readonly byId = new Map<string, LayerRecord>();
  private readonly slotLayer = new Map<number, string>();
  private readonly slotActor = new Map<number, string>();
  private readonly retiredLayers = new PostProcessRetirement();
  /** Every Scene this compositor built and has not yet disposed: layers, blit Scenes, and retired generations still releasing. */
  private readonly ownedSceneSet = new Set<Scene>();
  /** Draw order, rebuilt only when layers are created or removed. */
  private sortedCache: LayerRecord[] | null = null;
  private outputWidth = 0;
  private outputHeight = 0;

  constructor(options: SceneLayerCompositorOptions) {
    this.engine = options.engine;
    this.isLayerReady = options.isLayerReady ?? (() => true);
    this.postProcessingEnabled = options.postProcessingEnabled ?? (() => true);
    this.attachLayerPostProcess = options.attachLayerPostProcess;
  }

  create(command: SceneLayerCreateCommand): SceneLayerView {
    this.remove(command.layerId);
    const scene = this.ownScene(new Scene(this.engine));
    configureCutoutSorting(scene);
    installEngineDefaultMaterial(scene);
    scene.lightsEnabled = false;
    scene.skipPointerMovePicking = false;
    scene.autoClear = false;
    scene.autoClearDepthAndStencil = true;
    scene.clearColor = new Color4(0, 0, 0, 0);
    const camera = new UniversalCamera(
      "sceneLayerCamera",
      new Vector3(0, 0, -10),
      scene,
    );
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    scene.activeCamera = camera;
    const layer: LayerRecord = {
      layerId: command.layerId,
      assetGuid: command.assetGuid,
      zOrder: command.zOrder,
      scene,
      camera,
      renderer: new SceneRenderCoordinator(scene),
      designBounds: sceneLayerOrthoBounds(command.layerBounds),
      viewBounds: sceneLayerViewBounds(command.layerBounds, this.outputAspect()),
      cameraState: { ...SCENE_LAYER_DEFAULT_CAMERA },
      hudPose: null,
      postProcessStack: command.postProcessStack.map((entry) => ({ ...entry })),
      rtt: null,
      blitMaterial: null,
      blitScene: null,
      attachedPostProcess: null,
      parameters: new PostProcessParameterState(),
      retirements: new PostProcessRetirement(),
      presented: false,
      probedReady: false,
      blitReady: false,
      fallback: null,
    };
    this.bindHudCamera(layer);
    this.byId.set(command.layerId, layer);
    this.sortedCache = null;
    this.rebuildPostProcess(layer, false);
    return layer;
  }

  /** Scenes this compositor built that are still alive, retired layer and blit generations included. */
  ownedScenes(): Scene[] {
    return [...this.ownedSceneSet];
  }

  private ownScene(scene: Scene): Scene {
    this.ownedSceneSet.add(scene);
    scene.onDisposeObservable.addOnce(() => this.ownedSceneSet.delete(scene));
    return scene;
  }

  remove(layerId: string): void {
    const layer = this.byId.get(layerId);
    if (!layer) return;
    for (const [slotId, id] of [...this.slotLayer]) {
      if (id === layerId) this.slotLayer.delete(slotId);
    }
    this.byId.delete(layerId);
    this.sortedCache = null;
    this.releaseFallback(layer);
    this.releasePostProcess(layer);
    // Bounded cleanup reports stay separate from actual release: the Scene is
    // disposed only after every retired generation confirmed native release.
    const reported = layer.retirements.whenDisposed();
    const released = layer.retirements.whenReleased().then(() => { layer.scene.dispose(); });
    this.retiredLayers.add({ whenDisposed: () => reported, whenReleased: () => released });
    void reported.catch((error: unknown) => {
      console.warn(`[render] SceneLayer ${layer.layerId} cleanup report is uncertain: ${String(error)}`);
    });
    void released.catch((error: unknown) => {
      console.warn(`[render] SceneLayer ${layer.layerId} is quarantined until actual release: ${String(error)}`);
    });
  }

  clear(): void {
    for (const layerId of [...this.byId.keys()]) {
      this.remove(layerId);
    }
  }

  setPostProcess(
    layerId: string,
    stack: readonly SceneLayerPostProcessEntry[],
  ): void {
    const layer = this.byId.get(layerId);
    if (!layer) return;
    layer.postProcessStack = stack.map((entry) => ({ ...entry }));
    this.rebuildPostProcess(layer);
  }

  /** Move, turn or zoom a layer's camera (`sceneLayerCamera`); the next pick and draw use it. */
  setCamera(layerId: string, camera: Readonly<SceneLayerCamera>): void {
    const layer = this.byId.get(layerId);
    if (!layer) return;
    layer.cameraState = { ...camera };
    this.bindHudCamera(layer, true);
  }

  setPostProcessParameter(layerId: string, entryId: string, materialGuid: string, name: string, value: MaterialParameterValue, validate: () => boolean): boolean {
    const layer = this.byId.get(layerId);
    if (!layer || !this.isLayerReady(layerId) || !layer.postProcessStack.some((entry) => entry.id === entryId && entry.materialGuid === materialGuid) || !validate() || !layer.parameters.set(layer.postProcessStack, entryId, materialGuid, name, value)) return false;
    layer.attachedPostProcess?.setParameter?.(entryId, name, value);
    return true;
  }

  refreshPostProcess(): void {
    for (const layer of this.byId.values()) {
      this.rebuildPostProcess(layer);
    }
  }

  noteSpawn(
    slotId: number,
    sceneLayerId: string | null | undefined,
    actorGuid?: string | null,
  ): void {
    if (!sceneLayerId) {
      this.slotLayer.delete(slotId);
      this.slotActor.delete(slotId);
      return;
    }
    this.slotLayer.set(slotId, sceneLayerId);
    if (actorGuid) this.slotActor.set(slotId, actorGuid);
  }

  noteDespawn(slotId: number): void {
    this.slotLayer.delete(slotId);
    this.slotActor.delete(slotId);
  }

  sceneForSlot(slotId: number): Scene | null {
    const layerId = this.slotLayer.get(slotId);
    if (!layerId) return null;
    return this.byId.get(layerId)?.scene ?? null;
  }

  layerIdForSlot(slotId: number): string | null {
    return this.slotLayer.get(slotId) ?? null;
  }

  slotIdsForLayer(layerId: string): number[] {
    const slotIds: number[] = [];
    for (const [slotId, id] of this.slotLayer) {
      if (id === layerId) slotIds.push(slotId);
    }
    return slotIds;
  }

  layers(): SceneLayerView[] {
    return [...this.byId.values()];
  }

  sortedLayers(): SceneLayerView[] {
    return [...this.orderedLayers()];
  }

  /** Cached draw order for per-frame and per-pointer walks; never mutated in place. */
  private orderedLayers(): readonly LayerRecord[] {
    this.sortedCache ??= [...this.byId.values()].sort((a, b) => {
      if (a.zOrder !== b.zOrder) return a.zOrder - b.zOrder;
      return a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0;
    });
    return this.sortedCache;
  }

  resize(): void {
    const width = Math.max(1, this.engine.getRenderWidth(true));
    const height = Math.max(1, this.engine.getRenderHeight(true));
    if (width === this.outputWidth && height === this.outputHeight) return;
    for (const layer of this.byId.values()) {
      layer.viewBounds = sceneLayerViewBounds(layer.designBounds, width / height);
      this.bindHudCamera(layer, true);
      if (layer.rtt) {
        const previous = layer.rtt.getSize();
        if (previous.width !== width || previous.height !== height)
          this.rebuildPostProcess(layer);
      }
    }
    this.outputWidth = width;
    this.outputHeight = height;
  }

  private outputAspect(): number {
    return Math.max(1, this.engine.getRenderWidth(true)) / Math.max(1, this.engine.getRenderHeight(true));
  }

  retainResources(): () => void {
    const releases = [...this.byId.values()].map((layer) => layer.renderer.retainResources());
    return () => { for (const release of releases) release(); };
  }

  async prepare(layerId: string, assertCurrent: () => void): Promise<void> {
    this.resize();
    const layer = this.byId.get(layerId);
    if (!layer) throw new Error("SceneLayer was removed before rendering preparation.");
    this.bindHudCamera(layer, true);
    await layer.renderer.prepare(assertCurrent);
    assertCurrent();
    if (this.byId.get(layerId) !== layer) throw new Error("SceneLayer rendering preparation was superseded.");
  }

  render(presentingLayers: ReadonlySet<string> = new Set(), draw: (layerId: string, render: () => boolean, fallback: () => void) => void = (_id, render) => render()): void {
    this.resize();
    for (const record of this.orderedLayers()) {
      if (!this.isLayerReady(record.layerId) && !presentingLayers.has(record.layerId)) continue;
      this.bindHudCamera(record);
      draw(record.layerId, () => {
        let readyForPresentation: boolean;
        if (record.rtt) {
          record.scene.autoClear = true;
          const frameCapture = activeRenderFrameCapture(this.engine);
          const result = frameCapture
            ? frameCapture.stage(record.scene, { name: "SceneLayer scene output", kind: "composition", sceneId: record.layerId },
              () => record.renderer.render())
            : record.renderer.render();
          if (!record.blitReady && record.blitScene)
            record.blitReady = isSceneFrameReady(record.blitScene);
          if (!result.rendered || !result.readyForPresentation || !record.blitScene || !record.blitReady) {
            this.blitFallback(record);
            return false;
          }
          this.blit(record);
          readyForPresentation = record.blitReady;
          if (readyForPresentation) {
            record.presented = true;
            this.releaseFallback(record);
          }
        } else {
          record.scene.autoClear = false;
          record.scene.autoClearDepthAndStencil = true;
          const frameCapture = activeRenderFrameCapture(this.engine);
          const result = frameCapture
            ? frameCapture.stage(record.scene, { name: "SceneLayer scene output", kind: "composition", sceneId: record.layerId },
              () => record.renderer.render())
            : record.renderer.render();
          if (!result.rendered) {
            this.blitFallback(record);
            return false;
          }
          readyForPresentation = result.readyForPresentation;
          if (readyForPresentation) this.releaseFallback(record);
        }
        return readyForPresentation;
      }, () => { this.blitFallback(record); });
    }
  }

  isReady(layerId?: string): boolean {
    if (layerId && !this.byId.has(layerId)) return false;
    for (const record of this.byId.values()) {
      if (layerId ? record.layerId !== layerId : !this.isLayerReady(record.layerId)) continue;
      // Strict probes are cached per layer; the renderer's dirty flag re-opens
      // them after scene or rendering-definition changes. The coordinator's
      // probe already covers the layer's output target via customRenderTargets.
      if (record.probedReady && !record.renderer.readinessDirty) continue;
      const ready =
        record.renderer.isReady() &&
        (!record.rtt ||
          (!!record.blitScene &&
            (record.blitReady ||
              (record.blitReady = isSceneFrameReady(record.blitScene)))));
      record.probedReady = ready;
      if (!ready) return false;
    }
    return true;
  }

  pickHits(
    canvasX: number,
    canvasY: number,
    options?: { minTargetPx?: number; canvasCssHeight?: number },
  ): OverlayPointerHit[] {
    const hits: OverlayPointerHit[] = [];
    const seen = new Set<string>();

    const pushHit = (
      layerId: string,
      actorGuid: string,
      hitTest: SceneLayerHitTest,
      hasButton: boolean,
      componentId?: string,
      joystickMeshName?: string,
      controlMeshName?: string,
    ) => {
      const key = controlMeshName ?? joystickMeshName ?? (componentId ? `${actorGuid}:${componentId}` : actorGuid);
      if (!actorGuid || seen.has(key)) return;
      seen.add(key);
      hits.push({
        layerId,
        actorGuid,
        hitTest,
        hasButton,
        ...(componentId ? { componentId } : {}),
        ...(joystickMeshName ? { joystickMeshName } : {}),
        ...(controlMeshName ? { controlMeshName } : {}),
      });
    };

    const ordered = this.orderedLayers();
    for (let index = ordered.length - 1; index >= 0; index--) {
      const layer = ordered[index]!;
      if (!this.isLayerReady(layer.layerId)) continue;
      this.bindHudCamera(layer);
      // The pointer is in pick space (render size x hardware scaling level), as `scene.pick` expects.
      const pickSize = pickBufferSize(layer.scene);
      const pickWorld = sceneLayerCanvasToLayer(canvasX, canvasY, pickSize.width, pickSize.height, layer.viewBounds, layer.cameraState);
      const minWorld = overlayMinTargetWorldSize(
        options?.minTargetPx ?? 0,
        options?.canvasCssHeight ?? 0,
        layer.viewBounds.height / layer.cameraState.zoom,
      );
      const touch = minWorld > 0;
      const pickable = (mesh: AbstractMesh) => mesh.isEnabled() && mesh.isVisible && mesh.isPickable && overlayClipAllowsPoint(mesh, pickWorld.x, pickWorld.y);
      // The ray pick already offers every mesh of the scene to its predicate, in
      // scene order. Collect the interactive ones on that pass instead of walking
      // scene.meshes a second time per pointer event. Metadata, parents and the
      // mesh list change without any notification, so no cached list could be
      // trusted; reading them during the pass can't go stale.
      let offered = 0;
      const touchTargets: AbstractMesh[] = [];
      const pick = layer.scene.pick(canvasX, canvasY, (mesh, instance = -1) => {
        const eligible = pickable(mesh);
        if (touch && instance < 0) {
          offered += 1;
          if (eligible && isOverlayTouchTarget(overlayMetadataOf(mesh))) touchTargets.push(mesh);
        }
        return eligible;
      }, false);
      if (pick?.hit && pick.pickedMesh) {
        let mesh: {
          name: string;
          parent: unknown;
          metadata?: unknown;
          isPickable?: boolean;
        } | null = pick.pickedMesh;
        let slotId: number | null = null;
        let metadata: OverlayMeshMetadata | null = overlayMetadataOf(mesh);
        const interactive = metadata?.overlayJoystickMeshName || metadata?.overlayControlMeshName ? metadata : null;
        while (mesh) {
          const match = /^actor-(\d+)$/.exec(mesh.name);
          if (match) {
            slotId = Number(match[1]);
            metadata = overlayMetadataOf(mesh) ?? metadata;
            break;
          }
          metadata = overlayMetadataOf(mesh) ?? metadata;
          mesh = (mesh.parent as typeof mesh) ?? null;
        }
        if (interactive) metadata = { ...metadata, ...interactive };
        const actorGuid =
          metadata?.overlayActorGuid ??
          (slotId != null ? this.slotActor.get(slotId) : undefined) ??
          "";
        if (actorGuid) {
          pushHit(
            layer.layerId,
            actorGuid,
            parseSceneLayerHitTest(metadata?.overlayHitTest, "ignore"),
            metadata?.overlayHasButton === true,
            metadata?.overlayControlComponentId ?? (typeof metadata?.overlayButtonComponentId === "string" &&
              metadata.overlayButtonComponentId
              ? metadata.overlayButtonComponentId
              : undefined),
            metadata?.overlayJoystickMeshName,
            metadata?.overlayControlMeshName,
          );
        }
      }

      if (!touch) continue;
      // Should a Babylon version stop offering every mesh to the predicate, scan them all.
      for (const mesh of offered === layer.scene.meshes.length ? touchTargets : layer.scene.meshes) {
        // Same eligibility as Babylon's default ray pick above.
        if (!pickable(mesh)) continue;
        const metadata = overlayMetadataOf(mesh);
        if (!metadata || !isOverlayTouchTarget(metadata)) continue;
        const hitTest = parseSceneLayerHitTest(metadata.overlayHitTest, "ignore");
        if (hitTest === "ignore") continue;
        const slotMatch = /^actor-(\d+)$/.exec(mesh.name);
        const actorGuid =
          metadata.overlayActorGuid ??
          (slotMatch ? this.slotActor.get(Number(slotMatch[1])) : undefined) ??
          "";
        if (!actorGuid) continue;
        mesh.computeWorldMatrix(true);
        const box = mesh.getBoundingInfo().boundingBox;
        if (
          !pointInInflatedWorldAabb(
            pickWorld.x,
            pickWorld.y,
            box.centerWorld.x,
            box.centerWorld.y,
            box.extendSizeWorld.x,
            box.extendSizeWorld.y,
            minWorld,
          )
        ) {
          continue;
        }
        pushHit(
          layer.layerId,
          actorGuid,
          hitTest,
          metadata.overlayHasButton === true,
          metadata.overlayControlComponentId ?? (typeof metadata.overlayButtonComponentId === "string" &&
            metadata.overlayButtonComponentId
            ? metadata.overlayButtonComponentId
            : undefined),
          metadata.overlayJoystickMeshName,
          metadata.overlayControlMeshName,
        );
      }
    }
    return hits;
  }

  pickAt(
    canvasX: number,
    canvasY: number,
    options?: { minTargetPx?: number; canvasCssHeight?: number },
  ): {
    layerId: string;
    meshName: string;
    slotId: number | null;
    actorGuid: string | null;
    hitTest: SceneLayerHitTest;
    blocked: boolean;
    targets: OverlayPointerHit[];
  } | null {
    const hits = this.pickHits(canvasX, canvasY, options);
    const walked = walkOverlayPointerHits(hits);
    const first = walked.targets[0];
    if (!first) {
      return walked.blocked
        ? {
            layerId: "",
            meshName: "",
            slotId: null,
            actorGuid: null,
            hitTest: "block",
            blocked: true,
            targets: walked.targets,
          }
        : null;
    }
    return {
      layerId: first.layerId,
      meshName: first.actorGuid,
      slotId: null,
      actorGuid: first.actorGuid,
      hitTest: first.hitTest,
      blocked: walked.blocked,
      targets: walked.targets,
    };
  }

  dispose(): Promise<void> {
    this.clear();
    const retired = this.retiredLayers.whenDisposed();
    // Callers that own shared resources await this; ignored teardown still has
    // its failures reported at the individual quarantined owner boundary.
    void retired.catch(() => {});
    return retired;
  }

  /** Actual Scene/target release, including generations whose bounded wait failed. */
  whenReleased(): Promise<void> { return this.retiredLayers.whenReleased(); }

  /**
   * Pin the camera to the layer's orthographic pose: 10 units in front of its
   * `cameraState` centre, looking along +Z, rolled by its rotation, with the
   * view bounds divided by its zoom. Per-frame callers leave a camera alone
   * while its parent, position, rotation, mode, active-camera status and
   * orthographic bounds still match what the last bind wrote; Babylon
   * re-derives its view and projection when anything they read changes. A
   * mismatch, and create, resize, a camera change and preparation (force),
   * rebind those fields and force both matrices. Nothing else is restored
   * (target lock, near and far planes), as before; Babylon re-derives the up
   * vector from the roll.
   */
  private bindHudCamera(layer: LayerRecord, force = false): void {
    if (!force && this.hudCameraIntact(layer)) return;
    const { x, y } = layer.cameraState;
    layer.camera.parent = null;
    layer.camera.position.set(x, y, -10);
    layer.camera.rotation.set(0, 0, 0);
    if (layer.camera.rotationQuaternion) {
      layer.camera.rotationQuaternion.set(0, 0, 0, 1);
    }
    layer.camera.setTarget(scratchTarget.set(x, y, 0));
    // setTarget clears the roll, so it is applied afterwards.
    const roll = layer.cameraState.rotation * Math.PI / 180;
    if (layer.camera.rotationQuaternion) Quaternion.RotationYawPitchRollToRef(0, 0, roll, layer.camera.rotationQuaternion);
    else layer.camera.rotation.z = roll;
    layer.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    layer.scene.activeCamera = layer.camera;
    this.applyOrtho(layer);
    layer.camera.getViewMatrix(true);
    layer.camera.getProjectionMatrix(true);
    // Scene.render establishes Babylon's floating-origin scene before uploading
    // the scene matrices. Updating them here would cache the previous world
    // scene's offset/projection in this layer's GPU uniform buffer.
    const { position, rotation, rotationQuaternion: quaternion } = layer.camera;
    layer.hudPose = {
      position: [position.x, position.y, position.z],
      rotation: [rotation.x, rotation.y, rotation.z],
      quaternion: quaternion ? [quaternion.x, quaternion.y, quaternion.z, quaternion.w] : null,
    };
  }

  private hudCameraIntact(layer: LayerRecord): boolean {
    const { camera, scene, hudPose: pose } = layer;
    if (!pose || camera.parent !== null || camera.mode !== Camera.ORTHOGRAPHIC_CAMERA || scene.activeCamera !== camera) return false;
    const { position, rotation, rotationQuaternion: quaternion } = camera;
    if (position.x !== pose.position[0] || position.y !== pose.position[1] || position.z !== pose.position[2] ||
      rotation.x !== pose.rotation[0] || rotation.y !== pose.rotation[1] || rotation.z !== pose.rotation[2]) return false;
    if (quaternion) {
      const posed = pose.quaternion;
      if (!posed || quaternion.x !== posed[0] || quaternion.y !== posed[1] || quaternion.z !== posed[2] || quaternion.w !== posed[3]) return false;
    } else if (pose.quaternion) return false;
    const halfW = layer.viewBounds.width / 2 / layer.cameraState.zoom;
    const halfH = layer.viewBounds.height / 2 / layer.cameraState.zoom;
    return camera.orthoTop === halfH && camera.orthoBottom === -halfH && camera.orthoLeft === -halfW && camera.orthoRight === halfW;
  }

  private applyOrtho(layer: LayerRecord): void {
    const halfW = layer.viewBounds.width / 2 / layer.cameraState.zoom;
    const halfH = layer.viewBounds.height / 2 / layer.cameraState.zoom;
    layer.camera.orthoTop = halfH;
    layer.camera.orthoBottom = -halfH;
    layer.camera.orthoLeft = -halfW;
    layer.camera.orthoRight = halfW;
  }

  private rebuildPostProcess(layer: LayerRecord, replaceRenderer = true): void {
    if (replaceRenderer) {
      this.releasePostProcess(layer, true);
      layer.renderer = new SceneRenderCoordinator(layer.scene);
    }
    const enabledStack = layer.parameters.effective(layer.postProcessStack).filter((entry) => entry.enabled);
    if (
      !this.postProcessingEnabled() ||
      enabledStack.length === 0
    ) {
      layer.camera.outputRenderTarget = null;
      layer.scene.autoClear = false;
      layer.scene.autoClearDepthAndStencil = true;
      return;
    }
    const width = Math.max(1, this.engine.getRenderWidth(true));
    const height = Math.max(1, this.engine.getRenderHeight(true));
    layer.rtt = new RenderTargetTexture(
      `sceneLayerRtt:${layer.layerId}`,
      { width, height },
      layer.scene,
      false,
      true,
    );
    // StandardMaterial only blends sampled alpha when the source advertises it.
    // The layer clear is transparent; preserve world pixels outside its content.
    layer.rtt.hasAlpha = true;
    // The graph borrows both native attachments; the host retains their owner.
    // Without depth textures the coordinator reports the layer as unsupported.
    if (this.engine.getCaps().depthTextureExtension)
      layer.rtt.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);
    layer.camera.outputRenderTarget = layer.rtt;
    layer.scene.autoClear = true;
    layer.attachedPostProcess =
      this.attachLayerPostProcess?.(layer, enabledStack, layer.renderer) ?? null;
    this.prepareBlit(layer);
  }

  private releasePostProcess(layer: LayerRecord, keepPresented = false): void {
    const attached = layer.attachedPostProcess;
    const renderer = layer.renderer;
    const rtt = layer.rtt;
    const blitScene = layer.blitScene;
    let outputReleased = Promise.resolve();
    if (keepPresented && layer.presented && rtt && blitScene) {
      this.releaseFallback(layer);
      outputReleased = new Promise<void>((release) => {
        layer.fallback = { scene: blitScene, release };
      });
    }
    layer.presented = false;
    layer.probedReady = false;
    layer.blitReady = false;
    layer.attachedPostProcess = null;
    layer.camera.outputRenderTarget = null;
    layer.rtt = null;
    layer.blitScene = null;
    layer.blitMaterial = null;
    const reports: Promise<void>[] = [];
    try { attached?.dispose(); } catch (error) { reports.push(Promise.reject(error)); }
    try { reports.push(renderer.retire()); } catch (error) { reports.push(Promise.reject(error)); }
    // Bounded cleanup reporting stays separate from confirmed actual release:
    // an uncertain report never proves the target stopped being used.
    const reported = Promise.all(reports).then(
      () => {},
      (error: unknown) => {
        throw new Error(`SceneLayer ${layer.layerId} retirement failed`, { cause: error });
      },
    );
    const released = (async () => {
      await renderer.whenReleased();
      await outputReleased;
      blitScene?.dispose();
      rtt?.dispose();
    })();
    layer.retirements.add({ whenDisposed: () => reported, whenReleased: () => released });
    void reported.catch((error: unknown) => {
      console.warn(`[render] SceneLayer ${layer.layerId} cleanup report is uncertain: ${String(error)}`);
    });
    void released.catch((error: unknown) => {
      console.warn(`[render] SceneLayer ${layer.layerId} target is quarantined until actual release: ${String(error)}`);
    });
  }

  private releaseFallback(layer: LayerRecord): void {
    layer.fallback?.release();
    layer.fallback = null;
  }

  private blitFallback(layer: LayerRecord): void {
    const fallback = layer.fallback;
    if (fallback && !fallback.scene.isDisposed && isSceneFrameReady(fallback.scene)) {
      const capture = activeRenderFrameCapture(this.engine);
      if (capture) capture.stage(fallback.scene, { name: "SceneLayer held output", kind: "composition",
        sceneId: layer.layerId, detail: "Previously coherent layer output; no new layer frame was produced." }, () => fallback.scene.render());
      else fallback.scene.render();
    }
  }

  private prepareBlit(layer: LayerRecord): void {
    if (!layer.rtt) return;
    if (!layer.blitScene) {
      const blitScene = this.ownScene(new Scene(this.engine));
      blitScene.autoClear = false;
      blitScene.autoClearDepthAndStencil = false;
      blitScene.skipPointerMovePicking = true;
      blitScene.lightsEnabled = false;
      const camera = new UniversalCamera(
        "sceneLayerBlitCamera",
        new Vector3(0, 0, -1),
        blitScene,
      );
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -1;
      camera.orthoRight = 1;
      camera.orthoTop = 1;
      camera.orthoBottom = -1;
      blitScene.activeCamera = camera;
      const plane = MeshBuilder.CreatePlane(
        "sceneLayerBlitPlane",
        { size: 2 },
        blitScene,
      );
      const material = new StandardMaterial(
        `sceneLayerBlit:${layer.layerId}`,
        blitScene,
      );
      material.disableLighting = true;
      material.diffuseColor = Color3.White();
      material.emissiveColor = Color3.White();
      material.backFaceCulling = false;
      material.useAlphaFromDiffuseTexture = true;
      plane.material = material;
      layer.blitScene = blitScene;
      layer.blitMaterial = material;
    }
    if (layer.blitMaterial) {
      layer.blitMaterial.diffuseTexture = layer.rtt;
      layer.blitMaterial.emissiveTexture = layer.rtt;
    }
  }

  private blit(layer: LayerRecord): void {
    this.prepareBlit(layer);
    if (!layer.blitScene) return;
    const capture = activeRenderFrameCapture(this.engine);
    if (capture) capture.stage(layer.blitScene, { name: "SceneLayer output composition", kind: "composition",
      sceneId: layer.layerId }, () => layer.blitScene?.render());
    else layer.blitScene.render();
  }
}

type OverlayMeshMetadata = {
  overlayJoystickMeshName?: string;
  overlayControlMeshName?: string;
  overlayControlComponentId?: string;
  overlayHitTest?: SceneLayerHitTest;
  overlayActorGuid?: string;
  overlayHasButton?: boolean;
  overlayButtonComponentId?: string;
};

function overlayMetadataOf(
  mesh: { metadata?: unknown } | null,
): OverlayMeshMetadata | null {
  if (!mesh?.metadata || typeof mesh.metadata !== "object") return null;
  return mesh.metadata as OverlayMeshMetadata;
}

/** Buttons, joysticks and controls get their pick area widened to the touch floor. */
function isOverlayTouchTarget(metadata: OverlayMeshMetadata | null): boolean {
  return !!(metadata?.overlayHasButton || metadata?.overlayJoystickMeshName || metadata?.overlayControlMeshName);
}
