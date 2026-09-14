import type { AbstractEngine, EngineView } from "@babylonjs/core";

type Admission = { requestedEnabled: boolean; held: boolean };
const admissions = new WeakMap<EngineView, Admission>();
const offscreenDispatch = new WeakMap<AbstractEngine, { clients: number; release: () => void }>();

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
export function admitRegisteredViewFrames(engine: AbstractEngine, view: EngineView, canRender: () => boolean): () => void {
  if (admissions.has(view)) throw new Error("Registered view already has a frame owner.");
  const admission: Admission = { requestedEnabled: view.enabled, held: false };
  admissions.set(view, admission);
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
    admissions.delete(view);
  };
}
