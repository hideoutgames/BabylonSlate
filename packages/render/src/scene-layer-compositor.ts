import { activeRenderFrameCapture } from "./render-frame-report";
import { CameraShakeView, type CameraShakeViewOffset } from "./camera-shake-view";
import { PostProcessParameterState } from "./post-process-parameter-state";
import { overlayClipAllowsPoint } from "./overlay-layout-render";
import { isColliderVisualMesh } from "./collider-visual";
import { openRenderChangeReader, RenderChange, type RenderChangeReader } from "./render-change-journal";
import { pickBufferSize } from "./pick-coords";
import type { AttachedPostProcessStack } from "./post-process-material";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import type { CommandMessage, SceneLayerPostProcessPanelPayload } from "@haptic/bridge";
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
import { flushSceneImagePages, sceneDrawBatchWork, setSceneDrawBatching, type OverlayBatchWork } from "./overlay-draw-batcher";
import { uploadSceneGlyphPages } from "./text2d-glyph-atlas";
import { countLayerPhase, emptyLayerFrameStats, installLayerFrameCounters, type LayerFrameStats } from "./layer-frame-stats";
import { keepLayerDrawableMeshes, layerDrawableMeshWork, type LayerDrawableMeshWork } from "./layer-drawable-meshes";
import { keepLayerDrawList, layerDrawListWork, type LayerDrawListWork } from "./layer-draw-list";
import { isSceneFrameReady } from "./scene-perf";
import { PreparationTimedOut, SceneRenderCoordinator } from "./scene-render-coordinator";
import { SCENE_PREPARATION_CEILING_MS } from "./stall-deadline";
import { PostProcessRetirement } from "./post-process-retirement";
import { configureCutoutSorting } from "./sorting";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";
import { beginPremultipliedLayerContent, endPremultipliedLayerContent, setTargetedLayerScene } from "./layer-composite";
import { createDepthTextureTarget } from "./depth-texture-target";
import { isPostProcessPanelResult, POST_PROCESS_PANEL_ENTRY_ID, ScenePostProcessPanels, type PostProcessPanelView } from "./post-process-panels";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList";

/**
 * A full-screen texture without fog: the layers' shared target drawn into the passes' Scene, and the passes' output
 * blended by its alpha over the world.
 */
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

/** The Scene the Scene Layer post-processing passes run in, and the camera that views its full-screen input. */
export interface SceneLayerPostProcessView {
  scene: Scene;
  camera: Camera;
}

type AttachedLayerPostProcess = Pick<AttachedPostProcessStack, "dispose"> & Partial<Pick<AttachedPostProcessStack, "setParameter">>;

export interface SceneLayerCompositorOptions {
  engine: AbstractEngine;
  postProcessingEnabled?: () => boolean;
  isLayerReady?: (layerId: string) => boolean;
  /** Attaches the shared stack's enabled passes to the renderer of the Scene they run in. */
  attachLayerPostProcess?: (
    view: SceneLayerPostProcessView,
    stack: SceneLayerPostProcessEntry[],
    renderer: SceneRenderCoordinator,
  ) => AttachedLayerPostProcess | null;
  /** The passes' Scene, as it is built: it follows the world's settings and keeps full quality, as layer Scenes do. */
  preparePostProcessScene?: (scene: Scene) => void;
  /**
   * The output in design pixels over Pixels Per Unit, in layer units (`sceneLayerOutputDesignSize`): what Fullscreen
   * and True Pixel Size frame. Without it a layer frames its canvas widened to the output's aspect.
   */
  screen?: () => { width: number; height: number } | null;
  /** A Desired layer's view changed after its content was measured. */
  onLayerView?: (layerId: string, view: SceneLayerRect) => void;
  /** An actor slot's root in its layer's Scene, with the actor's visuals beneath it: Post Processing Panels draw them. */
  slotRoot?: (slotId: number) => AbstractMesh | null | undefined;
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
  /** The command's canvas: a Desired layer's while it draws nothing. */
  commandCanvas: SceneLayerRect;
  /** Desired only: hears the layer Scene's changes since its content was last measured. */
  contentChanges: ContentWatch | null;
  /** Null until the first bind. */
  hudPose: HudCameraPose | null;
  renderer: SceneRenderCoordinator;
  /**
   * While the Scene Layer post-processing has passes: this layer's Scene's view of the shared target (its colour and
   * depth textures), the camera's output. Null while layers draw straight over the world.
   */
  view: RenderTargetTexture | null;
  retirements: PostProcessRetirement;
  /** Cached strict layer readiness; invalidated by renderer dirtiness/rebuild. */
  probedReady: boolean;
  /** Play Camera Shake On Scene Layer: created with the layer's first shake. */
  shake: CameraShakeView | null;
  /** Its Post Processing Panels: created with the first list the runtime sends for it; null costs nothing. */
  panels: ScenePostProcessPanels | null;
};

