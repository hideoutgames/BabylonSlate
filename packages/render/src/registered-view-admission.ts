import type { AbstractEngine, EngineView } from "@babylonjs/core";
import {
  createEngineCanvasPlacement,
  createWebGl2HeldImageStore,
  directViewPresentationEnabled,
  trackDirectViewTarget,
  type EngineCanvasPlacement,
  type HeldImageStore,
} from "./direct-view-presentation";

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
  direct: DirectPresenter | null;
  release: () => void;
  releaseView: (view: EngineView) => void;
}>();

/**
 * 2D context attributes for a registered view canvas. A view is only drawn
 * into (one copy of the Engine canvas per frame) and never read back, so it
 * opts out of Chromium's readback heuristic: after a page has read back other
 * default 2D canvases, Chromium creates later default contexts unaccelerated,
 * and every view copy then becomes a synchronous GPU readback.
 */
export const VIEW_CANVAS_2D_ATTRIBUTES: CanvasRenderingContext2DSettings = { willReadFrequently: false };

/** The Engine canvas covers the view only while it is the sole enabled view; see direct-view-presentation.ts. */
type DirectPresenter = {
  store: HeldImageStore;
  placement: EngineCanvasPlacement;
  /** The last presented step was direct; copy steps first hand the image back to the view canvas. */
  active: boolean;
  /** Inside a view step, which resizes and redraws by itself. */
  inStep: boolean;
};

function createDirectPresenter(engine: AbstractEngine, storeFactory: (engine: AbstractEngine) => HeldImageStore | null): DirectPresenter | null {
  const source = engine.getRenderingCanvas();
  const store = source ? storeFactory(engine) : null;
  if (!source || !store) return null;
  return { store, placement: createEngineCanvasPlacement(source), active: false, inStep: false };
}

function soleEnabledView(engine: AbstractEngine): boolean {
  let enabled = 0;
  for (const view of engine.views ?? []) if (registeredViewIsEnabled(view) && ++enabled > 1) return false;
  return enabled === 1;
}

/** Store factory override for tests (node has no WebGL). */
let heldImageStoreFactory: (engine: AbstractEngine) => HeldImageStore | null = createWebGl2HeldImageStore;
export function setHeldImageStoreFactoryForTests(factory: ((engine: AbstractEngine) => HeldImageStore | null) | null): void {
  heldImageStoreFactory = factory ?? createWebGl2HeldImageStore;
}

/** Whether `view` is presented by showing the Engine canvas itself (diagnostics and tests). */
export function viewPresentedDirectly(engine: AbstractEngine, view: EngineView): boolean {
  return presenters.get(engine)?.direct?.placement.view === view;
}

/** Babylon's native view step copies even when a scene declines to draw. Keep
 * its dispatch/camera contract, but commit the visible bitmap only after the
 * owner produced a valid frame. A sole enabled view shows the Engine canvas
 * itself; several views copy it into their 2D canvases. */
