import type { Scene } from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";

/** Preserve shared render state even when Babylon's RTT probe throws mid-pass. */
export function withSceneReadinessState<T>(scene: Scene, probe: () => T): T {
  const engine = scene.getEngine();
  const camera = scene.activeCamera;
  const sceneUbo = scene.getSceneUniformBuffer();
  const view = scene.getViewMatrix()?.clone();
  const projection = scene.getProjectionMatrix()?.clone();
  const viewport = engine.currentViewport;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const renderPassId = engine.currentRenderPassId;
  const colorWrite = engine.getColorWrite();
  const imageProcessing = scene.imageProcessingConfiguration.applyByPostProcess;
  const previousScene = FloatingOriginCurrentScene.getScene;
  const previousEyeAtCamera = FloatingOriginCurrentScene.eyeAtCamera;
  FloatingOriginCurrentScene.getScene = () => scene.floatingOriginMode ? scene : undefined;
  FloatingOriginCurrentScene.eyeAtCamera = true;
  let failed = false;
  let failure: unknown;
  let result!: T;
  const errors: unknown[] = [];
  try {
    // Ready checks can upload scene UBOs before the first Scene.render().
    if (camera && (!view || !projection)) scene.updateTransformMatrix();
    engine.currentRenderPassId = camera?.renderPassId ?? renderPassId;
    result = probe();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const restore = (action: () => void) => {
      try { action(); } catch (error) { errors.push(error); }
    };
    // Do not invoke RTT after-render observers: some perform blur passes.
    scene._activeCamera = camera;
    FloatingOriginCurrentScene.eyeAtCamera = true;
    restore(() => scene.setSceneUniformBuffer(sceneUbo));
    if (view && projection) restore(() => scene.setTransformMatrix(view, projection));
    restore(() => { scene.imageProcessingConfiguration.applyByPostProcess = imageProcessing; });
    restore(() => engine.setViewport(viewport ?? { x: 0, y: 0, width: 1, height: 1 }, width, height));
    restore(() => engine.setColorWrite(colorWrite));
    engine.currentRenderPassId = renderPassId;
    restore(() => scene.resetCachedMaterial());
    FloatingOriginCurrentScene.getScene = previousScene;
    FloatingOriginCurrentScene.eyeAtCamera = previousEyeAtCamera;
  }
  if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors,
    "Scene readiness state restoration failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
  return result;
}

const readinessDirtyListeners = new WeakMap<Scene, Set<() => void>>();

/**
 * Project-owned rendering-definition changes that Babylon observables do not
 * cover mark the scene's cached strict readiness result stale.
 */
export function markSceneReadinessDirty(scene: Scene): void {
  for (const listener of readinessDirtyListeners.get(scene) ?? []) listener();
}

/** Subscribe to strict-readiness invalidations; returns an unsubscribe. */
export function onSceneReadinessDirty(
  scene: Scene,
  listener: () => void,
): () => void {
  let listeners = readinessDirtyListeners.get(scene);
  if (!listeners) {
    listeners = new Set();
    readinessDirtyListeners.set(scene, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) readinessDirtyListeners.delete(scene);
  };
}
