import {
  Engine,
  KhronosTextureContainer2,
  Mesh,
  Scene,
  ScenePerformancePriority,
  Texture,
} from "@babylonjs/core";
import type { SerializedScene, ViewportMode } from "@babylonslate/core";
import { createDefaultScene } from "@babylonslate/core";
import type { SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import type { CommandMessage } from "@babylonslate/bridge";
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
import { attachViewportFlyKeys } from "./viewport-fly-keys";
import { configureKtx2Transcoder } from "./ktx2-transcoder";
import {
  documentEditorColorScheme,
  editorClearColor,
  sceneClearColor,
  type EditorColorScheme,
} from "./editor-clear-color";
import { applySceneToBabylonScene } from "./scene-loader";
import { isSkyboxMesh } from "./skybox";
import { applySceneEnvironment as applySerializedSceneEnvironment } from "./scene-illumination";
import { setupDefaultViewport } from "./viewport";
import { RenderScheduler } from "./render-scheduler";
import { ResourceCache } from "./resource-cache";
import { HardwareScalingController } from "./hardware-scaling";
import { SnapshotInterpolator } from "./snapshot-sync";
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
import type { AudioPlaybackBackend } from "./audio-playback-backend";
import { FakeAudioPlaybackBackend } from "./audio-playback-backend";
import { BabylonAudioPlaybackBackend } from "./babylon-audio-backend";

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
  setPostProcessStack: (stack: readonly PostProcessStackInput[]) => void;
  setMaterialDocuments: (
    documents: ReadonlyMap<string, MaterialDocument>,
    functions?: ReadonlyMap<string, MaterialFunctionDocument>,
  ) => void;
  /** Unlock AudioV2 after a user gesture and drain the pre-unlock queue. */
  unlockAudio: () => Promise<void>;
  /** Clear session mixer volumes and stop voices (scene change / Play stop). */
  resetAudioSession: () => void;
}

export interface CreateEngineOptions {
  /** Existing app-lifetime engine; when set, this canvas is registerView'd. */
  sharedEngine?: Engine;
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
  /** Model source bytes keyed by Model asset guid. */
  modelBytes?: ReadonlyMap<string, Uint8Array>;
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
  /** Engine Settings `hardwareScalingLevel`. 1 is native. */
  hardwareScalingLevel?: number;
  /** Stack skip / compile messages (exported player and Play overlay). */
  onPostProcessDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
  /** Injected playback backend (tests). Browser Play uses AudioV2. */
  audioBackend?: AudioPlaybackBackend;
  /** Packed or collected Audio source bytes keyed by asset guid. */
  audioBytes?: ReadonlyMap<string, Uint8Array>;
  /** Mixer / channel / attenuation / Audio payloads for gain routing. */
  audioLibrary?: AudioLibrary;
  /** Scene `audioReverb` chunk; dry when missing. */
  audioReverbBytes?: Uint8Array | null;
  onAudioDiagnostic?: (diagnostic: {
    code: string;
    message: string;
    assetGuid?: string;
  }) => void;
}