function retainPresentation(engine: AbstractEngine, view: EngineView, presentation: Presentation): () => void {
  let owner = presenters.get(engine);
  if (!owner) {
    const descriptor = Object.getOwnPropertyDescriptor(engine, "_renderViewStep");
    const original = engine._renderViewStep;
    const views = new Map<EngineView, Presentation>();
    const direct = createDirectPresenter(engine, heldImageStoreFactory);
    /** Hand a view's held image to its own 2D canvas so it keeps its last frame without the Engine canvas. */
    const freeze = (current: EngineView) => {
      const size = direct?.store.size(current);
      const source = engine.getRenderingCanvas();
      const target = current.target;
      const context = target.getContext("2d", VIEW_CANVAS_2D_ATTRIBUTES);
      if (!direct || !size || !source?.width || !source.height || !context) return;
      direct.store.restore(current, source.width, source.height);
      engine.flushFramebuffer();
      if (target.width !== size.width) target.width = size.width;
      if (target.height !== size.height) target.height = size.height;
      if (current.clearBeforeCopy) context.clearRect(0, 0, size.width, size.height);
      context.drawImage(source, 0, 0, source.width, source.height, 0, 0, size.width, size.height);
    };
    const stopCovering = (current: EngineView, keepImage: boolean) => {
      if (!direct || direct.placement.view !== current) return;
      if (keepImage) freeze(current);
      trackDirectViewTarget(current.target, null);
      direct.placement.vacate();
    };
    const leaveDirect = () => {
      if (!direct?.active) return;
      const covered = direct.placement.view;
      if (covered) stopCovering(covered, true);
      direct.placement.park();
      // Copy steps keep the view canvases current; held images would go stale.
      direct.store.clear();
      direct.active = false;
    };
    const renderView = function (this: AbstractEngine, current: EngineView): boolean {
      const host = views.get(current);
      if (!host) return original.call(this, current);
      const canvas = current.target;
      const context = canvas.getContext("2d", VIEW_CANVAS_2D_ATTRIBUTES);
      const source = this.getRenderingCanvas();
      if (!context || !source) return true;
      const presentDirectly = direct !== null && directViewPresentationEnabled() && soleEnabledView(this);
      if (!presentDirectly) leaveDirect();
      else {
        // The previous sole view keeps its last frame in its own canvas.
        const covered = direct.placement.view;
        if (covered && covered !== current) stopCovering(covered, true);
      }
      host.begin();
      this.onBeforeViewRenderObservable.notifyObservers(current);
      const camera = current.camera;
      const scene = camera ? (Array.isArray(camera) ? camera[0]?.getScene() : camera.getScene()) : undefined;
      const previousCamera = scene?.activeCamera;
      const previousCameras = scene?.activeCameras;
      const previousView = this.activeView;
      if (direct) direct.inStep = true;
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
        if (presentDirectly) {
          direct.active = true;
          if (host.canCopy()) {
            const started = performance.now();
            direct.store.snapshot(current, source.width, source.height);
            // The view canvas keeps the presented image's dimensions; it is drawn into only when it stops being covered.
            if (canvas.width !== source.width) canvas.width = source.width;
            if (canvas.height !== source.height) canvas.height = source.height;
            if (direct.placement.show(current)) trackDirectViewTarget(canvas, () => freeze(current));
            host.copied(performance.now() - started);
          } else if (direct.store.restore(current, source.width, source.height)) {
            // An incoherent frame: put the last coherent image back before the browser presents.
            if (direct.placement.show(current)) trackDirectViewTarget(canvas, () => freeze(current));
          } else {
            // Nothing coherent yet: let the view canvas show through.
            stopCovering(current, false);
          }
          return true;
        }
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
        if (direct) direct.inStep = false;
        if (scene) { scene.activeCamera = previousCamera ?? null; scene.activeCameras = previousCameras ?? null; }
        try { this.onAfterViewRenderObservable.notifyObservers(current); }
        finally { this.activeView = previousView; }
      }
    };
    engine._renderViewStep = renderView;
    // A resize outside a view step reallocates (clears) the shown default
    // framebuffer: put the held image back and follow the view's new box.
    const sizeDescriptor = Object.getOwnPropertyDescriptor(engine, "setSize");
    const setSize = engine.setSize;
    const resizeWhileCovering = function (this: AbstractEngine, width: number, height: number, forceSetSize?: boolean): boolean {
      const changed = setSize.call(this, width, height, forceSetSize);
      const covered = direct?.placement.view;
      if (direct && covered && !direct.inStep) {
        const source = this.getRenderingCanvas();
        if (changed && source) direct.store.restore(covered, source.width, source.height);
        direct.placement.follow();
      }
      return changed;
    };
    if (direct) engine.setSize = resizeWhileCovering;
    const lost = direct ? engine.onContextLostObservable.add(() => {
      const covered = direct.placement.view;
      if (covered) trackDirectViewTarget(covered.target, null);
      direct.placement.vacate();
      direct.store.clear(true);
      direct.active = false;
    }) : null;
    owner = { views, direct, release: () => {
      if (direct) {
        leaveDirect();
        direct.placement.park();
        direct.store.clear();
        engine.onContextLostObservable.remove(lost);
        if (engine.setSize === resizeWhileCovering) {
          if (sizeDescriptor) Object.defineProperty(engine, "setSize", sizeDescriptor);
          else Reflect.deleteProperty(engine, "setSize");
        }
      }
      if (engine._renderViewStep !== renderView) return;
      if (descriptor) Object.defineProperty(engine, "_renderViewStep", descriptor);
      else Reflect.deleteProperty(engine, "_renderViewStep");
    }, releaseView: (released: EngineView) => {
      if (!direct) return;
      if (direct.placement.view === released) {
        trackDirectViewTarget(released.target, null);
        direct.placement.park();
      }
      direct.store.release(released);
    } };
    presenters.set(engine, owner);
  }
  owner.views.set(view, presentation);
  const current = owner;
  return () => {
    if (!current.views.delete(view)) return;
    current.releaseView(view);
    if (current.views.size) return;
    current.release();
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
      // Babylon 9.29 returns true for a nonempty all-disabled views array,
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
