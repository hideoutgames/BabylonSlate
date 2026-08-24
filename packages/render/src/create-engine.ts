import {
  Engine,
  KhronosTextureContainer2,
  Mesh,
  Scene,
  ScenePerformancePriority,
} from "@babylonjs/core";
import type { AudioProjectSettings, SerializedScene, ViewportMode } from "@babylonslate/core";
import { createDefaultScene, engineCommandBus } from "@babylonslate/core";
import type { SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import {
  isPublishedSnapshot,
  readSnapshotHeader,
  type CommandMessage,
} from "@babylonslate/bridge";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import {
  createEditorCamera,
  type EditorCameraController,
} from "./editor-camera";
import {
  viewCenterWorldPosition,
  worldPositionFromCanvas,
} from "./editor-place";
import { createEditorGrid, type EditorGrid } from "./editor-grid";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  ViewportShadingOverlay,
  type ViewportShadingMode,
} from "./viewport-shading-mode";
import { createGizmoHost, type GizmoHost } from "./gizmo-host";
import {
  applyGizmoMultiSelectDrag,
  beginGizmoMultiSelectDrag,
  pickGizmoAttachActorId,
  readMeshLocalTransform,
  selectionGizmoRoots,
  type GizmoMultiSelectDrag,
} from "./gizmo-multi-select";
import { SelectionOutline } from "./selection-outline";
import { attachViewportGestures } from "./viewport-gestures";
import { attachViewportFlyKeys, DEFAULT_FLY_SPEED } from "./viewport-fly-keys";
import { configureKtx2Transcoder } from "./ktx2-transcoder";
import {
  documentEditorColorScheme,
  editorClearColor,
  sceneClearColor,
  type EditorColorScheme,
} from "./editor-clear-color";
import { applySceneToBabylonScene, unfreezeActorWorldMatrix, freezeStaticActorWorldMatrix } from "./scene-loader";
import { isEditorModelPlaceholder } from "./glb-anim";
import { snapCanvasDrawingBuffer } from "./canvas-drawing-buffer";
import { isSkyboxMesh } from "./skybox";
import {
  applySceneEnvironment as applySerializedSceneEnvironment,
  refreshAuthoredCameraLenses,
  syncAuthoredCamerasFromMeshes,
} from "./scene-illumination";
import { setupDefaultViewport } from "./viewport";
import { RenderScheduler } from "./render-scheduler";
import {
  getMaterialTexture,
  releaseResourceCacheForEngine,
  resourceCacheForEngine,
  type ResourceCache,
} from "./resource-cache";
import { HardwareScalingController } from "./hardware-scaling";
import { applyPlayConsoleRenderCommand } from "./play-console-apply";
import {
  applyPlayFreeCamCommand,
  attachPlayFreeCamInput,
  createPlayFreeCamController,
  disablePlayFreeCam,
  type PlayFreeCamController,
  type PlayFreeCamInputHandle,
} from "./play-free-cam";
import {
  createPlayConsoleViz,
  type PlayConsoleVizController,
} from "./play-console-viz";
import type { NavDebugBlockerPose } from "./nav-debug-overlay";
import {
  createPlayDebugDraw,
  type PlayDebugDrawController,
} from "./play-debug-draw";
import { SnapshotInterpolator, writeSampledAudioPoses, type SampledAudioPose } from "./snapshot-sync";
import {
  applySnapshotToScene,
  applyAssignMaterial,
  applyAssignMesh,
  applyPossessCamera,
  applyShadowQuality,
  assignedMaterialGuids as listAssignedMaterialGuids,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  type SnapshotSceneBinding,
} from "./snapshot-apply";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";
import { pickAtCanvas } from "./picking";
import { mapCanvasPointer } from "./pick-coords";
import { meshNamesInCanvasRect } from "./two-d";
import { applyPixelArtSamplingToScene } from "./pixel-perfect";
import { EditorDebugOverlay } from "./editor-debug-overlay";
import { beginEngineDrawCallFrame, readEngineDrawCalls } from "./draw-calls";
import {
  MaterialLibrary,
  materialUnavailable,
} from "./material-library";
import {
  attachPostProcessStack,
  normalizePostProcessStack,
  probePostProcessDeviceBuffers,
  type AttachedPostProcessStack,
  type PostProcessStackDiagnostic,
  type PostProcessStackInput,
} from "./post-process-material";
import type { AudioLibrary } from "./audio-service";
import { AudioService } from "./audio-service";
import type { ParticleLibrary } from "./particle-service";
import { ParticleService } from "./particle-service";
import { WidgetGuiService, type WidgetGuiEvent } from "./widget-gui-service";
import type { AudioPlaybackBackend } from "./audio-playback-backend";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { BabylonAudioPlaybackBackend } from "./babylon-audio-backend";
import { createRttCanvasPresent } from "./rtt-canvas-present";
import { configureEditorRenderingGroups } from "./sorting";
import {
  applyEditorMaterialFreeze,
  prewarmSceneMaterials as warmSceneMaterials,
  SCENE_LOOKUP_MAPS,
} from "./scene-perf";

