import type { AbstractEngine, EngineView } from "@babylonjs/core";
import {
  createEngineCanvasPlacement,
  createWebGl2HeldImageStore,
  directViewPresentationEnabled,
  trackDirectViewTarget,
  type EngineCanvasPlacement,
  type HeldImageStore,
} from "./direct-view-presentation";
import { createWebGpuHeldImageStore } from "./webgpu-held-image-store";

type Admission = { requestedEnabled: boolean; held: boolean };
const admissions = new WeakMap<EngineView, Admission>();
const offscreenDispatch = new WeakMap<AbstractEngine, { clients: number; release: () => void }>();

type Presentation = {
  begin: () => void;
  canCopy: () => boolean;
  copied: (milliseconds: number) => void;
  /** Whether this step drew into the Engine's default framebuffer at all (absent: assume it did). */
  dirty?: () => boolean;
  /** Whether this view may show the Engine canvas directly while it is the sole view (absent: it may). */
  allowDirect?: () => boolean;
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
  return { store, placement: createEngineCanvasPlacement(source, () => engine.isDisposed), active: false, inStep: false };
}

/**
 * Whether a view canvas is laid out (a hidden dock tab's canvas, or a detached
 * one, has no box). Such a view is not admitted and has nothing to present.
 */
export function viewCanvasHasLayoutBox(canvas: HTMLCanvasElement): boolean {
  return canvas.clientWidth > 0 && canvas.clientHeight > 0;
}

/**
 * The only enabled view whose canvas has a layout box, or null. Admission
 * keeps a hidden dock tab's view enabled (held, not drawn) every frame; it
 * must not push the view on screen back to copying.
 */
function soleShownView(engine: AbstractEngine): EngineView | null {
  let sole: EngineView | null = null;
  for (const view of engine.views ?? []) {
    if (!registeredViewIsEnabled(view) || !viewCanvasHasLayoutBox(view.target)) continue;
    if (sole) return null;
    sole = view;
  }
  return sole;
}

const createHeldImageStore = (engine: AbstractEngine) =>
  engine.isWebGPU ? createWebGpuHeldImageStore(engine) : createWebGl2HeldImageStore(engine);

/** Store factory override for tests (node has no GPU). */
let heldImageStoreFactory: (engine: AbstractEngine) => HeldImageStore | null = createHeldImageStore;
export function setHeldImageStoreFactoryForTests(factory: ((engine: AbstractEngine) => HeldImageStore | null) | null): void {
  heldImageStoreFactory = factory ?? createHeldImageStore;
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
      // A store that turned itself off has nothing to hand over; the view canvas keeps what it had.
      if (!direct.store.restore(current, source.width, source.height, true)) return;
      engine.flushFramebuffer();
      // A scaled restore fills the canvas with the held image; an unscaled one holds it 1:1 in the top-left
      // corner, cropped by a smaller canvas, and the view canvas takes just that region (as the screen shows it).
      const from = direct.store.restoresUnscaled
        ? { width: Math.min(size.width, source.width), height: Math.min(size.height, source.height) }
        : { width: source.width, height: source.height };
      const to = direct.store.restoresUnscaled ? from : size;
      if (target.width !== to.width) target.width = to.width;
      if (target.height !== to.height) target.height = to.height;
      if (current.clearBeforeCopy) context.clearRect(0, 0, to.width, to.height);
      context.drawImage(source, 0, 0, from.width, from.height, 0, 0, to.width, to.height);
    };
    const stopCovering = (current: EngineView, keepImage: boolean) => {
      if (!direct || direct.placement.view !== current) return;
      if (keepImage) freeze(current);
      direct.placement.vacate();
    };
    /** Cover the view; a canvas that cannot be covered gets its held image instead. */
    const show = (current: EngineView) => {
      if (direct && !direct.placement.show(current, () => freeze(current))) freeze(current);
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
      // A popout window's view copies: the Engine canvas cannot leave its document.
      const presentDirectly = direct !== null && directViewPresentationEnabled() && host.allowDirect?.() !== false &&
        direct.store.usable?.() !== false &&
        soleShownView(this) === current && direct.placement.canCover(current);
      if (!presentDirectly) leaveDirect();
      else {
        // The previous sole view keeps its last frame in its own canvas.
        const covered = direct.placement.view;
        if (covered && covered !== current) stopCovering(covered, true);
        direct.active = true;
        direct.store.engage?.();
      }
      host.begin();
      this.onBeforeViewRenderObservable.notifyObservers(current);
      const camera = current.camera;
      const scene = camera ? (Array.isArray(camera) ? camera[0]?.getScene() : camera.getScene()) : undefined;
      const previousCamera = scene?.activeCamera;
      const previousCameras = scene?.activeCameras;
      const previousView = this.activeView;
      if (direct) direct.inStep = true;
      const startSize = { width: source.width, height: source.height };
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
          // A resize reallocates (clears) the default framebuffer even when nothing draws.
          const wrote = source.width !== startSize.width || source.height !== startSize.height || host.dirty?.() !== false;
          const coherent = host.canCopy();
          const started = performance.now();
          if (coherent && direct.store.snapshot(current, source.width, source.height)) {
            // The view canvas keeps the presented image's dimensions; it is drawn into only when it stops being covered.
            if (canvas.width !== source.width) canvas.width = source.width;
            if (canvas.height !== source.height) canvas.height = source.height;
            show(current);
            host.copied(performance.now() - started);
            return true;
          }
          if (!coherent) {
            if (!wrote && direct.placement.view === current) {
              // An idle step (render on demand): the shown image is still the held one.
              direct.placement.follow();
            } else if (direct.store.restore(current, source.width, source.height)) {
              // An incoherent frame: put the last coherent image back before the browser presents.
              show(current);
            } else {
              // Nothing coherent yet: let the view canvas show through.
              stopCovering(current, false);
            }
            return true;
          }
          // A coherent frame the store could not present (WebGPU turned it off while the frame drew, so the
          // frame is in the canvas): copy it into the view canvas rather than showing the stale held image.
          leaveDirect();
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
      direct.placement.vacate();
      direct.store.clear(true);
      direct.active = false;
    }) : null;
    owner = { views, direct, release: () => {
      if (direct) {
        leaveDirect();
        direct.placement.park();
        direct.store.clear();
        direct.store.dispose?.();
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
      // Untrack even an uncovered view: a stale entry would keep this Engine alive.
      trackDirectViewTarget(released.target, null);
      if (direct.placement.view === released) direct.placement.park();
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
