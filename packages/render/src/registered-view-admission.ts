import type { AbstractEngine, EngineView } from "@babylonjs/core";

type Admission = { requestedEnabled: boolean; held: boolean };
const admissions = new WeakMap<EngineView, Admission>();

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