/**
 * The Scene Layer post-processing while it has enabled passes: one transparent target at the output's size that every
 * layer draws into, in draw order, and a Scene that draws it full screen through the passes into `output`, which a blit
 * blends over the world. One target and one pass chain whatever the number of layers.
 */
type LayerStack = {
  width: number;
  height: number;
  /** Owns the shared target, its full-screen plane, the passes' camera and their output. */
  scene: Scene;
  camera: UniversalCamera;
  /** Colour (alpha kept) and a depth texture; each layer's `view` wraps the same two textures. */
  target: RenderTargetTexture;
  /** Colour only: the passes' chain draws through its own scene targets and copies its result here. */
  output: RenderTargetTexture;
  renderer: SceneRenderCoordinator;
  attached: AttachedLayerPostProcess | null;
  /** Blends `output` over the world. */
  blitScene: Scene;
  blitReady: boolean;
  /** Cached strict readiness of the passes' renderer; invalidated by its dirtiness or replacement. */
  probedReady: boolean;
  /** `output` holds a composite drawn over the world: a frame that cannot draw a new one shows it again. */
  presented: boolean;
  /** Renderers this stack replaced (a pass list change), released before its Scene. */
  retirements: PostProcessRetirement;
};

/**
 * Play-only overlay stack: extra unlit orthographic Scenes on the shared
 * Engine, drawn after the world camera (and its post-process). The Scene
 * Layer post-processing (`setPostProcess`) applies to all layers combined.
 */
export class SceneLayerCompositor {
  private readonly engine: AbstractEngine;
  private readonly isLayerReady: (layerId: string) => boolean;
  private readonly postProcessingEnabled: () => boolean;
  private readonly attachLayerPostProcess?: SceneLayerCompositorOptions["attachLayerPostProcess"];
  private readonly preparePostProcessScene?: SceneLayerCompositorOptions["preparePostProcessScene"];
  private readonly screen: () => { width: number; height: number } | null;
  private readonly onLayerView?: SceneLayerCompositorOptions["onLayerView"];
  private readonly slotRoot: (slotId: number) => AbstractMesh | null | undefined;
  private readonly byId = new Map<string, LayerRecord>();
  private readonly slotLayer = new Map<number, string>();
  private readonly slotActor = new Map<number, string>();
  private readonly retiredLayers = new PostProcessRetirement();
  /** Every Scene this compositor built and has not yet disposed: layers, the passes' and blit Scenes, and retired generations still releasing. */
  private readonly ownedSceneSet = new Set<Scene>();
  /** Draw order, rebuilt only when layers are created or removed. */
  private sortedCache: LayerRecord[] | null = null;
  private outputWidth = 0;
  private outputHeight = 0;
  /** The Scene Layer post-processing every layer shares, as the runtime last sent it. */
  private postProcessStack: SceneLayerPostProcessEntry[] = [];
  /** Live Material parameter writes on its passes, replayed when the passes are attached again. */
  private readonly parameters = new PostProcessParameterState();
  /** Null while the stack has no enabled pass (or post-processing is off): layers then draw straight over the world. */
  private stack: LayerStack | null = null;
  /**
   * The last composite of a stack that was replaced (a resize) or ended, shown in place of the layers while their new
   * renderers prepare, until a frame presents without it.
   */
  private held: { scene: Scene; release(): void } | null = null;
  private heldDrawn = false;
  /**
   * The current frame's layer work (`LayerFrameStats`): `beforeWorld` rewrites its `beforeWorld` part and `render` the
   * rest, so after both it describes the frame they drew.
   */
  readonly frameStats: LayerFrameStats = emptyLayerFrameStats();

  constructor(options: SceneLayerCompositorOptions) {
    this.engine = options.engine;
    this.isLayerReady = options.isLayerReady ?? (() => true);
    this.postProcessingEnabled = options.postProcessingEnabled ?? (() => true);
    this.attachLayerPostProcess = options.attachLayerPostProcess;
    this.preparePostProcessScene = options.preparePostProcessScene;
    this.screen = options.screen ?? (() => null);
    this.onLayerView = options.onLayerView;
    this.slotRoot = options.slotRoot ?? (() => null);
    installLayerFrameCounters(this.engine);
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
    // Babylon's per-frame mesh loop, cull, list preparation and sorts see only what the batcher draws; the objects pass
    // draws a retained list kept from what changed (`layer-draw-list.ts`).
    keepLayerDrawList(scene);
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
      design: normalizeSceneLayerCanvasDesign(command.canvas.design),
      canvas: commandCanvas(command),
      commandCanvas: commandCanvas(command),
      contentChanges: null,
      viewBounds: { width: 1, height: 1, center: [0, 0] },
      cameraState: { ...(command.camera ?? DEFAULT_LAYER_CAMERA_STATE) },
      hudPose: null,
      view: null,
      shake: null,
      panels: null,
      retirements: new PostProcessRetirement(),
      probedReady: false,
    };
    layer.viewBounds = this.layerView(layer);
    if (layer.design.sizeMode === "desired") layer.contentChanges = watchContent(scene);
    this.bindHudCamera(layer);
    this.byId.set(command.layerId, layer);
    this.sortedCache = null;
    if (this.stack) this.bindStackView(layer, this.stack);
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
    layer.panels?.release();
    layer.panels = null;
    layer.contentChanges?.release();
    layer.contentChanges = null;
    this.retireLayerRenderer(layer);
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

