import type { AbstractEngine, EngineView } from "@babylonjs/core";

type Admission = { requestedEnabled: boolean; held: boolean };
const admissions = new WeakMap<EngineView, Admission>();
const offscreenDispatch = new WeakMap<AbstractEngine, { clients: number; release: () => void }>();

type Presentation = {
  begin: () => void;
  canCopy: () => boolean;
  copied: (milliseconds: number) => void;
};
const presenters = new WeakMap<AbstractEngine, {
  views: Map<EngineView, Presentation>;
  release: () => void;
}>();

/** Babylon's native view step copies even when a scene declines to draw. Keep
 * its dispatch/camera contract, but commit the visible bitmap only after the
 * owner produced a valid frame. No staging canvas or extra GPU readback. */
function retainPresentation(engine: AbstractEngine, view: EngineView, presentation: Presentation): () => void {
  let owner = presenters.get(engine);
  if (!owner) {
    const descriptor = Object.getOwnPropertyDescriptor(engine, "_renderViewStep");
    const original = engine._renderViewStep;
    const views = new Map<EngineView, Presentation>();
    const renderView = function (this: AbstractEngine, current: EngineView): boolean {
      const host = views.get(current);
      if (!host) return original.call(this, current);
      const canvas = current.target;
      const context = canvas.getContext("2d");
      const source = this.getRenderingCanvas();
      if (!context || !source) return true;
      host.begin();
      this.onBeforeViewRenderObservable.notifyObservers(current);
      const camera = current.camera;
      const scene = camera ? (Array.isArray(camera) ? camera[0]?.getScene() : camera.getScene()) : undefined;
      const previousCamera = scene?.activeCamera;
      const previousCameras = scene?.activeCameras;
      const previousView = this.activeView;
      try {
        if (scene && camera) {
          if (Array.isArray(camera)) scene.activeCameras = camera;
          else { scene.activeCamera = camera; scene.activeCameras = null; }
        }
        this.activeView = current;
        // Owned customResize callbacks resize only the private Engine buffer.
        if (current.customResize) current.customResize(canvas);
        else if (canvas.clientWidth && canvas.clientHeight) {
          const width = Math.max(1, Math.floor(canvas.clientWidth / this.getHardwareScalingLevel()));
          const height = Math.max(1, Math.floor(canvas.clientHeight / this.getHardwareScalingLevel()));
          if (source.width !== width || source.height !== height) this.setSize(width, height);
        }
        if (!source.width || !source.height) return true;
        this._renderFrame();
        if (!host.canCopy()) return true;
        const started = performance.now();
        this.flushFramebuffer();
        if (canvas.width !== source.width) canvas.width = source.width;
        if (canvas.height !== source.height) canvas.height = source.height;
        if (current.clearBeforeCopy) context.clearRect(0, 0, source.width, source.height);
        context.drawImage(source, 0, 0);
        host.copied(performance.now() - started);
        return true;
      } finally {
        if (scene) { scene.activeCamera = previousCamera ?? null; scene.activeCameras = previousCameras ?? null; }
        try { this.onAfterViewRenderObservable.notifyObservers(current); }
        finally { this.activeView = previousView; }
      }
    };
    engine._renderViewStep = renderView;
    owner = { views, release: () => {
      if (engine._renderViewStep !== renderView) return;
      if (descriptor) Object.defineProperty(engine, "_renderViewStep", descriptor);
      else Reflect.deleteProperty(engine, "_renderViewStep");
    } };
    presenters.set(engine, owner);
  }
  owner.views.set(view, presentation);
  return () => {
    if (!owner.views.delete(view) || owner.views.size) return;
    owner.release();
    presenters.delete(engine);
  };
}

/** Keep the Engine's existing frame callbacks alive when every native copy view is held. */
export function retainOffscreenFrameDispatch(engine: AbstractEngine): () => void {
  let owner = offscreenDispatch.get(engine);
  if (!owner) {
    const descriptor = Object.getOwnPropertyDescriptor(engine, "_renderViews");
    const renderViews = engine._renderViews;
    const dispatch = function (this: AbstractEngine): boolean {
      const enabled = this.views?.some((view) => view.enabled) ?? false;
      const rendered = renderViews.call(this);
      // Babylon 9.20 returns true for a nonempty all-disabled views array,
      // suppressing _renderFrame entirely. Native dispatch still restores
      // activeView; returning false lets its ordinary frame loop run once.
      return enabled && rendered;
    };
    engine._renderViews = dispatch;
    owner = { clients: 0, release: () => {
      if (engine._renderViews !== dispatch) return;
      if (descriptor) Object.defineProperty(engine, "_renderViews", descriptor);
      else Reflect.deleteProperty(engine, "_renderViews");
    } };
    offscreenDispatch.set(engine, owner);
  }
  owner.clients += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.clients > 0) return;
    owner.release();
    offscreenDispatch.delete(engine);
  };
}

export function registeredViewIsEnabled(view: EngineView): boolean {
  const admission = admissions.get(view);
  return admission?.held ? admission.requestedEnabled : view.enabled;
}

export function setRegisteredViewEnabled(view: EngineView, enabled: boolean): void {
  const admission = admissions.get(view);
  if (admission) admission.requestedEnabled = enabled;
  if (!admission?.held) view.enabled = enabled;
}

/**
 * Native view rendering resizes and copies even when a render callback skips.
 * Admit the view before those operations, preserving its last complete canvas.
 */
export function admitRegisteredViewFrames(engine: AbstractEngine, view: EngineView, canRender: () => boolean, presentation?: Presentation): () => void {
  if (admissions.has(view)) throw new Error("Registered view already has a frame owner.");
  const admission: Admission = { requestedEnabled: view.enabled, held: false };
  admissions.set(view, admission);
  const releasePresentation = presentation ? retainPresentation(engine, view, presentation) : undefined;
  const restore = () => {
    if (!admission.held) return;
    admission.held = false;
    view.enabled = admission.requestedEnabled;
  };
  const before = engine.onBeginFrameObservable.add(() => {
    if (!view.enabled || canRender()) return;
    admission.requestedEnabled = view.enabled;
    admission.held = true;
    view.enabled = false;
  });
  const after = engine.onEndFrameObservable.add(restore);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    engine.onBeginFrameObservable.remove(before);
    engine.onEndFrameObservable.remove(after);
    restore();
    releasePresentation?.();
    admissions.delete(view);
  };
}
