import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheBindGroups } from "@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups";
import { drainEngineAfterRelease } from "./idle-engine-drain";
import { pruneReleasedWebGpuCacheEntries, webGpuCacheCounts } from "./webgpu-cache-pruning";

const engines: NullEngine[] = [];
beforeEach(() => WebGPUCacheBindGroups.ResetCache());
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

/**
 * An idle Engine that records its releases the way a WebGPU Engine does, so
 * the drain's cache prune shows on Babylon's real global bind-group cache.
 */
function releasingEngine() {
  const idle = idleEngine();
  Object.assign(idle.engine, { _releaseBuffer: () => true, _releaseTexture: () => {}, _releaseEffect: () => {} });
  const webGpu = idle.engine as unknown as WebGPUEngine;
  pruneReleasedWebGpuCacheEntries(webGpu);
  return { ...idle, webGpu };
}

/** Cache one bind group keyed by `buffer`, through Babylon's own lookup. */
function cacheBindGroupFor(buffer: { uniqueId: number }) {
  const pipelineContext = {
    shaderProcessingContext: {
      bufferNames: ["Scene"], samplerNames: [], textureNames: [],
      bindGroupLayoutEntries: [[{ binding: 0, buffer: {} }]],
      bindGroupEntries: [[{ binding: 0, resource: {} }]],
      bindGroupLayoutEntryInfo: [{ 0: { name: "Scene" } }],
    },
    bindGroupLayouts: { 0: [{}] },
  };
  const drawContext = { buffers: { Scene: buffer }, isDirty: () => true, resetIsDirty() {}, bindGroups: undefined };
  const materialContext = { textures: {}, samplers: {}, updateId: 0, isDirty: true, forceBindGroupCreation: false, textureState: 0 };
  const device = { createBindGroup: () => ({}) };
  new WebGPUCacheBindGroups(device as never, {} as never, {} as never)
    .getBindGroups(pipelineContext as never, drawContext as never, materialContext as never);
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

  it("prunes the cache entries of what the Engine released once the drain ends", async () => {
    const { engine, webGpu, frame } = releasingEngine();
    const closed = { uniqueId: 5 };
    const live = { uniqueId: 6 };
    cacheBindGroupFor(closed);
    cacheBindGroupFor(live);
    const release = deferred();
    drainEngineAfterRelease(engine, release.promise);
    // The Scene's disposal releases its buffer; below the frame-end threshold nothing else prunes it.
    webGpu._releaseBuffer(closed as never);
    expect(webGpuCacheCounts().bindGroups).toBe(2);

    release.resolve();
    await release.promise;
    for (let i = 0; i < 3; i++) frame();

    expect(webGpuCacheCounts().bindGroups).toBe(1);
  });

  it("removes only its own loop, so a client that starts mid-drain keeps rendering", async () => {
    const { engine, frame } = idleEngine();
    const release = deferred();
    drainEngineAfterRelease(engine, release.promise);
    const client = vi.fn();
    engine.runRenderLoop(client);
    frame();

    release.resolve();
    await release.promise;
    for (let i = 0; i < 3; i++) frame();

    expect(engine.activeRenderLoops).toHaveLength(1);
    expect(engine.activeRenderLoops).toContain(client);
    expect(client).toHaveBeenCalledTimes(4);
  });

  it("still gets its settle frames when the release settles just before the deadline", async () => {
    vi.useFakeTimers();
    const { engine, frame } = idleEngine();
    const release = deferred();
    drainEngineAfterRelease(engine, release.promise);

    vi.advanceTimersByTime(4_900);
    release.resolve();
    await release.promise;
    vi.advanceTimersByTime(200);
    expect(engine.activeRenderLoops).toHaveLength(1);
    for (let i = 0; i < 3; i++) frame();

    expect(engine.activeRenderLoops).toHaveLength(0);
  });

  it("stops shortly after the release settles when no frame follows", async () => {
    vi.useFakeTimers();
    const { engine } = idleEngine();
    const release = deferred();
    drainEngineAfterRelease(engine, release.promise);

    release.resolve();
    await release.promise;
    vi.advanceTimersByTime(1_000);

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
