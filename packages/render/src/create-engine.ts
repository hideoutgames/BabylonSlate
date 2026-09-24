import { RuntimeScalability } from "./runtime-scalability";
import { normalizeRenderProjectSettings, normalizePlayFrameCap, playFramebufferSize, outlineBindings, type RenderProjectSettings, type ScalabilityAcknowledgement } from "@babylonslate/core";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { PostProcessParameterState } from "./post-process-parameter-state";
import { applyPostProcessParameterCommand } from "./post-process-parameter-command";
import { sceneRenderPathStatus, subscribeSceneRenderPath } from "./scene-render-path";
import { requestRenderPath, retainPlayRenderPathSession, subscribeRenderPathSession } from "./render-path-session";
import type { RenderPath, ResolvedRenderingPipeline } from "@babylonslate/core";
import { submitPresentedFrame } from "./presented-frame";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { SceneOutlineHost, isOutlineOnlySceneEdit, type SceneOutlineSelection } from "./scene-outline-host";
import { isTransformOnlySceneEdit } from "./scene-transform-edit";
import { visualMeshes } from "./visual-meshes";
import type { SceneLayerLoadIdentity } from "./scene-load-readiness";
import type { AbstractEngine, BaseTexture, Camera } from "@babylonjs/core";
import { resolveRenderingQuality } from "@babylonslate/core";
import { isEnvironmentLightingReady } from "./environment-lighting";
import { createRenderDiagnostics, type GpuAttribution, type RenderDiagnostics } from "./render-diagnostics";
import {
  Engine,
  KhronosTextureContainer2,
  Mesh,
  NodeMaterial,
  Scene,
  ScenePerformancePriority,
} from "@babylonjs/core";
import type {
  AudioProjectSettings,
  PhysicsWorldKind,
  SerializedScene,
  ViewportMode,
} from "@babylonslate/core";
import { createDefaultScene, engineCommandBus } from "@babylonslate/core";
import { setSceneRenderSettings } from "./scene-render-mode";
import { applyMaterialTextureAnisotropy, sceneRenderingSettings, resolveSceneRenderingQuality, setSceneEffectsEnabled, type RenderShadingSettings } from "./render-settings";
import { SceneEffectsOwner } from "./scene-effects-owner";
import type {
  BakeRuntimeAssetReader,
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
} from "@babylonslate/assets";
import {
  isPublishedSnapshot,
  readSnapshotHeader,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  materialDependencies,
  type MaterialDocument,
  type MaterialFunctionDocument,
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
import { calculateEditorDropTransforms, type EditorDropTransform } from "./editor-drop";
import { createPreviewLighting } from "./preview-lighting";
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
import { attachViewportGestures } from "./viewport-gestures";
import { attachViewportFlyKeys, DEFAULT_FLY_SPEED } from "./viewport-fly-keys";
import { DracoDecoder } from "@babylonjs/core/Meshes/Compression/dracoDecoder";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import {
  configureKtx2DecoderRuntime,
  configureKtx2Transcoder,
} from "./ktx2-transcoder";
import { configureGltfMeshDecoders } from "./gltf-mesh-decoders";
import {
  documentEditorColorScheme,
  editorClearColor,
  sceneClearColor,
  type EditorColorScheme,
} from "./editor-clear-color";
import {
  applySceneToBabylonScene,
  editorComponentMeshName,
  unfreezeActorWorldMatrix,
  freezeStaticActorWorldMatrix,
} from "./scene-loader";
import {
  accountedGeometryBytesForScene,
  isEditorModelPlaceholder,
} from "./glb-anim";
import { cssCanvasPixelSize, snapCanvasDrawingBuffer } from "./canvas-drawing-buffer";
import { actorFramingRadius, actorFramingTarget } from "./actor-framing";
import {
  isSkyboxMesh,
} from "./skybox";
import {
  applySceneEnvironment as applySerializedSceneEnvironment,
  AUTHORED_LIGHT_PREFIX,
  refreshAuthoredCameraLenses,
  syncAuthoredCamerasFromMeshes,
  syncAuthoredAreaLightsFromMeshes,
} from "./scene-illumination";
import { setupDefaultViewport } from "./viewport";
import { RenderScheduler } from "./render-scheduler";
import {
  bindResourceCacheToHandle,
  acquireMaterialTexture,
  releaseResourceCacheForEngine,
  resourceCacheForEngine,
  type TextureResources,
} from "./resource-cache";
import { HardwareScalingController, type FramePressureSample } from "./hardware-scaling";
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
import {
  SnapshotInterpolator,
  writeSampledAudioPoses,
  type SampledAudioPose,
} from "./snapshot-sync";
import {
  applySnapshotToScene,
  applyAssignMaterial,
  applyAttachToBone,
  applySetMaterialParameter,
  applyAssignMesh,
  applyPossessCamera,
  assignedMaterialGuids as listAssignedMaterialGuids,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  disposeWorldOverlayLeftovers,
  refreshPlayActiveCamera,
  retirePlaySlot,
  retirePlayWorldSlots,
  migratePlaySlotVisual,
  playComponentMeshName,
  type SnapshotSceneBinding,
} from "./snapshot-apply";
import { applyAlbedoTexture, installModelSources, installTextureBytes, type MeshAssetContext } from "./mesh-assets";
import { FontRegistry, type FontAssetEntry } from "./font-registry";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";
import {
  BakedSceneSession,
  type BakedSceneHost,
  type BakedSessionDiagnostics,
} from "./baked-scene-session";
import { applyBoneAttachmentAudioPoses } from "./bone-attachment";
import { pickAtCanvas } from "./picking";
import { mapCanvasPointer } from "./pick-coords";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { attachPlayCursor } from "./play-cursor";
import {
  applyOverlayPointer,
  createOverlayPointerState,
  type OverlayPointerPhase,
} from "./scene-layer-pointer";
import {
  sceneLayerFrustumSize,
  walkOverlayPointerHits,
} from "@babylonslate/core";
import { meshNamesInCanvasRect } from "./two-d";
import { applyPixelArtSamplingToScene } from "./pixel-perfect";
import { updateSceneTilemapAnimations } from "./tilemap-mesh";
import { EditorDebugOverlay } from "./editor-debug-overlay";
import { beginEngineDrawCallFrame, readEngineDrawCalls } from "./draw-calls";
import { MaterialLibrary } from "./material-library";
import {
  attachPostProcessStack,
  normalizePostProcessStack,
  probePostProcessDeviceBuffers,
  type AttachedPostProcessStack,
  type PostProcessStackDiagnostic,
  type PostProcessStackInput,
} from "./post-process-material";
import { PostProcessRetirement } from "./post-process-retirement";
import type { AudioLibrary } from "./audio-service";
import { AudioService } from "./audio-service";
import type { ParticleLibrary } from "./particle-service";
import { ParticleService } from "./particle-service";
import { acquireParticleMaterial } from "./particle-material";
import type { AudioPlaybackBackend } from "./audio-playback-backend";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { BabylonAudioPlaybackBackend } from "./babylon-audio-backend";
import { createRttCanvasPresent } from "./rtt-canvas-present";
import { admitRegisteredViewFrames, registeredViewIsEnabled, retainOffscreenFrameDispatch, setRegisteredViewEnabled } from "./registered-view-admission";
import { configureCutoutSorting, configureEditorRenderingGroups } from "./sorting";
import {
  applyEditorMaterialFreeze,
  freezeEditorActiveMeshes,
  isSceneFrameReady,
  pendingSceneTextures,
  prewarmSceneMaterials as warmSceneMaterials,
  SCENE_LOOKUP_MAPS,
  SCENE_SHADER_WARM_TIMEOUT_MS,
} from "./scene-perf";
import { nodeMaterialTexturesSampleReady } from "./material-compiler";

export interface EditorSceneLoadOptions {
  signal: AbortSignal;
  assets?: MeshAssetContext;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  /** Project asset guid of the loaded Scene document (bake manifest `sceneGuid`). */
  sceneAssetGuid?: string;
  onProgress?: (progress: number) => void;
}

export interface EngineHandle {
  engine: AbstractEngine;
  scene: Scene;
  scheduler: RenderScheduler;
  resourceCache: TextureResources;
  scaling: HardwareScalingController;
  dispose: () => void;
  /**
   * Confirmed native release of every retired owner (native stack generations,
   * world renderer, layer compositor). Resolves after `dispose()` once actual
   * release is confirmed; rejects when release never confirmed and the shared
   * owners are quarantined.
   */
  whenReleased: () => Promise<void>;
  resize: () => void;
  setSize: (width: number, height: number) => void;
  loadScene: (
    sceneData: SerializedScene,
    options?: { sceneAssetGuid?: string },
  ) => void;
  /** Blocking editor realization; callers keep the view obstructed until readiness. */
  loadSceneAsync: (sceneData: SerializedScene, options: EditorSceneLoadOptions) => Promise<void>;
  /** Push a worker snapshot and invalidate the viewport. */
  pushSnapshot: (buffer: Float32Array) => void;
  /** Apply a structural command (spawn/assignMesh) from the game worker. */
  applyCommand: (command: CommandMessage) => void;
  setPaused: (paused: boolean) => void;
  /** Enable or disable this canvas's `registerView` client (overlay Play). */
  setRegisterViewEnabled: (enabled: boolean) => void;
  /** Live Babylon mesh/texture counts for Play leak assertions. */
  liveObjectCounts: () => { meshes: number; textures: number };
  /** Last rendered frame's Babylon draw-call count (`_drawCalls.current`). */
  drawCalls: () => number;
  renderDiagnostics: () => RenderDiagnostics;
  renderPathStatus: () => ResolvedRenderingPipeline;
  scalabilityStatus: () => ScalabilityAcknowledgement | undefined;
  /** Non-persistent game-wide session render path request; null resumes the project path. */
  setRenderPath: (renderPath: RenderPath | null) => void;
  /** Accounted GPU vertex+index bytes for this Scene's GLB cache. */
  accountedGeometryBytes: () => number;
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
  /** Material names on Play meshes and GLB descendants (Preview e2e). */
  playMeshMaterialNames: () => string[];
  /** Baked-lighting session state for player/editor diagnostics. */
  bakedSessionDiagnostics: () => BakedSessionDiagnostics;
  /**
   * Bind the baked-lighting session for an already-realized scene. Scene
   * switches go through `loadScene`; hosts whose boot scene never reloads
   * (the active-scene early return) call this so the bake still applies.
   */
  applyBakedSession: (
    sceneData: SerializedScene,
    sceneAssetGuid?: string,
  ) => void;
  /** Compiled effect defines per Play mesh (e2e shader-state readout). */
  playMeshMaterialDefines: () => Array<{
    mesh: string;
    material: string | null;
    defines: string;
  }>;
  /** Sprite/tilemap textures and GLB bytes for editor + Play mesh builders. */
  setMeshAssets: (assets: MeshAssetContext) => void;
  /** Project render mode and defaults; scene overrides remain independent. */
  setRenderSettings: (settings: RenderShadingSettings) => void;
  /** Register FontFace source bytes before Bitmap 2D Text paints. */
  registerFonts: (entries: readonly FontAssetEntry[]) => Promise<void>;
  /** Play/editor environment (clear, fog, IBL) without rebuilding actor meshes. */
  applySceneEnvironment: (sceneData: SerializedScene) => void;
  /** Overlay Play SceneLayer scenes, back to front. */
  sceneLayerScenes: () => Array<{
    layerId: string;
    scene: Scene;
    zOrder: number;
  }>;
  /** Authored camera post-process passes currently attached. */
  postProcessPassCount: () => number;
  /** Prepared FrameGraph task names in record order, or [] on classic. */
  renderTaskNames: () => string[];
  /** Unique Material guids currently assigned to Play meshes. */
  assignedMaterialGuids: () => string[];
  /** Diagnostics from the last stack rebuild (missing buffers, failed compiles). */
  postProcessDiagnostics: () => readonly PostProcessStackDiagnostic[];
  /** Local Engine Settings gate. Does not mutate the scene document. */
  setPostProcessingEnabled: (enabled: boolean) => void;
  /** Explicit local quality preferences; runtime commands take precedence. */
  setLocalQualityOverrides: (overrides: import("@babylonslate/core").QualityOverrides) => void;
  /** Live Engine Settings texture LRU budget. */
  setTextureBudget: (bytes: number, enabled: boolean) => void;
  /** Live Engine Settings decoded-PCM LRU (Play only). */
  setAudioBudget: (bytes: number, enabled: boolean) => void;
  /** Live Engine Settings max concurrent voices (Play only). */
  setMaxVoices: (maxVoices: number) => void;
  setPostProcessStack: (stack: readonly PostProcessStackInput[]) => void;
  setMaterialDocuments: (
    documents: ReadonlyMap<string, MaterialDocument>,
    functions?: ReadonlyMap<string, MaterialFunctionDocument>,
  ) => void;
  /** Material asset guids whose editor tab is open — those stay unfrozen. */
  setEditingMaterialGuids: (guids: ReadonlySet<string>) => void;
  /** Compile shaders before the first editor draw (scene-load warm). */
  prewarmSceneMaterials: (owner?: SceneLayerLoadIdentity) => Promise<void>;
  /** Present one loading frame without resuming normal paused/obstructed drawing. */
  presentFirstFrame: (owner?: SceneLayerLoadIdentity) => Promise<void>;
  /** Unlock AudioV2 after a user gesture and drain the pre-unlock queue. */
  unlockAudio: () => Promise<void>;
  /** Clear session mixer volumes and stop voices (scene change / Play stop). */
  resetAudioSession: () => void;
  /** Dispose live particle systems (scene change / Play stop). GPU stop still draws leftovers. */
  resetParticleSession: () => void;
  /** Debug free camera is the Play active camera. */
  isFreeCamEnabled: () => boolean;
  /** Fly the Play free camera; no-op while it is off. */
  steerPlayFreeCam: (forward: number, right: number) => void;
  /** Resolves when editor or Play GLB instantiations from the last apply have finished. */
  whenEditorModelsReady: (owner?: SceneLayerLoadIdentity) => Promise<void>;
  /** Resolves when library NodeMaterials can sample authored textures (or timeout). */
  whenMaterialTexturesReady: (owner?: SceneLayerLoadIdentity) => Promise<void>;
  /** Snapshot/editor GLB loads currently tracked (including settled promises). */
  modelLoadCount: () => number;
}

export interface CreateEngineOptions {
  /** Existing app-lifetime engine; when set, this canvas is registerView'd. */
  sharedEngine?: AbstractEngine;
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
  /** Document viewport identity for scoped editor commands. */
  editorViewportId?: string;
  /** Session-only studio lights for isolated editor asset previews. */
  previewLighting?: boolean;
  viewportMode?: ViewportMode;
  /** Navigation debug geometry follows the physics world, independently of the camera view. */
  physicsWorld?: PhysicsWorldKind;
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
  /**
   * SceneLayer / overlay-prefab viewports: 2D transform box instead of
   * Position/Rotation/Scale gizmos. World 2D scenes stay on axis gizmos.
   */
  overlayTransformBox?: boolean;
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
  renderSettings?: Partial<RenderProjectSettings>;
  onScalabilityApplied?: (acknowledgement: ScalabilityAcknowledgement) => void;
  onRuntimeOutputChanged?: (settings: RenderProjectSettings) => void;
  /** Plain scene-owned requested/effective selection, emitted only when it changes. */
  onRenderPathChanged?: (status: ResolvedRenderingPipeline) => void;
  /** Sprite asset payloads keyed by guid so Play can bake clip UVs from animState. */
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  /** Tilemap / tileset payloads for Play chunk meshes. */
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  pixelsPerUnit?: number;
  sortingLayers?: readonly string[];
  /** Overlay 2DButton pick floor in CSS pixels (Engine Settings `touchMinTargetPx`). */
  touchMinTargetPx?: number;
  /** Project `twoD.pixelPerfect` — snap the Play camera, not the editor camera. */
  pixelPerfect?: boolean;
  /** Texture pixels keyed by Texture asset guid. */
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>;
  areaEmissions?: MeshAssetContext["areaEmissions"];
  /** Authored Texture source pixels for overlay 2DTexture world size. */
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  /** Facetype JSON bytes keyed by Font asset guid (3D Text). */
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  /** MSDF bmfont JSON keyed by Font asset guid (overlay 2D Text). */
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  /** MSDF atlas PNG keyed by Font asset guid. */
  fontMsdfPng?: ReadonlyMap<string, Uint8Array>;
  /** CSS font stack when no Font is picked. */
  fontCssStack?: string;
  /** Per-Font compiled CSS stacks for Bitmap 2D Text. */
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  /** FontFace source bytes for Bitmap 2D Text. */
  fontFaceEntries?: readonly FontAssetEntry[];
  /** Model source bytes keyed by Model asset guid. */
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  /** Model payloads (material slots / clip names) keyed by Model asset guid. */
  modelPayloads?: ReadonlyMap<
    string,
    import("@babylonslate/assets").ModelPayload
  >;
  /** Native clipName → Animation guid, keyed by Model guid. */
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Retargeted Animation loads keyed by the actor (target) Model guid. */
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly import("@babylonslate/assets").RetargetAnimationLoad[]
  >;
  /** Self-hosted KTX2 transcoder directory. Editor uses `/ktx2/`; the player uses a relative folder. */
  ktx2BasePath?: string;
  /** Self-hosted Draco glTF decoder directory. Editor uses `/draco/`. */
  dracoBasePath?: string;
  /** Self-hosted meshopt glTF decoder directory. Editor uses `/meshopt/`. */
  meshoptBasePath?: string;
  /** Compiled Material documents keyed by asset guid. */
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  /** Material Function documents keyed by asset guid. */
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  /**
   * Reads BakedLighting / BakedGeometry assets from this host's asset source
   * (project registry, packed game container). Without it, assigned baked
   * lighting releases instead of applying.
   */
  bakeAssetReader?: BakeRuntimeAssetReader;
  /** Authored scene post-process stack. */
  postProcessStack?: readonly PostProcessStackInput[];
  /**
   * Local Engine Settings gate (default on). Skips attaching the authored
   * stack without mutating scene documents.
   */
  postProcessingEnabled?: boolean;
  textureByteCeiling?: number;
  textureBudgetEnabled?: boolean;
  audioByteCeiling?: number;
  audioBudgetEnabled?: boolean;
  audioMaxVoices?: number;
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
  onMaterialDiagnostic?: (diagnostic: {
    code: string;
    message: string;
    severity?: string;
    nodeId?: string;
  }) => void;
  /** Baked navmesh bytes for Play `shownav`. */
  navmeshBytes?: Uint8Array | null;
  /** NavMesh Blocker volumes drawn with Play `shownav`. */
  navBlockers?: readonly NavDebugBlockerPose[] | null;
  /** Overlay 2DButton graph events (Play compositor). */
  onSceneLayerPointer?: (event: {
    layerId: string;
    actorGuid: string;
    event:
      | "onMouseEnter"
      | "onMouseLeave"
      | "onClick"
      | "onPressStart"
      | "onPressEnd";
    componentId?: string;
  }) => void;
  /** Overlay 2DAnchor frustum in world units (height 9, width 9 * aspect). */
  onSceneLayerResize?: (size: {
    frustumWidth: number;
    frustumHeight: number;
    canvasWidth: number;
    canvasHeight: number;
  }) => void;
  /** Finished non-looping AudioComponent voice (Play graph On Audio Finished). */
  onAudioVoiceEnded?: (voiceId: string) => void;
}

export interface EditorTools {
  camera: EditorCameraController;
  gizmos: GizmoHost;
  grid: EditorGrid;
  selection: SceneOutlineSelection;
  sync: EditorSceneSync;
  setViewportMode: (mode: ViewportMode) => void;
  /** Session overlay: PBR / Unlit / Wireframe. */
  setViewportShadingMode: (mode: ViewportShadingMode) => void;
  /** Session MeshComponent collision dashes (default off). */
  setDrawMeshCollision: (enabled: boolean) => void;
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
  /** Pure collision query; the caller commits the resulting authored transforms. */
  dropSelectedActors: (actorIds: readonly string[], maxDistance?: number) => EditorDropTransform[];
  /** Frustum / light / audio debug + 1 Hz camera preview for the current selection. */
  syncSelectionDebug: (options: {
    sceneData: SerializedScene | null;
    selectedActorIds: readonly string[];
    selectedComponentIds?: readonly string[];
    audioLibrary?: Pick<AudioLibrary, "audio" | "attenuations">;
  }) => void;
  setPreviewCanvas: (canvas: HTMLCanvasElement | null) => void;
  frameActor: (actorId: string) => void;
  /** Live local TRS of each selection-root mesh after a gizmo drag. */
  selectedActorTransforms: () => Array<{
    actorId: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    text2dWrap?: { wrapWidth: number; wrapHeight: number };
  }>;
  /** Live transform of the gizmo-attached mesh, for turning a drag into a command. */
  attachedActorTransform: () => {
    actorId: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    text2dWrap?: { wrapWidth: number; wrapHeight: number };
  } | null;
  /** Preview the named Default Camera without replacing the stored orbit pose. */
  setPreviewGameCamera: (enabled: boolean) => void;
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
    typeof (globalThis as { AudioContext?: unknown }).AudioContext ===
      "function";
  if (!hasAudioContext) return new FakeAudioPlaybackBackend();
  return new BabylonAudioPlaybackBackend();
}

/**
 * Creates an editor or Play view. Prefer one Engine for the open project and
 * pass it via `sharedEngine` + registerView for Scene / Play canvases.
 * ResourceCache is keyed on that Engine (`resourceCacheForEngine`); shared
 * handles release their retains on dispose and must not dispose the cache.
 */
export function createEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions = {},
): EngineHandle {
  const rollback: Array<() => void> = [];
  try {
    return initializeEngine(canvas, options, (cleanup) => rollback.push(cleanup));
  } catch (error) {
    // Construction can fail before a handle exists. Release every acquired
    // owner even if one cleanup also fails, preserving the construction error.
    const failures: unknown[] = [error];
    for (const cleanup of rollback.reverse()) {
      try { cleanup(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Scene construction and rollback failed.", { cause: error });
    throw error;
  }
}

function initializeEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions,
  onRollback: (cleanup: () => void) => void,
): EngineHandle {
  configureKtx2Transcoder(KhronosTextureContainer2, options.ktx2BasePath);
  configureGltfMeshDecoders(DracoDecoder, MeshoptCompression, {
    dracoBasePath: options.dracoBasePath,
    meshoptBasePath: options.meshoptBasePath,
    playMode: options.playMode === true,
  });

  const ownsEngine = !options.sharedEngine;
  const presentRtt = options.present === "rtt";
  // The visible bitmap must survive skipped/loading frames and backend RTT
  // work. Keep owned browser engines on a private constructor canvas, using
  // the same admitted native view copy as project-shared handles.
  const visibleContext = typeof canvas.getContext === "function" &&
    (options.sharedEngine || typeof document !== "undefined")
    ? canvas.getContext("2d") : null;
  const constructorCanvas = ownsEngine && visibleContext && typeof document !== "undefined"
    ? document.createElement("canvas") : canvas;
  const engine =
    options.sharedEngine ??
    new Engine(constructorCanvas, false, {
      preserveDrawingBuffer: true,
      stencil: true,
      adaptToDeviceRatio: false,
      antialias: false,
      useLargeWorldRendering: true,
      useExactSrgbConversions: true,
    });
  if (ownsEngine) {
    engine.inputElement = canvas;
    onRollback(() => engine.dispose());
    onRollback(() => releaseResourceCacheForEngine(engine));
  }
  // Include utility scenes created inside helpers before those helpers return.
  const previousScenes = new Set([...engine.scenes, ...engine._virtualScenes]);
  onRollback(() => {
    const failures: unknown[] = [];
    for (const owned of [...engine.scenes, ...engine._virtualScenes]) {
      if (!previousScenes.has(owned) && !owned.isDisposed) {
        try { owned.dispose(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, "Failed to release constructed scenes.");
  });
  const previousViews = new Map((engine.views ?? []).map((view) => [view, registeredViewIsEnabled(view)]));
  onRollback(() => {
    const failures: unknown[] = [];
    for (const view of [...(engine.views ?? [])]) {
      if (!previousViews.has(view)) {
        try { engine.unRegisterView(view.target); } catch (error) { failures.push(error); }
      }
    }
    for (const [view, enabled] of previousViews) setRegisteredViewEnabled(view, enabled);
    if (failures.length) throw new AggregateError(failures, "Failed to release constructed views.");
  });
  const previousScaling = engine.getHardwareScalingLevel();
  onRollback(() => engine.setHardwareScalingLevel(previousScaling));
  const releasePlayRenderPath = options.playMode ? retainPlayRenderPathSession(engine) : null;
  onRollback(() => releasePlayRenderPath?.());
  configureKtx2DecoderRuntime(KhronosTextureContainer2, {
    mainThread: options.playMode === true,
    caps: engine.getCaps(),
    renderer: (
      engine as { getGlInfo?: () => { renderer?: string } }
    ).getGlInfo?.().renderer,
  });

  const sharedViewBlit = !presentRtt && visibleContext &&
    (options.sharedEngine || constructorCanvas !== canvas);
  // clearBeforeCopy: overlay is a 2D blit of the WebGL canvas; without a
  // clear, skipped render-on-demand frames composite additively.
  const registeredView = sharedViewBlit
    ? engine.registerView(canvas, undefined, true)
    : null;
  const releaseOffscreenDispatch = presentRtt ? retainOffscreenFrameDispatch(engine) : null;
  onRollback(() => releaseOffscreenDispatch?.());
  if (registeredView && options.playMode) {
    // Scene tabs stay mounted; Babylon _renderViews still setSize+blit every
    // enabled view. Disable them so overlay Play owns the framebuffer.
    setOtherEngineViewsEnabled(engine, canvas, false);
  }

  const scene = new Scene(engine, SCENE_LOOKUP_MAPS);
  // Every view shares the same graph path for authored and selection outlines.
  // The graph owns its active queue; editor world matrices still freeze.
  const worldRenderer = new SceneRenderCoordinator(scene);
  onRollback(() => worldRenderer?.dispose());
  let disposed = false;
  let releasedHandle: Promise<void> | null = null;
  let contextLost = false;
  let loadGeneration = 0;
  let worldLoading = false;
  let worldLoadId = 0;
  let worldSceneAssetGuid: string | null = null;
  const layerLoads = new Map<string, { loadId: number; ready: boolean }>();
  type PendingPresentation = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    ready: boolean;
    attempts: number;
    rendered: boolean;
    owner?: SceneLayerLoadIdentity;
    submission: ReturnType<typeof submitPresentedFrame> | null;
    copied: boolean;
    completionStarted: boolean;
  };
  const pendingPresentations = new Map<string, PendingPresentation>();
  const frameOwners = new Map<string, PendingPresentation>();
  const presentationKey = (owner?: SceneLayerLoadIdentity) => owner ? `layer:${owner.layerId}` : "world";
  const cancelPresentation = (error: Error, key?: string) => {
    for (const [id, pending] of pendingPresentations) {
      if (key !== undefined && id !== key) continue;
      pendingPresentations.delete(id);
      clearTimeout(pending.timer);
      pending.submission?.cancel();
      pending.reject(error);
    }
  };
  const expirePresentation = (key: string) => {
    const pending = pendingPresentations.get(key);
    if (!pending) return;
    cancelPresentation(new Error(`The scene did not present a frame before the loading deadline. Ready: ${pending.ready}; draws: ${pending.attempts}; rendered: ${pending.rendered}; GPU pending: ${Boolean(pending.submission)}; copied: ${pending.copied}.`), key);
  };
  const assertCurrent = (generation: number) => {
    if (disposed || scene.isDisposed || generation !== loadGeneration) {
      throw new Error("Scene loading was superseded or disposed.");
    }
    if (contextLost) throw new Error("Rendering context was lost during scene loading.");
  };
  onRollback(() => {
    disposed = true;
    loadGeneration += 1;
    cancelPresentation(new Error("Scene construction failed."));
  });
  setSceneRenderSettings(scene, options.renderSettings ?? {});
  const unsubscribeRenderPath = options.onRenderPathChanged
    ? subscribeSceneRenderPath(scene, options.onRenderPathChanged) : () => {};
  onRollback(unsubscribeRenderPath);
  // A game-wide session render path request re-keys this view's shader and
  // presentation admission exactly like a project render-settings change.
  const unsubscribeRenderPathSession = subscribeRenderPathSession(engine, () => {
    worldRenderer?.invalidate();
    scheduler.invalidate("asset");
  });
  onRollback(unsubscribeRenderPathSession);
  configureCutoutSorting(scene);
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
  if (options.editor && !options.playMode && options.previewLighting) {
    createPreviewLighting(scene);
  }
  if (presentRtt) {
    // RTT clear targets the preview buffer, not Scene/Play's framebuffer.
    scene.autoClear = true;
  }

  const rttPresent = presentRtt
    ? createRttCanvasPresent(scene, canvas, { name: "prefabPreview" })
    : null;
  onRollback(() => rttPresent?.dispose());

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
  let frameCopyReady = false;
  let frameWasLoading = false;
  const presentationStats = {
    attempted: 0, drawn: 0, copied: 0, held: 0,
    preparationMs: 0, copyMs: 0,
    contextLosses: 0, contextRestorations: 0,
  };
  let captureFramePhases = false;
  const outlineHost = new SceneOutlineHost(scene, worldRenderer, () => scheduler.invalidate("selection"));
  onRollback(() => outlineHost.dispose());
  let lockedViewSize: { width: number; height: number } | null = null;
  const scaledLockedViewSize = () => lockedViewSize ? {
    width: Math.max(1, Math.floor(lockedViewSize.width / engine.getHardwareScalingLevel())),
    height: Math.max(1, Math.floor(lockedViewSize.height / engine.getHardwareScalingLevel())),
  } : null;
  const syncLockedViewSize = () => {
    const size = scaledLockedViewSize();
    if (size && (engine.getRenderWidth(true) !== size.width || engine.getRenderHeight(true) !== size.height)) engine.setSize(size.width, size.height);
  };
  let runtimeScalability: RuntimeScalability | undefined;
  let lastScalabilityStatus: ScalabilityAcknowledgement | undefined;
  const hasLoadingFrame = () => [...pendingPresentations.values()].some((pending) => !pending.copied && presentationReady(pending)) && scheduler.canPresentLoadingFrame();
  const hasPendingOwners = () => worldLoading || [...layerLoads.values()].some((layer) => !layer.ready);
  const hasReadyContent = () => !worldLoading || (sceneLayerCompositor?.layers().some((layer) => layerLoads.get(layer.layerId)?.ready !== false) ?? false);
  const shouldRenderFrame = (now: number) => (worldLoading || runtimeScalability?.canPresent !== false) && !rttPresent?.isPresenting() && (hasLoadingFrame() || (hasReadyContent() &&
    (hasPendingOwners() ? scheduler.shouldRenderReadyOwners(now) : scheduler.shouldRender(now))));
  const releaseViewAdmission = registeredView ? admitRegisteredViewFrames(engine, registeredView, () =>
    {
      if (disposed || contextLost) return false;
      if (!worldLoading) runtimeScalability?.advance();
      // Prepare against this view's private-buffer dimensions before Babylon
      // resizes its visible canvas. A pending graph must retain that bitmap.
      if (worldRenderer) {
        const css = cssCanvasPixelSize(canvas);
        const scale = engine.getHardwareScalingLevel();
        const size = scaledLockedViewSize() ?? {
          width: Math.max(1, Math.floor(css.width / scale)),
          height: Math.max(1, Math.floor(css.height / scale)),
        };
        if (engine.getRenderWidth(true) !== size.width || engine.getRenderHeight(true) !== size.height)
          engine.setSize(size.width, size.height);
      }
      prepareSnapshot();
      return shouldRenderFrame(performance.now());
    }, {
      begin: () => { frameCopyReady = false; },
      canCopy: () => frameCopyReady && !disposed && !contextLost,
      copied: (milliseconds) => {
        presentationStats.copyMs = milliseconds;
        acknowledgeFrameCopy();
      },
    }) : null;
  onRollback(() => releaseViewAdmission?.());
  if (options.editor) {
    scheduler.setAlwaysRender(true);
  }
  if (options.frameCap !== undefined) {
    scheduler.setFrameCap(options.frameCap);
  }
  const releasePlayLoop = options.playMode
    ? scheduler.acquireContinuous("play")
    : null;
  onRollback(() => releasePlayLoop?.());
  const sharedCache = resourceCacheForEngine(engine);
  const cacheBinding = bindResourceCacheToHandle(sharedCache);
  const resourceCache = cacheBinding.cache;
  onRollback(() => cacheBinding.dispose());
  onRollback(() => { if (!scene.isDisposed) scene.dispose(); });
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
        onVoiceEnded: options.onAudioVoiceEnded,
        loadSourceBytes: options.loadAudioSourceBytes,
        maxVoices: options.audioMaxVoices,
      })
    : null;
  onRollback(() => audioService?.dispose());
  if (audioService) {
    if (
      typeof options.audioByteCeiling === "number" ||
      typeof options.audioBudgetEnabled === "boolean"
    ) {
      audioService.setAudioBudget(
        typeof options.audioByteCeiling === "number"
          ? options.audioByteCeiling
          : 256 * 1024 * 1024,
        options.audioBudgetEnabled !== false,
      );
    }
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
  onRollback(() => disposeSnapshotBinding(binding));
  binding.tilemaps = options.tilemapPayloads;
  binding.tilesets = options.tilesetPayloads;
  binding.pixelsPerUnit = options.pixelsPerUnit;
  binding.sortingLayers = options.sortingLayers;
  binding.pixelPerfect = options.pixelPerfect === true;
  binding.spritePayloads = options.spritePayloads;
  binding.spriteAnimations = options.spriteAnimations;
  binding.textureBytes = installTextureBytes(options.textureBytes);
  binding.areaEmissions = options.areaEmissions;
  binding.texturePixelSizes = options.texturePixelSizes;
  binding.fontFacetypeBytes = options.fontFacetypeBytes;
  binding.fontMsdfJson = options.fontMsdfJson;
  binding.fontMsdfPng = installTextureBytes(options.fontMsdfPng);
  binding.fontCssStack = options.fontCssStack;
  binding.fontCssStackByGuid = options.fontCssStackByGuid;
  const fontRegistry = new FontRegistry();
  binding.modelBytes = options.modelBytes;
  binding.modelSources = installModelSources(options);
  binding.modelPayloads = options.modelPayloads;
  binding.modelClipAnimationGuids = options.modelClipAnimationGuids;
  binding.retargetAnimationLoads = options.retargetAnimationLoads;
  binding.resourceCache = resourceCache;
  binding.slotAnimReady = () => {
    appliedSnapshotIdentity = null;
    scheduler.invalidate("snapshot");
  };

  const playFreeCam: PlayFreeCamController | null = options.playMode
    ? createPlayFreeCamController(scene, {
        binding,
        mode: options.viewportMode ?? "3d",
      })
    : null;
  onRollback(() => playFreeCam?.dispose());
  const playFreeCamInput: PlayFreeCamInputHandle | null = playFreeCam
    ? attachPlayFreeCamInput(canvas, playFreeCam, {
        mode: options.viewportMode ?? "3d",
      })
    : null;
  onRollback(() => playFreeCamInput?.dispose());
  const playViz: PlayConsoleVizController | null = options.playMode
    ? createPlayConsoleViz(scene, {
        navmeshBytes: options.navmeshBytes,
        navBlockers: options.navBlockers,
        world: options.physicsWorld ?? options.viewportMode,
      })
    : null;
  onRollback(() => playViz?.dispose());
  const playDebugDraw: PlayDebugDrawController | null = options.playMode
    ? createPlayDebugDraw(scene)
    : null;
  onRollback(() => playDebugDraw?.dispose());

  const materialDocuments = new Map<string, MaterialDocument>(
    options.materialDocuments ?? [],
  );
  const materialFunctions = new Map<string, MaterialFunctionDocument>(
    options.materialFunctions ?? [],
  );
  binding.materialTextureGuids = materialTextureGuidMap(materialDocuments);
  const editingMaterialGuids = new Set<string>();
  const compiledMaterialGuids = new Set<string>();
  binding.compiledMaterialGuids = compiledMaterialGuids;
  const freezeLibraryMaterials = (): void => {
    if (options.playMode) return;
    applyEditorMaterialFreeze(scene, editingMaterialGuids);
  };
  const materialLibrary = new MaterialLibrary({
    textureIdentity: (guid) => { const source = binding.textureBytes?.get(guid); return source ? assetByteFingerprint(source) : undefined; },
    functions: () => Object.fromEntries(materialFunctions),
    acquireTexture: (guid) => {
      const bytes = binding.textureBytes?.get(guid);
      if (!bytes) return null;
      return acquireMaterialTexture(resourceCache, guid, engine, bytes);
    },
    onTextureError: (diagnostic) => {
      options.onMaterialDiagnostic?.(diagnostic);
    },
    onMaterialReady: (materialScene) => {
      // Babylon completes deferred post-process effects on the attached pass.
      // Rebuilding here releases the ready material and starts compilation again.
      if (materialScene === scene) editorSync?.refreshMaterials();
      scheduler.invalidate("asset");
    },
  });
  onRollback(() => materialLibrary.dispose());
  binding.resolveMaterial = (guid, options) => {
    const host = options?.scene ?? scene;
    const document = materialDocuments.get(guid);
    if (!document) return null;
    const material = materialLibrary.resolve(host, guid, document, options);
    if (!material) return null;
    if (materialLibrary.isReady(host, guid, document, options)) compiledMaterialGuids.add(guid);
    else compiledMaterialGuids.delete(guid);
    return material;
  };
  binding.releaseMaterialInstance = (key, assetGuid) =>
    materialLibrary.releaseInstance(key, assetGuid);
  binding.validateMaterialParameter = (guid, name, value) => {
    const document = materialDocuments.get(guid);
    return (
      !!document && materialLibrary.acceptsParameter(document, name, value)
    );
  };

  const particleService = options.playMode
    ? new ParticleService({
        scene,
        acquireTexture: (guid) => {
          const bytes = binding.textureBytes?.get(guid);
          if (!bytes) return null;
          return acquireMaterialTexture(resourceCache, guid, engine, bytes, { hasAlpha: true });
        },
        acquireMaterial: (guid, owner) => {
          const document = materialDocuments.get(guid);
          return document ? acquireParticleMaterial(materialLibrary, guid, document, owner) : null;
        },
        resolveEmitter: (slotId) => binding.meshes.get(slotId) ?? null,
        onDiagnostic: options.onParticleDiagnostic,
      })
    : null;
  onRollback(() => particleService?.dispose());
  binding.slotVisualReady = (slotId, successor) => {
    // Move emitter nodes before recursive retirement of the old visual root.
    particleService?.bindSlot(slotId, successor);
    queueMicrotask(() => {
      if (successor.isDisposed() || binding.meshes.get(slotId) !== successor) return;
      appliedSnapshotIdentity = null;
      const pending = binding.pendingAnimState?.get(slotId);
      if (pending) applyAnimStateToScene(sceneAnimHostFromBinding(binding, {
        animationGroups: successor.getScene().animationGroups,
        spritePayloads: binding.spritePayloads ?? options.spritePayloads,
        spriteAnimations: binding.spriteAnimations ?? options.spriteAnimations,
        applyTexture: (mesh, guid) => applyAlbedoTexture(mesh, mesh.getScene(), guid, binding),
      }), pending);
      scheduler.invalidate("snapshot");
    });
  };

  if (particleService && options.particleLibrary) {
    particleService.setLibrary(options.particleLibrary);
  }

  let postProcessingEnabled = options.postProcessingEnabled !== false;
  let postProcessStack = normalizePostProcessStack(
    options.postProcessStack ?? [],
  );
  const postProcessParameters = new PostProcessParameterState();
  let attachedStack: AttachedPostProcessStack | null = null;
  let materialDocumentsKey = "";
  let materialRevision = 0;
  let appliedPostProcessKey: string | undefined;
  let appliedPostProcessCamera: Camera | null = null;
  // Every retired native stack generation stays tracked until actual release,
  // not just the one current at teardown.
  const nativeRetirement = new PostProcessRetirement();
  const retireAttachedStack = () => {
    const stack = attachedStack;
    attachedStack = null;
    if (!stack) return;
    try {
      stack.dispose();
    } finally {
      nativeRetirement.add(stack);
    }
  };
  onRollback(retireAttachedStack);
  // Native mirror of the settings-driven effect chain for hosts without a
  // SceneRenderCoordinator; coordinator hosts drive their own copy.
  const sceneEffectsOwner = new SceneEffectsOwner(scene);
  onRollback(() => {
    try {
      sceneEffectsOwner.dispose();
    } finally {
      nativeRetirement.add(sceneEffectsOwner);
    }
  });
  let lastPostProcessDiagnostics: PostProcessStackDiagnostic[] = [];

  const rebuildPostProcessStack = () => {
    const camera = scene.activeCamera;
    const stack = postProcessParameters.effective(postProcessStack);
    const resolutionScale = resolveSceneRenderingQuality(scene).postprocessing.resolutionScale;
    const key = JSON.stringify([postProcessingEnabled, stack, resolutionScale, materialRevision]);
    if (key === appliedPostProcessKey && camera === appliedPostProcessCamera) return;
    retireAttachedStack();
    appliedPostProcessKey = key;
    appliedPostProcessCamera = camera;
    lastPostProcessDiagnostics = [];
    if (!postProcessingEnabled) {
      if (!worldRenderer) sceneEffectsOwner.useGraph();
      return;
    }
    if (!camera) {
      if (!worldRenderer) sceneEffectsOwner.useGraph();
      return;
    }
    const attach = worldRenderer
      ? worldRenderer.attachPostProcess.bind(worldRenderer)
      : attachPostProcessStack;
    attachedStack = attach({
      scene,
      camera,
      library: materialLibrary,
      stack,
      documentFor: (guid) => materialDocuments.get(guid) ?? null,
      resolutionScale,
      ...(worldRenderer ? {} : { deviceBuffers: probePostProcessDeviceBuffers(scene, camera) }),
      onDiagnostic: (diagnostic) => {
        lastPostProcessDiagnostics.push(diagnostic);
        options.onPostProcessDiagnostic?.(diagnostic);
      },
    });
    // Coordinator hosts own effects inside the graph/classic decision; the
    // pure-native path mirrors the same settings through this owner.
    if (!worldRenderer) sceneEffectsOwner.useNative(camera);
  };

  let appliedQuality: ReturnType<typeof resolveRenderingQuality> | undefined;
  let appliedEffectsKey: string | undefined;
  let appliedProject: unknown;
  let appliedSceneOverrides: unknown;
  let appliedSessionOverrides: unknown;
  let appliedRuntimeOverrides: unknown;
  let appliedLocalOverrides: unknown;
  const applyTextureAnisotropy = (texture: BaseTexture) => {
    const anisotropy = appliedQuality?.textures.anisotropy ?? 4;
    applyMaterialTextureAnisotropy(texture, Math.min(anisotropy, engine.getCaps().maxAnisotropy ?? 1));
  };
  const applyRenderingQuality = () => {
    const state = sceneRenderingSettings(scene);
    if (appliedRuntimeOverrides === state.runtimeOverrides && appliedProject === state.project && appliedSceneOverrides === state.shadowOverrides && appliedSessionOverrides === state.qualityOverrides && appliedLocalOverrides === state.localQualityOverrides) return;
    appliedRuntimeOverrides = state.runtimeOverrides;
    appliedProject = state.project;
    appliedSceneOverrides = state.shadowOverrides;
    appliedSessionOverrides = state.qualityOverrides;
    appliedLocalOverrides = state.localQualityOverrides;
    const quality = resolveSceneRenderingQuality(scene);
    const previous = appliedQuality;
    appliedQuality = quality;
    if (JSON.stringify(previous?.resolution) !== JSON.stringify(quality.resolution)) {
      scaling.configureQuality(quality.resolution);
      syncLockedViewSize();
    }
    if (JSON.stringify(previous?.textures) !== JSON.stringify(quality.textures)) {
      resourceCache.setByteCeiling(quality.textures.byteBudget);
      for (const texture of scene.textures) applyTextureAnisotropy(texture);
    }
    if (previous && previous.postprocessing.resolutionScale !== quality.postprocessing.resolutionScale) {
      rebuildPostProcessStack();
      sceneLayerCompositor?.refreshPostProcess();
    }
    const effectsKey = state.effectsKey;
    if (appliedEffectsKey !== undefined && appliedEffectsKey !== effectsKey) {
      rebuildPostProcessStack();
      worldRenderer?.invalidate();
    }
    appliedEffectsKey = effectsKey;
  };
  // Apply at the host boundary below, never inside Scene.render. WebGPU
  // attachment resizing emits beginFrame and can re-enter view admission.
  scene.onNewTextureAddedObservable.add(applyTextureAnisotropy);

  const sceneLayerCompositor = options.playMode
    ? new SceneLayerCompositor({
        engine,
        postProcessingEnabled: () => postProcessingEnabled,
        isLayerReady: (layerId) => layerLoads.get(layerId)?.ready !== false,
        attachLayerPostProcess: (layer, stack, renderer) => {
          return renderer.attachPostProcess({
            scene: layer.scene,
            camera: layer.camera,
            library: materialLibrary,
            stack: normalizePostProcessStack(stack),
            resolutionScale: appliedQuality?.postprocessing.resolutionScale ?? 1,
            documentFor: (guid) => materialDocuments.get(guid) ?? null,
            onDiagnostic: (diagnostic) => {
              lastPostProcessDiagnostics.push(diagnostic);
              options.onPostProcessDiagnostic?.(diagnostic);
            },
          });
        },
      })
    : null;
  onRollback(() => sceneLayerCompositor?.dispose());
  binding.sceneForSlot = (slotId) =>
    sceneLayerCompositor?.sceneForSlot(slotId) ?? null;
  binding.isOverlaySlot = (slotId) =>
    sceneLayerCompositor?.layerIdForSlot(slotId) != null;
  particleService?.setSceneForSlot(
    (slotId) => binding.isOverlaySlot?.(slotId)
      ? sceneLayerCompositor?.sceneForSlot(slotId) ?? null
      : scene,
  );
  const pendingOverlayAssign = new Map<
    number,
    Extract<CommandMessage, { type: "assignMesh" }>
  >();
  const worldPlaySlots = new Set<number>();
  const syncOverlaySlot = (slotId: number) => {
    if (!sceneLayerCompositor) return;
    const overlayScene = sceneLayerCompositor.sceneForSlot(slotId);
    if (!overlayScene) return;
    const pending = pendingOverlayAssign.get(slotId);
    if (pending) {
      applyAssignMesh(overlayScene, binding, pending);
      pendingOverlayAssign.delete(slotId);
    } else {
      migratePlaySlotVisual(overlayScene, binding, slotId);
    }
    disposeWorldOverlayLeftovers(scene, slotId);
    particleService?.bindSlot(slotId, binding.meshes.get(slotId) ?? null);
  };
  const syncOverlayLayer = (layerId: string) => {
    if (!sceneLayerCompositor) return;
    for (const slotId of sceneLayerCompositor.slotIdsForLayer(layerId)) {
      syncOverlaySlot(slotId);
    }
  };
  const overlayPointerState = createOverlayPointerState();
  const playCursor = options.playMode ? attachPlayCursor(canvas) : null;
  onRollback(() => playCursor?.dispose());

  const notifyOverlayResize = () => {
    if (!sceneLayerCompositor) return;
    const height = Math.max(1, engine.getRenderHeight());
    const width = Math.max(1, engine.getRenderWidth());
    const frustum = sceneLayerFrustumSize(width / height);
    const canvasSize = pointerCanvas();
    options.onSceneLayerResize?.({
      frustumWidth: frustum.width,
      frustumHeight: frustum.height,
      canvasWidth: canvasSize.width,
      canvasHeight: canvasSize.height,
    });
  };
  notifyOverlayResize();

  const dispatchOverlayPointer = (
    phase: OverlayPointerPhase,
    canvasX: number,
    canvasY: number,
  ): boolean => {
    if (!sceneLayerCompositor) return false;
    const mapped = mapCanvasPointer(scene, canvasX, canvasY, pointerCanvas());
    const canvasSize = pointerCanvas();
    const walked = walkOverlayPointerHits(
      sceneLayerCompositor.pickHits(mapped.x, mapped.y, {
        minTargetPx: options.touchMinTargetPx ?? 44,
        canvasCssHeight: canvasSize.height,
      }),
    );
    const events = applyOverlayPointer(
      overlayPointerState,
      phase,
      walked.targets,
    );
    for (const event of events) {
      options.onSceneLayerPointer?.(event);
    }
    return walked.blocked;
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
        freezeActiveMeshes: false,
        resolveMaterial: (guid) => binding.resolveMaterial?.(guid) ?? null,
        onAfterApply: () => { viewportShading?.apply(); syncEditorOutlines(); },
      })
    : null;
  onRollback(() => editorSync?.dispose());
  const syncEditorOutlines = () => {
    const data = editorSync?.serializedScene();
    if (!editorSync || !data) return;
    outlineHost.replaceActors(data.actors.map((actor) => ({ id: actor.id,
      meshes: editorSync.visualMeshesForActor(actor.id), bindings: outlineBindings(actor.id, actor.components) })));
    outlineHost.refreshSettings();
  };
  const outlineActorBySlot = new Map<number, string>();
  const refreshRuntimeOutline = (slotId: number) => {
    if (options.editor) return;
    const root = binding.meshes.get(slotId);
    const authored = binding.outlines.get(slotId);
    const actorId = authored?.actorId ?? binding.meshSorting.get(slotId)?.actorGuid;
    const previous = outlineActorBySlot.get(slotId);
    if (previous && (!root || root.getScene() !== scene || binding.isOverlaySlot?.(slotId))) {
      outlineHost.removeActor(previous); outlineActorBySlot.delete(slotId);
    }
    if (!actorId || !root || root.getScene() !== scene || binding.isOverlaySlot?.(slotId)) return;
    // Runtime transforms are normally world-space. If a caller attaches actor
    // roots, descendants still belong to their own actor's outline identity.
    const otherRoots = new Set([...binding.meshes.values()].filter((mesh) => mesh !== root));
    const meshes = visualMeshes(root, otherRoots);
    outlineHost.setActor(actorId, meshes, authored?.bindings ?? [], previous);
    outlineActorBySlot.set(slotId, actorId);
  };
  binding.onVisualChanged = refreshRuntimeOutline;

  // One bake owner per world Scene. `apply` runs at the end of every scene
  // load; receivers that have not spawned yet (Play command realization) keep
  // the session pending, which withholds strict first-frame admission until
  // the atlas and bindings are confirmed or the bake proves stale.
  const bakedSession = new BakedSceneSession(scene);
  onRollback(() => bakedSession.dispose());
  let lastBakedSceneGuid: string | undefined;
  const playSlotForActor = (actorId: string): number | null => {
    for (const [slotId, sorting] of binding.meshSorting) {
      if (sorting.actorGuid === actorId) return slotId;
    }
    return null;
  };
  const playMeshForComponent = (
    actorId: string,
    componentId: string,
  ): Mesh | null => {
    const slotId = playSlotForActor(actorId);
    if (slotId === null) return null;
    const root = binding.meshes.get(slotId);
    if (!root || root.isDisposed()) return null;
    const named = playComponentMeshName(slotId, componentId);
    const target = [root, ...root.getChildMeshes()].find(
      (mesh) => mesh.name === named,
    );
    if (target instanceof Mesh) return target;
    return binding.primaryComponentIds.get(slotId) === componentId
      ? root
      : null;
  };
  const playLightForComponent = (actorId: string) => {
    const slotId = playSlotForActor(actorId);
    return slotId === null ? null : (binding.lights.get(slotId) ?? null);
  };
  const bakeHost = (
    sceneAssetGuid: string | undefined,
    signal?: AbortSignal,
  ): BakedSceneHost | null => {
    if (!sceneAssetGuid || !options.bakeAssetReader) return null;
    return {
      sceneAssetGuid,
      readAsset: options.bakeAssetReader,
      materials: materialDocuments,
      functions: Object.fromEntries(materialFunctions),
      projectEnvironment:
        sceneRenderingSettings(scene).project.environmentLighting,
      meshForComponent: editorSync
        ? (actorId, componentId) =>
            editorSync.meshForComponent(actorId, componentId)
        : options.playMode
          ? playMeshForComponent
          : (actorId, componentId) =>
              scene.getMeshByName(
                editorComponentMeshName(actorId, componentId),
              ) as Mesh | null,
      lightForComponent: options.playMode
        ? playLightForComponent
        : (actorId) =>
            scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}${actorId}`),
      isCurrent: () => !disposed && !scene.isDisposed,
      signal,
    };
  };

  let lastRenderedSnapshotFrame: number | null = null;
  const installMeshAssets = (assets: MeshAssetContext): MeshAssetContext => {
      binding.resourceCache = assets.resourceCache ?? binding.resourceCache;
      binding.textureBytes = installTextureBytes(assets.textureBytes);
      binding.areaEmissions = assets.areaEmissions;
      let emissionChanged = false;
      for (const group of binding.areaLights.values())
        emissionChanged = group.refreshEmissions(assets.areaEmissions) || emissionChanged;
      if (emissionChanged) {
        worldRenderer?.invalidate();
        scheduler.invalidate("asset");
      }
      binding.texturePixelSizes = assets.texturePixelSizes;
      binding.fontFacetypeBytes = assets.fontFacetypeBytes;
      binding.fontMsdfJson = assets.fontMsdfJson;
      binding.fontMsdfPng = installTextureBytes(assets.fontMsdfPng);
      binding.fontCssStack = assets.fontCssStack;
      binding.fontCssStackByGuid = assets.fontCssStackByGuid;
      binding.modelBytes = assets.modelBytes;
      binding.modelSources = installModelSources(assets);
      binding.modelPayloads = assets.modelPayloads;
      binding.modelClipAnimationGuids = assets.modelClipAnimationGuids;
      binding.retargetAnimationLoads = assets.retargetAnimationLoads;
      binding.spritePayloads = assets.spritePayloads ?? binding.spritePayloads;
      binding.spriteAnimations =
        assets.spriteAnimations ?? binding.spriteAnimations;
      binding.tilemaps = assets.tilemaps ?? binding.tilemaps;
      binding.tilesets = assets.tilesets ?? binding.tilesets;
      binding.sortingLayers = assets.sortingLayers ?? binding.sortingLayers;
      if (assets.materialTextureGuids) {
        binding.materialTextureGuids = assets.materialTextureGuids;
      }
      if (typeof assets.pixelsPerUnit === "number") {
        binding.pixelsPerUnit = assets.pixelsPerUnit;
      }
      return { ...assets, modelSources: binding.modelSources, textureBytes: binding.textureBytes, fontMsdfPng: binding.fontMsdfPng, materialTextureGuids: binding.materialTextureGuids, compiledMaterialGuids };
  };
  const installMaterialDocuments = (
    documents: ReadonlyMap<string, MaterialDocument>,
    functions?: ReadonlyMap<string, MaterialFunctionDocument>,
  ) => {
      const key = JSON.stringify([
        [...documents].sort(([a], [b]) => a.localeCompare(b)),
        [...(functions ?? materialFunctions)].sort(([a], [b]) => a.localeCompare(b)),
      ]);
      if (key === materialDocumentsKey) return false;
      materialDocumentsKey = key;
      materialRevision += 1;
      materialDocuments.clear();
      for (const [guid, document] of documents) {
        materialDocuments.set(guid, document);
      }
      binding.materialTextureGuids = materialTextureGuidMap(materialDocuments);
      if (functions) {
        materialFunctions.clear();
        for (const [guid, document] of functions) {
          materialFunctions.set(guid, document);
        }
      }
      return true;
  };

  const loadSceneAsync = async (sceneData: SerializedScene, load: EditorSceneLoadOptions) => {
    load.signal.throwIfAborted();
    assertCurrent(loadGeneration);
    if (!editorSync) throw new Error("Chunked scene realization requires an editor scene.");
    const generation = ++loadGeneration;
    worldRenderer?.invalidate();
    cancelPresentation(new Error("Scene loading was superseded."), "world");
    if (load.materialDocuments) installMaterialDocuments(load.materialDocuments, load.materialFunctions);
    const assets = load.assets ? installMeshAssets(load.assets) : undefined;
    setSceneRenderSettings(scene, undefined, sceneData.settings.celShading ?? {}, sceneData.settings.shadowOverrides ?? {});
    postProcessParameters.clear();
    appliedPostProcessKey = undefined;
    postProcessStack = normalizePostProcessStack(sceneData.settings.postProcessStack);
    await editorSync.applyAsync(sceneData, { signal: load.signal, assets, onProgress: load.onProgress });
    load.signal.throwIfAborted();
    assertCurrent(generation);
    freezeLibraryMaterials();
    rebuildPostProcessStack();
    lastBakedSceneGuid = load.sceneAssetGuid;
    bakedSession.apply(sceneData, bakeHost(load.sceneAssetGuid, load.signal));
    if (lastSelectedActorIds.length > 0) editor?.setSelectedActors(lastSelectedActorIds);
  };

  const loadScene = (
    sceneData: SerializedScene,
    loadOptions?: { sceneAssetGuid?: string },
  ) => {
    assertCurrent(loadGeneration);
    if (editorSync && loadOptions?.sceneAssetGuid === lastBakedSceneGuid &&
      isTransformOnlySceneEdit(editorSync.serializedScene(), sceneData)) {
      editorSync.apply(sceneData);
      // Poses change bake validity even while rendering topology stays stable.
      bakedSession.apply(sceneData, bakeHost(loadOptions?.sceneAssetGuid));
      return;
    }
    if (editorSync && loadOptions?.sceneAssetGuid === lastBakedSceneGuid &&
      isOutlineOnlySceneEdit(editorSync.serializedScene(), sceneData)) {
      setSceneRenderSettings(scene, undefined, sceneData.settings.celShading ?? {}, sceneData.settings.shadowOverrides ?? {});
      editorSync.apply(sceneData);
      outlineHost.refreshSettings();
      return;
    }
    loadGeneration += 1;
    worldRenderer?.invalidate();
    cancelPresentation(new Error("Scene loading was superseded."), "world");
    setSceneRenderSettings(scene, undefined, sceneData.settings.celShading ?? {}, sceneData.settings.shadowOverrides ?? {});
    postProcessParameters.clear();
    appliedPostProcessKey = undefined;
    postProcessStack = normalizePostProcessStack(
      sceneData.settings.postProcessStack,
    );
    lastBakedSceneGuid = loadOptions?.sceneAssetGuid;
    if (editorSync) {
      editorSync.apply(sceneData);
      freezeLibraryMaterials();
      rebuildPostProcessStack();
      bakedSession.apply(sceneData, bakeHost(loadOptions?.sceneAssetGuid));
      return;
    }
    if (options.playMode) {
      disablePlayFreeCam(playFreeCam);
      interpolator.clear();
      appliedSnapshotIdentity = null;
      lastRenderedSnapshotFrame = null;
      retirePlayWorldSlots(binding);
      worldPlaySlots.clear();
      refreshPlayActiveCamera(scene, binding);
      playViz?.applyCommand({ type: "setShowNav", enabled: false });
      // Play visuals come from assignMesh. Document illumination would plant a
      // second set of lights (`authoredLight:<actorId>`) on changescene.
      applySerializedSceneEnvironment(scene, sceneData, {
        applyClearColor: true,
        assets: binding,
      });
      rebuildPostProcessStack();
      scheduler.invalidate("asset");
      bakedSession.apply(sceneData, bakeHost(loadOptions?.sceneAssetGuid));
      return;
    }
    applySceneToBabylonScene(scene, sceneData, binding);
    rebuildPostProcessStack();
    scheduler.invalidate("asset");
    bakedSession.apply(sceneData, bakeHost(loadOptions?.sceneAssetGuid));
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
    onRollback(() => cameraController.dispose());
    let previewGameCamera = false;
    const grid = createEditorGrid(scene, {
      mode,
      camera: cameraController.camera,
    });
    onRollback(() => grid.dispose());
    const selection = outlineHost.selection;
    onRollback(() => selection.dispose());
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
        text2dWrap?: { wrapWidth: number; wrapHeight: number };
      }> = [];
      for (const actorId of roots) {
        const mesh = editorSync.meshForActor(actorId);
        if (!mesh) continue;
        const liveTransform = readMeshLocalTransform(mesh);
        const meta = mesh.metadata as {
          text2dPendingWrap?: { wrapWidth: number; wrapHeight: number };
          text2dDragStartScale?: [number, number, number];
        } | null;
        live.push({
          actorId,
          ...liveTransform,
          ...(meta?.text2dDragStartScale
            ? { scale: meta.text2dDragStartScale }
            : {}),
          ...(meta?.text2dPendingWrap
            ? { text2dWrap: meta.text2dPendingWrap }
            : {}),
        });
      }
      return live;
    };
    const gizmosRef: { host: GizmoHost | null } = { host: null };
    const debugOverlayInstance = new EditorDebugOverlay(scene);
    onRollback(() => debugOverlayInstance.dispose());
    debugOverlay = debugOverlayInstance;
    const gizmos = createGizmoHost(scene, {
      mode,
      registerOverlay: (draw) => worldRenderer.attachEditorOverlay(draw),
      scheduler,
      manipulator: options.overlayTransformBox ? "overlay-box" : "trs",
      canvasCssHeight: () => pointerCanvas().height,
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
        syncAuthoredAreaLightsFromMeshes(scene, (id) => editorSync.meshForActor(id));
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
    onRollback(() => gizmos.dispose());

    const gestures = attachViewportGestures(canvas, cameraController, {
      scheduler,
      editorCameraActive: () => !previewGameCamera,
      blockLook: (x, y) =>
        gizmos.isDragging() || gizmos.hitTest(x, y, pointerCanvas()),
      dragSelectActive: () => options.dragSelectActive?.() === true,
      onPointer:
        options.sharedEngine || presentRtt
          ? (type, x, y, pointerId) => {
              gizmos.forwardPointer(type, x, y, {
                ...pointerCanvas(),
                pointerId,
              });
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
        const names = meshNamesInCanvasRect(scene, rect, css.width, css.height);
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
    onRollback(() => gestures.dispose());
    const flyKeys =
      typeof window === "undefined"
        ? null
        : attachViewportFlyKeys(window, cameraController, canvas, {
            scheduler,
            speed: () => options.editorFlySpeed?.() ?? DEFAULT_FLY_SPEED,
            isEnabled: () =>
              !previewGameCamera && options.editorFlyEnabled?.() !== false,
          });
    onRollback(() => flyKeys?.dispose());
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
        syncEditorOutlines();
        scheduler.invalidate("asset");
      },
      setDrawMeshCollision: (enabled: boolean) => {
        editorSync.setDrawMeshCollision(enabled);
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
        if (!worldRenderer && scene._activeMeshesFrozen) {
          freezeEditorActiveMeshes(scene);
        }
        scheduler.invalidate("asset");
      },
      setSelectedActors: (actorIds: string[]) => {
        lastSelectedActorIds = [...actorIds];
        outlineHost.setSelection(actorIds);
        // Locked actors are not pickable; keep the gizmo off them so lock is
        // more than a pick filter. Attach to the first pickable selection root
        // so a selected child is not the group handle when its parent is too.
        const attachId = pickGizmoAttachActorId(actorIds, parentIdOf, (id) => {
          const mesh = editorSync.meshForActor(id);
          if (!mesh) return false;
          const locked = editorSync
            .serializedScene()
            ?.actors.find((actor) => actor.id === id)?.locked;
          if (locked) return false;
          return mesh.isPickable || isEditorModelPlaceholder(mesh);
        });
        gizmos.attachTo(
          attachId ? editorSync.meshForActor(attachId) : null,
          attachId ? editorSync.visualMeshesForActor(attachId) : [],
        );
        scheduler.invalidate("selection");
      },
      syncSelectionDebug: (options) => {
        debugOverlayInstance.sync(options);
        editorSync.setCollisionSelection(options);
        scheduler.invalidate("selection");
      },
      setPreviewCanvas: (canvas) => {
        debugOverlayInstance.setPreviewCanvas(canvas);
      },
      frameActor: (actorId: string) => {
        const mesh = editorSync.meshForActor(actorId);
        if (!mesh || isSkyboxMesh(mesh)) return;
        const center = actorFramingTarget(mesh);
        if (cameraController.mode === "3d") {
          cameraController.frame(
            center,
            actorFramingRadius(mesh, { minZ: cameraController.camera.minZ }),
          );
        } else {
          cameraController.frame(center);
        }
      },
      selectedActorTransforms,
      dropSelectedActors: (selectedActorIds, maxDistance) => {
        const sceneData = editorSync.serializedScene();
        return sceneData ? calculateEditorDropTransforms({
          sceneData, selectedActorIds, maxDistance, meshForActor: (id) => editorSync.meshForActor(id),
          assets: { modelBytes: binding.modelBytes, modelSources: binding.modelSources, modelPayloads: binding.modelPayloads,
            spritePayloads: binding.spritePayloads, tilemaps: binding.tilemaps, tilesets: binding.tilesets,
            pixelsPerUnit: binding.pixelsPerUnit },
        }) : [];
      },
      attachedActorTransform: () => {
        const mesh = gizmos.attachedMesh();
        if (!mesh) return selectedActorTransforms()[0] ?? null;
        const actorId = editorSync.actorForMesh(mesh.name);
        if (!actorId) return null;
        return (
          selectedActorTransforms().find(
            (entry) => entry.actorId === actorId,
          ) ?? {
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

  const resize = () => {
    if (registeredView && !registeredViewIsEnabled(registeredView)) {
      return;
    }
    lockedViewSize = null;
    if (presentRtt) {
      // Resize owned GPU targets while keeping the last completed canvas copy.
      rttPresent?.bind();
    } else if (registeredView) {
      registeredView.customResize = undefined;
      const size = cssCanvasPixelSize(canvas);
      const scale = engine.getHardwareScalingLevel();
      engine.setSize(Math.max(1, Math.floor(size.width / scale)), Math.max(1, Math.floor(size.height / scale)));
    } else if (options.sharedEngine) {
      const size = snapCanvasDrawingBuffer(canvas);
      engine.setSize(size.width, size.height);
    } else {
      snapCanvasDrawingBuffer(canvas);
      engine.resize();
    }
    const size = presentRtt
      ? (rttPresent?.canvasSize() ?? { width: 1, height: 1 })
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
    sceneLayerCompositor?.resize();
    refreshAuthoredCameraLenses(scene);
    notifyOverlayResize();
  };

  const setSize = (width: number, height: number) => {
      lockedViewSize = { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
      const { width: nextWidth, height: nextHeight } = scaledLockedViewSize()!;
      if (registeredView) {
        // Native view admission runs before this callback. Defer visible bitmap
        // writes until that frame can replace them, and retain the authored
        // locked resolution instead of letting native CSS sizing override it.
        registeredView.customResize = () => {
          const size = scaledLockedViewSize();
          if (!size) return;
          engine.setSize(size.width, size.height);
        };
      } else if (options.sharedEngine && !presentRtt) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      engine.setSize(nextWidth, nextHeight);
      sceneLayerCompositor?.resize();
      refreshAuthoredCameraLenses(scene);
      notifyOverlayResize();
    };

  let interpAlpha = 1;
  // Registered-view admission and renderLoop both prepare the same frame; apply
  // only when the sampled identity changes or a command invalidated it.
  let appliedSnapshotIdentity: { frameId: number; alpha: number; layoutGeneration: number } | null = null;
  const lastPositions: PlayActorPosition[] = [];
  const audioPoses: SampledAudioPose[] = [];
  let lastDrawCalls = 0;
  let lastRenderCpuMs = 0;
  // Dynamic scaling input: whether this view presented the current and previous
  // engine frames (non-loading), when the last presentation happened, and the
  // most recent pressure sample surfaced through diagnostics.
  let framePresented = false;
  let previousFramePresented = false;
  let lastPresentedAt = 0;
  let lastPressureSample: FramePressureSample | null = null;
  let gpuFrameCaptureRequested = false;
  const soleRenderingView = () => {
    let enabled = 0;
    for (const view of engine.views ?? []) {
      if (registeredViewIsEnabled(view)) enabled += 1;
    }
    return registeredView ? enabled === 1 : enabled === 0;
  };
  const gpuAttribution = (): GpuAttribution => {
    // Babylon's WebGPU whole-frame counter can contain a synthetic zero when
    // command-encoder timestamps are absent. Per-pass timing is separate.
    if (engine.isWebGPU || !engine.getCaps().timerQuery) return "unavailable";
    if (!soleRenderingView()) return "shared-engine";
    return engine.getGPUFrameTimeCounter().count > 0 ? "view" : "unavailable";
  };
  // Engine-owned instrumentation is acquired only by a successfully returned handle.
  let readDiagnostics: ReturnType<typeof createRenderDiagnostics> | undefined;
  const renderDiagnostics = () => {
    captureFramePhases = true;
    return { ...(readDiagnostics ??= createRenderDiagnostics(
      scene, () => lastRenderCpuMs, () => rttPresent?.readbackMs() ?? null,
      () => ({ sample: lastPressureSample, gpuAttribution: gpuAttribution() }),
    ))(), presentation: { ...presentationStats }, rendererWork: worldRenderer.diagnostics() };
  };
  const loadingScope = (owner?: SceneLayerLoadIdentity) => {
    const generation = loadGeneration;
    const layer = owner ? layerLoads.get(owner.layerId) : undefined;
    const target = owner ? sceneLayerCompositor?.layers().find((entry) => entry.layerId === owner.layerId)?.scene : scene;
    const assert = () => {
      if (!owner) { assertCurrent(generation); return; }
      if (disposed || !target || target.isDisposed || layerLoads.get(owner.layerId) !== layer || layer?.loadId !== owner.layerLoadId) {
        throw new Error("SceneLayer loading was superseded or disposed.");
      }
      if (contextLost) throw new Error("Rendering context was lost during SceneLayer loading.");
    };
    assert();
    return { target: target!, assert };
  };
  const presentationReady = (pending: PendingPresentation) => {
    try {
      pending.ready = pending.owner ? sceneLayerCompositor?.isReady(pending.owner.layerId) === true : worldRenderer?.isReady() ?? isSceneFrameReady(scene);
      return pending.ready;
    } catch (error) {
      cancelPresentation(error instanceof Error ? error : new Error(String(error)), presentationKey(pending.owner));
      return false;
    }
  };
  const finishPresentation = (key: string, pending: PendingPresentation) => {
    if (!pending.rendered || !pending.copied || pending.submission || pendingPresentations.get(key) !== pending) return;
    pendingPresentations.delete(key);
    clearTimeout(pending.timer);
    if (pending.owner) {
      const layer = layerLoads.get(pending.owner.layerId);
      if (layer?.loadId === pending.owner.layerLoadId) layer.ready = true;
    } else worldLoading = false;
    pending.resolve();
  };
  function acknowledgeFrameCopy(owners = [...frameOwners]) {
    presentationStats.copied += 1;
    if (!frameWasLoading) framePresented = true;
    for (const [key, pending] of owners) {
      if (pendingPresentations.get(key) !== pending) continue;
      pending.copied = true;
      finishPresentation(key, pending);
    }
  }
  const tilemapPreviewStart = performance.now();
  function prepareSnapshot() {
    const sampled = interpolator.sample(interpAlpha);
    if (!sampled) return null;
    const layoutGeneration = interpolator.layoutGeneration;
    if (
      appliedSnapshotIdentity &&
      appliedSnapshotIdentity.frameId === sampled.frameId &&
      appliedSnapshotIdentity.alpha === sampled.alpha &&
      appliedSnapshotIdentity.layoutGeneration === layoutGeneration
    ) {
      return sampled;
    }
    const previousCamera = scene.activeCamera;
    applySnapshotToScene(scene, binding, sampled);
    playViz?.refresh();
    rebuildIfActiveCameraChanged(previousCamera);
    positionsFromSample(sampled, lastPositions);
    // Pose/listener sync owns the applied snapshot, not render admission: a
    // capped or held frame must not leave spatial audio stale.
    if (audioService) {
      if (audioService.hasSpatialVoices()) {
        writeSampledAudioPoses(sampled, audioPoses);
        applyBoneAttachmentAudioPoses(binding, audioPoses);
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
    appliedSnapshotIdentity = {
      frameId: sampled.frameId,
      alpha: sampled.alpha,
      layoutGeneration,
    };
    return sampled;
  }
  if (options.playMode) {
    let appliedOutput = normalizeRenderProjectSettings(options.renderSettings);
    runtimeScalability = new RuntimeScalability({ revision: 0, overrides: {}, settings: {
      render: appliedOutput, frameCap: normalizePlayFrameCap(options.frameCap),
    } }, {
      apply: (transaction) => {
        const state = sceneRenderingSettings(scene);
        const { quality, shadows, ...visual } = transaction.overrides;
        state.runtimeOverrides = visual;
        state.qualityOverrides = { ...quality, ...(shadows ? { shadows } : {}) };
        setSceneRenderSettings(scene);
        outlineHost.refreshSettings();
        applyRenderingQuality();
        requestRenderPath(engine, visual.renderPath ? { renderPath: visual.renderPath } : {});
        scheduler.setFrameCap(transaction.settings.frameCap);
        const output = transaction.settings.render;
        if (["width", "height", "customResolution", "blackBars"].some((key) => output[key as keyof RenderProjectSettings] !== appliedOutput[key as keyof RenderProjectSettings])) {
          options.onRuntimeOutputChanged?.(output);
          const framebuffer = playFramebufferSize(output);
          if (framebuffer) setSize(framebuffer.width, framebuffer.height);
          else resize();
          appliedOutput = output;
        }
        scheduler.invalidate("asset");
      },
      prepare: async (assertCurrent) => {
        assertCurrent();
        await worldRenderer?.prepare(assertCurrent);
        for (const layer of sceneLayerCompositor?.layers() ?? []) {
          if (layerLoads.get(layer.layerId)?.ready !== false) await sceneLayerCompositor?.prepare(layer.layerId, assertCurrent);
        }
        assertCurrent();
      },
      read: (transaction) => {
        const state = sceneRenderingSettings(scene);
        const { shadows, ...quality } = resolveSceneRenderingQuality(scene);
        quality.textures = { ...quality.textures, anisotropy: state.textureAnisotropy };
        const pipeline = sceneRenderPathStatus(scene);
        return { revision: transaction.revision, status: transaction.clamped || pipeline.limits.length || quality.textures.anisotropy !== transaction.settings.render.quality?.textures.anisotropy ? "clamped" : "applied",
          message: pipeline.limits.join(" ") || (transaction.clamped ? "Clamped rendering settings presented." : "Rendering settings presented."), pipeline,
          effective: { frameCap: transaction.settings.frameCap, render: { ...transaction.settings.render,
            ...pipeline.effective, quality, shadows, cel: state.cel, mode: state.mode,
            environmentLighting: state.environmentLighting, effects: state.effects } } };
      },
      publish: (acknowledgement) => {
        lastScalabilityStatus = acknowledgement;
        options.onScalabilityApplied?.(acknowledgement);
      },
      invalidate: () => scheduler.invalidate("asset"),
      retainResources: () => {
        const world = worldRenderer?.retainResources();
        const layers = sceneLayerCompositor?.retainResources();
        return () => { try { world?.(); } finally { layers?.(); } };
      },
    });
    onRollback(() => runtimeScalability?.dispose());
  }
  const renderLoop = () => {
    if (disposed || contextLost || registeredView?.enabled === false) return;
    // Babylon invokes all render callbacks for each registered view. A loading
    // permit belongs to this canvas and must not draw into a sibling's blit.
    if (registeredView && engine.activeView && engine.activeView !== registeredView) return;
    frameCopyReady = false;
    frameOwners.clear();
    const preparationStart = captureFramePhases ? performance.now() : 0;
    applyRenderingQuality();
    outlineHost.refreshSettings();
    if (!worldLoading) runtimeScalability?.advance();
    if (!registeredView) syncLockedViewSize();
    const sampled = prepareSnapshot();
    const frameStart = performance.now();
    const loadingFrame = hasLoadingFrame();
    if (!shouldRenderFrame(frameStart)) {
      return;
    }
    frameWasLoading = loadingFrame;
    // Measure render cost only, not wall-clock gap since the previous
    // rendered frame — a frozen obstructed viewport can idle for seconds
    // between frames, and feeding that gap to the scaling valve would read
    // as a catastrophic frame time and drop quality for no reason.
    const renderStart = performance.now();
    presentationStats.attempted += 1;
    if (captureFramePhases) presentationStats.preparationMs = renderStart - preparationStart;
    let coherentFrame = true;
    beginEngineDrawCallFrame(engine);
    if (rttPresent) rttPresent.bind();
    if (!options.playMode) {
      updateSceneTilemapAnimations(scene, frameStart - tilemapPreviewStart);
    }
    try {
      const presentingLayers = new Set([...pendingPresentations.values()].flatMap((pending) => pending.owner ? [pending.owner.layerId] : []));
      const drawOwner = (key: string, draw: () => boolean, fallback?: () => void) => {
        const pending = pendingPresentations.get(key);
        if (!pending) { draw(); return; }
        if (!presentationReady(pending)) {
          pending.rendered = false;
          pending.copied = false;
          fallback?.();
          return;
        }
        if (pending.rendered || pending.submission) {
          if (draw() && pending.rendered) frameOwners.set(key, pending);
          return;
        }
        pending.copied = false;
        const submission = submitPresentedFrame(engine, () => {
          pending.attempts += 1;
          const rendered = draw();
          pending.rendered = rendered && presentationReady(pending);
        });
        pending.submission = submission;
        if (pending.rendered) {
          frameOwners.set(key, pending);
          // A validated draw is progress beyond shader readiness. Observed
          // software-GL completion can outlast that earlier budget even after
          // the canvas copy. Give completion its own bounded budget, without
          // acknowledging before both this owner's fence and copy finish.
          if (!pending.completionStarted) {
            pending.completionStarted = true;
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => {
              if (pendingPresentations.get(key) === pending) expirePresentation(key);
            }, 15_000);
          }
        }
        void submission.completed.then(() => {
          if (pending.submission !== submission) return;
          pending.submission = null;
          finishPresentation(key, pending);
        }, (error: unknown) => {
          if (pending.submission !== submission) return;
          if (pendingPresentations.get(key) === pending) cancelPresentation(error instanceof Error ? error : new Error(String(error)), key);
        });
      };
      if (!worldLoading || pendingPresentations.has("world")) drawOwner("world", () => {
        if (worldRenderer) {
          const result = worldRenderer.render();
          coherentFrame = result.rendered;
          return result.readyForPresentation;
        }
        scene.render();
        return true;
      }, () => engine.clear(scene.clearColor, true, true, true));
      else engine.clear(scene.clearColor, true, true, true);
      sceneLayerCompositor?.render(presentingLayers, (layerId, draw, fallback) => drawOwner(`layer:${layerId}`, draw, fallback));
      if (!coherentFrame) {
        for (const pending of frameOwners.values()) {
          if (pending.copied) continue;
          // This candidate never reached the canvas. Its fence cannot certify
          // a later retry, which needs its own validation scope and submission.
          pending.rendered = false;
          const submission = pending.submission;
          pending.submission = null;
          submission?.cancel();
        }
        presentationStats.held += 1;
        return;
      }
      if (rttPresent) {
        const owners = [...frameOwners];
        void rttPresent.blit().then(() => {
          acknowledgeFrameCopy(owners);
        }, (error: unknown) => {
          if (!owners.length && !disposed) console.warn(`[render] RTT presentation failed: ${String(error)}`);
          for (const [key, pending] of owners) {
            if (pendingPresentations.get(key) === pending) cancelPresentation(error instanceof Error ? error : new Error(String(error)), key);
          }
        });
      }
    } catch (error) {
      if (!pendingPresentations.size) throw error;
      cancelPresentation(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (sampled) lastRenderedSnapshotFrame = sampled.frameId;
    frameCopyReady = true;
    presentationStats.drawn += 1;
    lastDrawCalls = readEngineDrawCalls(engine);
    scheduler.noteRendered(frameStart);
    lastRenderCpuMs = performance.now() - renderStart;
    if (!registeredView && !rttPresent && !loadingFrame) framePresented = true;
  };
  const presentationObserver = engine.onEndFrameObservable.add(() => {
    if (!registeredView && !rttPresent && frameCopyReady) acknowledgeFrameCopy();
    if (framePresented) {
      if (runtimeScalability && !worldLoading && worldRenderer?.isReady() && sceneLayerCompositor?.isReady() !== false) runtimeScalability.presented();
      const presentedAt = performance.now();
      // Only Play handles pace frames: their presented-frame interval measures
      // sustainable frame cost. Editor/prefab viewports are free-running, so
      // the same interval mostly measures host event-loop contention and must
      // not drive resolution scaling — they keep the cpuMs-only input.
      const presentationSignals = options.playMode === true;
      // GPU timing only means this view when it owns the Engine's render —
      // siblings would fold their cost into the same counter.
      const sole = soleRenderingView();
      if (!engine.isWebGPU && sole && presentationSignals && !gpuFrameCaptureRequested && engine.getCaps().timerQuery) {
        gpuFrameCaptureRequested = true;
        engine.captureGPUFrameTime(true);
      }
      const counter = !engine.isWebGPU && presentationSignals && sole && engine.getCaps().timerQuery ? engine.getGPUFrameTimeCounter() : null;
      lastPressureSample = {
        presentationMs:
          presentationSignals && previousFramePresented
            ? presentedAt - lastPresentedAt
            : null,
        cpuMs: lastRenderCpuMs,
        gpuMs: counter && counter.count > 0 ? counter.current / 1_000_000 : null,
      };
      lastPresentedAt = presentedAt;
      scaling.noteFramePressure(lastPressureSample);
      if (!registeredView) syncLockedViewSize();
    }
    previousFramePresented = framePresented;
    framePresented = false;
    frameCopyReady = false;
  });
  onRollback(() => engine.onEndFrameObservable.remove(presentationObserver));
  onRollback(() => engine.stopRenderLoop(renderLoop));
  engine.runRenderLoop(renderLoop);

  const onVisibility = () => {
    const hidden = document.visibilityState === "hidden";
    scheduler.setDocumentVisible(!hidden);
  };
  if (typeof document !== "undefined") {
    onRollback(() => document.removeEventListener("visibilitychange", onVisibility));
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
  }

  const contextLostObserver = engine.onContextLostObservable.add(() => {
    if (disposed) return;
    contextLost = true;
    presentationStats.contextLosses += 1;
    loadGeneration += 1;
    cancelPresentation(new Error("Rendering context was lost during scene loading."));
    engineCommandBus.dispatch({ type: "log", message: "WebGL context lost" });
  });
  onRollback(() => engine.onContextLostObservable.remove(contextLostObserver));
  const contextRestoredObserver = engine.onContextRestoredObservable.add(() => {
    if (disposed) return;
    contextLost = false;
    presentationStats.contextRestorations += 1;
    engineCommandBus.dispatch({
      type: "log",
      message: "WebGL context restored",
    });
    scaling.noteRestore();
    // Babylon rebuilds retained textures/material effects before notifying.
    // Releasing the shared cache here destroys those newly restored resources
    // and leaves other live clients holding disposed wrappers.
    scheduler.invalidate("manual");
  });
  onRollback(() => engine.onContextRestoredObservable.remove(contextRestoredObserver));

  // Tap-to-pick: continuous hover picking is off for touch.
  const overlayPointerCanvasCoords = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };
  const onPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    if (dispatchOverlayPointer("down", x, y)) {
      scheduler.invalidate("selection");
      return;
    }
    const hit = pickAtCanvas(scene, x, y);
    if (hit) {
      scheduler.invalidate("selection");
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const { x, y } = overlayPointerCanvasCoords(event);
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    dispatchOverlayPointer("move", x, y);
  };
  const onPointerUp = (event: PointerEvent) => {
    const { x, y } = overlayPointerCanvasCoords(event);
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    dispatchOverlayPointer("up", x, y);
  };
  const onPointerCancel = (event: PointerEvent) => {
    const { x, y } = overlayPointerCanvasCoords(event);
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    dispatchOverlayPointer("cancel", x, y);
  };
  const onOverlayTouch = (event: TouchEvent) => {
    event.preventDefault();
  };
  if (!options.editor) {
    onRollback(() => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("touchstart", onOverlayTouch);
      canvas.removeEventListener("touchmove", onOverlayTouch);
    });
    canvas.addEventListener("pointerdown", onPointerDown);
    if (options.playMode && sceneLayerCompositor) {
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("touchstart", onOverlayTouch, { passive: false });
      canvas.addEventListener("touchmove", onOverlayTouch, { passive: false });
    }
  }

  rebuildPostProcessStack();

  const unsubscribeEditorDrop = engineCommandBus.subscribe((command) => {
    if (command.type !== "editor.drop" || !editor || !options.editorViewportId || command.viewportId !== options.editorViewportId) return;
    engineCommandBus.dispatch({ type: "editor.drop.result", viewportId: command.viewportId,
      requestId: command.requestId, transforms: editor.dropSelectedActors(command.actorIds, command.maxDistance) });
  });
  onRollback(unsubscribeEditorDrop);
  // FontFace registration publishes to the document, so start it only after
  // the synchronous construction steps that can still roll back have succeeded.
  if (options.fontFaceEntries && options.fontFaceEntries.length > 0) {
    void fontRegistry.registerAll(options.fontFaceEntries);
  }

  return {
    engine,
    scene,
    scheduler,
    resourceCache,
    scaling,
    editor,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      runtimeScalability?.dispose();
      unsubscribeRenderPath();
      unsubscribeRenderPathSession();
      loadGeneration += 1;
      cancelPresentation(new Error("Scene loading was disposed."));
      engine.onContextLostObservable.remove(contextLostObserver);
      engine.onContextRestoredObservable.remove(contextRestoredObserver);
      engine.onEndFrameObservable.remove(presentationObserver);
      releaseViewAdmission?.();
      releaseOffscreenDispatch?.();
      unsubscribeEditorDrop();
      releasePlayLoop?.();
      engine.stopRenderLoop(renderLoop);
      // Bounded cleanup reporting (`bounded`) stays separate from confirmed
      // actual native release (`actual`): an uncertain report never proves a
      // shared owner stopped being used.
      const bounded: Promise<void>[] = [];
      const actual: Promise<void>[] = [];
      const track = (list: Promise<void>[], report: () => Promise<void> | void) => {
        try {
          const result = report();
          if (result) list.push(result);
        } catch (error) {
          list.push(Promise.reject(error));
        }
      };
      track(bounded, () => retireAttachedStack());
      track(bounded, () => outlineHost.dispose());
      track(bounded, () => nativeRetirement.whenDisposed());
      track(bounded, () => worldRenderer?.retire());
      track(bounded, () => sceneLayerCompositor?.dispose());
      track(actual, () => nativeRetirement.whenReleased());
      track(actual, () => worldRenderer?.whenReleased());
      track(actual, () => outlineHost.whenReleased());
      track(actual, () => sceneLayerCompositor?.whenReleased());
      // Cancel graph preparation before restoring the editor's global request.
      track(bounded, () => releasePlayRenderPath?.());
      const retired = Promise.all(bounded);
      const released = Promise.all(actual).then(() => {});
      releasedHandle = released;
      playFreeCamInput?.dispose();
      disposeGestures?.();
      editor?.gizmos.dispose();
      editor?.grid.dispose();
      editor?.selection.dispose();
      editor?.sync.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("touchstart", onOverlayTouch);
      canvas.removeEventListener("touchmove", onOverlayTouch);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      audioService?.dispose();
      const releaseSceneResources = () => {
        playFreeCam?.dispose();
        playViz?.dispose();
        playDebugDraw?.dispose();
        playCursor?.dispose();
        debugOverlay?.dispose();
        debugOverlay = null;
        disposeSnapshotBinding(binding);
        particleService?.dispose();
        materialLibrary.dispose();
        scene.dispose();
        rttPresent?.dispose();
        cacheBinding.dispose();
      };
      const reportRetirementFailure = (error: unknown) => {
        console.warn(`[render] Scene resource cleanup report is uncertain: ${String(error)}`);
      };
      const reportReleaseFailure = (error: unknown) => {
        console.warn(`[render] Scene resource cleanup is quarantined: ${String(error)}`);
      };
      if (!ownsEngine && (worldRenderer || sceneLayerCompositor || !nativeRetirement.releasedConfirmed)) {
        // Pending native work may still borrow Scene, library and cache
        // resources. Stop the view immediately, but release these owners only
        // after actual release confirms; a rejected release quarantines them.
        void retired.catch(reportRetirementFailure);
        void released.then(releaseSceneResources).catch(reportReleaseFailure);
      } else {
        void retired.catch(reportRetirementFailure);
        void released.catch(reportReleaseFailure);
        releaseSceneResources();
      }
      if (registeredView) {
        engine.unRegisterView(canvas);
        if (options.playMode) {
          // Play borrows the Engine-wide scale while sibling views are held.
          // Restore it before admitting their next native resize/copy. Their
          // unchanged quality snapshots otherwise leave Play's scale installed.
          if (engine.getHardwareScalingLevel() !== previousScaling) {
            engine.setHardwareScalingLevel(previousScaling);
          }
          setOtherEngineViewsEnabled(engine, canvas, true);
        }
      }
      if (ownsEngine) {
        releaseResourceCacheForEngine(engine);
        engine.dispose();
      }
    },
    whenReleased: () => releasedHandle ?? Promise.resolve(),
    resize,
    setSize,
    loadScene,
    loadSceneAsync,
    pushSnapshot: (buffer: Float32Array) => {
      interpolator.push(buffer);
      interpAlpha = 1;
      appliedSnapshotIdentity = null;
      const sampled = interpolator.sample(interpAlpha);
      if (sampled) positionsFromSample(sampled, lastPositions);
      if (sampled && sampled.frameId !== lastRenderedSnapshotFrame) scheduler.requestPausedFrame();
      if (isPublishedSnapshot(buffer)) {
        playDebugDraw?.noteSimTick(readSnapshotHeader(buffer).tickIndex);
      }
      scheduler.invalidate("snapshot");
    },
    applyCommand: (command: CommandMessage) => {
      if (command.type === "snapshotLayout") {
        interpolator.installLayout(command.capacity, command.generation);
        appliedSnapshotIdentity = null;
        scheduler.invalidate("snapshot");
        return;
      }
      if (options.playMode) {
        applyPlayConsoleRenderCommand({ scheduler }, command);
      }
      applyPlayFreeCamCommand(playFreeCam, command);
      playViz?.applyCommand(command);
      playDebugDraw?.applyCommand(command);
      if (command.type === "setCursorVisible") {
        playCursor?.setVisible(command.visible);
      }
      if (command.type === "spawn") {
        appliedSnapshotIdentity = null;
        audioService?.noteActorSlot(command.actorGuid, command.slotId);
        if (command.sceneLayerId) {
          worldPlaySlots.delete(command.slotId);
          sceneLayerCompositor?.noteSpawn(
            command.slotId,
            command.sceneLayerId,
            command.actorGuid,
          );
          syncOverlaySlot(command.slotId);
        } else {
          worldPlaySlots.add(command.slotId);
          sceneLayerCompositor?.noteSpawn(
            command.slotId,
            undefined,
            command.actorGuid,
          );
          const pendingWorld = pendingOverlayAssign.get(command.slotId);
          if (pendingWorld) {
            applyAssignMesh(scene, binding, pendingWorld);
            pendingOverlayAssign.delete(command.slotId);
            // Same late-resolution as the direct assignMesh path below: a
            // deferred `light:*` visual may be the baked source a receiver
            // could not resolve at bind time.
            if (pendingWorld.meshKind?.startsWith("light:"))
              bakedSession.refresh();
          }
        }
      }
      if (command.type === "despawn") {
        appliedSnapshotIdentity = null;
        pendingOverlayAssign.delete(command.slotId);
        worldPlaySlots.delete(command.slotId);
        sceneLayerCompositor?.noteDespawn(command.slotId);
        const previousCamera = scene.activeCamera;
        retirePlaySlot(binding, command.slotId);
        refreshPlayActiveCamera(scene, binding);
        rebuildIfActiveCameraChanged(previousCamera);
      }
      if ((command.type === "sceneLoading" || command.type === "activeScene") && command.sceneLoadId > worldLoadId) {
        particleService?.retireSlots((slotId) => worldPlaySlots.has(slotId));
        appliedSnapshotIdentity = null;
        worldLoadId = command.sceneLoadId;
        worldSceneAssetGuid = command.sceneAssetGuid;
        postProcessParameters.clear();
        worldLoading = true;
        worldRenderer?.invalidate();
        cancelPresentation(new Error("Scene loading was superseded."), "world");
      }
      if (command.type === "sceneLayerLoading") {
        const previous = layerLoads.get(command.layerId);
        if (!previous || previous.loadId < command.layerLoadId) {
          particleService?.retireSlots((slotId) => sceneLayerCompositor?.layerIdForSlot(slotId) === command.layerId);
          cancelPresentation(new Error("SceneLayer loading was superseded."), `layer:${command.layerId}`);
          layerLoads.set(command.layerId, { loadId: command.layerLoadId, ready: false });
        }
      }
      if (command.type === "sceneLayerCreate") {
        sceneLayerCompositor?.create(command);
        syncOverlayLayer(command.layerId);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "sceneLayerRemove") {
        particleService?.retireSlots((slotId) => sceneLayerCompositor?.layerIdForSlot(slotId) === command.layerId);
        cancelPresentation(new Error("SceneLayer was removed."), `layer:${command.layerId}`);
        layerLoads.delete(command.layerId);
        sceneLayerCompositor?.remove(command.layerId);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "sceneLayerClear") {
        particleService?.retireSlots((slotId) => sceneLayerCompositor?.layerIdForSlot(slotId) != null);
        for (const layerId of layerLoads.keys()) cancelPresentation(new Error("SceneLayer was removed."), `layer:${layerId}`);
        layerLoads.clear();
        pendingOverlayAssign.clear();
        sceneLayerCompositor?.clear();
        scheduler.invalidate("snapshot");
      }
      if (command.type === "sceneLayerPostProcess") {
        sceneLayerCompositor?.setPostProcess(
          command.layerId,
          command.postProcessStack,
        );
        scheduler.invalidate("asset");
      }
      audioService?.handleCommand(command);
      if (command.type === "setActorOutlines") {
        const previous = binding.outlines.get(command.slotId);
        binding.outlines.set(command.slotId, { actorId: command.actorId, bindings: command.outlines });
        try { refreshRuntimeOutline(command.slotId); }
        catch (error) {
          if (previous) binding.outlines.set(command.slotId, previous);
          else binding.outlines.delete(command.slotId);
          throw error;
        }
        scheduler.invalidate("asset");
      }
      if (command.type === "setAreaLights") {
        let group = binding.areaLights.get(command.slotId);
        let changed = false;
        if (command.lights.length) {
          if (!group) { group = new AreaRectLightGroup(scene, `playAreaLight:${command.slotId}`); binding.areaLights.set(command.slotId, group); }
          changed = group.update(command.lights, binding.areaEmissions);
          const mesh = binding.meshes.get(command.slotId);
          if (mesh) group.setWorld(mesh.getWorldMatrix());
        } else if (group) { group.dispose(); binding.areaLights.delete(command.slotId); changed = true; }
        if (changed) {
          appliedSnapshotIdentity = null;
          worldRenderer?.invalidate();
          scheduler.invalidate("asset");
        }
      }
      particleService?.handleCommand(command);
      if (command.type === "assignMesh") {
        appliedSnapshotIdentity = null;
        if (command.sceneLayerId) {
          worldPlaySlots.delete(command.slotId);
          sceneLayerCompositor?.noteSpawn(
            command.slotId,
            command.sceneLayerId,
            command.actorGuid,
          );
          syncOverlaySlot(command.slotId);
        }
        const previousCamera = scene.activeCamera;
        const overlayScene = sceneLayerCompositor?.sceneForSlot(command.slotId);
        const overlayIdentity =
          Boolean(command.sceneLayerId) ||
          sceneLayerCompositor?.layerIdForSlot(command.slotId) != null ||
          (sceneLayerCompositor != null &&
            isOverlayOnlyMeshKind(command.meshKind)) ||
          (sceneLayerCompositor != null &&
            isAmbiguousHudMeshKind(command.meshKind) &&
            !worldPlaySlots.has(command.slotId));
        if (overlayIdentity && !overlayScene) {
          pendingOverlayAssign.set(command.slotId, command);
        } else if (overlayIdentity && overlayScene) {
          applyAssignMesh(overlayScene, binding, command);
          disposeWorldOverlayLeftovers(scene, command.slotId);
        } else {
          applyAssignMesh(scene, binding, command);
        }
        // A spawned light can resolve a baked receiver's pending exclusion.
        if (command.meshKind?.startsWith("light:")) bakedSession.refresh();
        rebuildIfActiveCameraChanged(previousCamera);
        particleService?.bindSlot(
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
                applyAlbedoTexture(mesh, mesh.getScene(), guid, binding),
            }),
            pending,
          );
        }
        scheduler.invalidate("snapshot");
      }
      if (command.type === "assignMaterial") {
        appliedSnapshotIdentity = null;
        applyAssignMaterial(scene, binding, command);
        scheduler.invalidate("asset");
      }
      if (command.type === "attachToBone") {
        appliedSnapshotIdentity = null;
        applyAttachToBone(binding, command);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "setMaterialParameter") {
        applySetMaterialParameter(binding, command);
        scheduler.invalidate("asset");
      }
      if (command.type === "setPostProcessMaterialParameter") {
        const validParameter = () => {
          const document = materialDocuments.get(command.materialAssetGuid);
          return document?.domain === "postProcess" && materialLibrary.acceptsParameter(document, command.parameterName, command.parameter);
        };
        const applied = applyPostProcessParameterCommand(command, {
          world: { sceneAssetGuid: worldSceneAssetGuid, sceneLoadId: worldLoadId, ready: !worldLoading },
          layer: (id) => layerLoads.get(id),
          setWorld: (write) => {
            if (!postProcessStack.some((entry) => entry.id === write.entryId && entry.materialGuid === write.materialAssetGuid) || !validParameter() ||
              !postProcessParameters.set(postProcessStack, write.entryId, write.materialAssetGuid, write.parameterName, write.parameter)) return false;
            attachedStack?.setParameter(write.entryId, write.parameterName, write.parameter);
            return true;
          },
          setLayer: (id, write) => sceneLayerCompositor?.setPostProcessParameter(id, write.entryId, write.materialAssetGuid, write.parameterName, write.parameter, validParameter) ?? false,
        });
        if (applied) scheduler.invalidate("asset");
      }
      if (command.type === "possessCamera") {
        const previousCamera = scene.activeCamera;
        applyPossessCamera(scene, binding, command.slotId);
        rebuildIfActiveCameraChanged(previousCamera);
        scheduler.invalidate("camera");
      }
      if (command.type === "setScalability" && options.playMode) runtimeScalability?.enqueue(command.transaction);
      if (command.type === "setRenderingQuality" && options.playMode) {
        sceneRenderingSettings(scene).qualityOverrides = command.overrides;
        setSceneRenderSettings(scene);
        applyRenderingQuality();
        scheduler.invalidate("asset");
      }
      if (command.type === "setRenderPath" && options.playMode) {
        requestRenderPath(
          engine,
          command.renderPath ? { renderPath: command.renderPath } : {},
        );
      }
      if (command.type === "setLightsDebug")
        sceneRenderingSettings(scene).lightsDebug = command.enabled;
      if (command.type === "tilemapAnimationTime") {
        binding.tilemapAnimationTimeMs = command.elapsedMs;
        scheduler.invalidate("snapshot");
      }
      if (command.type === "animState") {
        appliedSnapshotIdentity = null;
        if (!binding.pendingAnimState) binding.pendingAnimState = new Map();
        binding.pendingAnimState.set(command.slotId, command);
        applyAnimStateToScene(
          sceneAnimHostFromBinding(binding, {
            animationGroups: scene.animationGroups,
            spritePayloads: binding.spritePayloads ?? options.spritePayloads,
            spriteAnimations:
              binding.spriteAnimations ?? options.spriteAnimations,
            applyTexture: (mesh, guid) =>
              applyAlbedoTexture(mesh, mesh.getScene(), guid, binding),
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
      binding.paused = paused;
      scheduler.setPaused(paused);
      audioService?.setPaused(paused);
      particleService?.setPaused(paused);
    },
    setRegisterViewEnabled: (enabled: boolean) => {
      if (registeredView) setRegisteredViewEnabled(registeredView, enabled);
    },
    liveObjectCounts: () => ({
      meshes: scene.meshes.length,
      textures: engine.getLoadedTexturesCache().length,
    }),
    drawCalls: () => lastDrawCalls,
    renderDiagnostics,
    renderPathStatus: () => sceneRenderPathStatus(scene),
    scalabilityStatus: () => lastScalabilityStatus,
    setRenderPath: (renderPath: RenderPath | null) => {
      requestRenderPath(engine, renderPath ? { renderPath } : {});
    },
    accountedGeometryBytes: () => accountedGeometryBytesForScene(scene),
    pickAt: (x, y) => {
      const mapped = mapCanvasPointer(scene, x, y, pointerCanvas());
      const canvasSize = pointerCanvas();
      const overlayHit = sceneLayerCompositor?.pickAt(mapped.x, mapped.y, {
        minTargetPx: options.touchMinTargetPx ?? 44,
        canvasCssHeight: canvasSize.height,
      });
      if (overlayHit?.blocked || overlayHit?.actorGuid) {
        return { meshName: overlayHit.meshName, slotId: overlayHit.slotId };
      }
      const hit = pickAtCanvas(scene, mapped.x, mapped.y);
      return hit ? { meshName: hit.meshName, slotId: hit.slotId } : null;
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
    playMeshMaterialNames: () => {
      const names = new Set<string>();
      for (const root of binding.meshes.values()) {
        const meshes = [root, ...root.getChildMeshes()];
        for (const mesh of meshes) {
          const name = mesh.material?.name;
          if (name) names.add(name);
        }
      }
      return [...names].sort();
    },
    bakedSessionDiagnostics: () => bakedSession.diagnostics(),
    applyBakedSession: (sceneData, sceneAssetGuid) => {
      if (sceneAssetGuid !== undefined) lastBakedSceneGuid = sceneAssetGuid;
      bakedSession.apply(sceneData, bakeHost(lastBakedSceneGuid));
    },
    playMeshMaterialDefines: () => {
      const rows: Array<{
        mesh: string;
        material: string | null;
        defines: string;
      }> = [];
      for (const root of binding.meshes.values()) {
        for (const mesh of [root, ...root.getChildMeshes()]) {
          const defines =
            mesh.subMeshes
              ?.map((sub) => String(sub.effect?.defines ?? ""))
              .filter((entry) => entry.length)
              .join("\n") ?? "";
          if (mesh.material || defines)
            rows.push({
              mesh: mesh.name,
              material: mesh.material?.name ?? null,
              defines,
            });
        }
      }
      return rows;
    },
    registerFonts: async (entries) => {
      await fontRegistry.registerAll(entries);
      if (fontRegistry.consumeDirty()) scheduler.invalidate("asset");
    },
    setMeshAssets: (assets: MeshAssetContext) => {
      const installed = installMeshAssets(assets);
      const rebuilt =
        editorSync?.setMeshAssets(installed) === true;
      if (rebuilt && lastSelectedActorIds.length > 0) {
        editor?.setSelectedActors(lastSelectedActorIds);
      }
    },
    applySceneEnvironment: (sceneData: SerializedScene) => {
      setSceneRenderSettings(scene, undefined, sceneData.settings.celShading ?? {}, sceneData.settings.shadowOverrides ?? {});
      outlineHost.refreshSettings();
      applySerializedSceneEnvironment(scene, sceneData, {
        applyClearColor: true,
        assets: binding,
      });
      // Environment inputs are part of the bake's validity hash; revalidate.
      bakedSession.apply(sceneData, bakeHost(lastBakedSceneGuid));
      scheduler.invalidate("asset");
    },
    setRenderSettings: (settings) => {
      const previousMode = sceneRenderingSettings(scene).mode;
      setSceneRenderSettings(scene, settings);
      viewportShading?.apply();
      if (options.editor && !worldRenderer && previousMode !== sceneRenderingSettings(scene).mode)
        freezeEditorActiveMeshes(scene);
      outlineHost.refreshSettings();
      scheduler.invalidate("asset");
    },
    postProcessPassCount: () =>
      worldRenderer?.postProcessPassCount() ??
      (attachedStack?.passes.length ?? 0) + sceneEffectsOwner.passes.length,
    renderTaskNames: () => worldRenderer?.taskNames() ?? [],
    sceneLayerScenes: () =>
      (sceneLayerCompositor?.sortedLayers() ?? []).map((layer) => ({
        layerId: layer.layerId,
        scene: layer.scene,
        zOrder: layer.zOrder,
      })),
    assignedMaterialGuids: () => listAssignedMaterialGuids(binding),
    postProcessDiagnostics: () => lastPostProcessDiagnostics,
    setPostProcessingEnabled: (enabled: boolean) => {
      postProcessingEnabled = enabled;
      setSceneEffectsEnabled(scene, enabled);
      rebuildPostProcessStack();
      sceneLayerCompositor?.refreshPostProcess();
      scheduler.invalidate("asset");
    },
    setLocalQualityOverrides: (overrides) => {
      sceneRenderingSettings(scene).localQualityOverrides = overrides;
      setSceneRenderSettings(scene);
      applyRenderingQuality();
      scheduler.invalidate("asset");
    },
    setTextureBudget: (bytes: number, enabled: boolean) => {
      resourceCache.setByteCeiling(bytes);
      resourceCache.setBudgetEnabled(enabled);
    },
    setAudioBudget: (bytes: number, enabled: boolean) => {
      audioService?.setAudioBudget(bytes, enabled);
    },
    setMaxVoices: (maxVoices: number) => {
      audioService?.setMaxVoices(maxVoices);
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
      if (!installMaterialDocuments(documents, functions)) return;
      rebuildPostProcessStack();
      const serialized = editorSync?.serializedScene();
      if (editorSync && serialized) editorSync.apply(serialized);
      freezeLibraryMaterials();
      scheduler.invalidate("asset");
    },
    setEditingMaterialGuids: (guids) => {
      editingMaterialGuids.clear();
      for (const guid of guids) editingMaterialGuids.add(guid);
      freezeLibraryMaterials();
      scheduler.invalidate("asset");
    },
    prewarmSceneMaterials: async (owner) => {
      const scope = loadingScope(owner);
      applyRenderingQuality();
      await warmSceneMaterials(scope.target, scope.assert);
      scope.assert();
      freezeLibraryMaterials();
      if (options.editor && !owner && !worldRenderer) freezeEditorActiveMeshes(scene);
      outlineHost.refreshSettings();
      if (owner) await sceneLayerCompositor?.prepare(owner.layerId, scope.assert);
      else await worldRenderer?.prepare(scope.assert);
      scope.assert();
    },
    whenMaterialTexturesReady: async (owner) => {
      const scope = loadingScope(owner);
      // Measure stalls of the pending set, not total load time: a slow host
      // that keeps finishing uploads stays in budget; a hung upload fails.
      let lastProgress = Date.now();
      let previous: string | null = null;
      for (;;) {
        const pending = pendingSceneTextureWork(scope.target);
        if (pending.length === 0) break;
        scope.assert();
        const key = pending.join("\n");
        const now = Date.now();
        if (key !== previous) {
          lastProgress = now;
        } else if (now - lastProgress >= SCENE_SHADER_WARM_TIMEOUT_MS) {
          throw new Error(
            `Material textures did not become ready before the loading deadline. Still waiting for ${pending.length}: ${pending.slice(0, 8).join(", ")}${pending.length > 8 ? ", …" : ""}.`,
          );
        }
        previous = key;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      scope.assert();
    },
    presentFirstFrame: (owner) => {
      try { loadingScope(owner); } catch (error) { return Promise.reject(error); }
      if (registeredView && !registeredViewIsEnabled(registeredView)) {
        return Promise.reject(new Error("The loading viewport is not active."));
      }
      const key = presentationKey(owner);
      const previous = pendingPresentations.get(key);
      if (previous) return previous.promise;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      const timer = setTimeout(() => expirePresentation(key), SCENE_SHADER_WARM_TIMEOUT_MS);
      pendingPresentations.set(key, { promise, resolve, reject, timer, ready: false, attempts: 0, rendered: false, owner, submission: null, copied: false, completionStarted: false });
      return promise;
    },
    unlockAudio: () => audioService?.unlockAsync() ?? Promise.resolve(),
    resetAudioSession: () => {
      audioService?.resetSession();
    },
    resetParticleSession: () => {
      particleService?.resetSession();
    },
    isFreeCamEnabled: () => playFreeCam?.enabled() ?? false,
    steerPlayFreeCam: (forward, right) => {
      playFreeCam?.fly(forward, right);
    },
    whenEditorModelsReady: async (owner) => {
      const scope = loadingScope(owner);
      if (!owner) await (editorSync?.whenEditorModelsReady() ?? Promise.resolve());
      const playLoads = [...(binding.slotAnimLoads?.entries() ?? [])]
        .filter(([slotId]) => (sceneLayerCompositor?.layerIdForSlot(slotId) ?? undefined) === owner?.layerId)
        .map(([, pending]) => pending);
      await Promise.all(playLoads);
      scope.assert();
    },
    modelLoadCount: () =>
      (editorSync?.pendingModelLoadCount() ?? 0) +
      (binding.slotAnimLoads?.size ?? 0),
  };
}

/**
 * Pause the editor viewport while Play is open. Disable this canvas's
 * registerView so Babylon `_renderViews` cannot setSize from the dock while
 * the overlay owns the framebuffer. On close, restore the view, engine size,
 * and invalidate so render-on-demand redraws the docked view.
 */
export function syncEditorPlayState(
  handle: EngineHandle,
  playing: boolean,
): void {
  handle.setPaused(playing);
  handle.setRegisterViewEnabled(!playing);
  if (!playing) {
    handle.resize();
    handle.scheduler.invalidate("play");
  }
}

function materialTextureGuidMap(
  documents: ReadonlyMap<string, MaterialDocument>,
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [guid, document] of documents) {
    out.set(guid, materialDependencies(document).textures);
  }
  return out;
}

/** Texture work the first frame still waits on, named for loading diagnostics. */
function pendingSceneTextureWork(scene: Scene): string[] {
  // Native RGBD environment/BRDF decoding outlives the texture load event and
  // can render asynchronously even when no current material samples the map.
  const pending = pendingSceneTextures(scene);
  if (!isEnvironmentLightingReady(scene)) pending.push("environment lighting");
  for (const material of scene.materials) {
    if (material instanceof NodeMaterial && !nodeMaterialTexturesSampleReady(material)) {
      pending.push(`material "${material.name}" samples`);
    }
    for (const texture of material.getActiveTextures()) {
      if (!texture.isReady()) pending.push(`material "${material.name}" texture "${texture.name}"`);
    }
  }
  return pending;
}

function isOverlayOnlyMeshKind(meshKind: string | null | undefined): boolean {
  switch (meshKind) {
    case "2dtexture":
    case "2dmaterial":
    case "2dbutton":
    case "2dpanel":
    case "2dtext":
    case "2drichtext":
      return true;
    default:
      return false;
  }
}

/** World scenes also use these kinds; hold off until spawn classifies the slot. */
function isAmbiguousHudMeshKind(meshKind: string | null | undefined): boolean {
  return meshKind === "sprite" || meshKind === "tilemap";
}

function setOtherEngineViewsEnabled(
  engine: AbstractEngine,
  except: HTMLCanvasElement,
  enabled: boolean,
): void {
  for (const view of engine.views ?? []) {
    if (view.target !== except) setRegisteredViewEnabled(view, enabled);
  }
}

/** Create the project-lifetime Engine (no scene). */
export function createAppEngine(
  canvas: HTMLCanvasElement,
  options: Pick<
    CreateEngineOptions,
    "ktx2BasePath" | "dracoBasePath" | "meshoptBasePath"
  > = {},
): Engine {
  configureKtx2Transcoder(KhronosTextureContainer2, options.ktx2BasePath);
  configureGltfMeshDecoders(DracoDecoder, MeshoptCompression, {
    dracoBasePath: options.dracoBasePath,
    meshoptBasePath: options.meshoptBasePath,
  });
  const engine = new Engine(canvas, false, {
    preserveDrawingBuffer: true,
    stencil: true,
    adaptToDeviceRatio: false,
    antialias: false,
    useLargeWorldRendering: true,
      useExactSrgbConversions: true,
  });
  configureKtx2DecoderRuntime(KhronosTextureContainer2, {
    caps: engine.getCaps(),
    renderer: (
      engine as { getGlInfo?: () => { renderer?: string } }
    ).getGlInfo?.().renderer,
  });
  return engine;
}
import { AreaRectLightGroup } from "./area-rect-light";