export interface EngineHandle {
  engine: Engine;
  scene: Scene;
  scheduler: RenderScheduler;
  resourceCache: ResourceCache;
  scaling: HardwareScalingController;
  dispose: () => void;
  resize: () => void;
  setSize: (width: number, height: number) => void;
  loadScene: (sceneData: SerializedScene) => void;
  /** Push a worker snapshot and invalidate the viewport. */
  pushSnapshot: (buffer: Float32Array) => void;
  /** Apply a structural command (spawn/assignMesh) from the game worker. */
  applyCommand: (command: CommandMessage) => void;
  setPaused: (paused: boolean) => void;
  /** Live Babylon mesh/texture counts for Play leak assertions. */
  liveObjectCounts: () => { meshes: number; textures: number };
  /** Last rendered frame's Babylon draw-call count (`_drawCalls.current`). */
  drawCalls: () => number;
  /** Explicit tap pick (hover picking is disabled). */
  pickAt: (
    canvasX: number,
    canvasY: number,
  ) => { meshName: string; slotId: number | null } | null;
  /** Editor camera, gizmos, grid, outline and scene sync; null in Play views. */
  editor: EditorTools | null;
  /** Latest snapshot actor positions (Play), for e2e collision / motion. */
  lastActorPositions: () => PlayActorPosition[];
  /** Snapshot-driven Babylon visuals for Play/Preview parity assertions. */
  playVisualStates: () => Array<{
    slotId: number;
    name: string;
    visible: boolean;
    position: [number, number, number];
    worldMatrixPosition: [number, number, number];
    materialName: string | null;
  }>;
  /** Sprite/tilemap textures and GLB bytes for editor + Play mesh builders. */
  setMeshAssets: (assets: MeshAssetContext) => void;
  /** Play/editor environment (clear, fog, IBL) without rebuilding actor meshes. */
  applySceneEnvironment: (sceneData: SerializedScene) => void;
  setShadowQuality: (level: string) => void;
  /** Authored camera post-process passes currently attached. */
  postProcessPassCount: () => number;
  /** Unique Material guids currently assigned to Play meshes. */
  assignedMaterialGuids: () => string[];
  /** Diagnostics from the last stack rebuild (missing buffers, failed compiles). */
  postProcessDiagnostics: () => readonly PostProcessStackDiagnostic[];
  /** Local Engine Settings gate. Does not mutate the scene document. */
  setPostProcessingEnabled: (enabled: boolean) => void;
  /** Live Engine Settings texture LRU budget. */
  setTextureBudget: (bytes: number, enabled: boolean) => void;
  setPostProcessStack: (stack: readonly PostProcessStackInput[]) => void;
  setMaterialDocuments: (
    documents: ReadonlyMap<string, MaterialDocument>,
    functions?: ReadonlyMap<string, MaterialFunctionDocument>,
  ) => void;
  /** Material asset guids whose editor tab is open — those stay unfrozen. */
  setEditingMaterialGuids: (guids: ReadonlySet<string>) => void;
  /** Compile shaders before the first editor draw (scene-load warm). */
  prewarmSceneMaterials: () => Promise<void>;
  /** Unlock AudioV2 after a user gesture and drain the pre-unlock queue. */
  unlockAudio: () => Promise<void>;
  /** Clear session mixer volumes and stop voices (scene change / Play stop). */
  resetAudioSession: () => void;
  /** Dispose live particle systems (scene change / Play stop). GPU stop still draws leftovers. */
  resetParticleSession: () => void;
  resetWidgetSession: () => void;
  /** Debug free camera is the Play active camera. */
  isFreeCamEnabled: () => boolean;
  /** Fly the Play free camera; no-op while it is off. */
  steerPlayFreeCam: (forward: number, right: number) => void;
  /** Resolves when editor GLB instantiations from the last apply have finished. */
  whenEditorModelsReady: () => Promise<void>;
}

export interface CreateEngineOptions {
  /** Existing app-lifetime engine; when set, this canvas is registerView'd. */
  sharedEngine?: Engine;
  /**
   * How a `sharedEngine` canvas is presented.
   * `registerView` (default) is the Play overlay blit of the engine framebuffer.
   * `rtt` renders this Scene into an RTT and 2D-blits the canvas — Prefab
   * Preview must use this so it does not steal Scene/Play's default framebuffer.
   */
  present?: "registerView" | "rtt";
  /** When true, use Play scene performance settings. */
  playMode?: boolean;
  maxActors?: number;
  /** Attach the editor camera, gizmos, grid, selection and scene sync. */
  editor?: boolean;
  viewportMode?: ViewportMode;
  /** Actor id under an explicit tap, or null when the tap missed. */
  onPickActor?: (
    actorId: string | null,
    options?: { additive?: boolean },
  ) => void;
  /** Actors inside a one-finger marquee drag (2D hold, or Drag Select). */
  onMarqueeSelect?: (actorIds: string[]) => void;
  /** Live marquee overlay rect in CSS canvas pixels; null to hide. */
  onMarqueeMove?: (
    rect: { x: number; y: number; width: number; height: number } | null,
  ) => void;
  /** True while the viewport Drag Select tool is armed. */
  dragSelectActive?: () => boolean;
  /** Fired when an armed drag-select gesture ends so the tool can unpress. */
  onDragSelectEnd?: () => void;
  /** Gizmo drag lifecycle so the editor can coalesce one undo entry. */
  onGizmoDragStart?: () => void;
  onGizmoDrag?: () => void;
  onGizmoDragEnd?: () => void;
  /** When false, WASD does not fly the editor camera (Play overlay). */
  editorFlyEnabled?: () => boolean;
  /** World units/s for WASD. Read each tick so Engine Settings apply live. */
  editorFlySpeed?: () => number;
  /** Viewport clear color scheme; defaults from `html.dark` when present. */
  colorScheme?: EditorColorScheme;
  /** Play `clearColor` from scene `settings.environmentColor`. */
  environmentColor?: readonly [number, number, number];
  /** Optional fps cap. Play sessions pass project `playFrameCap` (default 60). */
  frameCap?: number;
  /** Sprite asset payloads keyed by guid so Play can bake clip UVs from animState. */
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  /** Tilemap / tileset payloads for Play chunk meshes. */
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  pixelsPerUnit?: number;
  /** Project `twoD.pixelPerfect` — snap the Play camera, not the editor camera. */
  pixelPerfect?: boolean;
  /** Texture pixels keyed by Texture asset guid. */
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>;
  /** Facetype JSON bytes keyed by Font asset guid (3D Text). */
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  /** UserInterface documents for WidgetComponent world-space GUI. */
  uiDocuments?: ReadonlyMap<string, import("@babylonslate/ui-runtime").UserInterfaceDocument>;
  /** Model source bytes keyed by Model asset guid. */
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  /** Model payloads (material slots / clip names) keyed by Model asset guid. */
  modelPayloads?: ReadonlyMap<string, import("@babylonslate/assets").ModelPayload>;
  /** Native clipName → Animation guid, keyed by Model guid. */
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Retargeted Animation loads keyed by the actor (target) Model guid. */
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly import("@babylonslate/assets").RetargetAnimationLoad[]
  >;
  /** Self-hosted KTX2 transcoder directory. Editor uses `/ktx2/`; the player uses a relative folder. */
  ktx2BasePath?: string;
  /** Compiled Material documents keyed by asset guid. */
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  /** Material Function documents keyed by asset guid. */
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  /** Authored scene post-process stack. */
  postProcessStack?: readonly PostProcessStackInput[];
  /**
   * Local Engine Settings gate (default on). Skips attaching the authored
   * stack without mutating scene documents.
   */
  postProcessingEnabled?: boolean;
  textureByteCeiling?: number;
  textureBudgetEnabled?: boolean;
  /** Engine Settings `hardwareScalingLevel`. 1 is native. */
  hardwareScalingLevel?: number;
  /** Stack skip / compile messages (exported player and Play overlay). */
  onPostProcessDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
  /** Injected playback backend (tests). Browser Play uses AudioV2. */
  audioBackend?: AudioPlaybackBackend;
  /** Packed or collected Audio source bytes keyed by asset guid. */
  audioBytes?: ReadonlyMap<string, Uint8Array>;
  /** Load clip bytes on first `playSound` (overlay Play / player lazy path). */
  loadAudioSourceBytes?: import("./audio-service").AudioSourceBytesLoader;
  /** Mixer / channel / attenuation / Audio payloads for gain routing. */
  audioLibrary?: AudioLibrary;
  /** Particle Emitter / Particle System payloads for Play. */
  particleLibrary?: ParticleLibrary;
  /** Scene `audioReverb` chunk; dry when missing. */
  audioReverbBytes?: Uint8Array | null;
  /** Project Settings Audio (occlusion master and reverb scales). */
  audioProjectSettings?: Partial<
    Pick<
      AudioProjectSettings,
      | "occlusionEnabled"
      | "reverbWetScale"
      | "reverbDecayScale"
      | "reverbDampingScale"
    >
  >;
  onAudioDiagnostic?: (diagnostic: {
    code: string;
    message: string;
    assetGuid?: string;
  }) => void;
  onParticleDiagnostic?: (diagnostic: {
    code: string;
    message: string;
    assetGuid?: string;
  }) => void;
  onWidgetEvent?: (event: WidgetGuiEvent) => void;
  /** Baked navmesh bytes for Play `shownav`. */
  navmeshBytes?: Uint8Array | null;
  /** NavMesh Blocker volumes drawn with Play `shownav`. */
  navBlockers?: readonly NavDebugBlockerPose[] | null;
}

