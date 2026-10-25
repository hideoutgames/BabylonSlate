import type { EngineGpuTimingObservation, EngineGpuTimingSample } from "./engine-gpu-timing";
import type { RuntimeMaterialPreparationRequest, RuntimeMaterialCommitCommand } from "./runtime-material-edit";
import type { RuntimeTransformTools, RuntimeTransformToolsOptions } from "./runtime-transform-tools";
import type { RenderFrameReport } from "./render-frame-report";
import type { AudioLibrary } from "./audio-service";
import type { ParticleLibrary } from "./particle-service";
import type { AudioPlaybackBackend } from "./audio-playback-backend";
import type { RagdollCaptureResult } from "./ragdoll-pose";
import type { RenderProjectSettings, ScalabilityAcknowledgement } from "@haptic/core";
import type { RenderPath, ResolvedRenderingPipeline } from "@haptic/core";
import type { SceneOutlineSelection } from "./scene-outline-host";
import type { SceneLayerLoadIdentity } from "./scene-load-readiness";
import type { SceneStreamIdentity } from "./scene-streaming-readiness";
import type { SceneSourceAssets } from "./scene-source-assets";
import type { LoadRehearsalReport } from "./load-rehearsal";
import type { nativePreparationForEngine, NativePreparationLimits, NativePreparationPriority } from "./native-preparation";
import type { AbstractEngine } from "@babylonjs/core";
import type { RenderDiagnostics } from "./render-diagnostics";
import type { RenderPerformanceSample } from "./render-performance";
import type { Scene } from "@babylonjs/core";
import type {
  AudioProjectSettings,
  PhysicsWorldKind,
  SerializedScene,
  ViewportMode,
} from "@haptic/core";
import type { RenderShadingSettings } from "./render-settings";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
} from "@haptic/assets";
import type { CommandMessage } from "@haptic/bridge";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@haptic/shader-graph";
import type { EditorCameraController } from "./editor-camera";
import type { EditorGrid } from "./editor-grid";
import type { EditorSceneSync } from "./editor-scene-sync";
import type { EditorDropTransform } from "./editor-drop";
import type { ViewportShadingMode } from "./viewport-shading-mode";
import type { GizmoHost } from "./gizmo-host";
import type { ComponentShapeEdit } from "./shape-handles";
import type { EditorColorScheme } from "./editor-clear-color";
import type { RenderScheduler } from "./render-scheduler";
import type { CommandSourceLoader } from "./command-source-preparation";
import type { TextureResources } from "./resource-cache";
import type { HardwareScalingController } from "./hardware-scaling";
import type { NavDebugBlockerPose } from "./nav-debug-overlay";
import type { MeshAssetContext } from "./mesh-assets";
import type { FontAssetEntry } from "./font-registry";
import type { SceneLayerControlEvent } from "./ui-controls2d-input";
import type {
  PostProcessStackDiagnostic,
  PostProcessStackInput,
} from "./post-process-material";

