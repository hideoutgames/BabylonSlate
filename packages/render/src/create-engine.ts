import {
  Engine,
  KhronosTextureContainer2,
  Scene,
  ScenePerformancePriority,
} from "@babylonjs/core";
import type { SerializedScene, ViewportMode } from "@babylonslate/core";
import { createDefaultScene } from "@babylonslate/core";
import {
  createEditorCamera,
  type EditorCameraController,
} from "./editor-camera";
import { createEditorGrid, type EditorGrid } from "./editor-grid";
import { EditorSceneSync } from "./editor-scene-sync";
import { createGizmoHost, type GizmoHost } from "./gizmo-host";
import { SelectionOutline } from "./selection-outline";
import { attachViewportGestures } from "./viewport-gestures";
import { configureKtx2Transcoder } from "./ktx2-transcoder";
import { EDITOR_CLEAR_COLOR } from "./editor-clear-color";
import { applySceneToBabylonScene } from "./scene-loader";
import { setupDefaultViewport } from "./viewport";
import { RenderScheduler } from "./render-scheduler";
import { ResourceCache } from "./resource-cache";
import { HardwareScalingController } from "./hardware-scaling";
import { SnapshotInterpolator } from "./snapshot-sync";
import {
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  type SnapshotSceneBinding,
} from "./snapshot-apply";
import { pickAtCanvas } from "./picking";
import { meshNamesInCanvasRect } from "./two-d";
import { applyPixelArtSamplingToScene } from "./pixel-perfect";

export interface EngineHandle {
  engine: Engine;
  scene: Scene;
  scheduler: RenderScheduler;
  resourceCache: ResourceCache;
  scaling: HardwareScalingController;
  dispose: () => void;
  resize: () => void;
  loadScene: (sceneData: SerializedScene) => void;
  /** Push a worker snapshot and invalidate the viewport. */
  pushSnapshot: (buffer: Float32Array) => void;
  setPaused: (paused: boolean) => void;
  /** Live Babylon mesh/texture counts for Play leak assertions. */
  liveObjectCounts: () => { meshes: number; textures: number };
  /** Explicit tap pick (hover picking is disabled). */
  pickAt: (
    canvasX: number,
    canvasY: number,
  ) => { meshName: string; slotId: number | null } | null;
  /** Editor camera, gizmos, grid, outline and scene sync; null in Play views. */
  editor: EditorTools | null;
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
  onPickActor?: (actorId: string | null) => void;
  /** Actors inside a 2D one-finger marquee drag. */
  onMarqueeSelect?: (actorIds: string[]) => void;
  /** Gizmo drag lifecycle so the editor can coalesce one undo entry. */
  onGizmoDragStart?: () => void;
  onGizmoDrag?: () => void;
  onGizmoDragEnd?: () => void;
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
  frameActor: (actorId: string) => void;
  /** Live transform of the gizmo-attached mesh, for turning a drag into a command. */
  attachedActorTransform: () => {
    actorId: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  } | null;
}

/**
 * Creates an editor or Play view. Prefer one Engine for the app lifetime and
 * pass it via `sharedEngine` + registerView for Play overlays.
 */