export interface EditorTools {
  camera: EditorCameraController;
  gizmos: GizmoHost;
  grid: EditorGrid;
  selection: SelectionOutline;
  sync: EditorSceneSync;
  setViewportMode: (mode: ViewportMode) => void;
  /** Session overlay: PBR / Unlit / Wireframe / Points Cloud. */
  setViewportShadingMode: (mode: ViewportShadingMode) => void;
  /** Project 2D unit settings; pass null to leave pixel-perfect framing off. */
  setPixelPerfect: (
    settings: { pixelsPerUnit: number; integerZoomSteps: boolean } | null,
  ) => void;
  /** Ordered sorting layers from project settings, back to front. */
  setSortingLayers: (layers: readonly string[]) => void;
  /** Tile grid, subdivision and 2D game camera bounds from scene settings. */
  setGridSettings: (settings: {
    tileSize: number;
    tileSubdivisions: number;
    cameraBounds2D: { width: number; height: number };
    showGrid?: boolean;
  }) => void;
  /** Select actors by id; passing an empty list clears the selection. */
  setSelectedActors: (actorIds: string[]) => void;
  /** Frustum / light debug + 1 Hz camera preview for the current selection. */
  syncSelectionDebug: (options: {
    sceneData: SerializedScene | null;
    selectedActorIds: readonly string[];
    selectedComponentIds?: readonly string[];
  }) => void;
  setPreviewCanvas: (canvas: HTMLCanvasElement | null) => void;
  frameActor: (actorId: string) => void;
  /** Live local TRS of each selection-root mesh after a gizmo drag. */
  selectedActorTransforms: () => Array<{
    actorId: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  }>;
  /** Live transform of the gizmo-attached mesh, for turning a drag into a command. */
  attachedActorTransform: () => {
    actorId: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  } | null;
  /** Preview the named Default Camera without replacing the stored orbit pose. */
  setPreviewGameCamera: (enabled: boolean) => void;
  setShadowQuality: (level: string) => void;
  /**
   * World point under a client coordinate on this viewport canvas, or null when
   * the canvas has no layout size.
   */
  worldPositionAtClient: (
    clientX: number,
    clientY: number,
  ) => [number, number, number] | null;
  /** World point in the middle of this viewport, in front of the editor camera. */
  worldPositionAtViewCenter: () => [number, number, number];
}

export type PlayActorPosition = {
  slotId: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
};

