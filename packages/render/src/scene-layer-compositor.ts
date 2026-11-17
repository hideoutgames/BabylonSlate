import { activeRenderFrameCapture } from "./render-frame-report";
import { CameraShakeView, type CameraShakeViewOffset } from "./camera-shake-view";
import { PostProcessParameterState } from "./post-process-parameter-state";
import { overlayClipAllowsPoint } from "./overlay-layout-render";
import { openRenderChangeReader, RenderChange, type RenderChangeReader } from "./render-change-journal";
import { pickBufferSize } from "./pick-coords";
import type { AttachedPostProcessStack } from "./post-process-material";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import type { CommandMessage } from "@haptic/bridge";
import {
  parseSceneLayerHitTest,
  normalizeSceneLayerCanvasDesign,
  sceneLayerCanvasToLayer,
  sceneLayerFitToAspect,
  sceneLayerView,
  DEFAULT_LAYER_CAMERA_STATE,
  type SceneLayerCanvasDesign,
  type SceneLayerContentBounds,
  type SceneLayerRect,
  type OverlayPointerHit,
  type LayerCameraState,
  type SceneLayerHitTest,
  type ScenePostProcessEntry,
  type MaterialParameterValue,
} from "@haptic/core";
import { installEngineDefaultMaterial } from "./default-material";
import { sceneDrawBatchWork, setSceneDrawBatching, type OverlayBatchWork } from "./overlay-draw-batcher";
import { keepLayerDrawableMeshes, layerDrawableMeshWork, type LayerDrawableMeshWork } from "./layer-drawable-meshes";
import { isSceneFrameReady } from "./scene-perf";
import { PreparationTimedOut, SceneRenderCoordinator } from "./scene-render-coordinator";
import { SCENE_PREPARATION_CEILING_MS } from "./stall-deadline";
import { PostProcessRetirement } from "./post-process-retirement";
import { configureCutoutSorting } from "./sorting";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

/** A layer's output over the world: its target's colour, blended by its alpha, without fog. */
const SCENE_LAYER_BLIT: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: false, role: "world" };
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
  /** What the camera frames at zoom 1 and Camera Location (0, 0): the canvas's view (`sceneLayerView`), its size and centre. */
  viewBounds: SceneLayerRect;
  /** The camera location (from `viewBounds`' centre), roll and zoom scripts set; with `viewBounds` it maps the canvas into the layer (`sceneLayerCanvasToLayer`). */
  cameraState: LayerCameraState;
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
  /**
   * The output in design pixels over Pixels Per Unit, in layer units (`sceneLayerOutputDesignSize`): what Fullscreen
   * and True Pixel Size frame. Without it a layer frames its canvas widened to the output's aspect.
   */
  screen?: () => { width: number; height: number } | null;
  /** A Desired layer's view changed after its content was measured. */
  onLayerView?: (layerId: string, view: SceneLayerRect) => void;
}

const scratchTarget = new Vector3();

/** The pose bindHudCamera leaves; any other reading means another owner moved the camera. */
interface HudCameraPose {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  quaternion: readonly [number, number, number, number] | null;
}