  /**
   * The Scene Layer post-processing every layer shares (`sceneLayerPostProcess`). With enabled passes all layers draw
   * into one transparent target that the passes run over before it is blended over the world; without any, layers
   * draw straight over the world. Kept across layer creation and removal.
   */
  setPostProcess(stack: readonly SceneLayerPostProcessEntry[]): void {
    this.postProcessStack = stack.map((entry) => ({ ...entry }));
    this.rebuildStack();
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

  /**
   * A live Material parameter write on one of the shared stack's passes: kept for that pass whether or not it is
   * enabled now, and applied to the attached passes without rebuilding them.
   */
  setPostProcessParameter(entryId: string, materialGuid: string, name: string, value: MaterialParameterValue, validate: () => boolean): boolean {
    if (!this.postProcessStack.some((entry) => entry.id === entryId && entry.materialGuid === materialGuid) || !validate() ||
      !this.parameters.set(this.postProcessStack, entryId, materialGuid, name, value)) return false;
    this.stack?.attached?.setParameter?.(entryId, name, value);
    return true;
  }

  /** Post-processing was switched on or off (`postprocessing`): the stack runs again, or layers draw straight over the world. */
  refreshPostProcess(): void {
    this.rebuildStack();
  }

  /**
   * A layer's Post Processing Panels (`sceneLayerPostProcessPanels`): each enabled panel with a Material draws its
   * content through its Material at its place in the layer (`ScenePostProcessPanels`). An empty list ends them all.
   */
  setPostProcessPanels(layerId: string, panels: readonly SceneLayerPostProcessPanelPayload[]): void {
    const layer = this.byId.get(layerId);
    if (!layer) return;
    if (!layer.panels && panels.length === 0) return;
    layer.panels ??= new ScenePostProcessPanels(layer.scene, {
      slotRoot: (slotId) => this.slotLayer.get(slotId) === layerId ? this.slotRoot(slotId) : null,
      createView: (camera, objects, stack) => this.panelView(layer, camera, objects, stack),
    });
    layer.panels.set(panels);
  }

  /**
   * A live parameter write on a Post Processing Panel's Material Object (`setMaterialParameter` for its slot and
   * component): false when the slot holds no such panel with that Material, so the write is a surface's.
   */
  setPostProcessPanelParameter(slotId: number, componentId: string | undefined, materialGuid: string, name: string, value: MaterialParameterValue, validate: () => boolean): boolean {
    const layerId = this.slotLayer.get(slotId);
    const panels = layerId ? this.byId.get(layerId)?.panels : null;
    if (!panels?.holds(slotId, componentId, materialGuid)) return false;
    // A write the Material does not accept is dropped, never handed to a surface.
    return !validate() || panels.setParameter(slotId, componentId, materialGuid, name, value);
  }

  /**
   * A panel's view: an auxiliary view of the layer's Scene that draws the panel's content with its camera, inside the
   * layer's own frame, through the panel's one pass into its output. Its renderer is retired with the layer's.
   */
  private panelView(layer: LayerRecord, camera: TargetCamera, objects: FrameGraphObjectList, stack: SceneLayerPostProcessEntry[]): PostProcessPanelView {
    const renderer = new SceneRenderCoordinator(layer.scene, { waterPlanarReflections: false, auxiliary: { camera, objects, screenEffects: true } });
    let attached: AttachedLayerPostProcess | null = null;
    try {
      attached = this.attachLayerPostProcess?.({ scene: layer.scene, camera }, stack, renderer) ?? null;
    } catch (error) {
      renderer.dispose();
      throw error;
    }
    if (!attached) {
      renderer.dispose();
      throw new Error("its Material cannot run as a pass here");
    }
    return {
      render: () => renderer.render(false).rendered,
      setParameter: (name, value) => { attached?.setParameter?.(POST_PROCESS_PANEL_ENTRY_ID, name, value); },
      retire: () => {
        const retired = new PostProcessRetirement();
        this.retireRenderer(renderer, attached, retired, `Post Processing Panel of SceneLayer ${layer.layerId}`);
        layer.retirements.add({ whenDisposed: () => retired.whenDisposed(), whenReleased: () => retired.whenReleased() });
        return retired.whenReleased();
      },
    };
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
   * batcher kept its work (`sceneDrawBatchWork`), how its drawable mesh list was kept (`layerDrawableMeshWork`) and how
   * its retained draw list was kept and checked (`layerDrawListWork`). Reading starts the measuring, as a view's own does.
   */
  diagnostics(): Array<{
    layerId: string; meshes: number; work: ReturnType<SceneRenderCoordinator["diagnostics"]>; batching: OverlayBatchWork | null;
    drawable: LayerDrawableMeshWork | null; drawList: LayerDrawListWork | null;
  }> {
    return this.orderedLayers().map((layer) => ({
      layerId: layer.layerId, meshes: layer.scene.meshes.length, work: layer.renderer.diagnostics(), batching: sceneDrawBatchWork(layer.scene),
      drawable: layerDrawableMeshWork(layer.scene), drawList: layerDrawListWork(layer.scene),
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
      const previous = layer.viewBounds;
      layer.viewBounds = this.layerView(layer);
      this.bindHudCamera(layer, true);
      // The runtime frames a Desired layer by its reported view, which a new screen can change.
      if (layer.contentChanges && !sameRect(previous, layer.viewBounds)) this.onLayerView?.(layer.layerId, layer.viewBounds);
    }
    // The shared target keeps the output's device pixels.
    if (this.stack && (this.stack.width !== width || this.stack.height !== height)) this.rebuildStack();
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
    // Without anything drawn it is the command's (Fullscreen) canvas.
    const canvas: SceneLayerRect = bounds ? {
      width: Math.max(bounds.maxX - bounds.minX, 1e-3),
      height: Math.max(bounds.maxY - bounds.minY, 1e-3),
      center: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2],
    } : layer.commandCanvas;
    if (sameRect(canvas, layer.canvas)) return;
    layer.canvas = canvas;
    layer.viewBounds = this.layerView(layer);
    this.bindHudCamera(layer, true);
    this.onLayerView?.(layer.layerId, layer.viewBounds);
  }

  /** Restarts every layer's preparation, and the passes', and clears what they latched (a restored graphics context). */
  invalidate(): void {
    for (const layer of this.byId.values()) {
      layer.renderer.invalidate();
      layer.probedReady = false;
      // Their views are built again with the next frame.
      layer.panels?.invalidate();
    }
    if (this.stack) {
      this.stack.renderer.invalidate();
      this.stack.probedReady = false;
    }
  }

  retainResources(): () => void {
    const releases = [...this.byId.values()].map((layer) => layer.renderer.retainResources());
    if (this.stack) releases.push(this.stack.renderer.retainResources());
    return () => { for (const release of releases) release(); };
  }

  /**
   * Prepares the layer's current renderer, then the shared post-processing passes' while there are any. A
   * post-process rebuild, resize or re-create during the wait replaces either, and preparation follows the
   * replacement; a removed layer has nothing left to prepare. The caller's `assertCurrent` cancels, and an error of a
   * renderer that is still current (a timeout, a missing camera) rejects. Each replacement brings fresh bounds, so
   * following one more starts no later than `SCENE_PREPARATION_CEILING_MS` after the first pass began.
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
      const stack = this.stack;
      const passes = stack?.renderer;
      const current = () => this.byId.get(layerId) === layer && layer.renderer === renderer &&
        this.stack === stack && stack?.renderer === passes;
      try {
        await renderer.prepare(assertCurrent);
        assertCurrent();
        if (passes && current()) await passes.prepare(assertCurrent);
      } catch (error) {
        assertCurrent();
        if (!current()) continue;
        throw error;
      }
      assertCurrent();
      if (current()) return;
    }
  }

  /**
   * The layers' work that changes the bound framebuffer or uploads textures, done before the world draws so none of it
   * falls inside the backbuffer's pass after the world's output: each layer that may draw this frame (ready, or
   * presenting) copies the images its shared page was asked for into their cells and uploads its written glyph pages.
   * Both are what the layer Scene's before-render work does first, which then finds nothing left; what a layer draws
   * does not change, since only its own draws sample its pages. Post Processing Panel views and the shared stack's
   * target stay in the layer pass: they draw the layer Scene's content, which its own frame steps first.
   */
  beforeWorld(presentingLayers: ReadonlySet<string> = new Set()): void {
    const counts = this.frameStats.beforeWorld;
    const start = performance.now();
    counts.uploads = 0;
    counts.targetSwitches = 0;
    countLayerPhase(this.engine, counts, () => {
      for (const record of this.orderedLayers()) {
        if (!this.isLayerReady(record.layerId) && !presentingLayers.has(record.layerId)) continue;
        flushSceneImagePages(record.scene);
        uploadSceneGlyphPages(record.scene);
      }
    });
    counts.ms = performance.now() - start;
  }

  render(presentingLayers: ReadonlySet<string> = new Set(), draw: (layerId: string, render: () => boolean, fallback: () => void) => void = (_id, render) => render()): void {
    const stats = this.frameStats;
    const start = performance.now();
    stats.scenes = 0;
    stats.batchMs = 0;
    stats.clears = 0;
    stats.depthClears = 0;
    stats.targetSwitches = 0;
    stats.uploads = 0;
    countLayerPhase(this.engine, stats, () => {
      this.resize();
      this.heldDrawn = false;
      // With no layer left, an ended stack's last composite has nothing to stand in for.
      if (this.byId.size === 0) this.releaseHeld();
      if (this.stack) this.renderThroughStack(this.stack, presentingLayers, draw);
      else this.renderDirect(presentingLayers, draw);
    });
    stats.ms = performance.now() - start;
  }

  /** No passes: each layer draws straight over the world, clearing only depth and stencil. */
  private renderDirect(presentingLayers: ReadonlySet<string>, draw: (layerId: string, render: () => boolean, fallback: () => void) => void): void {
    let drawn = 0;
    let presentable = 0;
    for (const record of this.orderedLayers()) {
      if (!this.isLayerReady(record.layerId) && !presentingLayers.has(record.layerId)) continue;
      this.measureContent(record);
      this.bindHudCamera(record);
      drawn += 1;
      draw(record.layerId, () => {
        record.scene.autoClear = false;
        record.scene.autoClearDepthAndStencil = this.depthClears;
        const result = this.renderLayer(record);
        if (!result.rendered) {
          this.drawHeld();
          return false;
        }
        if (result.readyForPresentation) presentable += 1;
        return result.readyForPresentation;
      }, () => { this.drawHeld(); });
    }
    // The ended stack's last composite stands in until every layer presents without it.
    if (this.held && drawn > 0 && presentable === drawn) this.releaseHeld();
  }

  /**
   * Passes: the layers draw into the shared transparent target in draw order (the first one drawn clears it), the
   * passes run over it, and the result is blended over the world. A layer that cannot draw shows the last composite
   * instead, so no layer drops out of a frame; one that is not presenting yet (`fallback`) is left out until it is.
   */
  private renderThroughStack(stack: LayerStack, presentingLayers: ReadonlySet<string>, draw: (layerId: string, render: () => boolean, fallback: () => void) => void): void {
    let attempted = false;
    let cleared = false;
    let failed = false;
    let passesReady = false;
    try { passesReady = this.stackReady(stack); } catch { passesReady = false; }
    for (const record of this.orderedLayers()) {
      if (!this.isLayerReady(record.layerId) && !presentingLayers.has(record.layerId)) continue;
      this.measureContent(record);
      this.bindHudCamera(record);
      attempted = true;
      draw(record.layerId, () => {
        record.scene.autoClear = !cleared;
        record.scene.autoClearDepthAndStencil = !cleared || this.depthClears;
        // The shared target holds premultiplied colour and coverage, which the blit composites as such.
        beginPremultipliedLayerContent(this.engine);
        let result: ReturnType<SceneRenderCoordinator["render"]>;
        try { result = this.renderLayer(record); } finally { endPremultipliedLayerContent(this.engine); }
        if (!result.rendered) {
          failed = true;
          return false;
        }
        cleared = true;
        return result.readyForPresentation && passesReady;
      }, () => {});
    }
    if (!attempted) return;
    if (!cleared || failed) {
      this.drawStackHeld(stack);
      return;
    }
    stack.scene.autoClear = true;
    stack.scene.autoClearDepthAndStencil = true;
    const capture = activeRenderFrameCapture(this.engine);
    const result = capture
      ? capture.stage(stack.scene, { name: "SceneLayer post-processing", kind: "composition" }, () => stack.renderer.render())
      : stack.renderer.render();
    if (!stack.blitReady) stack.blitReady = isSceneFrameReady(stack.blitScene);
    if (!result.rendered || !stack.blitReady) {
      this.drawStackHeld(stack);
      return;
    }
    this.blitStack(stack, false);
    stack.presented = true;
    if (result.readyForPresentation) this.releaseHeld();
  }

  private renderLayer(record: LayerRecord): ReturnType<SceneRenderCoordinator["render"]> {
    // Its panels frame themselves with the camera as bound for this frame, before the layer's cull reads the masks.
    record.panels?.beforeRender(record.camera, this.outputWidth, this.outputHeight, this.postProcessingEnabled());
    this.frameStats.scenes += 1;
    const frameCapture = activeRenderFrameCapture(this.engine);
    return frameCapture
      ? frameCapture.stage(record.scene, { name: "SceneLayer scene output", kind: "composition", sceneId: record.layerId },
        () => record.renderer.render())
      : record.renderer.render();
  }

  isReady(layerId?: string): boolean {
    if (layerId && !this.byId.has(layerId)) return false;
    let checked = false;
    for (const record of this.byId.values()) {
      if (layerId ? record.layerId !== layerId : !this.isLayerReady(record.layerId)) continue;
      checked = true;
      // Strict probes are cached per layer; the renderer's dirty flag re-opens
      // them after scene or rendering-definition changes.
      if (record.probedReady && !record.renderer.readinessDirty) continue;
      const ready = record.renderer.isReady();
      record.probedReady = ready;
      if (!ready) return false;
    }
    // A layer reaches the screen only through the passes while there are any.
    return !checked || !this.stack || this.stackReady(this.stack);
  }

  /** The passes' renderer is strictly ready and the blit can draw its output. Cached until either changes. */
  private stackReady(stack: LayerStack): boolean {
    if (stack.probedReady && !stack.renderer.readinessDirty) return true;
    const ready = stack.renderer.isReady() &&
      (stack.blitReady || (stack.blitReady = isSceneFrameReady(stack.blitScene)));
    stack.probedReady = ready;
    return ready;
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
      const panels = layer.panels;
      // Content a Post Processing Panel draws is hit only where it shows: inside the panel's rectangle.
      const panelAllows = (mesh: AbstractMesh) => !panels ||
        panels.allowsPick(mesh, canvasX * this.outputWidth / pickSize.width, canvasY * this.outputHeight / pickSize.height, this.outputHeight);
      const pickable = (mesh: AbstractMesh) => mesh.isEnabled() && mesh.isVisible && mesh.isPickable && overlayClipAllowsPoint(mesh, pickWorld.x, pickWorld.y) &&
        panelAllows(mesh);
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

  /**
   * Test builds: points in pick space (as `pickHits` takes them) over every enabled, visible, pickable mesh of a ready
   * layer that takes pointer input (a button, a joystick or a form control part): its projected bounds' centre and four
   * points halfway to its corners.
   */
  hitTargets(): Array<{ layerId: string; mesh: string; x: number; y: number }> {
    const points: Array<{ layerId: string; mesh: string; x: number; y: number }> = [];
    for (const layer of this.orderedLayers()) {
      if (!this.isLayerReady(layer.layerId)) continue;
      this.bindHudCamera(layer);
      const size = pickBufferSize(layer.scene);
      const viewport = new Viewport(0, 0, size.width, size.height);
      const transform = layer.camera.getViewMatrix().multiply(layer.camera.getProjectionMatrix());
      for (const mesh of layer.scene.meshes) {
        if (!mesh.isEnabled() || !mesh.isVisible || !mesh.isPickable || !isOverlayTouchTarget(overlayMetadataOf(mesh))) continue;
        const box = mesh.getBoundingInfo().boundingBox;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const corner of box.vectorsWorld) {
          const projected = Vector3.Project(corner, Matrix.IdentityReadOnly, transform, viewport);
          minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
          minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
        }
        if (!Number.isFinite(minX + minY + maxX + maxY)) continue;
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, hx = (maxX - minX) / 4, hy = (maxY - minY) / 4;
        for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
          points.push({ layerId: layer.layerId, mesh: mesh.name, x: cx + dx * hx, y: cy + dy * hy });
      }
    }
    return points;
  }

  dispose(): Promise<void> {
    this.clear();
    if (this.stack) this.retireStack(this.stack, false);
    this.stack = null;
    this.releaseHeld();
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

  /**
   * Applies the shared stack as it is now. No enabled pass (or post-processing off): layers draw straight over the
   * world. Passes at the same output size: only the passes' renderer is replaced, and the layers keep drawing into the
   * same target. Otherwise a new target replaces the old one and every layer's renderer follows it; the old composite
   * stays on screen (`held`) while they prepare.
   */
  private rebuildStack(): void {
    const enabled = this.parameters.effective(this.postProcessStack).filter((entry) => entry.enabled);
    const current = this.stack;
    if (!this.postProcessingEnabled() || enabled.length === 0) {
      if (!current) return;
      this.stack = null;
      this.retireStack(current, true);
      for (const layer of this.byId.values()) this.replaceLayerRenderer(layer, null);
      return;
    }
    const width = Math.max(1, this.engine.getRenderWidth(true));
    const height = Math.max(1, this.engine.getRenderHeight(true));
    if (current && current.width === width && current.height === height) {
      this.attachPasses(current, enabled, true);
      return;
    }
    const next = this.buildStack(width, height);
    this.stack = next;
    if (current) this.retireStack(current, true);
    this.attachPasses(next, enabled, false);
    for (const layer of this.byId.values()) this.replaceLayerRenderer(layer, next);
  }

  /** The shared target, the Scene that draws it full screen through the passes, and the blit over the world. */
  private buildStack(width: number, height: number): LayerStack {
    const scene = this.ownScene(new Scene(this.engine));
    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;
    scene.clearColor = new Color4(0, 0, 0, 0);
    scene.skipPointerMovePicking = true;
    scene.lightsEnabled = false;
    this.preparePostProcessScene?.(scene);
    const camera = fullScreenCamera("sceneLayerPostProcessCamera", scene);
    // Every layer draws here through its own view, with depth cleared before each layer as over the world. A layer's
    // graph needs a depth texture to draw into a target directly; without one it would copy over the others.
    const target = createDepthTextureTarget("sceneLayerTarget", { width, height }, scene);
    // Transparent where no layer drew: the unlit Material reads a texture's alpha only when the texture advertises it.
    target.hasAlpha = true;
    const input = MeshBuilder.CreatePlane("sceneLayerPostProcessInput", { size: 2 }, scene);
    const copy = setUnlitMaterial(input, SCENE_LAYER_BLIT, {
      texture: target, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: true, textureAlpha: true, twoSided: false,
    });
    // Over the passes' transparent clear, premultiplied blending (one, one minus source alpha) writes the layers'
    // colour and alpha unchanged, so the passes see exactly what the layers drew. Only this Scene uses this instance.
    copy.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    // Colour only: the passes' graph draws through its chain's scene colour and depth and copies its result here.
    const output = new RenderTargetTexture("sceneLayerPostProcessOutput", { width, height }, scene, {
      generateMipMaps: false, generateDepthBuffer: false,
    });
    output.hasAlpha = true;
    camera.outputRenderTarget = output;
    return {
      width, height, scene, camera, target, output,
      renderer: new SceneRenderCoordinator(scene),
      attached: null,
      blitScene: this.createBlitScene(output),
      blitReady: false,
      probedReady: false,
      presented: false,
      retirements: new PostProcessRetirement(),
    };
  }

  /**
   * Attaches the enabled passes to the stack's renderer; `replace` first retires the renderer holding the previous
   * passes and makes a fresh one. Until the new one draws, `output` keeps the last composite, which frames show again.
   */
  private attachPasses(stack: LayerStack, enabled: SceneLayerPostProcessEntry[], replace: boolean): void {
    if (replace) {
      this.retireRenderer(stack.renderer, stack.attached, stack.retirements, "Scene Layer post-processing");
      stack.renderer = new SceneRenderCoordinator(stack.scene);
    }
    stack.probedReady = false;
    stack.attached = this.attachLayerPostProcess?.({ scene: stack.scene, camera: stack.camera }, enabled, stack.renderer) ?? null;
  }

  /**
   * Ends a stack: its passes' renderer and those it replaced are released before its Scenes (the shared target, the
   * input plane, the output and the blit). Each layer's view holds the target's textures until that layer's own
   * renderer released them. `keepPresented` keeps its last composite on screen as `held` until a frame presents
   * without it.
   */
  private retireStack(stack: LayerStack, keepPresented: boolean): void {
    let heldReleased = Promise.resolve();
    if (keepPresented && stack.presented) {
      this.releaseHeld();
      heldReleased = new Promise<void>((release) => { this.held = { scene: stack.blitScene, release }; });
    }
    this.retireRenderer(stack.renderer, stack.attached, stack.retirements, "Scene Layer post-processing");
    stack.attached = null;
    stack.camera.outputRenderTarget = null;
    const reported = stack.retirements.whenDisposed();
    const released = (async () => {
      await stack.retirements.whenReleased();
      await heldReleased;
      stack.blitScene.dispose();
      stack.scene.dispose();
    })();
    this.retiredLayers.add({ whenDisposed: () => reported, whenReleased: () => released });
    void released.catch((error: unknown) => {
      console.warn(`[render] Scene Layer post-processing target is quarantined until actual release: ${String(error)}`);
    });
  }

  /** Retires `renderer` and the passes attached to it into `retirements`: bounded cleanup reports apart from actual release. */
  private retireRenderer(renderer: SceneRenderCoordinator, attached: AttachedLayerPostProcess | null, retirements: PostProcessRetirement, owner: string): void {
    const reports: Promise<void>[] = [];
    try { attached?.dispose(); } catch (error) { reports.push(Promise.reject(error)); }
    try { reports.push(renderer.retire()); } catch (error) { reports.push(Promise.reject(error)); }
    // Bounded cleanup reporting stays separate from confirmed actual release:
    // an uncertain report never proves the target stopped being used.
    const reported = Promise.all(reports).then(
      () => {},
      (error: unknown) => {
        throw new Error(`${owner} retirement failed`, { cause: error });
      },
    );
    const released = renderer.whenReleased();
    retirements.add({ whenDisposed: () => reported, whenReleased: () => released });
    void reported.catch((error: unknown) => {
      console.warn(`[render] ${owner} cleanup report is uncertain: ${String(error)}`);
    });
  }

  /**
   * A layer's output follows the stack: a fresh renderer draws into the new target's view (or straight over the world),
   * and the old renderer and view are released once that renderer has released them.
   */
  private replaceLayerRenderer(layer: LayerRecord, stack: LayerStack | null): void {
    this.retireLayerRenderer(layer);
    layer.renderer = layerRenderer(layer.scene);
    if (stack) this.bindStackView(layer, stack);
    else {
      layer.scene.autoClear = false;
      layer.scene.autoClearDepthAndStencil = true;
      // Straight over the world again: its Multiply visuals multiply by their colour (`layerMultiplyAlphaMode`).
      setTargetedLayerScene(layer.scene, false);
    }
  }

  private retireLayerRenderer(layer: LayerRecord): void {
    const renderer = layer.renderer;
    const view = layer.view;
    layer.view = null;
    layer.camera.outputRenderTarget = null;
    layer.probedReady = false;
    const retired = new PostProcessRetirement();
    this.retireRenderer(renderer, null, retired, `SceneLayer ${layer.layerId}`);
    const released = (async () => {
      await retired.whenReleased();
      view?.dispose();
    })();
    layer.retirements.add({ whenDisposed: () => retired.whenDisposed(), whenReleased: () => released });
    void released.catch((error: unknown) => {
      console.warn(`[render] SceneLayer ${layer.layerId} target is quarantined until actual release: ${String(error)}`);
    });
  }

  /**
   * The layer's Scene draws into the shared target through a view of its own Scene (a renderer's output belongs to
   * its Scene): the same colour and depth textures, each referenced once more so the view's disposal releases only
   * its own reference.
   */
  private bindStackView(layer: LayerRecord, stack: LayerStack): void {
    const color = stack.target.getInternalTexture();
    const depth = stack.target.depthStencilTexture;
    if (!color) return;
    const view = new RenderTargetTexture(`sceneLayerView:${layer.layerId}`, { width: stack.width, height: stack.height }, layer.scene, {
      generateMipMaps: false, generateDepthBuffer: false, colorAttachment: color,
    });
    color.incrementReferences();
    if (depth && view.renderTarget) {
      view.renderTarget.setDepthStencilTexture(depth, false);
      depth.incrementReferences();
    }
    view.hasAlpha = true;
    layer.view = view;
    layer.camera.outputRenderTarget = view;
    // Before any of its Multiply visuals draws: they darken the shared target by their grey from now on.
    setTargetedLayerScene(layer.scene, true);
  }

  private createBlitScene(texture: RenderTargetTexture): Scene {
    const blitScene = this.ownScene(new Scene(this.engine));
    blitScene.autoClear = false;
    blitScene.autoClearDepthAndStencil = false;
    blitScene.skipPointerMovePicking = true;
    blitScene.lightsEnabled = false;
    fullScreenCamera("sceneLayerBlitCamera", blitScene);
    const plane = MeshBuilder.CreatePlane("sceneLayerBlitPlane", { size: 2 }, blitScene);
    // The passes' premultiplied colour over the world, which shows through by one minus its coverage. The held
    // composite redraws this Scene, so it composites the same way. Only this Scene uses this instance.
    const blit = setUnlitMaterial(plane, SCENE_LAYER_BLIT, {
      texture, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: true, textureAlpha: true, twoSided: false,
    });
    blit.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    return blitScene;
  }

  /** Blends the stack's output over the world: this frame's composite, or (`held`) the last one again. */
  private blitStack(stack: LayerStack, held: boolean): void {
    const capture = activeRenderFrameCapture(this.engine);
    if (capture) capture.stage(stack.blitScene, held
      ? { name: "SceneLayer held output", kind: "composition", detail: "Previously coherent Scene Layer output; no new composite was produced." }
      : { name: "SceneLayer output composition", kind: "composition" }, () => stack.blitScene.render());
    else stack.blitScene.render();
  }

  /** No new composite this frame: the stack's last one, else the one an ended stack left. */
  private drawStackHeld(stack: LayerStack): void {
    if (stack.presented && stack.blitReady) this.blitStack(stack, true);
    else this.drawHeld();
  }

  /** An ended stack's last composite, at most once a frame. */
  private drawHeld(): void {
    const held = this.held;
    if (!held || this.heldDrawn || held.scene.isDisposed || !isSceneFrameReady(held.scene)) return;
    this.heldDrawn = true;
    const capture = activeRenderFrameCapture(this.engine);
    if (capture) capture.stage(held.scene, { name: "SceneLayer held output", kind: "composition",
      detail: "Previously coherent Scene Layer output; no new layer frame was produced." }, () => held.scene.render());
    else held.scene.render();
  }

  private releaseHeld(): void {
    this.held?.release();
    this.held = null;
  }
}

/** An orthographic camera framing a 2 × 2 plane at the origin: a full-screen draw. */
function fullScreenCamera(name: string, scene: Scene): UniversalCamera {
  const camera = new UniversalCamera(name, new Vector3(0, 0, -1), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -1;
  camera.orthoRight = 1;
  camera.orthoTop = 1;
  camera.orthoBottom = -1;
  scene.activeCamera = camera;
  return camera;
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

/** The sceneLayerCreate command's canvas; a degenerate one is 1 × 1 at its centre. */
function commandCanvas(command: SceneLayerCreateCommand): SceneLayerRect {
  const { rect } = command.canvas;
  return {
    width: rect.width > 0 ? rect.width : 1,
    height: rect.height > 0 ? rect.height : 1,
    center: [rect.center[0], rect.center[1]],
  };
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
 * `visualBounds2D` measures visuals, less `showcollision` collider outlines (draw batches are not in `scene.meshes`).
 * Null without any.
 */
export function sceneLayerContentBounds(scene: Scene, computeMatrices = false): SceneLayerContentBounds | null {
  let bounds: SceneLayerContentBounds | null = null;
  for (const mesh of scene.meshes) {
    if (!mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0 || isColliderVisualMesh(mesh) ||
      isPostProcessPanelResult(mesh)) continue;
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
