import { applyGamepadRumble } from "./gamepad-rumble";
import { applyDeviceVibration } from "./device-vibration";
import { drainEngineAfterRelease } from "./idle-engine-drain";
import { acquireEngineGpuTiming, observeEngineGpuTiming, type EngineGpuTimingLease, type EngineGpuTimingObservation } from "./engine-gpu-timing";
import { RuntimeMaterialEditOwner } from "./runtime-material-edit";
import { drainFinalAuthoringResources } from "./final-authoring-drain";
import { createRuntimeTransformTools, type RuntimeTransformToolsOwner } from "./runtime-transform-tools";
import { beginRenderFrameCapture, RenderFrameReportFeed, type RenderFrameReportReceipt } from "./render-frame-report";
import { pausedSceneRedrawIssue, setSceneGameTimePaused } from "./scene-game-time";
import { applyDynamicRuntimeMeshUpdate } from "./dynamic-runtime-mesh";
import { PostProcessRetirement } from "./post-process-retirement";
import { OverlayLayoutRenderer } from "./overlay-layout-render";
import { sceneRenderTargetCaptures } from "./render-target-capture";
import { AudioService } from "./audio-service";
import { ParticleService } from "./particle-service";
import { acquireParticleMaterial } from "./particle-material";
import type { AudioPlaybackBackend, AudioPose } from "./audio-playback-backend";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { BabylonAudioPlaybackBackend } from "./babylon-audio-backend";
import { createRttCanvasPresent } from "./rtt-canvas-present";
import { directViewPresentationAllowed } from "./direct-view-presentation";
import { admitRegisteredViewFrames, registeredViewIsEnabled, retainOffscreenFrameDispatch, setRegisteredViewEnabled, VIEW_CANVAS_2D_ATTRIBUTES, viewCanvasHasLayoutBox, viewPresentedDirectly } from "./registered-view-admission";
import { configureCutoutSorting, configureEditorRenderingGroups } from "./sorting";
import { nodeMaterialTexturesSampleReady } from "./material-compiler";
import { hasFogVolumes, removeFogVolumes, upsertFogVolumes } from "./fog-volumes";
import { findSceneReflectionProbes } from "./reflection-probes";
import { isFogVolumeOnlySceneEdit } from "./fog-volume-edit";
import { isBuiltInWaterMesh, setSceneWaterTime, settleSceneWater } from "./water-mesh";
import { RuntimeScalability } from "./runtime-scalability";
import { RagdollPoseController } from "./ragdoll-pose";
import { updateBoneAttachments } from "./bone-attachment";
import { normalizeRenderProjectSettings, normalizePlayFrameCap, playFramebufferSize, fogVolumeBindings, outlineBindings, deformerBindings, reflectionProbeStaticActors, type RenderProjectSettings, type ScalabilityAcknowledgement } from "@haptic/core";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { PostProcessParameterState } from "./post-process-parameter-state";
import { applyPostProcessParameterCommand } from "./post-process-parameter-command";
import { sceneRenderPathStatus, subscribeSceneRenderPath } from "./scene-render-path";
import { requestRenderPath, retainPlayRenderPathSession, subscribeRenderPathSession } from "./render-path-session";
import type { RenderPath } from "@haptic/core";
import { submitPresentedFrame } from "./presented-frame";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import {
  isFixedShapeLightingEnabled,
  setFixedShapeLightingEnabled,
  setFixedShapeLightingWorldScene,
} from "./fixed-light-admission";
import { fixedShapeLightGuard, setFixedShapeLightGuard, type FixedLightGuard } from "./fixed-light-binding";
import { SceneOutlineHost, isOutlineOnlySceneEdit } from "./scene-outline-host";
import { SceneDeformerHost, isDeformerOnlySceneEdit } from "./scene-deformer-host";
import { markLatticeComponentRoot } from "./lattice-deformer";
import { isTransformOnlySceneEdit } from "./scene-transform-edit";
import { isLightValueOnlySceneEdit } from "./light-edit";
import type { SceneLayerLoadIdentity } from "./scene-load-readiness";
import { prepareSceneStream } from "./scene-stream-preparation";
import { captureMeshSourceAssets, mergeSceneSourceAssets, type SceneSourceAssets } from "./scene-source-assets";
import { acquireGlbContainer, packedSlimProof, releaseUnownedGlbSources } from "./glb-anim";
import { warmSpawnables } from "./spawnable-warm";
import { createLoadRehearsal, type LoadRehearsal, type LoadRehearsalReport } from "./load-rehearsal";
import { releaseLightPredictions } from "./variant-prediction";
import { nativePreparationForEngine } from "./native-preparation";
import { createSceneStreamAdmission, isSceneStreamSlotPending } from "./scene-stream-admission";
import type { AbstractEngine, AssetContainer, BaseTexture, Camera, EngineOptions, EngineView, Material } from "@babylonjs/core";
import { resolveRenderingQuality } from "@haptic/core";
import { isEnvironmentLightingReady } from "./environment-lighting";
import { createRenderDiagnostics, type GpuAttribution } from "./render-diagnostics";
import { RenderPerformanceFeed, type RenderPerformanceReceipt } from "./render-performance";
import {
  Engine,
  KhronosTextureContainer2,
  NodeMaterial,
  Scene,
  ScenePerformancePriority,
  WebGPUCacheRenderPipeline,
} from "@babylonjs/core";
import type {
  SerializedScene,
} from "@haptic/core";
import { createDefaultScene, engineCommandBus } from "@haptic/core";
import { setSceneRenderSettings } from "./scene-render-mode";
import { liveMeshCount } from "./model-lod";
import { applyMaterialTextureAnisotropy, followSceneRenderSettings, sceneRenderingSettings, sceneWaterQualityDeviceClamp, sceneWaterQualityRevision, resolveSceneRenderingQuality, setSceneEffectsEnabled } from "./render-settings";
import { environmentTextureContainer } from "@haptic/assets";
import {
  isPublishedSnapshot,
  readSnapshotHeader,
  type CommandMessage,
} from "@haptic/bridge";
import {
  materialDependencies,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@haptic/shader-graph";
import { EditorSceneSync } from "./editor-scene-sync";
import { applyCableFrame, stepEditorCables } from "./cable-mesh";
import { createPreviewLighting } from "./preview-lighting";
import {
  ViewportShadingOverlay,
} from "./viewport-shading-mode";
import { DracoDecoder } from "@babylonjs/core/Meshes/Compression/dracoDecoder";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import {
  configureKtx2DecoderRuntime,
  configureKtx2Transcoder,
  type Ktx2DecoderRuntimeOptions,
} from "./ktx2-transcoder";
import { configureGltfMeshDecoders } from "./gltf-mesh-decoders";
import {
  documentEditorColorScheme,
  editorClearColor,
  sceneClearColor,
} from "./editor-clear-color";
import {
  applySceneToBabylonScene,
} from "./scene-loader";
import {
  accountedGeometryBytesForScene,
  holdSceneInstanceCompiles,
} from "./glb-anim";
import { cssCanvasPixelSize, snapCanvasDrawingBuffer } from "./canvas-drawing-buffer";
import {
  applySceneEnvironment as applySerializedSceneEnvironment,
  refreshAuthoredCameraLenses,
} from "./scene-illumination";
import { setupDefaultViewport } from "./viewport";
import { RenderScheduler } from "./render-scheduler";
import { CommandSourcePreparation } from "./command-source-preparation";
import {
  bindResourceCacheToHandle,
  acquireMaterialTexture,
  releaseResourceCacheForEngine,
  resourceCacheForEngine,
} from "./resource-cache";
import { HardwareScalingController, type FramePressureSample } from "./hardware-scaling";
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
import {
  createPlayDebugDraw,
  type PlayDebugDrawController,
} from "./play-debug-draw";
import {
  SnapshotSampler,
  writeSampledAudioPoses,
  type SampledAudioPose,
} from "./snapshot-sync";
import {
  applySnapshotToScene,
  applyAssignMaterial,
  applyAttachToBone,
  applySetMaterialParameter,
  applyAssignMesh,
  applyPainter2DCommand,
  applyUIControl2DCommand,
  applyText2DAppearCommand,
  applyOverlayVisualStyleCommand,
  applyComponentTransformsCommand,
  retainAssignMeshComponentTransforms,
  applyPossessCamera,
  assignedMaterialGuids as listAssignedMaterialGuids,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  disposeWorldOverlayLeftovers,
  refreshPlayActiveCamera,
  resolvePlayGameCamera,
  retirePlaySlot,
  retirePlayWorldSlots,
  migratePlaySlotVisual,
  meshForPlayComponent,
  type SnapshotSceneBinding,
} from "./snapshot-apply";
import { applyAlbedoTexture, installModelSources, installTextureBytes, type MeshAssetContext } from "./mesh-assets";
import { FontRegistry } from "./font-registry";
import { applyAnimStateToScene, onceMissingClip, sceneAnimHostFromBinding, type MissingAnimClip } from "./anim-apply";
import { applyBoneAttachmentAudioPoses } from "./bone-attachment";
import { pickAtCanvas } from "./picking";
import { mapCanvasPointer } from "./pick-coords";
import { refreshJoystick2DMaterials } from "./joystick2d-mesh";
import { Joystick2DInput } from "./joystick2d-input";
import { refreshUIControl2DMaterials } from "./ui-controls2d-mesh";
import { UIControls2DInput } from "./ui-controls2d-input";
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
} from "@haptic/core";
import { updateSceneTilemapAnimations } from "./tilemap-mesh";
import { EditorDebugOverlay } from "./editor-debug-overlay";
import { beginEngineDrawCallFrame, readEngineDrawCalls } from "./draw-calls";
import { MaterialLibrary } from "./material-library";
import { refreshText2DMaterials } from "./text2d-mesh";
import {
  normalizePostProcessStack,
  type AttachedPostProcessStack,
  type PostProcessStackInput,
} from "./post-process-material";
import {
  applyEditorMaterialFreeze,
  pendingSceneTextures,
  prewarmSceneMaterials as warmSceneMaterials,
  SCENE_LOOKUP_MAPS,
  SCENE_FIRST_FRAME_TIMEOUT_MS,
  SCENE_SHADER_WARM_TIMEOUT_MS,
} from "./scene-perf";
import { firstFrameCompletionMs } from "./stall-deadline";
import { DriverCompileWatch } from "./driver-compile";

import { createEditorViewportTools } from "./editor-viewport-tools";
import { createPlayGameInput } from "./play-game-input";
import { createPlayVisualBindings } from "./play-visual-bindings";
import { createPlayHandleInspection } from "./play-handle-inspection";
import type {
  CreateEngineOptions,
  EditorSceneLoadOptions,
  EditorTools,
  EngineHandle,
  PlayActorPosition,
} from "./create-engine-types";

export type {
  CreateEngineOptions,
  EditorSceneLoadOptions,
  EditorTools,
  EngineHandle,
  PlayActorPosition,
} from "./create-engine-types";
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

/** Render-loop passes (about ten seconds at 60 Hz) that frame-phase timing outlives its last `renderDiagnostics()` read. */
const FRAME_PHASE_LEASE_FRAMES = 600;
/**
 * A hold for GPU work (`onPipelineHold`) pauses Play only once the view has held its image this long, so a
 * brief wait costs no stop; the release is immediate.
 */
export const PIPELINE_HOLD_PAUSE_DELAY_MS = 250;
/**
 * The project Engine's construction options, for editor views and the app
 * Engine alike. A new object each time: Babylon writes resolved values back
 * into the options it is given, which must not reach the next Engine.
 */
function projectEngineOptions(): EngineOptions {
  return {
    preserveDrawingBuffer: true,
    stencil: true,
    adaptToDeviceRatio: false,
    antialias: false,
    useLargeWorldRendering: true,
    useExactSrgbConversions: true,
  };
}

/** Frames with no layer still presenting share this set instead of building one. */
const NO_PRESENTING_LAYERS: ReadonlySet<string> = new Set();

function initializeEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions,
  onRollback: (cleanup: () => void) => void,
): EngineHandle {
  // This view owns its retained source references independently of the caller.
  options = { ...options };
  // Decoder statics are page-global. Overlay Play borrows the editor Engine,
  // so the page's last Play view returns later editor decodes to workers.
  // Retain before the Play configuration so any construction failure restores it.
  let ktx2Runtime: Pick<Ktx2DecoderRuntimeOptions, "caps" | "renderer"> | null = null;
  const releaseMainThreadDecoding = options.playMode
    ? retainMainThreadDecoding(() => {
        configureGltfMeshDecoders(DracoDecoder, MeshoptCompression, {
          dracoBasePath: options.dracoBasePath,
          meshoptBasePath: options.meshoptBasePath,
        });
        // Without an Engine this view never moved KTX2 decoding to the main thread.
        if (ktx2Runtime) configureKtx2DecoderRuntime(KhronosTextureContainer2, ktx2Runtime);
      })
    : null;
  onRollback(() => releaseMainThreadDecoding?.());
  // Views mounted while any Play view is live keep Play's main-thread decoding.
  const mainThreadDecoding = mainThreadDecodingViews > 0;
  configureKtx2Transcoder(KhronosTextureContainer2, options.ktx2BasePath);
  configureGltfMeshDecoders(DracoDecoder, MeshoptCompression, {
    dracoBasePath: options.dracoBasePath,
    meshoptBasePath: options.meshoptBasePath,
    playMode: mainThreadDecoding,
  });

  const ownsEngine = !options.sharedEngine;
  const presentRtt = options.present === "rtt";
  // The visible bitmap must survive skipped/loading frames and backend RTT
  // work. Keep owned browser engines on a private constructor canvas, using
  // the same admitted native view copy as project-shared handles. The 2D
  // context is created here, before registerView, with the view attributes.
  const visibleContext = typeof canvas.getContext === "function" &&
    (options.sharedEngine || typeof document !== "undefined")
    ? canvas.getContext("2d", VIEW_CANVAS_2D_ATTRIBUTES) : null;
  const constructorCanvas = ownsEngine && visibleContext && typeof document !== "undefined"
    ? document.createElement("canvas") : canvas;
  const engine =
    options.sharedEngine ??
    new Engine(constructorCanvas, false, projectEngineOptions());
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
  ktx2Runtime = {
    caps: engine.getCaps(),
    renderer: (
      engine as { getGlInfo?: () => { renderer?: string } }
    ).getGlInfo?.().renderer,
  };
  const releasePlayRenderPath = options.playMode ? retainPlayRenderPathSession(engine) : null;
  onRollback(() => releasePlayRenderPath?.());
  // Console `fixedlights` switches the shared Engine; the state it found comes back when this view goes.
  let fixedShapeLightingBefore: { enabled: boolean; guard: FixedLightGuard } | null = null;
  const restoreFixedShapeLighting = () => {
    if (!fixedShapeLightingBefore) return;
    setFixedShapeLightGuard(engine, fixedShapeLightingBefore.guard);
    setFixedShapeLightingEnabled(engine, fixedShapeLightingBefore.enabled);
    fixedShapeLightingBefore = null;
  };
  configureKtx2DecoderRuntime(KhronosTextureContainer2, {
    mainThread: mainThreadDecoding,
    ...ktx2Runtime,
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
  // Scene tabs stay mounted; Babylon _renderViews still setSize+blit every
  // enabled view. Disable them so overlay Play owns the framebuffer, and
  // re-enable only those afterwards (a hidden tab's view stays disabled).
  const heldEngineViews = registeredView && options.playMode ? holdOtherEngineViews(engine, canvas) : [];

  const scene = new Scene(engine, SCENE_LOOKUP_MAPS);
  // The editor world view, Play and the exported player; Prefab Preview (and its two-fill studio lights) keeps the
  // legacy lighting path.
  if (!presentRtt && !options.previewLighting) setFixedShapeLightingWorldScene(scene);
  // Every view shares the same graph path for authored and selection outlines.
  // The graph owns its active queue; editor world matrices still freeze.
  // The world view draws every frame and presents only rendered ones, so a
  // draw whose WebGPU pipeline is still compiling holds the last image.
  const worldRenderer = new SceneRenderCoordinator(scene, { deferPipelines: true });
  onRollback(() => worldRenderer.dispose());
  let disposed = false;
  let streamAdmission: ReturnType<typeof createSceneStreamAdmission> | undefined;
  let releasedHandle: Promise<void> | null = null;
  let contextLost = false;
  let loadGeneration = 0;
  let worldLoading = false;
  let worldLoadId = 0;
  let worldSceneAssetGuid: string | null = null;
  // A world load's model and foliage instances compile in its warm-up, under final lighting, not as they publish.
  // The editor's blocking load holds while its generation is current, Play's while its scene load is.
  let instanceCompileHold: (() => boolean) | null = null;
  holdSceneInstanceCompiles(scene, () => instanceCompileHold?.() ?? false);
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
    errorsCleared: boolean;
    /** WebGPU render pipelines the latest submitted draw created; they build inside its GPU completion. */
    pipelines: number;
    /** Restarts the loading deadline (progress that is not a compile: a rehearsal step). */
    restart?: () => void;
  };
  const pendingPresentations = new Map<string, PendingPresentation>();
  /**
   * Play's load rehearsal of its light changes (`load-rehearsal.ts`), run in the world presentation's loading frames
   * before its first presented frame; its report once it ends.
   */
  let loadRehearsal: LoadRehearsal | null = null;
  let loadRehearsalReport: LoadRehearsalReport | null = null;
  const endLoadRehearsal = () => {
    if (!loadRehearsal) return;
    loadRehearsal.cancel();
    // Its Effects go with its load: Play keeps one Scene across loads, which would otherwise keep every level's.
    loadRehearsal.release();
    loadRehearsalReport = loadRehearsal.report();
    loadRehearsal = null;
  };
  const frameOwners = new Map<string, PendingPresentation>();
  const presentationKey = (owner?: SceneLayerLoadIdentity) => owner ? `layer:${owner.layerId}` : "world";
  const cancelPresentation = (error: Error, key?: string) => {
    for (const [id, pending] of pendingPresentations) {
      if (key !== undefined && id !== key) continue;
      if (id === "world") endLoadRehearsal();
      pendingPresentations.delete(id);
      clearTimeout(pending.timer);
      pending.submission?.cancel();
      pending.reject(error);
    }
  };
  const expirePresentation = (key: string) => {
    const pending = pendingPresentations.get(key);
    if (!pending) return;
    cancelPresentation(new Error(`The scene did not present a frame before the loading deadline. Ready: ${pending.ready}; draws: ${pending.attempts}; rendered: ${pending.rendered}; GPU pending: ${Boolean(pending.submission)}; copied: ${pending.copied}; render pipelines created: ${pending.pipelines}.`), key);
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
    worldRenderer.invalidate();
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
  // A handle without a registered view draws into the same Engine frame as the
  // registered views; the sole-view gate counts it while its canvas is shown.
  const viewlessShown = registeredView ? null : () => !disposed && scheduler.isShown();
  const releaseViewless = viewlessShown ? retainViewlessRenderer(engine, viewlessShown) : null;
  onRollback(() => releaseViewless?.());
  let frameCopyReady = false;
  let frameWasLoading = false;
  const presentationStats = {
    attempted: 0, drawn: 0, copied: 0, held: 0,
    preparationMs: 0, copyMs: 0,
    contextLosses: 0, contextRestorations: 0,
  };
  /** `presentationStats.attempted` when the current view step began. */
  let attemptedAtStep = 0;
  /** Rendered-loop passes of preparation timing left; each `renderDiagnostics()` read renews it so a closed HUD stops the timing. */
  let framePhaseLeaseFrames = 0;
  const performanceFeed = new RenderPerformanceFeed();
  const frameReportFeed = new RenderFrameReportFeed();
  let pendingFrameReportReceipt: RenderFrameReportReceipt | null = null;
  onRollback(() => frameReportFeed.cancel("Scene construction failed."));
  let pendingPerformanceReceipt: RenderPerformanceReceipt | null = null;
  let admissionPreparationMs = 0;
  onRollback(() => performanceFeed.dispose());
  const outlineHost = new SceneOutlineHost(scene, worldRenderer, () => scheduler.invalidate("selection"));
  onRollback(() => outlineHost.dispose());
  const deformerHost = new SceneDeformerHost(scene);
  onRollback(() => deformerHost.dispose());
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
  // While a presentation fence is outstanding, no loading work may touch the GL
  // context: the strict readiness probe finalises effects, a retry draw queues
  // more driver compiles, and each synchronous query waits behind all of them.
  const presentationFenceWaiting = () => {
    for (const pending of pendingPresentations.values()) if (pending.submission?.fenceWaiting()) return true;
    return false;
  };
  const hasLoadingFrame = () => {
    if (presentationFenceWaiting()) return false;
    for (const pending of pendingPresentations.values()) {
      if (!pending.copied && presentationReady(pending)) return scheduler.canPresentLoadingFrame();
    }
    return false;
  };
  const hasPendingOwners = () => {
    if (worldLoading) return true;
    for (const layer of layerLoads.values()) if (!layer.ready) return true;
    return false;
  };
  const hasReadyContent = () => !worldLoading || (sceneLayerCompositor?.layers().some((layer) => layerLoads.get(layer.layerId)?.ready !== false) ?? false);
  // renderLoop passes the loading permit it already evaluated for this frame.
  const shouldRenderFrame = (now: number, loadingFrame?: boolean) => (worldLoading || runtimeScalability?.canPresent !== false) && !rttPresent?.isPresenting() && ((loadingFrame ?? hasLoadingFrame()) || (hasReadyContent() &&
    (hasPendingOwners() ? scheduler.shouldRenderReadyOwners(now) : scheduler.shouldRender(now))));
  const releaseViewAdmission = registeredView ? admitRegisteredViewFrames(engine, registeredView, () =>
    {
      if (disposed || contextLost) return false;
      const preparationStart = performanceFeed.active ? performance.now() : 0;
      streamAdmission?.sync();
      if (!worldLoading) runtimeScalability?.advance();
      // Prepare against this view's private-buffer dimensions before Babylon
      // resizes its visible canvas. A pending graph must retain that bitmap.
      const css = cssCanvasPixelSize(canvas);
      const scale = engine.getHardwareScalingLevel();
      const locked = scaledLockedViewSize();
      const size = locked ?? {
        width: Math.max(1, Math.floor(css.width / scale)),
        height: Math.max(1, Math.floor(css.height / scale)),
      };
      // A canvas with no layout box (a hidden dock tab) has nothing to present, yet the scheduler only learns
      // that from an IntersectionObserver callback a frame or more later. Until then, `css` floors to 1×1:
      // neither resize the shared Engine to that for it nor draw it, since a 1×1 frame re-plans the graph
      // (the water scene copy is off at that size) and compiles the variants it then draws. Direct
      // presentation does not count such a view either.
      const noLayout = !locked && !viewCanvasHasLayoutBox(canvas);
      if (!noLayout && (engine.getRenderWidth(true) !== size.width || engine.getRenderHeight(true) !== size.height))
        engine.setSize(size.width, size.height);
      admittedSnapshot = prepareSnapshot();
      snapshotAdmitted = true;
      const admitted = !noLayout && shouldRenderFrame(performance.now());
      if (performanceFeed.active) admissionPreparationMs = performance.now() - preparationStart;
      return admitted;
    }, {
      begin: () => { frameCopyReady = false; attemptedAtStep = presentationStats.attempted; },
      canCopy: () => frameCopyReady && !disposed && !contextLost,
      // renderLoop counts an attempt once it passes shouldRenderFrame, before it touches the framebuffer.
      dirty: () => presentationStats.attempted !== attemptedAtStep,
      // Only the editor's project Engine presents directly. The exported player and Preview Build run their own
      // Engine session, whose view canvas keeps receiving copies: the player and its checks read those pixels.
      allowDirect: () => directViewPresentationAllowed(engine),
      copied: (milliseconds) => {
        presentationStats.copyMs = milliseconds;
        acknowledgeFrameCopy(undefined, pendingPerformanceReceipt, milliseconds);
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
  const nativePreparation = nativePreparationForEngine(engine, options.nativePreparation);
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
        onAssetReady: options.onAudioAssetReady,
        loadSourceBytes: options.loadAudioSourceBytes,
        prepareAsset: options.prepareAudioAsset,
        preparation: nativePreparation,
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
  const snapshots = new SnapshotSampler(options.maxActors ?? 256);
  const binding: SnapshotSceneBinding = createSnapshotSceneBinding();
  let gameInputEnabled = true;
  let simulationEditMode = false;
  const acceptsGameInput = () => !disposed && gameInputEnabled && !simulationEditMode && !binding.paused;
  if (options.playMode) streamAdmission = createSceneStreamAdmission(scene, binding);
  onRollback(() => streamAdmission?.clear());
  onRollback(() => disposeSnapshotBinding(binding));
  if (options.playMode && options.onRagdollPoseCaptured) {
    binding.ragdoll = new RagdollPoseController(binding, options.onRagdollPoseCaptured, () => scheduler.invalidate("snapshot"));
    scene.onAfterAnimationsObservable.add(() => {
      binding.ragdoll?.update();
      updateBoneAttachments(binding);
    });
  }
  binding.tilemaps = options.tilemapPayloads;
  binding.waters = options.waterPayloads;
  if (options.playMode) setSceneWaterTime(scene, 0);
  binding.tilesets = options.tilesetPayloads;
  binding.pixelsPerUnit = options.pixelsPerUnit;
  binding.sortingLayers = options.sortingLayers;
  binding.pixelPerfect = options.pixelPerfect === true;
  binding.spritePayloads = options.spritePayloads;
  binding.spriteAnimations = options.spriteAnimations;
  binding.textureBytes = installTextureBytes(options.textureBytes);
  binding.renderTargets = options.renderTargets;
  binding.renderTargetTextures = options.renderTargetTextures;
  const renderTargetCaptures = sceneRenderTargetCaptures(scene);
  renderTargetCaptures.setAssets(binding.renderTargets, binding.renderTargetTextures);
  // Full Quality captures draw the scene's gameplay outlines, never the editor selection.
  renderTargetCaptures.setOutlines((renderer, includes) => outlineHost.attachCaptureView(renderer, includes));
  const captureActorSlots = new Map<number, string>();
  const runtimeActorIdentities = new Map<number, import("@haptic/bridge").RuntimeObjectIdentity>();
  const runtimeComponentTokens = new Map<number, Map<string, number>>();
  binding.areaEmissions = options.areaEmissions;
  binding.texturePixelSizes = options.texturePixelSizes;
  binding.fontFacetypeBytes = options.fontFacetypeBytes;
  binding.fontMsdfJson = options.fontMsdfJson;
  binding.fontMsdfPng = installTextureBytes(options.fontMsdfPng);
  binding.fontCssStack = options.fontCssStack;
  binding.fontCssStackByGuid = options.fontCssStackByGuid;
  const fontRegistry = new FontRegistry();
  onRollback(() => fontRegistry.dispose());
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

  let runtimeTransformTools: RuntimeTransformToolsOwner | null = null;
  let runtimeTransformToolsEnabled = false;
  onRollback(() => runtimeTransformTools?.dispose());
  const playFreeCam: PlayFreeCamController | null = options.playMode
    ? createPlayFreeCamController(scene, {
        binding,
        mode: options.viewportMode ?? "3d",
        onChanged: () => {
          if (gameTimePaused) scheduler.requestPausedFrame();
          else scheduler.invalidate("camera");
        },
      })
    : null;
  onRollback(() => playFreeCam?.dispose());
  // Assigned once SceneLayer picking exists; a HUD control keeps its drag.
  let overlayBlocksPointer: (canvasX: number, canvasY: number) => boolean = () => false;
  const playFreeCamInput: PlayFreeCamInputHandle | null = playFreeCam
    ? attachPlayFreeCamInput(canvas, playFreeCam, {
        mode: options.viewportMode ?? "3d",
        blockPointer: (x, y) => (runtimeTransformTools?.blocksCameraPointer(x, y) ?? false) || overlayBlocksPointer(x, y),
      })
    : null;
  onRollback(() => playFreeCamInput?.dispose());
  const playViz: PlayConsoleVizController | null = options.playMode
    ? createPlayConsoleViz(scene, {
        navmeshBytes: options.navmeshBytes,
        navBlockers: options.navBlockers,
        world: options.physicsWorld ?? options.viewportMode,
        layerScene: (layerId) => sceneLayerCompositor?.layers().find((layer) => layer.layerId === layerId)?.scene,
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
  // The library memoizes lowered plans per functions record identity; every
  // accepted installMaterialDocuments replaces it.
  let materialFunctionRecord = Object.fromEntries(materialFunctions);
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
    functions: () => materialFunctionRecord,
    acquireTexture: (guid, consumerScene) => {
      if (binding.renderTargetTextures?.has(guid)) {
        return renderTargetCaptures.acquireTexture(guid, consumerScene);
      }
      const bytes = binding.textureBytes?.get(guid);
      if (!bytes) return null;
      return acquireMaterialTexture(resourceCache, guid, engine, bytes);
    },
    onTextureError: (diagnostic) => {
      options.onMaterialDiagnostic?.(diagnostic);
    },
    onMaterialReady: (materialScene, assetGuid) => {
      // Babylon completes deferred post-process effects on the attached pass.
      // Rebuilding here releases the ready material and starts compilation again.
      // Only the editor actors that resolved this Material are rebound.
      if (materialScene === scene) editorSync?.refreshMaterialsCoalesced(assetGuid);
      for (const root of binding.meshes.values()) {
        if (root.getScene() === materialScene) { refreshText2DMaterials(root, binding); refreshJoystick2DMaterials(root, binding); refreshUIControl2DMaterials(root, binding); }
      }
      scheduler.invalidate("asset");
    },
  });
  onRollback(() => materialLibrary.dispose());
  const runtimeMaterialEdits = new RuntimeMaterialEditOwner(binding, materialLibrary);
  let finalAuthoringDrain: AbortController | null = null;
  onRollback(() => runtimeMaterialEdits.dispose());
  binding.resolveMaterial = (guid, options) => {
    const host = options?.scene ?? scene;
    const document = materialDocuments.get(guid);
    if (!document) return null;
    const resolved = materialLibrary.resolveWithReadiness(host, guid, document, options);
    if (!resolved) return null;
    if (resolved.ready) compiledMaterialGuids.add(guid);
    else compiledMaterialGuids.delete(guid);
    return resolved.material;
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
        acquireMaterial: (guid, owner) => {
          const document = materialDocuments.get(guid);
          return document ? acquireParticleMaterial(materialLibrary, guid, document, owner) : null;
        },
        resolveEmitter: (slotId) => binding.meshes.get(slotId) ?? null,
        onDiagnostic: options.onParticleDiagnostic,
        sortingLayers: () => binding.sortingLayers,
      })
    : null;
  onRollback(() => particleService?.dispose());
  // One adapter per binding, shared by every animState replay: sprite sources
  // are read when a clip resolves, so applying a command allocates no host.
  const animHostOptions = (onMissingClip?: (info: MissingAnimClip) => void): NonNullable<Parameters<typeof sceneAnimHostFromBinding>[1]> => ({
    get spritePayloads() { return binding.spritePayloads ?? options.spritePayloads; },
    get spriteAnimations() { return binding.spriteAnimations ?? options.spriteAnimations; },
    applyTexture: (mesh, guid) => applyAlbedoTexture(mesh, mesh.getScene(), guid, binding),
    onMissingClip,
  });
  const animHost = sceneAnimHostFromBinding(binding, animHostOptions());
  // Once per slot and clip for this Play session. A model whose clips are still loading is not
  // reported, so it does not use up the warning.
  const warnMissingClip = onceMissingClip((info) =>
    console.warn(`[render] missing ${info.clipKind} clip "${info.clipName}" on slot ${info.slotId}`));
  const animHostReportingMissing = sceneAnimHostFromBinding(binding, animHostOptions((info) => {
    const groups = binding.slotAnimationGroups?.get(info.slotId);
    if (info.clipKind === "animation" && (!groups || groups.length === 0)) return;
    warnMissingClip(info);
  }));
  binding.slotVisualReady = (slotId, successor) => {
    // Move emitter nodes before recursive retirement of the old visual root.
    particleService?.bindSlot(slotId, successor);
    queueMicrotask(() => {
      if (successor.isDisposed() || binding.meshes.get(slotId) !== successor) return;
      appliedSnapshotIdentity = null;
      const pending = binding.pendingAnimState?.get(slotId);
      if (pending) applyAnimStateToScene(animHost, pending);
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

  const rebuildPostProcessStack = () => {
    const camera = scene.activeCamera;
    const stack = postProcessParameters.effective(postProcessStack);
    const resolutionScale = resolveSceneRenderingQuality(scene).postprocessing.resolutionScale;
    const key = JSON.stringify([postProcessingEnabled, stack, resolutionScale, materialRevision]);
    if (key === appliedPostProcessKey && camera === appliedPostProcessCamera) return;
    retireAttachedStack();
    appliedPostProcessKey = key;
    appliedPostProcessCamera = camera;
    // Full Quality captures run the scene view's stack, with the parameter
    // writes made so far; later writes reach both through the parameter command.
    renderTargetCaptures.setPostProcess(postProcessingEnabled && camera ? (renderer, captureCamera) => renderer.attachPostProcess({
      scene, camera: captureCamera, library: materialLibrary, stack: postProcessParameters.effective(postProcessStack),
      documentFor: (guid) => materialDocuments.get(guid) ?? null, resolutionScale,
    }) : null);
    if (!postProcessingEnabled || !camera) return;
    attachedStack = worldRenderer.attachPostProcess({
      scene,
      camera,
      library: materialLibrary,
      stack,
      documentFor: (guid) => materialDocuments.get(guid) ?? null,
      resolutionScale,
      onDiagnostic: (diagnostic) => options.onPostProcessDiagnostic?.(diagnostic),
    });
  };

  let appliedQuality: ReturnType<typeof resolveRenderingQuality> | undefined;
  let appliedEffectsKey: string | undefined;
  let appliedWaterRevision: number | undefined;
  let appliedProject: unknown;
  let appliedSceneOverrides: unknown;
  let appliedSessionOverrides: unknown;
  let appliedRuntimeOverrides: unknown;
  let appliedLocalOverrides: unknown;
  const applyTextureAnisotropy = (texture: BaseTexture) => {
    const anisotropy = appliedQuality?.textures.anisotropy ?? 4;
    applyMaterialTextureAnisotropy(texture, Math.min(anisotropy, engine.getCaps().maxAnisotropy ?? 1));
  };
  const applyQualitySettings = (state: ReturnType<typeof sceneRenderingSettings>) => {
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
      for (const layer of sceneLayerCompositor?.layers() ?? [])
        for (const texture of layer.scene.textures) applyTextureAnisotropy(texture);
    }
    if (previous && previous.postprocessing.resolutionScale !== quality.postprocessing.resolutionScale) {
      rebuildPostProcessStack();
      sceneLayerCompositor?.refreshPostProcess();
    }
  };
  const applyRenderingQuality = () => {
    const state = sceneRenderingSettings(scene);
    applyQualitySettings(state);
    // Fog Volume presence, a published LUT and the effects toggle replan the
    // effects key without touching the quality inputs compared above.
    const effectsKey = state.effectsKey;
    if (appliedEffectsKey !== undefined && appliedEffectsKey !== effectsKey) {
      rebuildPostProcessStack();
      worldRenderer.invalidate();
    }
    appliedEffectsKey = effectsKey;
    // Each forward graph re-plans its water-owned passes (scene copy, planar,
    // FFT) when the revision it was built for is stale; this supersedes a
    // world preparation that is already under way.
    const waterRevision = sceneWaterQualityRevision(scene);
    if (appliedWaterRevision !== undefined && appliedWaterRevision !== waterRevision)
      worldRenderer.invalidate();
    appliedWaterRevision = waterRevision;
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
            onDiagnostic: (diagnostic) =>
              options.onPostProcessDiagnostic?.(diagnostic),
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
  const commandSources = new CommandSourcePreparation({ onError: (error) => console.warn(`[render] ${error.message}`) });
  let applyingPreparedCommand = false;
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
  const joysticks = new Joystick2DInput(
    id => layerLoads.get(id)?.ready === false ? undefined : sceneLayerCompositor?.layers().find(layer => layer.layerId === id),
    pointerCanvas,
    (controlId, value) => options.onTouchAxis?.(controlId, value),
  );
  onRollback(() => joysticks.reset());
  const uiControls = new UIControls2DInput(
    () => (sceneLayerCompositor?.layers() ?? []).filter(layer => layerLoads.get(layer.layerId)?.ready !== false),
    pointerCanvas,
    event => { options.onSceneLayerControl?.(event); scheduler.invalidate("selection"); },
    canvas,
    options.onSceneLayerFocusNavigate,
  );
  onRollback(() => uiControls.reset());
  const overlayLayouts = new OverlayLayoutRenderer(id => sceneLayerCompositor?.layers().find(layer => layer.layerId === id)?.scene);
  onRollback(() => overlayLayouts.dispose());
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
      safeAreaInsets: sceneLayerSafeAreaInsets(canvas),
    });
  };
  notifyOverlayResize();

  const overlayPointerWalk = (canvasX: number, canvasY: number) => {
    if (!sceneLayerCompositor || !acceptsGameInput()) return null;
    const mapped = mapCanvasPointer(scene, canvasX, canvasY, pointerCanvas());
    const canvasSize = pointerCanvas();
    return walkOverlayPointerHits(
      sceneLayerCompositor.pickHits(mapped.x, mapped.y, {
        minTargetPx: options.touchMinTargetPx ?? 44,
        canvasCssHeight: canvasSize.height,
      }),
    );
  };
  /** A blocking HUD hit owns the pointer, as it does for world input. */
  overlayBlocksPointer = (canvasX, canvasY) => overlayPointerWalk(canvasX, canvasY)?.blocked ?? false;

  const dispatchOverlayPointer = (
    phase: OverlayPointerPhase,
    canvasX: number,
    canvasY: number,
    pointerId?: number,
  ): boolean => {
    const walked = overlayPointerWalk(canvasX, canvasY);
    if (!walked) return false;
    if (phase === "down" && !binding.paused && pointerId !== undefined) {
      if (uiControls.down(pointerId, walked.targets, canvasX, canvasY)) return true;
      if (joysticks.down(pointerId, walked.targets, canvasX, canvasY)) return true;
    }
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
        resolveMaterial: (guid, options) => binding.resolveMaterial?.(guid, options) ?? null,
        releaseMaterialInstance: (key, guid) => binding.releaseMaterialInstance?.(key, guid),
        validateMaterialParameter: (guid, name, value) => binding.validateMaterialParameter?.(guid, name, value) ?? false,
        onAfterApply: () => { viewportShading?.apply(); syncEditorDeformers(); syncEditorOutlines(); syncEditorFogVolumes(); },
      })
    : null;
  onRollback(() => editorSync?.dispose());
  const syncEditorDeformers = () => {
    const data = editorSync?.serializedScene();
    if (!editorSync || !data) return;
    // Mark every boundary before resolving cages: attached components/actors
    // remain separate deformation owners, even if they have no deformer.
    for (const actor of data.actors) {
      const root = editorSync.meshForActor(actor.id);
      if (root) markLatticeComponentRoot(root);
      for (const target of editorSync.visualComponentRootsForActor(actor.id)) markLatticeComponentRoot(target);
    }
    for (const actor of data.actors) {
      deformerHost.setActor(actor.id, deformerBindings(actor.id, actor.components),
        (id) => editorSync.meshForComponent(actor.id, id), true);
    }
    deformerHost.retainActors(new Set(data.actors.map((actor) => actor.id)));
  };
  const syncEditorOutlines = () => {
    const data = editorSync?.serializedScene();
    if (!editorSync || !data) return;
    outlineHost.replaceActors(data.actors.map((actor) => ({ id: actor.id,
      meshes: editorSync.visualMeshesForActor(actor.id), bindings: outlineBindings(actor.id, actor.components) })));
    outlineHost.refreshSettings();
  };
  const editorFogActors = new Set<string>();
  const syncEditorFogVolumes = () => {
    const data = editorSync?.serializedScene();
    if (!editorSync || !data) return;
    const retained = new Set<string>();
    for (const actor of data.actors) {
      const root = editorSync.meshForActor(actor.id);
      const volumes = actor.visible ? fogVolumeBindings(actor.components) : [];
      if (root && volumes.length) {
        upsertFogVolumes(scene, actor.id, root, volumes);
        retained.add(actor.id);
      }
    }
    for (const id of editorFogActors) if (!retained.has(id)) removeFogVolumes(scene, id);
    editorFogActors.clear();
    for (const id of retained) editorFogActors.add(id);
  };
  const playVisuals = createPlayVisualBindings({
    options,
    scene,
    binding,
    deformerHost,
    outlineHost,
    scheduler,
    worldRenderer,
    markSnapshotStale: () => { appliedSnapshotIdentity = null; },
  });

  let lastSceneAssetGuid: string | undefined;
  let lastRenderedSnapshotFrame: number | null = null;
  const installMeshAssets = (assets: MeshAssetContext): MeshAssetContext => {
      binding.resourceCache = assets.resourceCache ?? binding.resourceCache;
      binding.textureBytes = installTextureBytes(assets.textureBytes);
      binding.renderTargets = assets.renderTargets;
      binding.renderTargetTextures = assets.renderTargetTextures;
      renderTargetCaptures.setAssets(assets.renderTargets, assets.renderTargetTextures);
      binding.areaEmissions = assets.areaEmissions;
      let emissionChanged = false;
      for (const group of binding.areaLights.values())
        emissionChanged = group.refreshEmissions(assets.areaEmissions) || emissionChanged;
      if (emissionChanged) {
        worldRenderer.invalidate();
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
      binding.waters = assets.waters ?? binding.waters;
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
      materialFunctionRecord = Object.fromEntries(materialFunctions);
      return true;
  };

  const sourceOwners = new Map<number, SceneSourceAssets>([[0, mergeSceneSourceAssets([{
    assets: captureMeshSourceAssets(binding), materialDocuments: new Map(materialDocuments),
    materialFunctions: new Map(materialFunctions), audioLibrary: options.audioLibrary,
    particleLibrary: options.particleLibrary, fonts: options.fontFaceEntries,
  }])]]);
  let nextSourceOwner = 0;
  let sourceFontGuids = new Set(options.fontFaceEntries?.map((font) => font.guid));
  const installOwnedSources = () => {
    const union = mergeSceneSourceAssets(sourceOwners.values());
    installMeshAssets(union.assets!);
    installMaterialDocuments(union.materialDocuments!, union.materialFunctions);
    for (const guid of compiledMaterialGuids) if (!union.materialDocuments?.has(guid)) compiledMaterialGuids.delete(guid);
    const models = new Set(binding.modelSources?.keys());
    releaseUnownedGlbSources(scene, models);
    for (const layer of sceneLayerCompositor?.layers() ?? []) releaseUnownedGlbSources(layer.scene, models);
    if (union.audioLibrary) audioService?.setLibrary(union.audioLibrary, true);
    if (union.particleLibrary) particleService?.setLibrary(union.particleLibrary);
    const fonts = new Set(union.fonts?.map((font) => font.guid));
    for (const guid of sourceFontGuids) if (!fonts.has(guid)) fontRegistry.unregister(guid);
    sourceFontGuids = fonts;
    scheduler.invalidate("asset");
  };
  const releaseSceneSources = (owner: number) => {
    if (!sourceOwners.delete(owner) || disposed) return;
    installOwnedSources();
  };
  const sourceRelease = (owner: number) => () => releaseSceneSources(owner);
  const releaseInitialSources = () => {
    releaseSceneSources(0);
    // The engine options closure must not keep source data alive after its lease.
    for (const key of ["textureBytes", "modelBytes", "modelPayloads", "spritePayloads", "spriteAnimations",
      "tilemapPayloads", "tilesetPayloads", "waterPayloads", "fontFacetypeBytes", "fontMsdfJson", "fontMsdfPng",
      "fontCssStackByGuid", "fontFaceEntries", "materialDocuments", "materialFunctions", "audioLibrary", "particleLibrary",
      "renderTargets", "renderTargetTextures", "areaEmissions", "texturePixelSizes", "modelClipAnimationGuids",
      "retargetAnimationLoads", "navmeshBytes", "audioReverbBytes", "audioBytes"] as const) delete options[key];
  };

  /** A scene document's cel shading and shadow overrides, without project settings. */
  const applySceneDocumentRenderSettings = (sceneData: SerializedScene) =>
    setSceneRenderSettings(scene, undefined, sceneData.settings.celShading ?? {}, sceneData.settings.shadowOverrides ?? {});
  const loadSceneAsync = async (sceneData: SerializedScene, load: EditorSceneLoadOptions) => {
    load.signal.throwIfAborted();
    assertCurrent(loadGeneration);
    if (!editorSync) throw new Error("Chunked scene realization requires an editor scene.");
    frameReportFeed.cancel("The scene changed before frame capture completed.");
    const generation = ++loadGeneration;
    const hold = () => generation === loadGeneration;
    instanceCompileHold = hold;
    worldRenderer.invalidate();
    cancelPresentation(new Error("Scene loading was superseded."), "world");
    if (load.materialDocuments) installMaterialDocuments(load.materialDocuments, load.materialFunctions);
    const assets = load.assets ? installMeshAssets(load.assets) : undefined;
    applySceneDocumentRenderSettings(sceneData);
    postProcessParameters.clear();
    appliedPostProcessKey = undefined;
    postProcessStack = normalizePostProcessStack(sceneData.settings.postProcessStack);
    try {
      await editorSync.applyAsync(sceneData, { signal: load.signal, assets, onProgress: load.onProgress });
      load.signal.throwIfAborted();
      assertCurrent(generation);
    } catch (error) {
      // A failed or cancelled load never reaches the warm-up that ends its hold; a newer load's hold is not this one's to end.
      if (instanceCompileHold === hold) instanceCompileHold = null;
      throw error;
    }
    freezeLibraryMaterials();
    rebuildPostProcessStack();
    lastSceneAssetGuid = load.sceneAssetGuid;
    const reselect = selectedActorIds();
    if (reselect.length > 0) editor?.setSelectedActors(reselect);
    if (assets) debugOverlay?.refreshRenderTargets();
  };

  const loadScene = (
    sceneData: SerializedScene,
    loadOptions?: { sceneAssetGuid?: string },
  ) => {
    assertCurrent(loadGeneration);
    // The registry can index a Scene after the viewport's first load, so the same editor
    // document may resolve its Asset GUID late. That is not a different Scene.
    let sameScene = loadOptions?.sceneAssetGuid === lastSceneAssetGuid;
    if (!sameScene && editorSync && lastSceneAssetGuid === undefined && loadOptions?.sceneAssetGuid !== undefined &&
      editorSync.serializedScene() !== null) {
      sameScene = true;
      lastSceneAssetGuid = loadOptions.sceneAssetGuid;
    }
    if (editorSync && sameScene &&
      (isTransformOnlySceneEdit(editorSync.serializedScene(), sceneData) ||
        isDeformerOnlySceneEdit(editorSync.serializedScene(), sceneData) ||
        isFogVolumeOnlySceneEdit(editorSync.serializedScene(), sceneData))) {
      editorSync.apply(sceneData);
      return;
    }
    if (editorSync && sameScene &&
      isOutlineOnlySceneEdit(editorSync.serializedScene(), sceneData)) {
      applySceneDocumentRenderSettings(sceneData);
      editorSync.apply(sceneData);
      outlineHost.refreshSettings();
      return;
    }
    // A light value edit (Range, Intensity, Color, cone angles) changes uniforms, never a
    // shader variant, so it applies in place without restarting readiness. A presentation or
    // preparation in flight, or a latched failure, still takes the full path below.
    if (editorSync && sameScene &&
      pendingPresentations.size === 0 && !frameReportFeed.active && worldRenderer.settled &&
      isLightValueOnlySceneEdit(editorSync.serializedScene(), sceneData)) {
      editorSync.apply(sceneData);
      return;
    }
    loadGeneration += 1;
    frameReportFeed.cancel("The scene changed before frame capture completed.");
    worldRenderer.invalidate();
    cancelPresentation(new Error("Scene loading was superseded."), "world");
    applySceneDocumentRenderSettings(sceneData);
    const nextPostProcessStack = normalizePostProcessStack(
      sceneData.settings.postProcessStack,
    );
    // Re-attaching the post-process stack releases the prepared FrameGraph, and
    // rebuilding it holds the viewport's frames for seconds. An edit of the same
    // editor scene that leaves the stack alone (a light range, say) keeps it;
    // the key below still re-attaches for any other change to its inputs.
    const keepPostProcess = Boolean(editorSync) && sameScene &&
      JSON.stringify(nextPostProcessStack) === JSON.stringify(postProcessStack);
    postProcessParameters.clear();
    if (!keepPostProcess) appliedPostProcessKey = undefined;
    postProcessStack = nextPostProcessStack;
    lastSceneAssetGuid = loadOptions?.sceneAssetGuid;
    if (editorSync) {
      editorSync.apply(sceneData);
      freezeLibraryMaterials();
      rebuildPostProcessStack();
      return;
    }
    if (options.playMode) {
      disablePlayFreeCam(playFreeCam);
      snapshots.clear();
      appliedSnapshotIdentity = null;
      lastRenderedSnapshotFrame = null;
      retirePlayWorldSlots(binding);
      commandSources.releaseSlots(worldPlaySlots);
      worldPlaySlots.clear();
      refreshPlayActiveCamera(scene, binding);
      if (simulationEditMode) playFreeCam?.setEnabled(true);
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
  let debugOverlay: EditorDebugOverlay | null = null;
  let disposeInput: (() => void) | null = null;
  let selectedActorIds: () => string[] = () => [];
  if (options.editor && editorSync) {
    ({ editor, debugOverlay, disposeInput, selectedActorIds } = createEditorViewportTools({
      canvas,
      engine,
      scene,
      options,
      editorSync,
      scheduler,
      outlineHost,
      worldRenderer,
      binding,
      viewportShading,
      presentRtt,
      pointerCanvas,
      syncEditorOutlines,
      onRollback,
    }));
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

  // Registered-view admission and renderLoop both prepare the same frame; apply
  // only when the sampled identity changes or a command invalidated it.
  let appliedSnapshotIdentity: { frameId: number; layoutGeneration: number } | null = null;
  // renderLoop reuses admission's sample until end-frame unless a push or
  // command invalidated the applied identity in between.
  let admittedSnapshot: ReturnType<typeof prepareSnapshot> = null;
  let snapshotAdmitted = false;
  const lastPositions: PlayActorPosition[] = [];
  // pushSnapshot publishes positions as soon as a snapshot lands; preparing the
  // same buffered snapshot later finds them already current.
  let positionsRevision = -1;
  const publishPositions = (sampled: Parameters<typeof positionsFromSample>[0]) => {
    if (positionsRevision === snapshots.revision) return;
    positionsRevision = snapshots.revision;
    positionsFromSample(sampled, lastPositions);
  };
  const audioPoses: SampledAudioPose[] = [];
  const audioEmitterSlots = new Set<number>();
  const audioPoseRows = new Map<number, number>();
  if (audioService) {
    // A voice starting on an actor no snapshot has posed for audio yet is placed
    // from the sampled snapshot now instead of one snapshot later.
    const probeSlots = new Set<number>();
    const probeRows = new Map<number, number>();
    const probe: SampledAudioPose[] = [];
    audioService.setEmitterPoseSource((slotId) => {
      const sampled = snapshots.sample();
      if (!sampled) return undefined;
      probeSlots.clear();
      probeSlots.add(slotId);
      if (!writeSampledAudioPoses(sampled, probe, probeSlots, probeRows)) return undefined;
      applyBoneAttachmentAudioPoses(binding, probe);
      return probe[0]!.position;
    });
  }
  let lastDrawCalls = 0;
  let lastRenderCpuMs = 0;
  // Dynamic scaling input: whether this view presented the current and previous
  // engine frames (non-loading), when the last presentation happened, and the
  // most recent pressure sample surfaced through diagnostics.
  let framePresented = false;
  let previousFramePresented = false;
  let lastPresentedAt = 0;
  let lastPressureSample: FramePressureSample | null = null;
  let rendererGpuLease: EngineGpuTimingLease | null = null;
  const gpuObservers = new Set<() => void>();
  onRollback(() => {
    for (const release of [...gpuObservers]) release();
    rendererGpuLease?.release();
    rendererGpuLease = null;
  });
  const soleRenderingView = () => {
    if (hasShownViewlessSibling(engine, viewlessShown)) return false;
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
    framePhaseLeaseFrames = FRAME_PHASE_LEASE_FRAMES;
    const source = engine.getRenderingCanvas();
    // Babylon 9.29 exposes loop scheduling fields but keeps the native context
    // loss flag protected; this snapshot never mutates native ownership.
    const native = engine as unknown as { _contextWasLost: boolean };
    return { ...(readDiagnostics ??= createRenderDiagnostics(
      scene, () => lastRenderCpuMs, () => rttPresent?.readbackMs() ?? null,
      () => ({ sample: lastPressureSample, gpuAttribution: gpuAttribution() }),
    ))(), presentation: { ...presentationStats, direct: registeredView ? viewPresentedDirectly(engine, registeredView) : false }, rendererWork: worldRenderer.diagnostics(),
      frameAdmission: { ...scheduler.gateState(), worldLoading,
        pendingPresentations: pendingPresentations.size,
        registeredViewEnabled: registeredView?.enabled ?? null,
        registeredViewRequestedEnabled: registeredView ? registeredViewIsEnabled(registeredView) : null,
        rttPresenting: rttPresent?.isPresenting() ?? false, contextLost },
      engineLoop: { frameId: engine.frameId, activeLoops: engine.activeRenderLoops.length,
        ownsLoop: engine.activeRenderLoops.includes(renderLoop), frameHandler: engine._frameHandler,
        disposed: engine.isDisposed, contextLost: native._contextWasLost,
        windowIsBackground: engine._windowIsBackground, renderEvenInBackground: engine.renderEvenInBackground,
        skipFrameRender: engine.skipFrameRender, maxFPS: engine.maxFPS ?? null,
        customRequester: Boolean(engine.customAnimationFrameRequester),
        sourceSize: source ? [source.width, source.height] as [number, number] : null,
        now: performance.now() } };
  };
  const loadingScope = (owner?: SceneLayerLoadIdentity) => {
    const generation = loadGeneration;
    // A live Play scene change advances worldLoadId before the host reloads.
    const sceneLoadId = worldLoadId;
    const layer = owner ? layerLoads.get(owner.layerId) : undefined;
    const target = owner ? sceneLayerCompositor?.layers().find((entry) => entry.layerId === owner.layerId)?.scene : scene;
    const assert = () => {
      if (!owner) {
        assertCurrent(generation);
        if (sceneLoadId !== worldLoadId) throw new Error("Scene loading was superseded or disposed.");
        return;
      }
      if (disposed || !target || target.isDisposed || layerLoads.get(owner.layerId) !== layer || layer?.loadId !== owner.layerLoadId) {
        throw new Error("SceneLayer loading was superseded or disposed.");
      }
      if (contextLost) throw new Error("Rendering context was lost during SceneLayer loading.");
    };
    assert();
    return { target: target!, assert };
  };
  let spawnableWarm: { materials: number; models: number; ms: number } | null = null;
  /**
   * Play's load compiles what it may spawn before its first frame (`warmSpawnables`), against the Scene's final
   * lighting: every Material document and model its sources hold, the Classes, Prefabs and spawnable actors of its
   * required closure included. A model that cannot load here fails when it spawns, as before.
   */
  const warmPlaySpawnables = async (assertCurrent: () => void) => {
    const started = performance.now();
    const materials: Material[] = [];
    // Surface Materials only: post-process, particle, text and landscape graphs never draw on a spawned mesh.
    for (const [guid, document] of materialDocuments) {
      if (document.domain !== "surface") continue;
      const material = binding.resolveMaterial?.(guid);
      if (material) materials.push(material);
    }
    const leases: { release(): void }[] = [];
    const containers: AssetContainer[] = [];
    try {
      const packed = packedSlimProof(binding);
      await Promise.all([...binding.modelSources ?? []].map(async ([guid, source]) => {
        const lease = acquireGlbContainer(scene, guid, source, binding.modelPayloads?.get(guid), packed);
        leases.push(lease);
        try { containers.push(await lease.load); } catch { /* it fails when it spawns */ }
      }));
      assertCurrent();
      await warmSpawnables(scene, { materials, containers }, assertCurrent);
      spawnableWarm = { materials: materials.length, models: containers.length, ms: performance.now() - started };
    } finally {
      for (const lease of leases) lease.release();
    }
  };
  const presentationReady = (pending: PendingPresentation) => {
    try {
      if (!pending.owner && loadRehearsal && !loadRehearsal.done) loadRehearsal.check();
      pending.ready = pending.owner ? sceneLayerCompositor?.isReady(pending.owner.layerId) === true : worldRenderer.isReady();
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
  function acknowledgeFrameCopy(owners = [...frameOwners], receipt = pendingPerformanceReceipt, copyMs = 0, frameReport = pendingFrameReportReceipt) {
    presentationStats.copied += 1;
    frameReportFeed.complete(frameReport, loadGeneration);
    if (receipt) performanceFeed.complete(receipt, copyMs, performance.now(), loadGeneration);
    if (!frameWasLoading) framePresented = true;
    for (const [key, pending] of owners) {
      if (pendingPresentations.get(key) !== pending) continue;
      pending.copied = true;
      finishPresentation(key, pending);
    }
  }
  const tilemapPreviewStart = performance.now();
  function prepareSnapshot() {
    const sampled = snapshots.sample();
    if (!sampled) return null;
    const layoutGeneration = snapshots.layoutGeneration;
    if (
      appliedSnapshotIdentity &&
      appliedSnapshotIdentity.frameId === sampled.frameId &&
      appliedSnapshotIdentity.layoutGeneration === layoutGeneration
    ) {
      return sampled;
    }
    const previousCamera = scene.activeCamera;
    applySnapshotToScene(scene, binding, sampled);
    playViz?.refresh();
    rebuildIfActiveCameraChanged(previousCamera);
    publishPositions(sampled);
    // Pose/listener sync owns the applied snapshot, not render admission: a
    // capped or held frame must not leave spatial audio stale.
    if (audioService) {
      const camera = simulationEditMode ? resolvePlayGameCamera(scene, binding) : scene.activeCamera;
      let listener: AudioPose | null = null;
      if (camera && !gameTimePaused) {
        const pos = camera.globalPosition ?? camera.position;
        const rot = camera.absoluteRotation;
        // A fresh object per snapshot: the service keeps the previous listener
        // for Doppler until the next one arrives.
        listener = {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          qx: rot.x,
          qy: rot.y,
          qz: rot.z,
          qw: rot.w,
        };
      }
      if (audioService.hasSpatialVoices()) {
        // Only the actors voices emit from are posed, not every actor.
        writeSampledAudioPoses(
          sampled,
          audioPoses,
          audioService.collectEmitterSlots(audioEmitterSlots),
          audioPoseRows,
        );
        applyBoneAttachmentAudioPoses(binding, audioPoses);
        // One refresh moves the voices and the listener together.
        audioService.syncSnapshot(audioPoses, listener);
      } else if (listener) {
        audioService.syncListener(listener);
      }
    }
    appliedSnapshotIdentity = {
      frameId: sampled.frameId,
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
        await worldRenderer.prepare(assertCurrent);
        for (const layer of sceneLayerCompositor?.layers() ?? []) {
          if (layerLoads.get(layer.layerId)?.ready !== false) await sceneLayerCompositor?.prepare(layer.layerId, assertCurrent);
        }
        assertCurrent();
      },
      read: (transaction) => {
        const state = sceneRenderingSettings(scene);
        const { shadows, ...quality } = resolveSceneRenderingQuality(scene);
        quality.textures = { ...quality.textures, anisotropy: state.textureAnisotropy };
        const water = sceneWaterQualityDeviceClamp(scene);
        quality.water = { ...quality.water, ...water.quality };
        const pipeline = sceneRenderPathStatus(scene);
        const limits = [...pipeline.limits, ...water.limits];
        return { revision: transaction.revision, status: transaction.clamped || limits.length || quality.textures.anisotropy !== transaction.settings.render.quality?.textures.anisotropy ? "clamped" : "applied",
          message: limits.join(" ") || (transaction.clamped ? "Clamped rendering settings presented." : "Rendering settings presented."), pipeline,
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
        const world = worldRenderer.retainResources();
        const layers = sceneLayerCompositor?.retainResources();
        return () => { try { world(); } finally { layers?.(); } };
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
    pendingPerformanceReceipt = null;
    pendingFrameReportReceipt = null;
    frameOwners.clear();
    const measurePhases = framePhaseLeaseFrames > 0 || performanceFeed.active;
    if (framePhaseLeaseFrames > 0) framePhaseLeaseFrames--;
    const preparationStart = measurePhases ? performance.now() : 0;
    applyRenderingQuality();
    outlineHost.refreshSettings();
    if (!worldLoading) runtimeScalability?.advance();
    if (!registeredView) syncLockedViewSize();
    const sampled = snapshotAdmitted && appliedSnapshotIdentity ? admittedSnapshot : prepareSnapshot();
    streamAdmission?.sync();
    const frameStart = performance.now();
    const loadingFrame = hasLoadingFrame();
    if (!shouldRenderFrame(frameStart, loadingFrame)) {
      return;
    }
    frameWasLoading = loadingFrame;
    // Measure render cost only, not wall-clock gap since the previous
    // rendered frame — a frozen obstructed viewport can idle for seconds
    // between frames, and feeding that gap to the scaling valve would read
    // as a catastrophic frame time and drop quality for no reason.
    const renderStart = performance.now();
    presentationStats.attempted += 1;
    if (measurePhases) presentationStats.preparationMs = renderStart - preparationStart;
    const profileReceipt = performanceFeed.active ? performanceFeed.begin({
      frameId: engine.frameId, tickId: sampled?.tickIndex ?? 0, sceneGeneration: loadGeneration,
      preparationMs: presentationStats.preparationMs + (registeredView ? admissionPreparationMs : 0),
      submissionMs: 0, drawCalls: 0,
      width: scene.activeCamera?.outputRenderTarget?.getSize().width ?? engine.getRenderWidth(true),
      height: scene.activeCamera?.outputRenderTarget?.getSize().height ?? engine.getRenderHeight(true),
      resolutionScale: 1 / engine.getHardwareScalingLevel(), loading: loadingFrame,
    }) : null;
    admissionPreparationMs = 0;
    let coherentFrame = true;
    beginEngineDrawCallFrame(engine);
    // Water created or enabled since the last update (an editor edit or drop, a Play spawn) settles before the world's
    // strict probes below request its variants, and counts in this frame's draw calls. A load frame that draws no world
    // leaves it to the load's own settle, so spawn batches arriving over frames never settle partial sets.
    if (!worldLoading || pendingPresentations.has("world")) settleSceneWater(scene);
    if (rttPresent) rttPresent.bind();
    if (!options.playMode) {
      updateSceneTilemapAnimations(scene, frameStart - tilemapPreviewStart);
      // Editor cables simulate only while this view renders (never in Play or
      // hidden/paused views); sleeping cables skip their anchor math.
      if (stepEditorCables(scene, frameStart)) scheduler.invalidate("asset");
    }
    const frameScope = frameReportFeed.active && (!worldLoading || pendingPresentations.has("world"))
      ? beginRenderFrameCapture(engine) : null;
    const frameReportReceipt = frameScope ? frameReportFeed.candidate({ ...frameScope.capture.report, frame: {
      renderFrameId: engine.frameId, snapshotFrameId: sampled?.frameId ?? 0, tickId: sampled?.tickIndex ?? 0,
      sceneGeneration: loadGeneration, sceneLoadId: worldLoadId, sceneAssetGuid: worldSceneAssetGuid ?? lastSceneAssetGuid, viewId: scene.uniqueId,
      width: scene.activeCamera?.outputRenderTarget?.getSize().width ?? engine.getRenderWidth(true),
      height: scene.activeCamera?.outputRenderTarget?.getSize().height ?? engine.getRenderHeight(true),
      backend: engine.isWebGPU ? "webgpu" : "webGLVersion" in engine && engine.webGLVersion === 2 ? "webgl2"
        : "webGLVersion" in engine && engine.webGLVersion === 1 ? "webgl1" : "unknown",
    } }) : null;
    try {
      let presentingLayers = NO_PRESENTING_LAYERS;
      if (pendingPresentations.size) {
        const presenting = new Set<string>();
        for (const pending of pendingPresentations.values()) if (pending.owner) presenting.add(pending.owner.layerId);
        presentingLayers = presenting;
      }
      const drawOwner = (key: string, draw: () => boolean, fallback?: () => void) => {
        const pending = pendingPresentations.get(key);
        if (!pending) { draw(); return; }
        if (presentationFenceWaiting()) return;
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
        if (key === "world" && loadRehearsal && !loadRehearsal.done) {
          // Drawn is enough: variants its post-draw probe requests draw in a later rehearsal frame.
          loadRehearsal.frame(() => worldRenderer.render(true).rendered);
          // Never presented: the loading frame shows the clear colour, as the loading frames before it did.
          engine.clear(scene.clearColor, true, true, true);
          pending.restart?.();
          if (loadRehearsal.done) loadRehearsalReport = loadRehearsal.report();
          return;
        }
        pending.copied = false;
        const pipelinesBefore = WebGPUCacheRenderPipeline.NumCacheMiss;
        const submission = submitPresentedFrame(engine, () => {
          pending.attempts += 1;
          const rendered = draw();
          pending.rendered = rendered && presentationReady(pending);
        }, { errorStateKnownClear: pending.errorsCleared });
        pending.pipelines = WebGPUCacheRenderPipeline.NumCacheMiss - pipelinesBefore;
        pending.submission = submission;
        // Unproven until this attempt's own fence-time read; a cancelled attempt leaves it unread.
        pending.errorsCleared = false;
        if (pending.rendered) {
          frameOwners.set(key, pending);
          // A validated draw is progress beyond shader readiness. Observed
          // software-GL completion can outlast that earlier budget even after
          // the canvas copy. Give completion its own bounded budget, without
          // acknowledging before both this owner's fence and copy finish. The
          // fence is polled without blocking, so this budget also spans the
          // driver compiling the draw's programs: the longest compile the
          // loading budgets already tolerate. WebGPU builds every render
          // pipeline the draw created in the GPU queue, inside this wait and
          // with no progress to observe, so each adds an allowance.
          if (!pending.completionStarted) {
            pending.completionStarted = true;
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => {
              if (pendingPresentations.get(key) === pending) expirePresentation(key);
            }, firstFrameCompletionMs(pending.pipelines));
          }
        }
        void submission.completed.then(() => {
          if (pending.submission !== submission) return;
          pending.submission = null;
          // The fence-time read left the error state cleared for this owner's next attempt.
          pending.errorsCleared = true;
          finishPresentation(key, pending);
        }, (error: unknown) => {
          if (pending.submission !== submission) return;
          if (pendingPresentations.get(key) === pending) cancelPresentation(error instanceof Error ? error : new Error(String(error)), key);
        });
      };
      if (!worldLoading || pendingPresentations.has("world")) drawOwner("world", () => {
        const result = frameScope
          ? frameScope.capture.stage(scene, { name: "World output", kind: "composition", sceneId: lastSceneAssetGuid },
            () => worldRenderer.render(true))
          : worldRenderer.render(pendingPresentations.has("world"));
        coherentFrame = result.rendered && (!frameScope || result.readyForPresentation);
        syncPipelineHold(worldRenderer.holdingForPipelines);
        return result.readyForPresentation;
      }, () => {
        // A newly bound output may invalidate admission between scheduling and
        // drawing. Only explicit world loading may present ready layers over a
        // clear; an active world must retain its last complete image.
        if (worldLoading) engine.clear(scene.clearColor, true, true, true);
        else coherentFrame = false;
      });
      else engine.clear(scene.clearColor, true, true, true);
      joysticks.refresh();
      uiControls.refresh();
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
        if (frameReportFeed.active) scheduler.requestPausedFrame();
        return;
      }
      if (rttPresent) {
        const owners = [...frameOwners];
        const copyStart = profileReceipt ? performance.now() : 0;
        void rttPresent.blit().then(() => {
          acknowledgeFrameCopy(owners, profileReceipt, profileReceipt ? performance.now() - copyStart : 0, frameReportReceipt);
        }, (error: unknown) => {
          if (frameReportReceipt) frameReportFeed.cancel(`Frame presentation failed: ${String(error)}`);
          if (!owners.length && !disposed) console.warn(`[render] RTT presentation failed: ${String(error)}`);
          for (const [key, pending] of owners) {
            if (pendingPresentations.get(key) === pending) cancelPresentation(error instanceof Error ? error : new Error(String(error)), key);
          }
        });
      }
    } catch (error) {
      frameReportFeed.cancel(`Frame capture failed: ${String(error)}`);
      if (!pendingPresentations.size) throw error;
      cancelPresentation(error instanceof Error ? error : new Error(String(error)));
      return;
    } finally {
      frameScope?.dispose();
      // Capture counters change during collection; receipt rows share the bounded arrays.
      if (frameScope && frameReportReceipt) Object.assign(frameReportReceipt.report, frameScope.capture.report);
    }
    pendingFrameReportReceipt = frameReportReceipt;
    if (sampled) lastRenderedSnapshotFrame = sampled.frameId;
    frameCopyReady = true;
    presentationStats.drawn += 1;
    lastDrawCalls = readEngineDrawCalls(engine);
    scheduler.noteRendered(frameStart);
    lastRenderCpuMs = performance.now() - renderStart;
    if (profileReceipt) {
      profileReceipt.sample.submissionMs = lastRenderCpuMs;
      profileReceipt.sample.drawCalls = lastDrawCalls;
      pendingPerformanceReceipt = profileReceipt;
    }
    if (!registeredView && !rttPresent && !loadingFrame) framePresented = true;
  };
  const presentationObserver = engine.onEndFrameObservable.add(() => {
    snapshotAdmitted = false;
    if (!registeredView && !rttPresent && frameCopyReady) acknowledgeFrameCopy();
    if (framePresented) {
      if (runtimeScalability && !worldLoading) {
        // A stored preparation failure rethrows until the coordinator's retry
        // succeeds. It must not escape endFrame and stop the shared Engine loop.
        let ready: boolean;
        try { ready = worldRenderer.isReady() && sceneLayerCompositor?.isReady() !== false; } catch { ready = false; }
        if (ready) runtimeScalability.presented();
      }
      const presentedAt = performance.now();
      // Only Play handles pace frames: their presented-frame interval measures
      // sustainable frame cost. Editor/prefab viewports are free-running, so
      // the same interval mostly measures host event-loop contention and must
      // not drive resolution scaling — they keep the cpuMs-only input.
      const presentationSignals = options.playMode === true;
      // GPU timing only means this view when it owns the Engine's render —
      // siblings would fold their cost into the same counter.
      const sole = soleRenderingView();
      if (!engine.isWebGPU && sole && presentationSignals && !rendererGpuLease && engine.getCaps().timerQuery) {
        rendererGpuLease = acquireEngineGpuTiming(engine);
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
      // The scaling level is Engine-wide: only the sole rendering view drives
      // it, so sibling views on a shared Engine cannot ratchet it against
      // each other.
      if (sole) scaling.noteFramePressure(lastPressureSample);
      if (!registeredView) syncLockedViewSize();
    }
    previousFramePresented = framePresented;
    framePresented = false;
    frameCopyReady = false;
    pendingPerformanceReceipt = null;
    pendingFrameReportReceipt = null;
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
    finalAuthoringDrain?.abort(new Error("The graphics context was lost during final scene capture."));
    runtimeMaterialEdits.cancelAll();
    frameReportFeed.cancel("The graphics context was lost before frame capture completed.");
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

  const {
    ownsGamePointer,
    resetJoysticks,
    detach: detachGameInput,
  } = createPlayGameInput({
    canvas,
    scene,
    options,
    pointerCanvas,
    sceneLayerCompositor,
    layerLoads,
    overlayLayouts,
    acceptsGameInput,
    joysticks,
    uiControls,
    playCursor,
    dispatchOverlayPointer,
    overlayPointerState,
    onRollback,
  });

  rebuildPostProcessStack();

  const unsubscribeEditorDrop = engineCommandBus.subscribe((command) => {
    if (command.type !== "editor.drop" || !editor || !options.editorViewportId || command.viewportId !== options.editorViewportId) return;
    engineCommandBus.dispatch({ type: "editor.drop.result", viewportId: command.viewportId,
      requestId: command.requestId, transforms: editor.dropSelectedActors(command.actorIds, command.maxDistance) });
  });
  onRollback(unsubscribeEditorDrop);
  // FontFace registration publishes to the document, so start it only after
  // the synchronous construction steps that can still roll back have succeeded.
  // World readiness awaits it. Bitmap 2D Text rasterizes once when its mesh is
  // built and a late face does not re-rasterize it, so Play and the player gate
  // each text assignment on `acquireSceneSources`, which awaits its faces and
  // fails the slot when one cannot load.
  const initialFonts = options.fontFaceEntries && options.fontFaceEntries.length > 0
    ? fontRegistry.registerAll(options.fontFaceEntries).then(() => {
      if (!disposed && fontRegistry.consumeDirty()) scheduler.invalidate("asset");
    })
    : Promise.resolve();

  let callerPaused = false;
  let sceneStreamingPaused = false;
  let gameTimePaused = false;
  /** The world view holds its last image for GPU work: WebGPU pipelines, or effects still
   * compiling on any backend (`SceneRenderCoordinator.holdingForPipelines`). */
  let pipelineHold = false;
  /** Play pauses its game time, audio and particles while the view holds, as
   * for a blocking load, but keeps drawing: the frame that finds the
   * pipelines or effects ready ends the hold. Resuming never consumes the held interval. */
  const heldForPipelines = () => pipelineHold && options.playMode === true;
  const applyPause = () => {
    const paused = callerPaused || sceneStreamingPaused || gameTimePaused;
    const held = heldForPipelines();
    setSceneGameTimePaused(scene, gameTimePaused || held);
    for (const layer of sceneLayerCompositor?.layers() ?? []) setSceneGameTimePaused(layer.scene, gameTimePaused || held);
    binding.paused = paused;
    if (paused) resetJoysticks();
    scheduler.setPaused(paused);
    debugOverlay?.setPaused(paused);
    audioService?.setPaused(paused || held);
    particleService?.setPaused(paused || held);
  };
  /** When the current run of held frames began, until the hold pauses or ends. */
  let holdSince: number | undefined;
  const syncPipelineHold = (held: boolean) => {
    if (held) {
      if (pipelineHold) return;
      const now = performance.now();
      holdSince ??= now;
      if (now - holdSince < PIPELINE_HOLD_PAUSE_DELAY_MS) return;
    } else holdSince = undefined;
    if (held === pipelineHold) return;
    pipelineHold = held;
    applyPause();
    options.onPipelineHold?.(held);
  };

  const engineHandle: EngineHandle = {
    engine,
    scene,
    scheduler,
    resourceCache,
    scaling,
    editor,
    dispose: () => {
      if (disposed) return;
      resetJoysticks();
      runtimeTransformTools?.dispose();
      runtimeTransformTools = null;
      disposed = true;
      finalAuthoringDrain?.abort(new Error("The game view stopped during final scene capture."));
      runtimeMaterialEdits.dispose();
      performanceFeed.dispose();
      for (const release of [...gpuObservers]) release();
      rendererGpuLease?.release();
      rendererGpuLease = null;
      frameReportFeed.cancel("The game view was disposed.");
      pendingPerformanceReceipt = null;
      pendingFrameReportReceipt = null;
      commandSources.dispose();
      sourceOwners.clear();
      streamAdmission?.clear();
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
      releaseViewless?.();
      unsubscribeEditorDrop();
      releasePlayLoop?.();
      releaseMainThreadDecoding?.();
      restoreFixedShapeLighting();
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
      track(bounded, () => deformerHost.dispose());
      track(bounded, () => outlineHost.dispose());
      track(bounded, () => nativeRetirement.whenDisposed());
      track(bounded, () => worldRenderer.retire());
      track(bounded, () => sceneLayerCompositor?.dispose());
      // Full Quality captures own forward views and borrowed outputs.
      track(bounded, () => renderTargetCaptures.clear());
      track(actual, () => nativeRetirement.whenReleased());
      track(actual, () => worldRenderer.whenReleased());
      track(actual, () => renderTargetCaptures.whenReleased());
      track(actual, () => outlineHost.whenReleased());
      track(actual, () => sceneLayerCompositor?.whenReleased());
      // Cancel graph preparation before restoring the editor's global request.
      track(bounded, () => releasePlayRenderPath?.());
      const retired = Promise.all(bounded);
      const released = Promise.all(actual).then(() => {});
      releasedHandle = released;
      playFreeCamInput?.dispose();
      disposeInput?.();
      editor?.gizmos.dispose();
      editor?.grid.dispose();
      editor?.selection.dispose();
      editor?.sync.dispose();
      // Host-side timers and DOM stop now; the preview RTT and meshes wait
      // for native release with the Scene.
      debugOverlay?.stop();
      playCursor?.dispose();
      detachGameInput();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      // Document FontFaces are host state; sibling views keep their own faces.
      fontRegistry.dispose();
      audioService?.dispose();
      const reportRetirementFailure = (error: unknown) => {
        console.warn(`[render] Scene resource cleanup report is uncertain: ${String(error)}`);
      };
      const reportReleaseFailure = (error: unknown) => {
        console.warn(`[render] Scene resource cleanup is quarantined: ${String(error)}`);
      };
      const releaseSceneResources = () => {
        playFreeCam?.dispose();
        playViz?.dispose();
        playDebugDraw?.dispose();
        debugOverlay?.dispose();
        debugOverlay = null;
        disposeSnapshotBinding(binding);
        particleService?.dispose();
        materialLibrary.dispose();
        for (const key of Object.keys(captureMeshSourceAssets(binding)))
          delete (binding as unknown as Record<string, unknown>)[key];
        materialDocuments.clear();
        materialFunctions.clear();
        materialFunctionRecord = {};
        materialDocumentsKey = "";
        releaseInitialSources();
        scene.dispose();
        rttPresent?.dispose();
        cacheBinding.dispose();
      };
      if (!ownsEngine) {
        // Pending native work may still borrow Scene, library and cache
        // resources. Stop the view immediately, but release these owners only
        // after actual release confirms; a rejected release quarantines them.
        void retired.catch(reportRetirementFailure);
        const sceneReleased = released.then(releaseSceneResources);
        void sceneReleased.catch(reportReleaseFailure);
        // Frame-gated releases and the Scene's deferred GPU destruction need end
        // frames even when this was the shared Engine's last rendering client.
        drainEngineAfterRelease(engine, sceneReleased);
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
          for (const view of heldEngineViews) {
            if (engine.views?.includes(view)) setRegisteredViewEnabled(view, true);
          }
        }
      }
      if (ownsEngine) {
        releaseResourceCacheForEngine(engine);
        engine.dispose();
      }
      // No frame will ever end a hold the disposed view still has: a host that
      // keeps a `rendering` pause for it must not wait for one.
      if (pipelineHold) {
        pipelineHold = false;
        options.onPipelineHold?.(false);
      }
    },
    whenReleased: () => releasedHandle ?? Promise.resolve(),
    resize,
    setSize,
    loadScene,
    loadSceneAsync,
    prepareRuntimeMaterialEdit: (request) => {
      if (disposed || contextLost || worldLoading) return Promise.reject(new Error("The game view is unavailable or loading."));
      return runtimeMaterialEdits.prepare(request);
    },
    commitRuntimeMaterialEdit: (command) => {
      if (disposed || contextLost || worldLoading) return { success: false, reason: "The game view is unavailable or loading." };
      const result = runtimeMaterialEdits.commit(command);
      if (result.success) { appliedSnapshotIdentity = null; scheduler.invalidate("asset"); scheduler.requestPausedFrame(); }
      return result;
    },
    releaseRuntimeMaterialPreparation: (token) => runtimeMaterialEdits.release(token),
    quiesceAuthoringRevision: async (commandRevision, signal) => {
      if (!Number.isSafeInteger(commandRevision) || commandRevision < 0 || finalAuthoringDrain)
        throw new Error("The final render command fence is invalid or already pending.");
      if (!gameTimePaused || disposed || contextLost || worldLoading)
        throw new Error("Final scene capture requires a complete, paused game view.");
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      finalAuthoringDrain = controller;
      const generation = loadGeneration, sceneLoadId = worldLoadId;
      const assert = () => {
        controller.signal.throwIfAborted();
        if (disposed || contextLost || worldLoading || generation !== loadGeneration || sceneLoadId !== worldLoadId)
          throw new Error("The final scene render ownership changed during capture.");
      };
      try {
        // These commands were accepted before the correlated fence. Their cold
        // source preparation may complete while game progression remains held.
        await commandSources.whenReady(undefined, controller.signal);
        assert();
        await drainFinalAuthoringResources(scene, binding, materialLibrary, {
          signal: controller.signal, assertCurrent: assert,
          pendingParticles: (slots) => particleService?.pendingSlotPreparation(slots) ?? [],
        });
        assert();
        return { commandRevision };
      } finally {
        signal.removeEventListener("abort", cancel);
        if (finalAuthoringDrain === controller) finalAuthoringDrain = null;
      }
    },
    pushSnapshot: (buffer: Float32Array) => {
      // Deliveries already queued when the view stopped must not repose it.
      if (disposed) return;
      snapshots.push(buffer);
      appliedSnapshotIdentity = null;
      const sampled = snapshots.sample();
      if (sampled) publishPositions(sampled);
      if (sampled && sampled.frameId !== lastRenderedSnapshotFrame) scheduler.requestPausedFrame();
      if (isPublishedSnapshot(buffer)) {
        playDebugDraw?.noteSimTick(readSnapshotHeader(buffer).tickIndex);
      }
      scheduler.invalidate("snapshot");
    },
    applyCommand: (command: CommandMessage) => {
      // A stopped view keeps its Scene until native release; queued commands
      // must not spawn or rebind visuals in it.
      if (disposed) return;
      if (!applyingPreparedCommand)
        finalAuthoringDrain?.abort(new Error(`Runtime render command ${command.type} arrived after the final capture fence.`));
      if (!applyingPreparedCommand && commandSources.receive(command, (prepared) => {
        applyingPreparedCommand = true;
        try { engineHandle.applyCommand(prepared); }
        finally { applyingPreparedCommand = false; }
      })) return;
      streamAdmission?.receive(command);
      if (command.type === "snapshotLayout") {
        snapshots.installLayout(command.capacity, command.generation);
        appliedSnapshotIdentity = null;
        scheduler.invalidate("snapshot");
        return;
      }
      if (!simulationEditMode || (command.type !== "possessCamera" && command.type !== "setFreeCam"))
        applyPlayFreeCamCommand(playFreeCam, command);
      playViz?.applyCommand(command);
      playDebugDraw?.applyCommand(command);
      if (command.type === "setPainter2D") {
        applyPainter2DCommand(binding, command);
        scheduler.invalidate("asset");
      }
      if (command.type === "setUIControl2D") {
        const pending = pendingOverlayAssign.get(command.slotId);
        const part = pending?.parts?.find(entry => entry.componentId === command.componentId);
        if (part) part.uiControl = command.uiControl;
        applyUIControl2DCommand(binding, command);
        if (command.focused !== undefined) {
          const mesh = meshForPlayComponent(binding, command.slotId, command.componentId);
          if (mesh && acceptsGameInput()) uiControls.syncFocus(mesh, command.focused, command.beginEditing);
        }
        scheduler.invalidate("asset");
      }
      if (command.type === "setText2DAppear") {
        const pending = pendingOverlayAssign.get(command.slotId);
        if (pending && Number.isFinite(command.progress)) {
          const progress = Math.max(0, Math.min(1, command.progress));
          const part = pending.parts?.find((entry) => entry.componentId === command.componentId && entry.meshKind === "2drichtext");
          if (part?.text2d) part.text2d.appearProgress = progress;
          if (pending.primaryComponentId === command.componentId && pending.meshKind === "2drichtext" && pending.text2d) {
            pending.text2d.appearProgress = progress;
          }
        }
        applyText2DAppearCommand(binding, command);
        scheduler.invalidate("asset");
      }
      if (command.type === "setOverlayVisualStyle") {
        const pending = pendingOverlayAssign.get(command.slotId);
        const part = pending?.parts?.find((entry) => entry.componentId === command.componentId);
        if (part) part.overlayStyle = command.style;
        if (pending?.primaryComponentId === command.componentId) pending.overlayStyle = command.style;
        applyOverlayVisualStyleCommand(binding, command);
        scheduler.invalidate("asset");
      }
      if (command.type === "setComponentTransforms") {
        const pending = pendingOverlayAssign.get(command.slotId);
        if (pending) retainAssignMeshComponentTransforms(pending, command);
        applyComponentTransformsCommand(binding, command);
        appliedSnapshotIdentity = null;
        scheduler.invalidate("snapshot");
      }
      if (command.type === "setCursorVisible") {
        playCursor?.setVisible(command.visible);
      }
      if (command.type === "setGamepadRumble") applyGamepadRumble(command);
      if (command.type === "vibrateDevice") applyDeviceVibration(command);
      if (command.type === "requestDeviceMotion") options.onDeviceMotionRequest?.();
      if (command.type === "spawn") {
        captureActorSlots.set(command.slotId, command.actorGuid);
        runtimeComponentTokens.delete(command.slotId);
        if (command.runtimeIdentity) runtimeActorIdentities.set(command.slotId, command.runtimeIdentity);
        else runtimeActorIdentities.delete(command.slotId);
        renderTargetCaptures.registerActor(command.actorGuid, () => binding.meshes.get(command.slotId) ?? null);
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
          }
        }
      }
      if (command.type === "despawn") {
        const actorGuid = captureActorSlots.get(command.slotId);
        if (actorGuid) runtimeTransformTools?.actorRemoved(actorGuid, command.slotId);
        if (actorGuid) renderTargetCaptures.removeActor(actorGuid);
        audioService?.forgetActorSlot(command.actorGuid, command.slotId);
        captureActorSlots.delete(command.slotId);
        runtimeActorIdentities.delete(command.slotId);
        runtimeComponentTokens.delete(command.slotId);
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
        runtimeTransformTools?.clear();
        frameReportFeed.cancel("The runtime changed Scene before frame capture completed.");
        renderTargetCaptures.clear();
        captureActorSlots.clear();
        runtimeActorIdentities.clear();
        runtimeComponentTokens.clear();
        particleService?.retireSlots((slotId) => worldPlaySlots.has(slotId));
        appliedSnapshotIdentity = null;
        runtimeMaterialEdits.cancelAll();
        worldLoadId = command.sceneLoadId;
        worldSceneAssetGuid = command.sceneAssetGuid;
        postProcessParameters.clear();
        worldLoading = true;
        const sceneLoadId = command.sceneLoadId;
        instanceCompileHold = () => worldLoading && sceneLoadId === worldLoadId;
        worldRenderer.invalidate();
        // A presented load's rehearsal ends here: the next level keeps none of its Effects, nor its predictions.
        endLoadRehearsal();
        releaseLightPredictions(scene);
        cancelPresentation(new Error("Scene loading was superseded."), "world");
      }
      // A failed load never reaches the warm-up that ends its hold.
      if (command.type === "sceneLoadFailed" && command.sceneLoadId === worldLoadId) instanceCompileHold = null;
      if (command.type === "sceneLayerLoading") {
        const previous = layerLoads.get(command.layerId);
        if (!previous || previous.loadId < command.layerLoadId) {
          particleService?.retireSlots((slotId) => sceneLayerCompositor?.layerIdForSlot(slotId) === command.layerId);
          cancelPresentation(new Error("SceneLayer loading was superseded."), `layer:${command.layerId}`);
          layerLoads.set(command.layerId, { loadId: command.layerLoadId, ready: false });
        }
      }
      if (command.type === "sceneLayerCreate") {
        const layer = sceneLayerCompositor?.create(command);
        // Layers resolve project quality (Geometry, Water, texture anisotropy)
        // through the world view.
        if (layer) {
          followSceneRenderSettings(layer.scene, scene);
          setSceneGameTimePaused(layer.scene, gameTimePaused || heldForPipelines());
          for (const texture of layer.scene.textures) applyTextureAnisotropy(texture);
          layer.scene.onNewTextureAddedObservable.add(applyTextureAnisotropy);
        }
        syncOverlayLayer(command.layerId);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "sceneLayerRemove") {
        overlayLayouts.remove(command.layerId);
        particleService?.retireSlots((slotId) => sceneLayerCompositor?.layerIdForSlot(slotId) === command.layerId);
        cancelPresentation(new Error("SceneLayer was removed."), `layer:${command.layerId}`);
        layerLoads.delete(command.layerId);
        sceneLayerCompositor?.remove(command.layerId);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "sceneLayerClear") {
        overlayLayouts.dispose();
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
      if (command.type === "sceneLayerLayout") {
        overlayLayouts.apply(command);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "sceneLayerCamera") {
        sceneLayerCompositor?.setCamera(command.layerId, command.camera);
        scheduler.invalidate("camera");
      }
      audioService?.handleCommand(command);
      if (command.type === "configureRenderTargetCapture") {
        const transform = command.transform;
        renderTargetCaptures.configure(command.actorGuid, command.settings,
          () => isSceneStreamSlotPending(scene, command.slotId) ? null : binding.meshes.get(command.slotId) ?? null, transform ? {
            position: [transform.position.x, transform.position.y, transform.position.z],
            rotation: [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w],
            scale: [transform.scale.x, transform.scale.y, transform.scale.z],
          } : undefined);
        scheduler.invalidate("asset");
      }
      if (command.type === "captureRenderTarget") {
        renderTargetCaptures.request(command.actorGuid);
        scheduler.invalidate("asset");
      }
      if (!playVisuals.applyCommand(command)) return;
      particleService?.handleCommand(command);
      if (command.type === "assignMesh") {
        if (command.runtimeComponentTokens) runtimeComponentTokens.set(command.slotId,
          new Map(command.runtimeComponentTokens.map((entry) => [entry.componentGuid, entry.componentToken])));
        else runtimeComponentTokens.delete(command.slotId);
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
        rebuildIfActiveCameraChanged(previousCamera);
        particleService?.bindSlot(
          command.slotId,
          binding.meshes.get(command.slotId) ?? null,
        );
        const pending = binding.pendingAnimState?.get(command.slotId);
        if (pending) applyAnimStateToScene(animHost, pending);
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
      if (command.type === "captureRagdollPose") {
        binding.ragdoll?.capture(command);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "setRagdollPose") {
        binding.ragdoll?.setPose(command);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "clearRagdollPose") {
        binding.ragdoll?.clear(command);
        const pending = binding.pendingAnimState?.get(command.slotId);
        if (pending) applyAnimStateToScene(animHost, pending);
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
            renderTargetCaptures.setPostProcessParameter(write.entryId, write.parameterName, write.parameter);
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
      if (command.type === "setLightsDebug")
        sceneRenderingSettings(scene).lightsDebug = command.enabled;
      if (command.type === "setFixedShapeLighting" && options.playMode) {
        fixedShapeLightingBefore ??= { enabled: isFixedShapeLightingEnabled(engine), guard: fixedShapeLightGuard(engine) };
        setFixedShapeLightGuard(engine, command.guard);
        setFixedShapeLightingEnabled(engine, command.enabled);
        scheduler.invalidate("asset");
      }
      if (command.type === "tilemapAnimationTime") {
        binding.tilemapAnimationTimeMs = command.elapsedMs;
        scheduler.invalidate("snapshot");
      }
      if (command.type === "waterTime") {
        setSceneWaterTime(scene, command.seconds, command.frameId);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "cableFrame") {
        applyCableFrame(scene, command.data, command.frameId);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "dynamicMeshUpdate") {
        applyDynamicRuntimeMeshUpdate(scene, command.meshId, command.update);
        scheduler.invalidate("snapshot");
      }
      if (command.type === "animState") {
        appliedSnapshotIdentity = null;
        if (!binding.pendingAnimState) binding.pendingAnimState = new Map();
        binding.pendingAnimState.set(command.slotId, command);
        applyAnimStateToScene(animHostReportingMissing, command);
        scheduler.invalidate("snapshot");
      }
      streamAdmission?.sync();
    },
    setPaused: (paused: boolean) => {
      callerPaused = paused;
      applyPause();
    },
    setGameTimePaused: (paused: boolean) => {
      if (disposed) return;
      gameTimePaused = paused;
      applyPause();
    },
    setGameInputEnabled: (enabled: boolean) => {
      if (disposed || gameInputEnabled === enabled) return;
      resetJoysticks();
      gameInputEnabled = enabled;
    },
    ownsGamePointer: (pointerId: number) => !disposed && ownsGamePointer(pointerId),
    publishSceneLayerSize: () => { if (!disposed) notifyOverlayResize(); },
    setSimulationEditMode: (enabled: boolean) => {
      if (disposed || !playFreeCam || simulationEditMode === enabled) return;
      resetJoysticks();
      playFreeCamInput?.reset();
      simulationEditMode = enabled;
      runtimeTransformTools?.setEnabled(enabled && runtimeTransformToolsEnabled);
      const previous = scene.activeCamera;
      playFreeCam.setEnabled(enabled);
      appliedSnapshotIdentity = null;
      rebuildIfActiveCameraChanged(previous);
      if (gameTimePaused) scheduler.requestPausedFrame();
      else scheduler.invalidate("camera");
    },
    requestPausedRedraw: () => {
      if (disposed) return { accepted: false, reason: "The view has been disposed." };
      if (!gameTimePaused) return { accepted: false, reason: "Render-only redraw requires paused game time." };
      const worldIssue = pausedSceneRedrawIssue(scene);
      if (worldIssue) return { accepted: false, reason: worldIssue };
      for (const layer of sceneLayerCompositor?.layers() ?? []) {
        const reason = pausedSceneRedrawIssue(layer.scene);
        if (reason) return { accepted: false, reason };
      }
      scheduler.requestPausedFrame();
      return { accepted: true };
    },
    setSceneStreamingPaused: (paused: boolean) => {
      sceneStreamingPaused = paused;
      applyPause();
    },
    setRegisterViewEnabled: (enabled: boolean) => {
      if (registeredView) setRegisteredViewEnabled(registeredView, enabled);
    },
    liveObjectCounts: () => ({
      meshes: liveMeshCount(scene),
      textures: engine.getLoadedTexturesCache().length,
    }),
    drawCalls: () => lastDrawCalls,
    renderDiagnostics,
    lightsDebugEnabled: () => sceneRenderingSettings(scene).lightsDebug,
    observePerformance: (onFrame) => {
      if (frameReportFeed.active) throw new Error("Stop frame capture before recording performance.");
      return performanceFeed.subscribe(onFrame);
    },
    observeGpuTiming: (onSample, onError) => {
      if (disposed || contextLost) return { status: "unavailable", reason: "The game graphics context is unavailable.", release() {} };
      // eslint-disable-next-line prefer-const -- release may run from a synchronous onError.
      let observation: EngineGpuTimingObservation | undefined;
      const release = () => { gpuObservers.delete(release); observation?.release(); };
      observation = observeEngineGpuTiming(engine, onSample, { onError: error => { release(); onError?.(error); } });
      if (observation.status === "unavailable") return observation;
      gpuObservers.add(release);
      return { ...observation, release };
    },
    captureFrame: () => {
      if (disposed || contextLost) return Promise.reject(new Error("The game view is unavailable."));
      if (performanceFeed.active) return Promise.reject(new Error("Stop performance recording before capturing a frame."));
      if (binding.paused && !gameTimePaused)
        return Promise.reject(new Error("Paused frame capture requires the game-time pause boundary."));
      if (gameTimePaused) {
        for (const target of [scene, ...(sceneLayerCompositor?.layers().map((layer) => layer.scene) ?? [])]) {
          const reason = pausedSceneRedrawIssue(target);
          if (reason) return Promise.reject(new Error(reason));
        }
      }
      const result = frameReportFeed.arm(loadGeneration);
      scheduler.requestPausedFrame();
      scheduler.invalidate("manual");
      return result;
    },
    cancelFrameCapture: (reason) => frameReportFeed.cancel(reason),
    attachRuntimeTransformTools: (callbacks) => {
      if (disposed || !options.playMode || options.editor || runtimeTransformTools)
        throw new Error("Runtime transform tools require a live, unattached game view.");
      const owner = createRuntimeTransformTools(scene, canvas, {
        mode: options.viewportMode ?? "3d", scheduler,
        requestRedraw: () => {
          if (gameTimePaused) scheduler.requestPausedFrame();
          else scheduler.invalidate("gizmo");
        },
        pointerCanvas,
        cameraGestureActive: () => playFreeCamInput?.isInteracting() ?? false,
        forwardPointers: !!options.sharedEngine || presentRtt,
        registerOverlay: (draw) => worldRenderer.attachEditorOverlay(draw),
        selectVisuals: (meshes) => outlineHost.selection.set(meshes),
        resolve: (identity, slotId) => {
          if (slotId === undefined || !Number.isSafeInteger(slotId) || binding.isOverlaySlot?.(slotId)) return null;
          const slot = slotId;
          const matches = () => {
            const owner = runtimeActorIdentities.get(slot);
            return owner?.actorGuid === identity.actorGuid && owner.actorToken === identity.actorToken &&
              owner.sceneInstanceId === identity.sceneInstanceId &&
              (!identity.componentGuid || runtimeComponentTokens.get(slot)?.get(identity.componentGuid) === identity.componentToken);
          };
          if (!matches()) return null;
          const root = binding.meshes.get(slot) ?? null;
          const mesh = identity.componentGuid ? meshForPlayComponent(binding, slot, identity.componentGuid) : root;
          return { slotId: slot, mesh, visuals: mesh ? [mesh, ...mesh.getChildMeshes()] : [],
            isCurrent: () => matches() && (binding.meshes.get(slot) ?? null) === root && !root?.isDisposed() &&
              (!identity.componentGuid || meshForPlayComponent(binding, slot, identity.componentGuid) === mesh),
          };
        },
        pick: (x, y) => {
          const mapped = mapCanvasPointer(scene, x, y, pointerCanvas());
          const picked = pickAtCanvas(scene, mapped.x, mapped.y);
          const actorGuid = picked?.slotId != null ? captureActorSlots.get(picked.slotId) : undefined;
          return actorGuid && picked?.slotId != null ? { actorGuid, slotId: picked.slotId } : null;
        },
      }, callbacks);
      runtimeTransformTools = owner;
      runtimeTransformToolsEnabled = false;
      return {
        setSelection: owner.setSelection, setTool: owner.setTool, setSnap: owner.setSnap,
        setEnabled: (enabled) => {
          if (runtimeTransformTools !== owner) return;
          runtimeTransformToolsEnabled = enabled;
          owner.setEnabled(enabled && simulationEditMode);
        },
        dispose: () => {
          if (runtimeTransformTools !== owner) return;
          owner.dispose(); runtimeTransformTools = null; runtimeTransformToolsEnabled = false;
        },
      };
    },
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
    ...createPlayHandleInspection(binding),
    registerFonts: async (entries) => {
      await fontRegistry.registerAll(entries);
      if (fontRegistry.consumeDirty()) scheduler.invalidate("asset");
    },
    setMeshAssets: (assets: MeshAssetContext) => {
      const installed = installMeshAssets(assets);
      const rebuilt =
        editorSync?.setMeshAssets(installed) === true;
      const reselect = selectedActorIds();
      if (rebuilt && reselect.length > 0) {
        editor?.setSelectedActors(reselect);
      }
      // After any mesh rebuild, so a resized target re-parents to live meshes.
      debugOverlay?.refreshRenderTargets();
    },
    replaceTextureBytes: (textureBytes) => {
      const current = binding.textureBytes;
      if (!current) return [];
      const next = new Map(current);
      const changed: string[] = [];
      const settled: string[] = [];
      for (const [guid, source] of installTextureBytes(textureBytes) ?? []) {
        const previous = current.get(guid);
        // A Texture that was never installed changes what meshes sample: setMeshAssets owns that.
        if (!previous) continue;
        settled.push(guid);
        // Already stored this way: nothing to apply, and nothing left to retry.
        if (assetByteFingerprint(previous) === assetByteFingerprint(source)) continue;
        next.set(guid, source);
        changed.push(guid);
      }
      if (changed.length === 0) return settled;
      // Before the sync call: the Material library reads these bytes for its texture identity.
      binding.textureBytes = next;
      editorSync?.replaceTextureEncodings(next, changed);
      return settled;
    },
    acquireSceneSources: async (sources, preparation) => {
      if (disposed) throw new Error("The render Scene is disposed.");
      preparation?.signal?.throwIfAborted();
      const owner = ++nextSourceOwner;
      const nativeReleases: Array<() => void> = [];
      sourceOwners.set(owner, mergeSceneSourceAssets([{ ...sources, assets: sources.assets ? {
        ...sources.assets, textureBytes: installTextureBytes(sources.assets.textureBytes),
        modelBytes: undefined, modelSources: installModelSources(sources.assets),
        fontMsdfPng: installTextureBytes(sources.assets.fontMsdfPng),
      } : undefined }]));
      const cancel = () => {
        for (const release of nativeReleases.splice(0)) release();
        releaseSceneSources(owner);
      };
      preparation?.signal?.addEventListener("abort", cancel, { once: true });
      try {
        installOwnedSources();
        for (const font of sources.fonts ?? []) {
          const registered = await nativePreparation.schedule({ label: `Font ${font.guid}`,
            temporaryBytes: Math.max(1024, font.bytes.byteLength * 4), signal: preparation?.signal,
            priority: preparation?.priority }, () => fontRegistry.registerAll([font]));
          if (!registered) {
            const reason = [...fontRegistry.getWarnings()].reverse().find((warning) => warning.guid === font.guid)?.message;
            throw new Error(`${(reason ?? `Font "${font.family}" failed to load`).replace(/\.?$/, ".")} Inspect the source and family of Font ${font.guid}.`);
          }
        }
        if (preparation?.prepare) {
          preparation.signal?.throwIfAborted();
          const prepared = sourceOwners.get(owner)!;
          const check = () => { preparation.signal?.throwIfAborted(); if (disposed) throw new Error("The render Scene is disposed."); };
          // The queue belongs to the Engine, so simultaneous source scopes and
          // scene-specific model containers share the same admission budget.
          for (const [guid, bytes] of prepared.assets?.textureBytes ?? []) {
            check();
            const size = prepared.assets?.texturePixelSizes?.get(guid);
            const sourceSize = bytes instanceof Blob ? bytes.size : bytes.byteLength;
            const isCube = bytes instanceof Blob
              ? bytes.type === "application/vnd.babylon.env" || bytes.type === "image/vnd-ms.dds"
              : environmentTextureContainer(bytes) !== null;
            await nativePreparation.schedule({ label: `Texture ${guid}`, signal: preparation.signal, priority: preparation.priority,
              temporaryBytes: sourceSize + (size ? size.width * size.height * 8 * (isCube ? 6 : 1) : Math.max(1024 * 1024, sourceSize * 16)),
            }, async () => {
              check();
              const lease = resourceCache.acquireTexture(guid, engine, bytes, { isCube });
              nativeReleases.push(() => lease.release());
              await lease.ready;
            });
          }
          const spawnableMaterials: Material[] = [];
          const spawnableContainers: AssetContainer[] = [];
          for (const [guid, document] of prepared.materialDocuments ?? []) {
            check();
            await nativePreparation.schedule({ label: `Material ${guid}`, signal: preparation.signal,
              priority: preparation.priority, temporaryBytes: 1024 * 1024 }, async () => {
              check();
              const material = materialLibrary.acquire(scene, guid, document);
              if (!material.ok) throw new Error(`Material ${guid}: ${material.diagnostics.map((entry) => entry.message).join("; ")}`);
              nativeReleases.push(() => materialLibrary.release(scene, guid));
              const diagnostics = await material.ready;
              if (diagnostics.some((entry) => entry.severity === "error"))
                throw new Error(`Material ${guid}: ${diagnostics.map((entry) => entry.message).join("; ")}`);
              compiledMaterialGuids.add(guid);
              if (document.domain === "surface") spawnableMaterials.push(material.material);
            });
          }
          for (const [guid, source] of prepared.assets?.modelSources ?? []) {
            check();
            const lease = acquireGlbContainer(scene, guid, source, binding.modelPayloads?.get(guid), {
              packedTextureGuids: new Set(binding.textureBytes?.keys()),
              texturesByMaterialGuid: binding.materialTextureGuids ?? new Map(), compiledMaterialGuids,
            }, preparation.priority);
            nativeReleases.push(() => lease.release());
            spawnableContainers.push(await lease.load);
            await lease.lods();
          }
          // What a latent spawn (Spawn Actor, a Class load) prepared compiles now, against the current lighting,
          // so it resolves with the actor's variants ready; anything this misses is hidden per mesh until it compiles.
          if (options.playMode && preparation.warm)
            await warmSpawnables(scene, { materials: spawnableMaterials, containers: spawnableContainers }, check);
          if (prepared.audioLibrary?.audio.size && audioService)
            nativeReleases.push(await audioService.preload([...prepared.audioLibrary.audio.keys()], preparation.priority));
          check();
        }
        if (disposed) throw new Error("The render Scene was disposed during source preparation.");
        preparation?.signal?.throwIfAborted();
        const releaseSources = sourceRelease(owner);
        return () => { for (const release of nativeReleases.splice(0)) release(); releaseSources(); };
      } catch (error) {
        cancel();
        throw error;
      } finally {
        preparation?.signal?.removeEventListener("abort", cancel);
      }
    },
    nativePreparationStats: () => nativePreparation.snapshot(),
    spawnableWarmStats: () => spawnableWarm,
    loadRehearsalStats: () => loadRehearsalReport ?? (loadRehearsal?.done ? loadRehearsal.report() : null),
    releaseInitialSources,
    setSourceLibraries: (libraries) => {
      if (libraries.audioLibrary) audioService?.setLibrary(libraries.audioLibrary, true);
      if (libraries.particleLibrary) particleService?.setLibrary(libraries.particleLibrary);
    },
    applySceneEnvironment: (sceneData: SerializedScene) => {
      if (!options.editor) {
        playVisuals.setStaticActors(reflectionProbeStaticActors(sceneData.actors));
        findSceneReflectionProbes(scene)?.markDirty(true);
      }
      applySceneDocumentRenderSettings(sceneData);
      outlineHost.refreshSettings();
      applySerializedSceneEnvironment(scene, sceneData, {
        applyClearColor: true,
        assets: binding,
      });
      scheduler.invalidate("asset");
    },
    setRenderSettings: (settings) => {
      setSceneRenderSettings(scene, settings);
      viewportShading?.apply();
      outlineHost.refreshSettings();
      scheduler.invalidate("asset");
    },
    postProcessPassCount: () => worldRenderer.postProcessPassCount(),
    renderTaskNames: () => worldRenderer.taskNames(),
    sceneLayerScenes: () =>
      (sceneLayerCompositor?.sortedLayers() ?? []).map((layer) => ({
        layerId: layer.layerId,
        scene: layer.scene,
        zOrder: layer.zOrder,
      })),
    ownedScenes: () => [scene, ...(sceneLayerCompositor?.ownedScenes() ?? [])],
    assignedMaterialGuids: () => listAssignedMaterialGuids(binding),
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
      for (const root of binding.meshes.values()) { refreshText2DMaterials(root, binding); refreshJoystick2DMaterials(root, binding); refreshUIControl2DMaterials(root, binding); }
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
      // Every instance the load published is in the Scene now; later ones compile as they publish.
      if (!owner) instanceCompileHold = null;
      applyRenderingQuality();
      // Water's blend and placement (flat) are otherwise first settled by the first frame's update, after the shader
      // warm-up and the graph's probes compiled every variant without them: each then compiles twice. Copy intent is
      // counted at creation and changes later only for water disabled through an ancestor or `setEnabled`.
      settleSceneWater(scope.target, true);
      // Built-in water compiles the variant its pass draws when the graph below prepares: which one that is depends on
      // the view's plan, so a warm-up here would compile one nothing draws, and wait for its link.
      await warmSceneMaterials(scope.target, scope.assert, isBuiltInWaterMesh);
      scope.assert();
      if (!owner && options.playMode) await warmPlaySpawnables(scope.assert);
      freezeLibraryMaterials();
      outlineHost.refreshSettings();
      if (owner) await sceneLayerCompositor?.prepare(owner.layerId, scope.assert);
      else await worldRenderer.prepare(scope.assert);
      scope.assert();
      // Play rehearses its light changes in the world presentation's loading frames, before the first presented one.
      if (!owner && options.playMode) {
        endLoadRehearsal();
        loadRehearsalReport = null;
        // Full Quality captures prepare their views in the starting state, so their variants share its Effects.
        loadRehearsal = createLoadRehearsal(scene, () => !renderTargetCaptures.preparing());
      }
    },
    whenMaterialTexturesReady: async (owner) => {
      const scope = loadingScope(owner);
      // Measure stalls of the pending set, not total load time: a slow host
      // that keeps finishing uploads stays in budget; a hung upload fails.
      let lastProgress = Date.now();
      let previous: string | null = null;
      // The RGBD decode behind the environment BRDF texture waits for its post-process effect, which can sit
      // behind long driver compiles; like the other loading budgets, renew while the driver is compiling.
      const compiles = new DriverCompileWatch(engine);
      for (;;) {
        const pending = pendingSceneTextureWork(scope.target);
        if (pending.length === 0) break;
        scope.assert();
        const key = pending.join("\n");
        const now = Date.now();
        if (key !== previous) {
          lastProgress = now;
        } else if (now - lastProgress >= SCENE_SHADER_WARM_TIMEOUT_MS) {
          if (!compiles.renew()) {
            throw new Error(
              `Material textures did not become ready before the loading deadline. Still waiting for ${pending.length}: ${pending.slice(0, 8).join(", ")}${pending.length > 8 ? ", …" : ""}.`,
            );
          }
          lastProgress = now;
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
      // The first draws' readiness probes can still be linking (one at a time
      // where links are synchronous) or building on a parallel-compile driver,
      // which reports completion only; renew the budget while shaders progress.
      const compiles = new DriverCompileWatch(engine);
      const expire = () => {
        const waiting = pendingPresentations.get(key);
        if (waiting && !waiting.completionStarted && compiles.renew()) waiting.timer = setTimeout(expire, SCENE_FIRST_FRAME_TIMEOUT_MS);
        else expirePresentation(key);
      };
      const timer = setTimeout(expire, SCENE_FIRST_FRAME_TIMEOUT_MS);
      const pending: PendingPresentation = { promise, resolve, reject, timer, ready: false, attempts: 0, rendered: false, owner, submission: null, copied: false, completionStarted: false, errorsCleared: false, pipelines: 0 };
      pending.restart = () => {
        if (pending.completionStarted || pendingPresentations.get(key) !== pending) return;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(expire, SCENE_FIRST_FRAME_TIMEOUT_MS);
      };
      pendingPresentations.set(key, pending);
      return promise;
    },
    unlockAudio: () => audioService?.unlockAsync() ?? Promise.resolve(),
    resetAudioSession: () => {
      audioService?.resetSession();
    },
    setAudioReverbField: (bytes) => {
      audioService?.setReverbField(bytes);
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
      if (!owner) { await initialFonts; scope.assert(); }
      await commandSources.whenReady(commandSources.pendingSlotIds().filter((slotId) =>
        (sceneLayerCompositor?.layerIdForSlot(slotId) ?? undefined) === owner?.layerId));
      scope.assert();
      if (!owner) await (editorSync?.whenEditorModelsReady() ?? Promise.resolve());
      const playLoads = [...(binding.slotAnimLoads?.entries() ?? [])]
        .filter(([slotId]) => (sceneLayerCompositor?.layerIdForSlot(slotId) ?? undefined) === owner?.layerId)
        .map(([, pending]) => pending);
      await Promise.all(playLoads);
      scope.assert();
    },
    prepareSceneStream: async (slotIds, signal, onProgress, owner) => {
      if (!options.playMode) return Promise.reject(new Error("Scene streaming is available only during Play."));
      const generation = loadGeneration;
      await commandSources.whenReady(slotIds, signal);
      assertCurrent(generation);
      await prepareSceneStream(scene, binding, slotIds, {
        signal, onProgress,
        assertCurrent: () => assertCurrent(generation),
        pendingParticles: (slots) => particleService?.pendingSlotPreparation(slots) ?? [],
      });
      signal.throwIfAborted();
      assertCurrent(generation);
      if (streamAdmission?.publish(slotIds, owner) === false)
        throw new Error("Scene streaming publication was superseded.");
      // Published roots are enabled now (the water update skips water held disabled until here): settle it before the
      // fog preparation below probes its variants.
      settleSceneWater(scene);
      if (slotIds.some((slot) => {
        const fog = binding.fogVolumes.get(slot);
        return fog && hasFogVolumes(scene, fog.actorId);
      })) {
        // Fog can introduce the shared effects pipeline. Its graph and actor
        // geometry must be ready before the runtime acknowledges Loaded.
        // Preparation belongs to the renderer, so one canceled stream cannot
        // reject a sibling waiting for the same graph generation.
        let cancel!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          cancel = () => reject(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
        });
        try {
          await Promise.race([worldRenderer.prepare(() => assertCurrent(generation)), cancelled]);
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        signal.throwIfAborted();
        assertCurrent(generation);
      }
      particleService?.startPreparedSlots(slotIds);
      appliedSnapshotIdentity = null;
      scheduler.invalidate("snapshot");
    },
    modelLoadCount: () =>
      (editorSync?.pendingModelLoadCount() ?? 0) +
      (binding.slotAnimLoads?.size ?? 0),
    setCommandSourceLoader: (loader) => commandSources.setLoader(loader),
  };
  return engineHandle;
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
    case "2dcontrol":
    case "2djoystick":
    case "2dtexture":
    case "2dmaterial":
    case "2dbutton":
    case "2dpanel":
    case "2dlayout":
    case "2dpainter":
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

/** Live Play views on every Engine in this page; decoder statics are page-global. */
let mainThreadDecodingViews = 0;

/** Hold main-thread decoding for one Play view; the page's last release restores workers. */
function retainMainThreadDecoding(restoreWorkers: () => void): () => void {
  mainThreadDecodingViews += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mainThreadDecodingViews -= 1;
    if (mainThreadDecodingViews === 0) restoreWorkers();
  };
}

/** Disable every other enabled view; returns the views to re-enable later. */
function holdOtherEngineViews(
  engine: AbstractEngine,
  except: HTMLCanvasElement,
): EngineView[] {
  const held: EngineView[] = [];
  for (const view of engine.views ?? []) {
    if (view.target === except || !registeredViewIsEnabled(view)) continue;
    setRegisteredViewEnabled(view, false);
    held.push(view);
  }
  return held;
}

// Handles without a registered view (RTT previews) still draw into their
// Engine's frame. Each entry reports whether that handle's canvas is shown.
const viewlessRenderers = new WeakMap<AbstractEngine, Set<() => boolean>>();

function retainViewlessRenderer(engine: AbstractEngine, shown: () => boolean): () => void {
  let renderers = viewlessRenderers.get(engine);
  if (!renderers) viewlessRenderers.set(engine, renderers = new Set());
  renderers.add(shown);
  return () => {
    renderers.delete(shown);
    if (!renderers.size && viewlessRenderers.get(engine) === renderers) viewlessRenderers.delete(engine);
  };
}

/** Whether a viewless handle other than `except` may draw into this Engine's frame. */
function hasShownViewlessSibling(engine: AbstractEngine, except: (() => boolean) | null): boolean {
  for (const shown of viewlessRenderers.get(engine) ?? []) {
    if (shown !== except && shown()) return true;
  }
  return false;
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
  const engine = new Engine(canvas, false, projectEngineOptions());
  configureKtx2DecoderRuntime(KhronosTextureContainer2, {
    caps: engine.getCaps(),
    renderer: (
      engine as { getGlInfo?: () => { renderer?: string } }
    ).getGlInfo?.().renderer,
  });
  return engine;
}

/** CSS safe-area insets are measured in viewport pixels, then intersected with the canvas. */
function sceneLayerSafeAreaInsets(canvas: HTMLCanvasElement): { left: number; right: number; top: number; bottom: number } {
  const doc = canvas.ownerDocument;
  const view = doc?.defaultView;
  if (!doc?.body || !view) return { left: 0, right: 0, top: 0, bottom: 0 };
  const probe = doc.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);";
  doc.body.append(probe);
  const style = view.getComputedStyle(probe);
  const rect = canvas.getBoundingClientRect();
  const inset = (value: string, offset: number) => Math.max(0, (Number.parseFloat(value) || 0) - offset);
  const result = { left: inset(style.paddingLeft, rect.left), right: inset(style.paddingRight, view.innerWidth - rect.right),
    top: inset(style.paddingTop, rect.top), bottom: inset(style.paddingBottom, view.innerHeight - rect.bottom) };
  probe.remove();
  return result;
}
