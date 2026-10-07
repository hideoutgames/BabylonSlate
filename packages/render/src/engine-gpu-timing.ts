import { EngineInstrumentation, type AbstractEngine } from "@babylonjs/core";

export type EngineGpuTimingSample = {
  /** Host delivery time, not the originating GPU frame's timestamp. */
  observedAtMs: number;
  durationMs: number;
  querySequence: number;
  coalescedQueries: number;
  attribution: "engine-aggregate";
};
export type EngineGpuTimingObservation = {
  status: "unpaired" | "unavailable";
  reason?: string;
  release(): void;
};
export type EngineGpuTimingLease = { release(): void };
type Owner = {
  instrument: EngineInstrumentation;
  priorCapture: boolean;
  leases: number;
  disposed: boolean;
  detach(): void;
};
const owners = new WeakMap<AbstractEngine, Owner>();

export function engineGpuTimingUnavailableReason(engine: AbstractEngine): string | null {
  if (engine.isWebGPU) return "Babylon 9.20.0 cannot provide valid whole-frame WebGPU timestamps on this path.";
  if (!engine.getCaps().timerQuery) return "The active graphics context does not support GPU timer queries.";
  if (engine.isDisposed) return "The graphics engine has been disposed.";
  return null;
}

/** Known renderer and profiler owners share one capture switch. */
export function acquireEngineGpuTiming(engine: AbstractEngine): EngineGpuTimingLease | null {
  if (engineGpuTimingUnavailableReason(engine)) return null;
  let owner = owners.get(engine);
  if (!owner) {
    // Pinned Babylon 9.20.0 has no public Engine getter for this switch. Read
    // this one version-verified flag; all changes use the public capture API.
    const priorCapture = (engine as AbstractEngine & { _captureGPUFrameTime?: boolean })._captureGPUFrameTime === true;
    const instrument = new EngineInstrumentation(engine);
    owner = { instrument, priorCapture, leases: 0, disposed: false, detach: () => {} };
    try { instrument.captureGPUFrameTime = true; }
    catch (error) {
      try { engine.captureGPUFrameTime(priorCapture); }
      finally { instrument.dispose(); }
      throw error;
    }
    owners.set(engine, owner);
    const owned = owner;
    const disposal = engine.onDisposeObservable.addOnce(() => {
      owned.disposed = true;
      owners.delete(engine);
      owned.instrument.dispose();
    });
    owner.detach = () => { engine.onDisposeObservable.remove(disposal); };
  }
  const owned = owner;
  owned.leases++;
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    if (--owned.leases || owned.disposed) return;
    owners.delete(engine);
    owned.detach();
    // Instrumentation.dispose() does not disable engine capture in 9.20.0.
    // A pending native token remains engine-owned; a later collector skips its
    // first ready result instead of disposing another owner's query privately.
    try { engine.captureGPUFrameTime(owned.priorCapture); }
    finally { owned.instrument.dispose(); }
  } };
}

/** Existing lightweight Stats may read an enabled owner's counter, never arm it. */
export function readEngineGpuTiming(engine: AbstractEngine): number | null {
  if (engineGpuTimingUnavailableReason(engine)) return null;
  const active = owners.has(engine) || (engine as AbstractEngine & { _captureGPUFrameTime?: boolean })._captureGPUFrameTime === true;
  if (!active) return null;
  const counter = engine.getGPUFrameTimeCounter();
  return counter.count > 0 && Number.isFinite(counter.current) && counter.current >= 0 ? counter.current / 1_000_000 : null;
}

/** Explicit collection only. Delayed queries cannot be paired to render frames
 * with this pinned API, and shared-engine work cannot be attributed to a view. */
export function observeEngineGpuTiming(
  engine: AbstractEngine,
  consume: (sample: EngineGpuTimingSample) => void,
  options: { now?: () => number; onError?: (error: unknown) => void } = {},
): EngineGpuTimingObservation {
  const unavailable = engineGpuTimingUnavailableReason(engine);
  if (unavailable) return { status: "unavailable", reason: unavailable, release() {} };
  let lease: EngineGpuTimingLease | null;
  try { lease = acquireEngineGpuTiming(engine); }
  catch (error) { return { status: "unavailable", reason: `GPU timing could not start: ${String(error)}`, release() {} }; }
  if (!lease) return { status: "unavailable", reason: "GPU timing is unavailable.", release() {} };
  const now = options.now ?? (() => performance.now());
  let count = engine.getGPUFrameTimeCounter().count;
  let discardFirst = true;
  let lost = false;
  let released = false;
  const frame = engine.onEndFrameObservable.add(() => {
    if (released || lost) return;
    const counter = engine.getGPUFrameTimeCounter();
    if (counter.count < count) { count = counter.count; discardFirst = true; return; }
    if (counter.count === count) return; // Pending, unsupported or disjoint query.
    const coalescedQueries = counter.count - count - 1;
    count = counter.count;
    if (discardFirst) { discardFirst = false; return; }
    if (!Number.isFinite(counter.current) || counter.current < 0) return;
    try { consume({ observedAtMs: now(), durationMs: counter.current / 1_000_000, querySequence: count,
      coalescedQueries, attribution: "engine-aggregate" }); }
    catch (error) { release(); options.onError?.(error); }
  });
  const contextLost = engine.onContextLostObservable.add(() => { lost = true; discardFirst = true; });
  const contextRestored = engine.onContextRestoredObservable.add(() => {
    lost = false;
    count = engine.getGPUFrameTimeCounter().count;
    discardFirst = true;
  });
  const disposal = engine.onDisposeObservable.addOnce(() => release());
  function release() {
    if (released) return;
    released = true;
    engine.onEndFrameObservable.remove(frame);
    engine.onContextLostObservable.remove(contextLost);
    engine.onContextRestoredObservable.remove(contextRestored);
    engine.onDisposeObservable.remove(disposal);
    lease?.release();
  }
  return { status: "unpaired", release };
}