export function createEngine(
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions = {},
): EngineHandle {
  configureKtx2Transcoder(KhronosTextureContainer2);

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
    engine.registerView(canvas);
  }

  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.clearColor = EDITOR_CLEAR_COLOR.clone();
  if (options.playMode) {
    scene.performancePriority = ScenePerformancePriority.Intermediate;
  }

  setupDefaultViewport(scene);

  const scheduler = new RenderScheduler();
  if (options.editor) {
    scheduler.setAlwaysRender(true);
  }
  const resourceCache = new ResourceCache();
  const scaling = new HardwareScalingController(engine);
  const interpolator = new SnapshotInterpolator(options.maxActors ?? 256);
  const binding: SnapshotSceneBinding = createSnapshotSceneBinding();

  const editorSync = options.editor ? new EditorSceneSync(scene, scheduler) : null;

  const loadScene = (sceneData: SerializedScene) => {
    if (editorSync) {
      editorSync.apply(sceneData);
      return;
    }
    applySceneToBabylonScene(scene, sceneData);
    scheduler.invalidate("asset");
  };

  let editor: EditorTools | null = null;
  let disposeGestures: (() => void) | null = null;
  if (options.editor && editorSync) {
    const mode: ViewportMode = options.viewportMode ?? "3d";
    // The editor camera replaces the default viewport camera set up above.
    scene.activeCamera?.dispose();
    const cameraController = createEditorCamera(scene, { mode, scheduler });
    const grid = createEditorGrid(scene, { mode });
    const selection = new SelectionOutline(scene);
    const gizmos = createGizmoHost(scene, {
      mode,
      scheduler,
      onDragStart: options.onGizmoDragStart,
      onDrag: options.onGizmoDrag,
      onDragEnd: options.onGizmoDragEnd,
    });

    const gestures = attachViewportGestures(canvas, cameraController, {
      scheduler,
      onTap: (x, y) => {
        const hit = pickAtCanvas(scene, x, y);
        const actorId = hit ? editorSync.actorForMesh(hit.meshName) : null;
        options.onPickActor?.(actorId);
      },
      onMarquee: (rect) => {
        if (!options.onMarqueeSelect) return;
        const names = meshNamesInCanvasRect(
          scene,
          rect,
          engine.getRenderWidth(),
          engine.getRenderHeight(),
        );
        const actorIds = names
          .map((name) => editorSync.actorForMesh(name))
          .filter((id): id is string => id !== null);
        options.onMarqueeSelect(actorIds);
      },
    });
    disposeGestures = gestures.dispose;

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
        const meshes = actorIds.map((id) => editorSync.meshForActor(id));
        selection.set(meshes);
        // Locked actors are not pickable; keep the gizmo off them so lock is
        // more than a pick filter.
        const gizmoTarget =
          meshes.find((mesh) => mesh !== null && mesh.isPickable) ?? null;
        gizmos.attachTo(gizmoTarget);
        scheduler.invalidate("selection");
      },
      frameActor: (actorId: string) => {
        const mesh = editorSync.meshForActor(actorId);
        if (mesh) {
          cameraController.frame(mesh.getAbsolutePosition());
        }
      },
      attachedActorTransform: () => {
        const mesh = gizmos.attachedMesh();
        if (!mesh) return null;
        const actorId = editorSync.actorForMesh(mesh.name);
        if (!actorId) return null;
        const rotation = mesh.rotationQuaternion;
        return {
          actorId,
          position: [mesh.position.x, mesh.position.y, mesh.position.z],
          rotation: rotation
            ? [rotation.x, rotation.y, rotation.z, rotation.w]
            : [0, 0, 0, 1],
          scale: [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z],
        };
      },
    };
  }

  loadScene(createDefaultScene());

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
  engine.runRenderLoop(() => {
    if (!scheduler.shouldRender()) {
      return;
    }
    const sampled = interpolator.sample(interpAlpha);
    if (sampled) {
      applySnapshotToScene(scene, binding, sampled);
    }
    // Measure render cost only, not wall-clock gap since the previous
    // rendered frame — a frozen obstructed viewport can idle for seconds
    // between frames, and feeding that gap to the scaling valve would read
    // as a catastrophic frame time and drop quality for no reason.
    const renderStart = performance.now();
    scene.render();
    scheduler.noteRendered();
    scaling.noteFrameTime(performance.now() - renderStart);
  });

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

  return {
    engine,
    scene,
    scheduler,
    resourceCache,
    scaling,
    editor,
    dispose: () => {
      disposeGestures?.();
      editor?.gizmos.dispose();
      editor?.grid.dispose();
      editor?.selection.dispose();
      editor?.sync.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      disposeSnapshotBinding(binding);
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
    loadScene,
    pushSnapshot: (buffer: Float32Array) => {
      interpolator.push(buffer);
      interpAlpha = 1;
      scheduler.invalidate("snapshot");
    },
    setPaused: (paused: boolean) => scheduler.setPaused(paused),
    liveObjectCounts: () => ({
      meshes: scene.meshes.length,
      textures: engine.getLoadedTexturesCache().length,
    }),
    pickAt: (x, y) => {
      const hit = pickAtCanvas(scene, x, y);
      return hit
        ? { meshName: hit.meshName, slotId: hit.slotId }
        : null;
    },
  };
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
