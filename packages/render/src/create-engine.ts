import {
  Color4,
  Engine,
  KhronosTextureContainer2,
  Scene,
  ScenePerformancePriority,
} from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/core";
import { createDefaultScene } from "@babylonslate/core";
import { configureKtx2Transcoder } from "./ktx2-transcoder";
import { applySceneToBabylonScene } from "./scene-loader";
import { setupDefaultViewport } from "./viewport";
import { RenderScheduler } from "./render-scheduler";
import { ResourceCache } from "./resource-cache";
import { HardwareScalingController } from "./hardware-scaling";
import {
  SnapshotInterpolator,
} from "./snapshot-sync";
import {
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
  type SnapshotSceneBinding,
} from "./snapshot-apply";

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
}

export interface CreateEngineOptions {
  /** Existing app-lifetime engine; when set, this canvas is registerView'd. */
  sharedEngine?: Engine;
  /** When true, use Play scene performance settings. */
  playMode?: boolean;
  maxActors?: number;
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
  scene.clearColor = new Color4(37 / 255, 37 / 255, 37 / 255, 1);
  if (options.playMode) {
    scene.performancePriority = ScenePerformancePriority.Intermediate;
  }

  setupDefaultViewport(scene);

  const scheduler = new RenderScheduler();
  const resourceCache = new ResourceCache();
  const scaling = new HardwareScalingController(engine);
  const interpolator = new SnapshotInterpolator(options.maxActors ?? 256);
  const binding: SnapshotSceneBinding = createSnapshotSceneBinding();

  const loadScene = (sceneData: SerializedScene) => {
    applySceneToBabylonScene(scene, sceneData);
    scheduler.invalidate("asset");
  };

  loadScene(createDefaultScene());

  const resize = () => engine.resize();

  let lastFrame = performance.now();
  engine.runRenderLoop(() => {
    if (!scheduler.shouldRender()) {
      return;
    }
    const sampled = interpolator.sample(1);
    if (sampled) {
      applySnapshotToScene(scene, binding, sampled);
    }
    scene.render();
    scheduler.noteRendered();
    const now = performance.now();
    scaling.noteFrameTime(now - lastFrame);
    lastFrame = now;
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

  return {
    engine,
    scene,
    scheduler,
    resourceCache,
    scaling,
    dispose: () => {
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
      scheduler.invalidate("snapshot");
    },
    setPaused: (paused: boolean) => scheduler.setPaused(paused),
    liveObjectCounts: () => ({
      meshes: scene.meshes.length,
      textures: engine.getLoadedTexturesCache().length,
    }),
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
