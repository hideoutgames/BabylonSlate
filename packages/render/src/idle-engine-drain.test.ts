import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { drainEngineAfterRelease } from "./idle-engine-drain";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A shared Engine whose last client stopped; the test delivers each animation frame. */
function idleEngine() {
  const engine = new NullEngine();
  engines.push(engine);
  let next: FrameRequestCallback | null = null;
  engine.customAnimationFrameRequester = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { next = callback; return 1; },
    cancelAnimationFrame: () => { next = null; },
  };
  const frame = () => {
    const callback = next;
    next = null;
    callback?.(performance.now());
  };
  return { engine, frame };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("drainEngineAfterRelease", () => {
  it("keeps end frames coming until the release settles and its deferred end-frame work has run", async () => {
    const { engine, frame } = idleEngine();
    const release = deferred();
    drainEngineAfterRelease(engine, release.promise);
    expect(engine.activeRenderLoops).toHaveLength(1);
    frame();
    frame();
    expect(engine.activeRenderLoops).toHaveLength(1);

    release.resolve();
    await release.promise;
    // Babylon's deferred native work, queued by the release itself.
    const deferredWork = vi.fn();
    engine.onEndFrameObservable.addOnce(deferredWork);
    for (let i = 0; i < 3; i++) frame();

    expect(deferredWork).toHaveBeenCalledOnce();
    expect(engine.activeRenderLoops).toHaveLength(0);
  });

  it("stops at its deadline when the release never settles", () => {
    vi.useFakeTimers();
    const { engine } = idleEngine();
    drainEngineAfterRelease(engine, new Promise(() => {}));

    vi.advanceTimersByTime(5_000);

    expect(engine.activeRenderLoops).toHaveLength(0);
  });

  it("stops when the release is rejected or the Engine is disposed", async () => {
    const rejected = idleEngine();
    const failure = Promise.reject(new Error("quarantined"));
    drainEngineAfterRelease(rejected.engine, failure);
    await failure.catch(() => {});
    expect(rejected.engine.activeRenderLoops).toHaveLength(0);

    const disposed = idleEngine();
    drainEngineAfterRelease(disposed.engine, new Promise(() => {}));
    disposed.engine.dispose();
    expect(disposed.engine.activeRenderLoops).toHaveLength(0);
  });
});