export interface EditorSceneLoadOptions {
  signal: AbortSignal;
  assets?: MeshAssetContext;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  /** Project asset guid of the loaded Scene document. */
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
  prepareRuntimeMaterialEdit: (request: RuntimeMaterialPreparationRequest) => Promise<void>;
  commitRuntimeMaterialEdit: (command: RuntimeMaterialCommitCommand) => { success: boolean; reason?: string };
  releaseRuntimeMaterialPreparation: (editToken: string) => void;
  /** Keep-only: drain accepted render owners after the correlated runtime command fence. */
  quiesceAuthoringRevision: (commandRevision: number, signal: AbortSignal) => Promise<{ commandRevision: number }>;
  /** Cold authored assignment sources prepare before replacing a live visual. */
  setCommandSourceLoader?: (loader: CommandSourceLoader | null) => void;
  setPaused: (paused: boolean) => void;
  /** Freeze render-owned game time independently of presentation/input pause reasons. */
  setGameTimePaused: (paused: boolean) => void;
  /** SceneLayer input gate, independent of Simulation Edit and pause ownership. */
  setGameInputEnabled: (enabled: boolean) => void;
  /**
   * True while a SceneLayer joystick, 2D control or active scroll drag owns
   * the pointer, so game input capture must not report it. Settled by the
   * engine's own canvas listeners, which run before a later-attached capture.
   */
  ownsGamePointer: (pointerId: number) => boolean;
  /**
   * Send the current Scene Layer and canvas size through `onSceneLayerResize`
   * again. Hosts call it once their runtime exists: the report `createEngine`
   * makes comes before there is a runtime to receive it.
   */
  publishSceneLayerSize: () => void;
  /** Use the existing debug camera while preserving the possessed game camera/listener. */
  setSimulationEditMode: (enabled: boolean) => void;
  /** Request one supported render-only frame; unsupported owners retain the last image. */
  requestPausedRedraw: () => { accepted: boolean; reason?: string };
  /** Streaming owns a separate pause, so releasing it cannot resume manual Pause. */
  setSceneStreamingPaused: (paused: boolean) => void;
  /** Enable or disable this canvas's `registerView` client (overlay Play). */
  setRegisterViewEnabled: (enabled: boolean) => void;
  /** Live Babylon mesh/texture counts for Play leak assertions. */
  liveObjectCounts: () => { meshes: number; textures: number };
  /** Last rendered frame's Babylon draw-call count (`_drawCalls.current`). */
  drawCalls: () => number;
  renderDiagnostics: () => RenderDiagnostics;
  /** Whether `lightsdebug` is on, so hosts read `renderDiagnostics().shadowLights` only while it is. */
  lightsDebugEnabled: () => boolean;
  /** Explicit CPU timing only; host controls finite capture, session mode and result retention. */
  observePerformance: (onFrame: (sample: RenderPerformanceSample) => void) => () => void;
  /** Explicit unpaired engine-wide GPU queries; unavailable backends explain why. */
  observeGpuTiming: (onSample: (sample: EngineGpuTimingSample) => void, onError?: (error: unknown) => void) => EngineGpuTimingObservation;
  /** Explicit next coherent game presentation; rejects concurrent profiling. */
  captureFrame: () => Promise<RenderFrameReport>;
  cancelFrameCapture: (reason?: string) => void;
  /** Existing gizmos/selection overlay adapted to exact runtime identities. */
  attachRuntimeTransformTools: (options: RuntimeTransformToolsOptions) => RuntimeTransformTools;
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
  /** Laid-out width in pixels and CSS stack of each Play 2D Text mesh (cold-load font e2e). */
  playText2DLayouts: () => Array<{ slotId: number; name: string; fontStack: string; width: number }>;
  /** Compiled effect defines per Play mesh (e2e shader-state readout). */
  playMeshMaterialDefines: () => Array<{
    mesh: string;
    material: string | null;
    defines: string;
  }>;
  /** Sprite/tilemap textures and GLB bytes for editor + Play mesh builders. */
  setMeshAssets: (assets: MeshAssetContext) => void;
  /**
   * Swap the stored encoding (PNG to KTX2) of Textures already installed with
   * `setMeshAssets`, when their pixels, sampler and settings are unchanged.
   * Editor meshes and Materials stay alive; a guid whose installed bytes are
   * already identical is left as it is, and a guid never installed is ignored.
   * Returns the guids whose installed bytes match the given bytes afterwards:
   * the replaced ones and the already-identical ones. A guid that is not
   * returned still needs `setMeshAssets`, or a retry once it is installed.
   * Content edits go through `setMeshAssets`.
   */
  replaceTextureBytes: (textureBytes: ReadonlyMap<string, Uint8Array | Blob>) => string[];
  /** Retain prepared source maps until the consuming runtime instance is retired. */
  /**
   * `prepare` loads the sources' textures, Materials and models before resolving; `warm` (a latent spawn's preload:
   * Spawn Actor, a Class load) then also compiles them against the current lighting (`warmSpawnables`). A scene's
   * sources leave `warm` off: its load compiles once its lighting is final.
   */
  acquireSceneSources: (sources: SceneSourceAssets, options?: { prepare?: boolean; warm?: boolean; signal?: AbortSignal; priority?: NativePreparationPriority }) => Promise<() => void>;
  nativePreparationStats: () => ReturnType<ReturnType<typeof nativePreparationForEngine>["snapshot"]>;
  /** Play's last load-time warm-up of what it may spawn (`warmSpawnables`): what it compiled for, and how long it took. */
  spawnableWarmStats: () => { materials: number; models: number; ms: number } | null;
  /** Play's last load rehearsal of its light changes (`createLoadRehearsal`), once it has ended. */
  loadRehearsalStats: () => LoadRehearsalReport | null;
  /** Release startup source ownership after its actors have retired. */
  releaseInitialSources: () => void;
  /** Refresh owned library unions without resetting live mixer session settings. */
  setSourceLibraries: (libraries: Pick<SceneSourceAssets, "audioLibrary" | "particleLibrary">) => void;
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
  /**
   * Every Scene this view owns that is still alive: the world Scene and everything the SceneLayer
   * compositor built (layer Scenes and their output-blit Scenes, retired generations still releasing).
   */
  ownedScenes: () => Scene[];
  /** Authored camera post-process passes currently attached. */
  postProcessPassCount: () => number;
  /** Prepared FrameGraph task names in record order, or [] before preparation. */
  renderTaskNames: () => string[];
  /** Unique Material guids currently assigned to Play meshes. */
  assignedMaterialGuids: () => string[];
  /** Local Engine Settings gate. Does not mutate the scene document. */
  setPostProcessingEnabled: (enabled: boolean) => void;
  /** Explicit local quality preferences; runtime commands take precedence. */
  setLocalQualityOverrides: (overrides: import("@haptic/core").QualityOverrides) => void;
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
  /** Replace the active scene's baked audio field; null restores dry acoustics. */
  setAudioReverbField: (bytes: Uint8Array | null) => void;
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
  /** Additive runtime readiness, restricted to the streamed instance's actor slots. */
  prepareSceneStream: (slotIds: readonly number[], signal: AbortSignal, onProgress?: (progress: number) => void, owner?: SceneStreamIdentity) => Promise<void>;
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
  /**
   * The world view started (true) or stopped (false) holding its last image
   * while WebGPU render pipelines, or on any backend effects the driver still
   * compiles, are needed, for `PIPELINE_HOLD_PAUSE_DELAY_MS`; the release is
   * immediate. Play hosts pause the game runtime's time for the hold (pause
   * reason `rendering`, which leaves input alone), as for a blocking load; this
   * Engine already pauses its own game time, audio and particles. Disposing the
   * Engine ends a hold.
   */
  onPipelineHold?: (held: boolean) => void;
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
  onGizmoDragEnd?: () => void;
  /** A component shape handle was released; merge properties as one undoable change. */
  onComponentShapeEdit?: (edit: ComponentShapeEdit) => void;
  /**
   * SceneLayer / overlay-prefab viewports: 2D transform box instead of
   * Position/Rotation/Scale gizmos. World 2D scenes stay on axis gizmos.
   */
  overlayTransformBox?: boolean;
  /** When false, WASD does not fly the editor camera (Play overlay) and Game Camera is not piloted. */
  editorFlyEnabled?: () => boolean;
  /**
   * Game Camera piloting paused: write the Default Camera actor's local
   * transform to the document as one undoable edit.
   */
  onPilotedActorMoveEnd?: (transform: {
    actorId: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  }) => void;
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
  onRagdollPoseCaptured?: (result: RagdollCaptureResult) => void;
  onRuntimeOutputChanged?: (settings: RenderProjectSettings) => void;
  /** Plain scene-owned requested/effective selection, emitted only when it changes. */
  onRenderPathChanged?: (status: ResolvedRenderingPipeline) => void;
  /** Sprite asset payloads keyed by guid so Play can bake clip UVs from animState. */
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  waterPayloads?: ReadonlyMap<string, import("@haptic/core").WaterDefinition>;
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
  renderTargets?: MeshAssetContext["renderTargets"];
  renderTargetTextures?: MeshAssetContext["renderTargetTextures"];
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
    import("@haptic/assets").ModelPayload
  >;
  /** Native clipName → Animation guid, keyed by Model guid. */
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Retargeted Animation loads keyed by the actor (target) Model guid. */
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly import("@haptic/assets").RetargetAnimationLoad[]
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
  /** Shared Engine admission limits, configured when its first handle is created. */
  nativePreparation?: NativePreparationLimits;
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
  prepareAudioAsset?: import("./audio-service").AudioAssetPreparer;
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
  onAudioAssetReady?: (guid: string) => void;
  /** Particle Graph problems also name the graph node (and pin) to focus. */
  onParticleDiagnostic?: (diagnostic: {
    code: string;
    message: string;
    assetGuid?: string;
    nodeId?: string;
    pinId?: string;
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
  /** Authored SceneLayer joystick input for the host input ring. */
  onTouchAxis?: (controlId: string, value: number) => void;
  /** The game reads tilt or device motion (`requestDeviceMotion`); the host starts motion input. */
  onDeviceMotionRequest?: () => void;
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
  onSceneLayerControl?: (event: SceneLayerControlEvent) => void;
  onSceneLayerFocusNavigate?: (reverse: boolean) => void;
  onSceneLayerScroll?: (event: { layerId: string; actorId: string; componentId: string; deltaX: number; deltaY: number }) => void;
  /** Overlay 2DAnchor frustum in world units (height 9, width 9 * aspect). */
  onSceneLayerResize?: (size: {
    frustumWidth: number;
    frustumHeight: number;
    canvasWidth: number;
    canvasHeight: number;
    safeAreaInsets?: { left: number; right: number; top: number; bottom: number };
  }) => void;
  /** Finished non-looping AudioComponent voice (Play graph On Audio Finished). */
  onAudioVoiceEnded?: (voiceId: string) => void;
}

export interface EditorTools {
  camera: EditorCameraController;
  /**
   * The camera controller viewport input should steer: the editor camera, or
   * the Default Camera actor while Game Camera is on and that actor can move.
   */
  navigation: EditorCameraController;
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
  setPixelPerfect: (settings: { pixelsPerUnit: number } | null) => void;
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
  /** Frustum / light / audio debug + 1 Hz Camera or Render Target Capture preview for the current selection. */
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