type LayerRecord = SceneLayerView & {
  /** How the asset sizes and scales its canvas. */
  design: SceneLayerCanvasDesign;
  /** The canvas in layer units: the command's, or for Desired the drawn content's bounds once measured. */
  canvas: SceneLayerRect;
  /** Desired only: hears the layer Scene's changes since its content was last measured. */
  contentChanges: ContentWatch | null;
  /** Null until the first bind. */
  hudPose: HudCameraPose | null;
  renderer: SceneRenderCoordinator;
  postProcessStack: SceneLayerPostProcessEntry[];
  rtt: RenderTargetTexture | null;
  /** The blit plane, drawing the layer's target with the unlit Material. */
  blitPlane: Mesh | null;
  blitScene: Scene | null;
  parameters: PostProcessParameterState;
  retirements: PostProcessRetirement;
  presented: boolean;
  /** Cached strict layer readiness; invalidated by renderer dirtiness/rebuild. */
  probedReady: boolean;
  blitReady: boolean;
  fallback: { scene: Scene; release(): void } | null;
  attachedPostProcess: ReturnType<NonNullable<SceneLayerCompositorOptions["attachLayerPostProcess"]>>;
  /** Play Camera Shake On Scene Layer: created with the layer's first shake. */
  shake: CameraShakeView | null;
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
  private readonly screen: () => { width: number; height: number } | null;
  private readonly onLayerView?: SceneLayerCompositorOptions["onLayerView"];
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
    this.screen = options.screen ?? (() => null);
    this.onLayerView = options.onLayerView;
  }

  create(command: SceneLayerCreateCommand): SceneLayerView {
    this.remove(command.layerId);
    const scene = this.ownScene(new Scene(this.engine));
    configureCutoutSorting(scene);
    installEngineDefaultMaterial(scene);
    // HUD content is many small unlit draws: batched where the output cannot change (`overlay-draw-batcher.ts`).
    setSceneDrawBatching(scene, true);
    // Most of a HUD's meshes are hidden actor roots and disabled control parts: the mesh loop and the cull read only
    // those that can draw (`layer-drawable-meshes.ts`).
    keepLayerDrawableMeshes(scene);
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
      renderer: layerRenderer(scene),
      design: normalizeSceneLayerCanvasDesign(command.canvas?.design),
      canvas: commandCanvas(command),
      contentChanges: null,
      viewBounds: { width: 1, height: 1, center: [0, 0] },
      cameraState: { ...(command.camera ?? DEFAULT_LAYER_CAMERA_STATE) },
      hudPose: null,
      postProcessStack: command.postProcessStack.map((entry) => ({ ...entry })),
      rtt: null,
      blitPlane: null,
      blitScene: null,
      attachedPostProcess: null,
      shake: null,
      parameters: new PostProcessParameterState(),
      retirements: new PostProcessRetirement(),
      presented: false,
      probedReady: false,
      blitReady: false,
      fallback: null,
    };
    layer.viewBounds = this.layerView(layer);
    if (layer.design.sizeMode === "desired") layer.contentChanges = watchContent(scene);
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
    layer.shake?.dispose();
    layer.shake = null;
    layer.contentChanges?.release();
    layer.contentChanges = null;
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

  /**
   * Debug (`layerdebug clears off`): a layer composited straight over the world no longer clears depth and stencil
   * before it draws. A layer whose meshes test or write depth then draws against what the frame left there, so its
   * picture may differ: a measurement switch, never a default.
   */
  depthClears = true;

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

  /** Shake a layer's view (`setCameraShake`); picks keep the unshaken camera. */
  setShake(layerId: string, offset: CameraShakeViewOffset | null): void {
    const layer = this.byId.get(layerId);
    if (!layer || (!offset && !layer.shake)) return;
    layer.shake ??= new CameraShakeView(layer.scene, () => layer.camera);
    layer.shake.set(offset);
  }

  /** Move, turn or zoom a layer's camera (`sceneLayerCamera`); the next pick and draw use it. */
  setCamera(layerId: string, camera: Readonly<LayerCameraState>): void {
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

  /**
   * Each layer's renderer work in draw order (`ForwardSceneFrameGraph.diagnostics`: its graph builds, strict readiness
   * checks with their reasons and time, and what the last failed one waited for) with its mesh count, how its draw
   * batcher kept its work (`sceneDrawBatchWork`) and how its drawable mesh list was kept (`layerDrawableMeshWork`).
   * Reading starts the measuring, as a view's own does.
   */
  diagnostics(): Array<{
    layerId: string; meshes: number; work: ReturnType<SceneRenderCoordinator["diagnostics"]>; batching: OverlayBatchWork | null;
    drawable: LayerDrawableMeshWork | null;
  }> {
    return this.orderedLayers().map((layer) => ({
      layerId: layer.layerId, meshes: layer.scene.meshes.length, work: layer.renderer.diagnostics(), batching: sceneDrawBatchWork(layer.scene),
      drawable: layerDrawableMeshWork(layer.scene),
    }));
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

  /** Reframes every layer after the output's size changed; `force` after its design-pixel size alone changed. */
  resize(force = false): void {
    const width = Math.max(1, this.engine.getRenderWidth(true));
    const height = Math.max(1, this.engine.getRenderHeight(true));
    if (!force && width === this.outputWidth && height === this.outputHeight) return;
    this.outputWidth = width;
    this.outputHeight = height;
    for (const layer of this.byId.values()) {
      layer.viewBounds = this.layerView(layer);
      this.bindHudCamera(layer, true);
      if (layer.rtt) {
        const previous = layer.rtt.getSize();
        if (previous.width !== width || previous.height !== height)
          this.rebuildPostProcess(layer);
      }
    }
  }

  /** The screen in layer units: the host's design-pixel output, else the canvas widened to the output's aspect. */
  private layerScreen(layer: LayerRecord): { width: number; height: number } {
    const screen = this.screen();
    if (screen && screen.width > 0 && screen.height > 0) return screen;
    const aspect = Math.max(1, this.engine.getRenderWidth(true)) / Math.max(1, this.engine.getRenderHeight(true));
    return sceneLayerFitToAspect(layer.canvas, aspect);
  }

  private layerView(layer: LayerRecord): SceneLayerRect {
    return sceneLayerView(layer.canvas, layer.design, this.layerScreen(layer));
  }

  /**
   * A Desired layer's canvas is its drawn content's bounds: measured again only after its Scene noted a change of a
   * mesh's transform, visibility, enabled state or geometry, or added or removed a mesh, and never for another mode.
   * `force` (preparation) measures whatever changed and recomputes every world matrix.
   */
  private measureContent(layer: LayerRecord, force = false): void {
    const changes = layer.contentChanges;
    if (!changes) return;
    if (!changes.reader.drain(() => { changes.dirty = true; })) changes.dirty = true;
    if (!changes.dirty && !force) return;
    changes.dirty = false;
    const bounds = sceneLayerContentBounds(layer.scene, force);
    // Its own matrix computations are not content changes.
    changes.reader.drain(() => {});
    if (!bounds) return;
    const canvas: SceneLayerRect = {
      width: Math.max(bounds.maxX - bounds.minX, 1e-3),
      height: Math.max(bounds.maxY - bounds.minY, 1e-3),
      center: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2],
    };
    if (sameRect(canvas, layer.canvas)) return;
    layer.canvas = canvas;
    layer.viewBounds = this.layerView(layer);
    this.bindHudCamera(layer, true);
    this.onLayerView?.(layer.layerId, layer.viewBounds);
  }

  /** Restarts every layer's preparation and clears what it latched (a restored graphics context). */
  invalidate(): void {
    for (const layer of this.byId.values()) {
      layer.renderer.invalidate();
      layer.probedReady = false;
    }
  }

  retainResources(): () => void {
    const releases = [...this.byId.values()].map((layer) => layer.renderer.retainResources());
    return () => { for (const release of releases) release(); };
  }

  /**
   * Prepares the layer's current renderer. A post-process rebuild, resize or
   * re-create during the wait replaces it, and preparation follows the
   * replacement; a removed layer has nothing left to prepare. The caller's
   * `assertCurrent` cancels, and an error of a renderer that is still current
   * (a timeout, a missing camera) rejects. Each replacement brings fresh
   * bounds, so following one more starts no later than
   * `SCENE_PREPARATION_CEILING_MS` after the first pass began.
   */
  async prepare(layerId: string, assertCurrent: () => void): Promise<void> {
    this.resize();
    const ceiling = performance.now() + SCENE_PREPARATION_CEILING_MS;
    for (let following = false; ; following = true) {
      const layer = this.byId.get(layerId);
      if (!layer) { assertCurrent(); return; }
      if (following && performance.now() >= ceiling)
        throw new PreparationTimedOut(`SceneLayer rendering preparation timed out after its ${SCENE_PREPARATION_CEILING_MS / 1000} s limit: its renderer kept being replaced.`);
      this.measureContent(layer, true);
      this.bindHudCamera(layer, true);
      const renderer = layer.renderer;
      try {
        await renderer.prepare(assertCurrent);
      } catch (error) {
        assertCurrent();
        if (this.byId.get(layerId) !== layer || layer.renderer !== renderer) continue;
        throw error;
      }
      assertCurrent();
      if (this.byId.get(layerId) === layer && layer.renderer === renderer) return;
    }
  }

  render(presentingLayers: ReadonlySet<string> = new Set(), draw: (layerId: string, render: () => boolean, fallback: () => void) => void = (_id, render) => render()): void {
    this.resize();
    for (const record of this.orderedLayers()) {
      if (!this.isLayerReady(record.layerId) && !presentingLayers.has(record.layerId)) continue;
      this.measureContent(record);
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
          record.scene.autoClearDepthAndStencil = this.depthClears;
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
   * view's centre moved by its `cameraState` location, looking along +Z,
   * rolled by its rotation, with the view bounds divided by its zoom. Per-frame callers leave a camera alone
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
    const x = layer.cameraState.x + layer.viewBounds.center[0];
    const y = layer.cameraState.y + layer.viewBounds.center[1];
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
      layer.renderer = layerRenderer(layer.scene);
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
    // Colour only: the layer's graph draws through its chain's scene colour and depth (or its own pair) and copies
    // colour here, so a depth attachment would never be drawn into. The graph borrows the colour; the host retains it.
    layer.rtt = new RenderTargetTexture(`sceneLayerRtt:${layer.layerId}`, { width, height }, layer.scene, {
      generateMipMaps: false, generateDepthBuffer: false,
    });
    // The unlit Material reads a texture's alpha only when the texture advertises it.
    // The layer clear is transparent; preserve world pixels outside its content.
    layer.rtt.hasAlpha = true;
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
    layer.blitPlane = null;
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
      layer.blitScene = blitScene;
      layer.blitPlane = plane;
    }
    // The layer's colour over the world, blended by its alpha.
    if (layer.blitPlane) setUnlitMaterial(layer.blitPlane, SCENE_LAYER_BLIT, {
      texture: layer.rtt, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: true, textureAlpha: true, twoSided: false,
    });
  }

  /** Draws the blit plane as `rebuildPostProcess` bound it: the layer's target changes only through that rebuild. */
  private blit(layer: LayerRecord): void {
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

/**
 * A layer's renderer, the first and every one that replaces it. A layer draws every frame: a visual that joins or
 * changes how it draws is probed for itself, not with every other visual of the layer.
 */
function layerRenderer(scene: Scene): SceneRenderCoordinator {
  return new SceneRenderCoordinator(scene, { scopedStrictProbes: true });
}

/** The sceneLayerCreate command's canvas, or a 1 × 1 one centred on the origin when it has none. */
function commandCanvas(command: SceneLayerCreateCommand): SceneLayerRect {
  const rect = command.canvas?.rect;
  return rect && rect.width > 0 && rect.height > 0
    ? { width: rect.width, height: rect.height, center: [rect.center[0], rect.center[1]] }
    : { width: 1, height: 1, center: [0, 0] };
}

function sameRect(a: SceneLayerRect, b: SceneLayerRect): boolean {
  return a.width === b.width && a.height === b.height && a.center[0] === b.center[0] && a.center[1] === b.center[1];
}

interface ContentWatch {
  reader: RenderChangeReader;
  dirty: boolean;
  release(): void;
}

/** Hears a layer Scene's content changes: mesh transform, visibility, enabled state and geometry, and added or removed meshes. */
function watchContent(scene: Scene): ContentWatch {
  const reader = openRenderChangeReader(scene, RenderChange.Transform | RenderChange.Visibility | RenderChange.Enabled | RenderChange.Geometry);
  const watch: ContentWatch = { reader, dirty: true, release: () => {} };
  const added = scene.onNewMeshAddedObservable.add(() => { watch.dirty = true; });
  const removed = scene.onMeshRemovedObservable.add(() => { watch.dirty = true; });
  watch.release = () => {
    reader.dispose();
    scene.onNewMeshAddedObservable.remove(added);
    scene.onMeshRemovedObservable.remove(removed);
  };
  return watch;
}

/**
 * The XY bounds of a layer Scene's drawn content: every enabled, visible mesh with vertices, as the editor's
 * `visualBounds2D` measures visuals. Null without any.
 */
export function sceneLayerContentBounds(scene: Scene, computeMatrices = false): SceneLayerContentBounds | null {
  let bounds: SceneLayerContentBounds | null = null;
  for (const mesh of scene.meshes) {
    if (!mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0) continue;
    // A frame's own render computed most matrices; one moved since is computed here, as that render would.
    mesh.computeWorldMatrix(computeMatrices);
    const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) continue;
    bounds = bounds
      ? { minX: Math.min(bounds.minX, min.x), minY: Math.min(bounds.minY, min.y), maxX: Math.max(bounds.maxX, max.x), maxY: Math.max(bounds.maxY, max.y) }
      : { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y };
  }
  return bounds;
}

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