function positionsFromSample(
  sampled: {
    actorCount: number;
    actors: Array<{
      slotId: number;
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    }>;
  },
  out: PlayActorPosition[],
): PlayActorPosition[] {
  const count = sampled.actorCount;
  for (let i = 0; i < count; i++) {
    const actor = sampled.actors[i]!;
    const row =
      out[i] ??
      (out[i] = {
        slotId: 0,
        x: 0,
        y: 0,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    row.slotId = actor.slotId;
    row.x = actor.position.x;
    row.y = actor.position.y;
    row.z = actor.position.z;
    row.qx = actor.rotation.x;
    row.qy = actor.rotation.y;
    row.qz = actor.rotation.z;
    row.qw = actor.rotation.w;
  }
  out.length = count;
  return out;
}

function createPlayAudioBackend(
  injected?: AudioPlaybackBackend,
): AudioPlaybackBackend {
  if (injected) return injected;
  const hasAudioContext =
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { AudioContext?: unknown }).AudioContext === "function";
  if (!hasAudioContext) return new FakeAudioPlaybackBackend();
  return new BabylonAudioPlaybackBackend();
}

/**
 * Creates an editor or Play view. Prefer one Engine for the app lifetime and
 * pass it via `sharedEngine` + registerView for Play overlays. ResourceCache
 * is keyed on that Engine (`resourceCacheForEngine`); shared handles must not
 * dispose it.
 */
export function createEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions = {},
): EngineHandle {
  configureKtx2Transcoder(KhronosTextureContainer2, options.ktx2BasePath);

  const ownsEngine = !options.sharedEngine;
  const presentRtt = options.present === "rtt";
  const engine =
    options.sharedEngine ??
    new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      adaptToDeviceRatio: false,
      antialias: false,
    });

  if (options.sharedEngine && !presentRtt) {
    // clearBeforeCopy: overlay is a 2D blit of the WebGL canvas; without a
    // clear, skipped render-on-demand frames composite additively.
    engine.registerView(canvas, undefined, true);
  }

  const scene = new Scene(engine, SCENE_LOOKUP_MAPS);
  scene.skipPointerMovePicking = true;
  scene.clearColor = options.environmentColor
    ? sceneClearColor(options.environmentColor)
    : editorClearColor(options.colorScheme ?? documentEditorColorScheme());
  if (options.playMode) {
    scene.performancePriority = ScenePerformancePriority.Intermediate;
    // Intermediate disables color clear (assumes a full-bleed skybox). Play
    // scenes often have none, so restore autoClear to avoid additive trails.
    scene.autoClear = true;
    configureEditorRenderingGroups(scene);
  } else {
    scene.performancePriority = ScenePerformancePriority.BackwardCompatible;
  }
  if (presentRtt) {
    // RTT clear targets the preview buffer, not Scene/Play's framebuffer.
    scene.autoClear = true;
  }

  const rttPresent = presentRtt
    ? createRttCanvasPresent(scene, canvas, { name: "prefabPreview" })
    : null;

  const pointerCanvas = () => {
    if (presentRtt) {
      return (
        rttPresent?.canvasSize() ?? {
          width: Math.max(1, canvas.clientWidth || 1),
          height: Math.max(1, canvas.clientHeight || 1),
        }
      );
    }
    const rect = canvas.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width || canvas.clientWidth || 1),
      height: Math.max(1, rect.height || canvas.clientHeight || 1),
    };
  };

  setupDefaultViewport(scene);

  const scheduler = new RenderScheduler();
  if (options.editor) {
    scheduler.setAlwaysRender(true);
  }
  if (options.frameCap !== undefined) {
    scheduler.setFrameCap(options.frameCap);
  }
  const releasePlayLoop = options.playMode
    ? scheduler.acquireContinuous("play")
    : null;
  const resourceCache = resourceCacheForEngine(engine);
  if (typeof options.textureByteCeiling === "number") {
    resourceCache.setByteCeiling(options.textureByteCeiling);
  }
  if (typeof options.textureBudgetEnabled === "boolean") {
    resourceCache.setBudgetEnabled(options.textureBudgetEnabled);
  }
  const audioService = options.playMode
    ? new AudioService({
        backend: createPlayAudioBackend(options.audioBackend),
        onDiagnostic: options.onAudioDiagnostic,
        loadSourceBytes: options.loadAudioSourceBytes,
      })
    : null;
  if (audioService) {
    if (options.audioLibrary) audioService.setLibrary(options.audioLibrary);
    for (const [guid, bytes] of options.audioBytes ?? []) {
      audioService.setSourceBytes(guid, bytes);
    }
    if (options.audioReverbBytes) {
      audioService.setReverbField(options.audioReverbBytes);
    }
    if (options.audioProjectSettings) {
      audioService.setProjectAudioSettings(options.audioProjectSettings);
    }
  }
  const settingsLevel = options.hardwareScalingLevel ?? 1;
  const scaling = new HardwareScalingController(engine, {
    minLevel: settingsLevel,
    maxLevel: 4,
    initialLevel: settingsLevel,
    targetFrameMs:
      options.frameCap && options.frameCap > 0
        ? 1000 / options.frameCap
        : 1000 / 60,
  });
  const interpolator = new SnapshotInterpolator(options.maxActors ?? 256);
  const binding: SnapshotSceneBinding = createSnapshotSceneBinding();
  binding.tilemaps = options.tilemapPayloads;
  binding.tilesets = options.tilesetPayloads;
  binding.pixelsPerUnit = options.pixelsPerUnit;
  binding.pixelPerfect = options.pixelPerfect === true;
  binding.spritePayloads = options.spritePayloads;
  binding.spriteAnimations = options.spriteAnimations;
  binding.textureBytes = options.textureBytes;
  binding.fontFacetypeBytes = options.fontFacetypeBytes;
  binding.uiDocuments = options.uiDocuments;
  binding.modelBytes = options.modelBytes;
  binding.modelPayloads = options.modelPayloads;
  binding.modelClipAnimationGuids = options.modelClipAnimationGuids;
  binding.retargetAnimationLoads = options.retargetAnimationLoads;
  binding.resourceCache = resourceCache;
  binding.slotAnimReady = () => {
    scheduler.invalidate("snapshot");
  };

  const playFreeCam: PlayFreeCamController | null = options.playMode
    ? createPlayFreeCamController(scene, {
        binding,
        mode: options.viewportMode ?? "3d",
      })
    : null;
  const playFreeCamInput: PlayFreeCamInputHandle | null = playFreeCam
    ? attachPlayFreeCamInput(canvas, playFreeCam, {
        mode: options.viewportMode ?? "3d",
      })
    : null;
  const playViz: PlayConsoleVizController | null = options.playMode
    ? createPlayConsoleViz(scene, {
        navmeshBytes: options.navmeshBytes,
        navBlockers: options.navBlockers,
      })
    : null;
  const playDebugDraw: PlayDebugDrawController | null = options.playMode
    ? createPlayDebugDraw(scene)
    : null;

  const materialDocuments = new Map<string, MaterialDocument>(
    options.materialDocuments ?? [],
  );
  const materialFunctions = new Map<string, MaterialFunctionDocument>(
    options.materialFunctions ?? [],
  );
  const editingMaterialGuids = new Set<string>();
  const materialLibrary = new MaterialLibrary({
    functions: () => Object.fromEntries(materialFunctions),
    resolveTexture: (guid) => {
      const bytes = binding.textureBytes?.get(guid);
      if (!bytes) return null;
      return getMaterialTexture(resourceCache, guid, engine, bytes);
    },
  });
  binding.resolveMaterial = (guid) => {
    const live = materialLibrary.materialFor(scene, guid);
    if (live) return live;
    const document = materialDocuments.get(guid);
    if (!document) return null;
    const acquired = materialLibrary.acquire(scene, guid, document);
    if (materialUnavailable(acquired)) return null;
    return acquired.material;
  };

  const particleService = options.playMode
    ? new ParticleService({
        scene,
        resolveTexture: (guid) => {
          const bytes = binding.textureBytes?.get(guid);
          if (!bytes) return null;
          return getMaterialTexture(resourceCache, guid, engine, bytes);
        },
        resolveMaterial: (guid) => {
          const live = binding.resolveMaterial?.(guid);
          return live && "createEffectForParticles" in live
            ? (live as import("@babylonjs/core").NodeMaterial)
            : null;
        },
        resolveEmitter: (slotId) => binding.meshes.get(slotId) ?? null,
        onDiagnostic: options.onParticleDiagnostic,
      })
    : null;
  if (particleService && options.particleLibrary) {
    particleService.setLibrary(options.particleLibrary);
  }

  const widgetGuiService = options.playMode
    ? new WidgetGuiService({
        scene,
        onWidgetEvent: options.onWidgetEvent,
      })
    : null;
  if (widgetGuiService && options.uiDocuments) {
    widgetGuiService.setLibrary(options.uiDocuments);
  }

  let postProcessingEnabled = options.postProcessingEnabled !== false;
  let postProcessStack = normalizePostProcessStack(
    options.postProcessStack ?? [],
  );
  let attachedStack: AttachedPostProcessStack | null = null;
  let lastPostProcessDiagnostics: PostProcessStackDiagnostic[] = [];

  const rebuildPostProcessStack = () => {
    attachedStack?.dispose();
    attachedStack = null;
    lastPostProcessDiagnostics = [];
    if (!postProcessingEnabled) return;
    const camera = scene.activeCamera;
    if (!camera) return;
    attachedStack = attachPostProcessStack({
      scene,
      camera,
      library: materialLibrary,
      stack: postProcessStack,
      documentFor: (guid) => materialDocuments.get(guid) ?? null,
      deviceBuffers: probePostProcessDeviceBuffers(scene, camera),
      onDiagnostic: (diagnostic) => {
        lastPostProcessDiagnostics.push(diagnostic);
        options.onPostProcessDiagnostic?.(diagnostic);
      },
    });
  };

  const rebuildIfActiveCameraChanged = (
    previous: typeof scene.activeCamera,
  ) => {
    if (scene.activeCamera === previous) return;
    rebuildPostProcessStack();
  };

  const viewportShading = options.editor
    ? new ViewportShadingOverlay(scene)
    : null;
  const editorSync = options.editor
    ? new EditorSceneSync(scene, scheduler, {
        resolveMaterial: (guid) => binding.resolveMaterial?.(guid) ?? null,
        onAfterApply: () => viewportShading?.apply(),
      })
    : null;

  const loadScene = (sceneData: SerializedScene) => {
    postProcessStack = normalizePostProcessStack(
      sceneData.settings.postProcessStack,
    );
    if (editorSync) {
      editorSync.apply(sceneData);
      applyEditorMaterialFreeze(scene, editingMaterialGuids);
      rebuildPostProcessStack();
      return;
    }
    if (options.playMode) {
      disablePlayFreeCam(playFreeCam);
      playViz?.applyCommand({ type: "setShowNav", enabled: false });
      // Play visuals come from assignMesh. Document illumination would plant a
      // second set of lights (`authoredLight:<actorId>`) on changescene.
      applySerializedSceneEnvironment(scene, sceneData, {
        applyClearColor: true,
        assets: binding,
      });
      rebuildPostProcessStack();
      scheduler.invalidate("asset");
      return;
    }
    applySceneToBabylonScene(scene, sceneData, binding);
    rebuildPostProcessStack();
    scheduler.invalidate("asset");
  };

  let editor: EditorTools | null = null;
  let lastSelectedActorIds: string[] = [];
  let debugOverlay: EditorDebugOverlay | null = null;
  let disposeGestures: (() => void) | null = null;
  if (options.editor && editorSync) {
    const mode: ViewportMode = options.viewportMode ?? "3d";
    // The editor camera replaces the default viewport camera set up above.
    scene.activeCamera?.dispose();
    const cameraController = createEditorCamera(scene, { mode, scheduler });
    let previewGameCamera = false;
    const grid = createEditorGrid(scene, { mode, camera: cameraController.camera });
    const selection = new SelectionOutline(scene);
    let multiSelectDrag: GizmoMultiSelectDrag | null = null;
    const parentIdOf = (id: string): string | null =>
      editorSync.serializedScene()?.actors.find((actor) => actor.id === id)
        ?.parentId ?? null;
    const selectedActorTransforms = () => {
      const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
      const live: Array<{
        actorId: string;
        position: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
      }> = [];
      for (const actorId of roots) {
        const mesh = editorSync.meshForActor(actorId);
        if (!mesh) continue;
        live.push({ actorId, ...readMeshLocalTransform(mesh) });
      }
      return live;
    };
    const gizmosRef: { host: GizmoHost | null } = { host: null };
    const debugOverlayInstance = new EditorDebugOverlay(scene);
    debugOverlay = debugOverlayInstance;
    const gizmos = createGizmoHost(scene, {
      mode,
      scheduler,
      onDragStart: () => {
        const attached = gizmosRef.host?.attachedMesh() ?? null;
        const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
        const followers = roots
          .map((id) => editorSync.meshForActor(id))
          .filter(
            (mesh): mesh is NonNullable<typeof mesh> =>
              mesh !== null && mesh !== attached,
          );
        for (const root of roots) {
          const mesh = editorSync.meshForActor(root);
          if (mesh) unfreezeActorWorldMatrix(mesh);
        }
        if (attached instanceof Mesh) unfreezeActorWorldMatrix(attached);
        multiSelectDrag = beginGizmoMultiSelectDrag(attached, followers);
        options.onGizmoDragStart?.();
      },
      onDrag: () => {
        const attached = gizmosRef.host?.attachedMesh() ?? null;
        if (multiSelectDrag && attached) {
          applyGizmoMultiSelectDrag(multiSelectDrag, attached);
        }
        const sceneData = editorSync.serializedScene();
        if (sceneData) {
          syncAuthoredCamerasFromMeshes(scene, sceneData, (id) =>
            editorSync.meshForActor(id),
          );
        }
        debugOverlayInstance.followLivePose();
        options.onGizmoDrag?.();
      },
      onDragEnd: () => {
        const attached = gizmosRef.host?.attachedMesh() ?? null;
        if (multiSelectDrag && attached) {
          applyGizmoMultiSelectDrag(multiSelectDrag, attached);
        }
        multiSelectDrag = null;
        const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
        for (const root of roots) {
          const mesh = editorSync.meshForActor(root);
          if (mesh) freezeStaticActorWorldMatrix(mesh);
        }
        if (attached instanceof Mesh) freezeStaticActorWorldMatrix(attached);
        options.onGizmoDragEnd?.();
      },
    });
    gizmosRef.host = gizmos;

    const gestures = attachViewportGestures(canvas, cameraController, {
      scheduler,
      editorCameraActive: () => !previewGameCamera,
      blockLook: (x, y) =>
        gizmos.isDragging() || gizmos.hitTest(x, y, pointerCanvas()),
      dragSelectActive: () => options.dragSelectActive?.() === true,
      onPointer: presentRtt
        ? (type, x, y, pointerId) => {
            gizmos.forwardPointer(type, x, y, { ...pointerCanvas(), pointerId });
          }
        : undefined,
      onTap: (x, y, tap) => {
        const mapped = mapCanvasPointer(scene, x, y, pointerCanvas());
        const hit = pickAtCanvas(scene, mapped.x, mapped.y);
        const actorId = hit ? editorSync.actorForMesh(hit.meshName) : null;
        options.onPickActor?.(actorId, { additive: tap?.additive === true });
      },
      onMarqueeMove: options.onMarqueeMove,
      onDragSelectEnd: options.onDragSelectEnd,
      onMarquee: (rect) => {
        if (!options.onMarqueeSelect) return;
        const css = canvas.getBoundingClientRect();
        const names = meshNamesInCanvasRect(
          scene,
          rect,
          css.width,
          css.height,
        );
        const actorIds = [
          ...new Set(
            names
              .map((name) => editorSync.actorForMesh(name))
              .filter((id): id is string => id !== null),
          ),
        ];
        options.onMarqueeSelect(actorIds);
      },
    });
    const flyKeys =
      typeof window === "undefined"
        ? null
        : attachViewportFlyKeys(window, cameraController, canvas, {
            scheduler,
            speed: () => options.editorFlySpeed?.() ?? DEFAULT_FLY_SPEED,
            isEnabled: () =>
              !previewGameCamera && options.editorFlyEnabled?.() !== false,
          });
    disposeGestures = () => {
      gestures.dispose();
      flyKeys?.dispose();
    };

    editor = {
      camera: cameraController,
      gizmos,
      grid,
      selection,
      sync: editorSync,
      setViewportMode: (next: ViewportMode) => {
        cameraController.setMode(next);
        gizmos.setMode(next);
        grid.setMode(next);
        scheduler.invalidate("camera");
      },
      setViewportShadingMode: (next: ViewportShadingMode) => {
        viewportShading?.setMode(next);
        scheduler.invalidate("asset");
      },
      setPixelPerfect: (settings) => {
        cameraController.setCanvasHeight(engine.getRenderHeight());
        cameraController.setPixelPerfect(settings);
        if (settings) {
          applyPixelArtSamplingToScene(scene);
        }
      },
      setSortingLayers: (layers) => {
        editorSync.setSortingLayers(layers);
        scheduler.invalidate("asset");
      },
      setGridSettings: (settings) => {
        grid.setSpacing(settings.tileSize);
        grid.setSubdivisions(settings.tileSubdivisions);
        grid.setCameraBounds(settings.cameraBounds2D);
        if (typeof settings.showGrid === "boolean") {
          grid.setVisible(settings.showGrid);
        }
        scheduler.invalidate("asset");
      },
      setSelectedActors: (actorIds: string[]) => {
        lastSelectedActorIds = [...actorIds];
        const meshes = actorIds.map((id) => editorSync.meshForActor(id));
        const visuals = actorIds.flatMap((id) =>
          editorSync.visualMeshesForActor(id),
        );
        selection.set(visuals.length > 0 ? visuals : meshes);
        // Locked actors are not pickable; keep the gizmo off them so lock is
        // more than a pick filter. Attach to the first pickable selection root
        // so a selected child is not the group handle when its parent is too.
        const attachId = pickGizmoAttachActorId(
          actorIds,
          parentIdOf,
          (id) => {
            const mesh = editorSync.meshForActor(id);
            if (!mesh) return false;
            const locked = editorSync
              .serializedScene()
              ?.actors.find((actor) => actor.id === id)?.locked;
            if (locked) return false;
            return mesh.isPickable || isEditorModelPlaceholder(mesh);
          },
        );
        gizmos.attachTo(
          attachId ? editorSync.meshForActor(attachId) : null,
        );
        scheduler.invalidate("selection");
      },
      syncSelectionDebug: (options) => {
        debugOverlayInstance.sync(options);
        scheduler.invalidate("selection");
      },
      setPreviewCanvas: (canvas) => {
        debugOverlayInstance.setPreviewCanvas(canvas);
      },
      frameActor: (actorId: string) => {
        const mesh = editorSync.meshForActor(actorId);
        if (!mesh || isSkyboxMesh(mesh)) return;
        cameraController.frame(mesh.getAbsolutePosition());
      },
      selectedActorTransforms,
      attachedActorTransform: () => {
        const mesh = gizmos.attachedMesh();
        if (!mesh) return selectedActorTransforms()[0] ?? null;
        const actorId = editorSync.actorForMesh(mesh.name);
        if (!actorId) return null;
        return (
          selectedActorTransforms().find((entry) => entry.actorId === actorId) ?? {
            actorId,
            ...readMeshLocalTransform(mesh),
          }
        );
      },
      setPreviewGameCamera: (enabled: boolean) => {
        previewGameCamera = enabled;
        editorSync.setGameCameraPreview(enabled, cameraController.camera);
        scheduler.invalidate("camera");
      },
      setShadowQuality: (level: string) => {
        editorSync.setShadowQuality(level);
        scheduler.invalidate("asset");
      },
      worldPositionAtClient: (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return worldPositionFromCanvas(
          cameraController.camera,
          clientX - rect.left,
          clientY - rect.top,
          { width: rect.width, height: rect.height },
          cameraController.mode,
        );
      },
      worldPositionAtViewCenter: () =>
        viewCenterWorldPosition(cameraController.camera, cameraController.mode),
    };
  }

  // Play renders snapshot proxy meshes only. Seeding the default scene here
  // stacks editor helpers under those proxies at the origin (z-fighting / additive look).
  if (!options.playMode) {
    loadScene(createDefaultScene());
  }

  const presentSharedPlayView = Boolean(
    options.sharedEngine && !presentRtt && options.playMode,
  );

  const resize = () => {
    if (presentRtt) {
      rttPresent?.clear();
    } else if (presentSharedPlayView) {
      const size = snapCanvasDrawingBuffer(canvas);
      engine.setSize(size.width, size.height);
    } else {
      snapCanvasDrawingBuffer(canvas);
      engine.resize();
    }
    const size = presentRtt
      ? rttPresent?.canvasSize() ?? { width: 1, height: 1 }
      : {
          width: engine.getRenderWidth(),
          height: engine.getRenderHeight(),
        };
    const width = size.width;
    const height = size.height;
    if (height > 0) {
      editor?.camera.setCanvasHeight(height);
      editor?.camera.updateOrthoBounds(width / height);
    }
    refreshAuthoredCameraLenses(scene);
  };

  let interpAlpha = 1;
  const lastPositions: PlayActorPosition[] = [];
  const audioPoses: SampledAudioPose[] = [];
  let lastDrawCalls = 0;
  const renderLoop = () => {
    if (!scheduler.shouldRender()) {
      return;
    }
    const sampled = interpolator.sample(interpAlpha);
    if (sampled) {
      const previousCamera = scene.activeCamera;
      applySnapshotToScene(scene, binding, sampled);
      playViz?.refresh();
      rebuildIfActiveCameraChanged(previousCamera);
      positionsFromSample(sampled, lastPositions);
    }
    if (audioService) {
      if (audioService.hasSpatialVoices() && sampled) {
        writeSampledAudioPoses(sampled, audioPoses);
        audioService.syncSnapshot(audioPoses);
      }
      const camera = scene.activeCamera;
      if (camera) {
        const pos = camera.globalPosition ?? camera.position;
        const rot = camera.absoluteRotation;
        audioService.syncListener({
          x: pos.x,
          y: pos.y,
          z: pos.z,
          qx: rot.x,
          qy: rot.y,
          qz: rot.z,
          qw: rot.w,
        });
      }
    }
    // Measure render cost only, not wall-clock gap since the previous
    // rendered frame — a frozen obstructed viewport can idle for seconds
    // between frames, and feeding that gap to the scaling valve would read
    // as a catastrophic frame time and drop quality for no reason.
    const renderStart = performance.now();
    beginEngineDrawCallFrame(engine);
    if (rttPresent) rttPresent.bind();
    scene.render();
    if (rttPresent) rttPresent.blit();
    lastDrawCalls = readEngineDrawCalls(engine);
    scheduler.noteRendered();
    scaling.noteFrameTime(performance.now() - renderStart);
  };
  engine.runRenderLoop(renderLoop);

  const onVisibility = () => {
    const hidden = document.visibilityState === "hidden";
    scheduler.setPaused(hidden);
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  engine.onContextLostObservable.add(() => {
    engineCommandBus.dispatch({ type: "log", message: "WebGL context lost" });
  });
  engine.onContextRestoredObservable.add(() => {
    engineCommandBus.dispatch({
      type: "log",
      message: "WebGL context restored",
    });
    scaling.noteRestore();
    resourceCache.releaseGpuTextures();
    resourceCache.flushUnreferenced();
    materialLibrary.invalidate();
    scheduler.invalidate("manual");
  });

  // Tap-to-pick: continuous hover picking is off for touch.
  const onPointerDown = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = pickAtCanvas(scene, x, y);
    if (hit) {
      scheduler.invalidate("selection");
    }
  };
  if (!options.editor) {
    canvas.addEventListener("pointerdown", onPointerDown);
  }

  rebuildPostProcessStack();

  return {
    engine,
    scene,
    scheduler,
    resourceCache,
    scaling,
    editor,
    dispose: () => {
      releasePlayLoop?.();
      engine.stopRenderLoop(renderLoop);
      playFreeCamInput?.dispose();
      playFreeCam?.dispose();
      playViz?.dispose();
      playDebugDraw?.dispose();
      disposeGestures?.();
      editor?.gizmos.dispose();
      editor?.grid.dispose();
      editor?.selection.dispose();
      editor?.sync.dispose();
      debugOverlay?.dispose();
      debugOverlay = null;
      canvas.removeEventListener("pointerdown", onPointerDown);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      disposeSnapshotBinding(binding);
      attachedStack?.dispose();
      attachedStack = null;
      materialLibrary.dispose();
      audioService?.dispose();
      particleService?.dispose();
      widgetGuiService?.dispose();
      scene.dispose();
      rttPresent?.dispose();
      if (options.sharedEngine && !presentRtt) {
        engine.unRegisterView(canvas);
      }
      if (ownsEngine) {
        releaseResourceCacheForEngine(engine);
        engine.dispose();
      }
    },
    resize,
    setSize: (width: number, height: number) => {
      const nextWidth = Math.max(1, Math.floor(width));
      const nextHeight = Math.max(1, Math.floor(height));
      if (presentSharedPlayView) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      engine.setSize(nextWidth, nextHeight);
      refreshAuthoredCameraLenses(scene);
    },
    loadScene,
    pushSnapshot: (buffer: Float32Array) => {
      interpolator.push(buffer);
      interpAlpha = 1;
      const sampled = interpolator.sample(interpAlpha);
      if (sampled) positionsFromSample(sampled, lastPositions);
      if (isPublishedSnapshot(buffer)) {
        playDebugDraw?.noteSimTick(readSnapshotHeader(buffer).tickIndex);
      }
      scheduler.invalidate("snapshot");
    },
    applyCommand: (command: CommandMessage) => {
      if (options.playMode) {
        applyPlayConsoleRenderCommand({ scaling, scheduler }, command);
      }
      applyPlayFreeCamCommand(playFreeCam, command);
      playViz?.applyCommand(command);
      playDebugDraw?.applyCommand(command);
      if (command.type === "spawn") {
        audioService?.noteActorSlot(command.actorGuid, command.slotId);
      }
      audioService?.handleCommand(command);
      particleService?.handleCommand(command);
      widgetGuiService?.handleCommand(command);
      if (command.type === "assignMesh") {
        const previousCamera = scene.activeCamera;
        applyAssignMesh(scene, binding, command);
        rebuildIfActiveCameraChanged(previousCamera);
        particleService?.bindSlot(
          command.slotId,
          binding.meshes.get(command.slotId) ?? null,
        );
        widgetGuiService?.bindSlot(
          command.slotId,
          binding.meshes.get(command.slotId) ?? null,
        );
        const pending = binding.pendingAnimState?.get(command.slotId);
        if (pending) {
          applyAnimStateToScene(
            sceneAnimHostFromBinding(binding, {
              animationGroups: scene.animationGroups,
              spritePayloads: binding.spritePayloads ?? options.spritePayloads,
              spriteAnimations:
                binding.spriteAnimations ?? options.spriteAnimations,
              applyTexture: (mesh, guid) =>
                applyAlbedoTexture(mesh, scene, guid, binding),
            }),
            pending,
          );
        }
        scheduler.invalidate("snapshot");
      }
      if (command.type === "assignMaterial") {
        applyAssignMaterial(scene, binding, command);
        scheduler.invalidate("asset");
      }
      if (command.type === "possessCamera") {
        const previousCamera = scene.activeCamera;
        applyPossessCamera(scene, binding, command.slotId);
        rebuildIfActiveCameraChanged(previousCamera);
        scheduler.invalidate("camera");
      }
      if (command.type === "setShadowQuality") {
        applyShadowQuality(scene, binding, command.level);
        scheduler.invalidate("asset");
      }
      if (command.type === "animState") {
        if (!binding.pendingAnimState) binding.pendingAnimState = new Map();
        binding.pendingAnimState.set(command.slotId, command);
        applyAnimStateToScene(
          sceneAnimHostFromBinding(binding, {
            animationGroups: scene.animationGroups,
            spritePayloads: binding.spritePayloads ?? options.spritePayloads,
            spriteAnimations:
              binding.spriteAnimations ?? options.spriteAnimations,
            applyTexture: (mesh, guid) =>
              applyAlbedoTexture(mesh, scene, guid, binding),
            onMissingClip: (info) => {
              const groups = binding.slotAnimationGroups?.get(info.slotId);
              if (
                info.clipKind === "animation" &&
                (!groups || groups.length === 0)
              ) {
                return;
              }
              console.warn(
                `[render] missing ${info.clipKind} clip "${info.clipName}" on slot ${info.slotId}`,
              );
            },
          }),
          command,
        );
        scheduler.invalidate("snapshot");
      }
    },
    setPaused: (paused: boolean) => {
      scheduler.setPaused(paused);
      audioService?.setPaused(paused);
    },
    liveObjectCounts: () => ({
      meshes: scene.meshes.length,
      textures: engine.getLoadedTexturesCache().length,
    }),
    drawCalls: () => lastDrawCalls,
    pickAt: (x, y) => {
      const mapped = mapCanvasPointer(scene, x, y, pointerCanvas());
      const hit = pickAtCanvas(scene, mapped.x, mapped.y);
      return hit
        ? { meshName: hit.meshName, slotId: hit.slotId }
        : null;
    },
    lastActorPositions: () => lastPositions,
    playVisualStates: () => {
      const states: Array<{
        slotId: number;
        name: string;
        visible: boolean;
        position: [number, number, number];
        worldMatrixPosition: [number, number, number];
        materialName: string | null;
      }> = [];
      for (const [slotId, root] of binding.meshes) {
        const componentVisuals = root
          .getChildMeshes()
          .filter(
            (mesh): mesh is Mesh =>
              mesh instanceof Mesh &&
              mesh.name.startsWith(`actor-${slotId}|`) &&
              !mesh.name.slice(mesh.name.indexOf("|") + 1).includes(":"),
          );
        const visuals = componentVisuals.length > 0 ? componentVisuals : [root];
        for (const visual of visuals) {
          visual.computeWorldMatrix(true);
          const position = visual.getAbsolutePosition();
          const worldMatrixPosition = visual.getWorldMatrix().getTranslation();
          states.push({
            slotId,
            name: visual.name,
            visible: visual.isVisible && visual.isEnabled(),
            position: [position.x, position.y, position.z],
            worldMatrixPosition: [
              worldMatrixPosition.x,
              worldMatrixPosition.y,
              worldMatrixPosition.z,
            ],
            materialName: visual.material?.name ?? null,
          });
        }
      }
      return states.sort(
        (a, b) => a.slotId - b.slotId || a.name.localeCompare(b.name),
      );
    },
    setMeshAssets: (assets: MeshAssetContext) => {
      binding.resourceCache = assets.resourceCache ?? binding.resourceCache;
      binding.textureBytes = assets.textureBytes;
      binding.fontFacetypeBytes = assets.fontFacetypeBytes;
      binding.uiDocuments = assets.uiDocuments;
      if (assets.uiDocuments) {
        widgetGuiService?.setLibrary(assets.uiDocuments);
      }
      binding.modelBytes = assets.modelBytes;
      binding.modelPayloads = assets.modelPayloads;
      binding.modelClipAnimationGuids = assets.modelClipAnimationGuids;
      binding.retargetAnimationLoads = assets.retargetAnimationLoads;
      binding.spritePayloads = assets.spritePayloads ?? binding.spritePayloads;
      binding.spriteAnimations =
        assets.spriteAnimations ?? binding.spriteAnimations;
      binding.tilemaps = assets.tilemaps ?? binding.tilemaps;
      binding.tilesets = assets.tilesets ?? binding.tilesets;
      if (typeof assets.pixelsPerUnit === "number") {
        binding.pixelsPerUnit = assets.pixelsPerUnit;
      }
      const rebuilt = editorSync?.setMeshAssets(assets) === true;
      if (rebuilt && lastSelectedActorIds.length > 0) {
        editor?.setSelectedActors(lastSelectedActorIds);
      }
    },
    applySceneEnvironment: (sceneData: SerializedScene) => {
      applySerializedSceneEnvironment(scene, sceneData, {
        applyClearColor: true,
        assets: binding,
      });
      scheduler.invalidate("asset");
    },
    setShadowQuality: (level: string) => {
      applyShadowQuality(scene, binding, level);
      editor?.setShadowQuality(level);
      scheduler.invalidate("asset");
    },
    postProcessPassCount: () => attachedStack?.passes.length ?? 0,
    assignedMaterialGuids: () => listAssignedMaterialGuids(binding),
    postProcessDiagnostics: () => lastPostProcessDiagnostics,
    setPostProcessingEnabled: (enabled: boolean) => {
      postProcessingEnabled = enabled;
      rebuildPostProcessStack();
      scheduler.invalidate("asset");
    },
    setTextureBudget: (bytes: number, enabled: boolean) => {
      resourceCache.setByteCeiling(bytes);
      resourceCache.setBudgetEnabled(enabled);
    },
    setPostProcessStack: (stack: readonly PostProcessStackInput[]) => {
      postProcessStack = normalizePostProcessStack(stack);
      rebuildPostProcessStack();
      scheduler.invalidate("asset");
    },
    setMaterialDocuments: (
      documents: ReadonlyMap<string, MaterialDocument>,
      functions?: ReadonlyMap<string, MaterialFunctionDocument>,
    ) => {
      materialDocuments.clear();
      for (const [guid, document] of documents) {
        materialDocuments.set(guid, document);
      }
      if (functions) {
        materialFunctions.clear();
        for (const [guid, document] of functions) {
          materialFunctions.set(guid, document);
        }
      }
      rebuildPostProcessStack();
      const serialized = editorSync?.serializedScene();
      if (editorSync && serialized) editorSync.apply(serialized);
      applyEditorMaterialFreeze(scene, editingMaterialGuids);
      scheduler.invalidate("asset");
    },
    setEditingMaterialGuids: (guids) => {
      editingMaterialGuids.clear();
      for (const guid of guids) editingMaterialGuids.add(guid);
      applyEditorMaterialFreeze(scene, editingMaterialGuids);
      scheduler.invalidate("asset");
    },
    prewarmSceneMaterials: async () => {
      await warmSceneMaterials(scene);
      applyEditorMaterialFreeze(scene, editingMaterialGuids);
    },
    unlockAudio: () => audioService?.unlockAsync() ?? Promise.resolve(),
    resetAudioSession: () => {
      audioService?.resetSession();
    },
    resetParticleSession: () => {
      particleService?.resetSession();
    },
    resetWidgetSession: () => {
      widgetGuiService?.resetSession();
    },
    isFreeCamEnabled: () => playFreeCam?.enabled() ?? false,
    steerPlayFreeCam: (forward, right) => {
      playFreeCam?.fly(forward, right);
    },
    whenEditorModelsReady: () =>
      editorSync?.whenEditorModelsReady() ?? Promise.resolve(),
  };
}

/**
 * Pause the editor viewport while Play is open. On close, restore the
 * engine size (Play's registerView path may have called setSize) and
 * invalidate so render-on-demand redraws the docked view.
 */
export function syncEditorPlayState(
  handle: EngineHandle,
  playing: boolean,
): void {
  handle.setPaused(playing);
  if (!playing) {
    handle.resize();
    handle.scheduler.invalidate("play");
  }
}

/** Create the single app-lifetime Engine (no scene). */
export function createAppEngine(canvas: HTMLCanvasElement): Engine {
  configureKtx2Transcoder(KhronosTextureContainer2);
  return new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    adaptToDeviceRatio: false,
    antialias: false,
  });
}