export interface EditorTools {
  camera: EditorCameraController;
  gizmos: GizmoHost;
  grid: EditorGrid;
  selection: SelectionOutline;
  sync: EditorSceneSync;
  setViewportMode: (mode: ViewportMode) => void;
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
): PlayActorPosition[] {
  const next: PlayActorPosition[] = [];
  const count = sampled.actorCount;
  for (let i = 0; i < count; i++) {
    const actor = sampled.actors[i]!;
    next.push({
      slotId: actor.slotId,
      x: actor.position.x,
      y: actor.position.y,
      z: actor.position.z,
      qx: actor.rotation.x,
      qy: actor.rotation.y,
      qz: actor.rotation.z,
      qw: actor.rotation.w,
    });
  }
  return next;
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
 * pass it via `sharedEngine` + registerView for Play overlays.
 */
export function createEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions = {},
): EngineHandle {
  configureKtx2Transcoder(KhronosTextureContainer2, options.ktx2BasePath);

  const ownsEngine = !options.sharedEngine;
  const engine =
    options.sharedEngine ??
    new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      adaptToDeviceRatio: false,
      antialias: false,
    });

  if (options.sharedEngine) {
    // clearBeforeCopy: overlay is a 2D blit of the WebGL canvas; without a
    // clear, skipped render-on-demand frames composite additively.
    engine.registerView(canvas, undefined, true);
  }

  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.clearColor = options.environmentColor
    ? sceneClearColor(options.environmentColor)
    : editorClearColor(options.colorScheme ?? documentEditorColorScheme());
  if (options.playMode) {
    scene.performancePriority = ScenePerformancePriority.Intermediate;
    // Intermediate disables color clear (assumes a full-bleed skybox). Play
    // scenes often have none, so restore autoClear to avoid additive trails.
    scene.autoClear = true;
  }

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
  const resourceCache = new ResourceCache();
  const audioService = options.playMode
    ? new AudioService({
        backend: createPlayAudioBackend(options.audioBackend),
        onDiagnostic: options.onAudioDiagnostic,
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
  binding.modelBytes = options.modelBytes;
  binding.resourceCache = resourceCache;
  binding.slotAnimReady = () => {
    scheduler.invalidate("snapshot");
  };

  const materialDocuments = new Map<string, MaterialDocument>(
    options.materialDocuments ?? [],
  );
  const materialFunctions = new Map<string, MaterialFunctionDocument>(
    options.materialFunctions ?? [],
  );
  const materialLibrary = new MaterialLibrary({
    functions: () => Object.fromEntries(materialFunctions),
    resolveTexture: (guid) => {
      const bytes = binding.textureBytes?.get(guid);
      if (!bytes) return null;
      const texture = resourceCache.getTexture(guid, engine, bytes);
      return texture instanceof Texture ? texture : null;
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

  const editorSync = options.editor
    ? new EditorSceneSync(scene, scheduler, {
        resolveMaterial: (guid) => binding.resolveMaterial?.(guid) ?? null,
      })
    : null;

  const loadScene = (sceneData: SerializedScene) => {
    postProcessStack = normalizePostProcessStack(
      sceneData.settings.postProcessStack,
    );
    if (editorSync) {
      editorSync.apply(sceneData);
      rebuildPostProcessStack();
      return;
    }
    if (options.playMode) {
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
        multiSelectDrag = beginGizmoMultiSelectDrag(attached, followers);
        options.onGizmoDragStart?.();
      },
      onDrag: () => {
        const attached = gizmosRef.host?.attachedMesh() ?? null;
        if (multiSelectDrag && attached) {
          applyGizmoMultiSelectDrag(multiSelectDrag, attached);
        }
        options.onGizmoDrag?.();
      },
      onDragEnd: () => {
        const attached = gizmosRef.host?.attachedMesh() ?? null;
        if (multiSelectDrag && attached) {
          applyGizmoMultiSelectDrag(multiSelectDrag, attached);
        }
        multiSelectDrag = null;
        options.onGizmoDragEnd?.();
      },
    });
    gizmosRef.host = gizmos;
    const debugOverlayInstance = new EditorDebugOverlay(scene);
    debugOverlay = debugOverlayInstance;

    const gestures = attachViewportGestures(canvas, cameraController, {
      scheduler,
      blockLook: (x, y) => gizmos.isDragging() || gizmos.hitTest(x, y),
      dragSelectActive: () => options.dragSelectActive?.() === true,
      onTap: (x, y, tap) => {
        const hit = pickAtCanvas(scene, x, y);
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
        const actorIds = names
          .map((name) => editorSync.actorForMesh(name))
          .filter((id): id is string => id !== null);
        options.onMarqueeSelect(actorIds);
      },
    });
    const flyKeys =
      typeof window === "undefined"
        ? null
        : attachViewportFlyKeys(window, cameraController, canvas, {
            scheduler,
            isEnabled: options.editorFlyEnabled,
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
            return mesh !== null && mesh.isPickable;
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

  // Play renders snapshot proxy meshes only. Seeding the default Cube here
  // stacks it under those proxies at the origin (z-fighting / additive look).
  if (!options.playMode) {
    loadScene(createDefaultScene());
  }

  const resize = () => {
    engine.resize();
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    if (height > 0) {
      editor?.camera.setCanvasHeight(height);
      editor?.camera.updateOrthoBounds(width / height);
    }
  };

  let interpAlpha = 1;
  let lastPositions: PlayActorPosition[] = [];
  let lastDrawCalls = 0;
  const renderLoop = () => {
    if (!scheduler.shouldRender()) {
      return;
    }
    const sampled = interpolator.sample(interpAlpha);
    if (sampled) {
      const previousCamera = scene.activeCamera;
      applySnapshotToScene(scene, binding, sampled);
      rebuildIfActiveCameraChanged(previousCamera);
      lastPositions = positionsFromSample(sampled);
    }
    if (audioService) {
      audioService.syncSnapshot(
        lastPositions.map((actor) => ({
          slotId: actor.slotId,
          position: {
            x: actor.x,
            y: actor.y,
            z: actor.z,
            qx: actor.qx,
            qy: actor.qy,
            qz: actor.qz,
            qw: actor.qw,
          },
        })),
      );
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
    scene.render();
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
    // Context loss is treated as memory pressure.
  });
  engine.onContextRestoredObservable.add(() => {
    scaling.dropTier();
    resourceCache.flushUnreferenced();
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
      scene.dispose();
      if (options.sharedEngine) {
        engine.unRegisterView(canvas);
      }
      resourceCache.dispose();
      if (ownsEngine) {
        engine.dispose();
      }
    },
    resize,
    setSize: (width: number, height: number) => {
      engine.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
    },
    loadScene,
    pushSnapshot: (buffer: Float32Array) => {
      interpolator.push(buffer);
      interpAlpha = 1;
      const sampled = interpolator.sample(interpAlpha);
      if (sampled) lastPositions = positionsFromSample(sampled);
      scheduler.invalidate("snapshot");
    },
    applyCommand: (command: CommandMessage) => {
      if (command.type === "spawn") {
        audioService?.noteActorSlot(command.actorGuid, command.slotId);
      }
      audioService?.handleCommand(command);
      if (command.type === "assignMesh") {
        const previousCamera = scene.activeCamera;
        applyAssignMesh(scene, binding, command);
        rebuildIfActiveCameraChanged(previousCamera);
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
    setPaused: (paused: boolean) => scheduler.setPaused(paused),
    liveObjectCounts: () => ({
      meshes: scene.meshes.length,
      textures: engine.getLoadedTexturesCache().length,
    }),
    drawCalls: () => lastDrawCalls,
    pickAt: (x, y) => {
      const hit = pickAtCanvas(scene, x, y);
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
      binding.modelBytes = assets.modelBytes;
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
      scheduler.invalidate("asset");
    },
    unlockAudio: () => audioService?.unlockAsync() ?? Promise.resolve(),
    resetAudioSession: () => {
      audioService?.resetSession();
    },
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
