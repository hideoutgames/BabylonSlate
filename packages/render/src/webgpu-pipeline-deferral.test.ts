import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import {
  beginPipelineDeferral,
  capturePipelineTarget,
  deferredPipelineCount,
  deferredPipelinesStalled,
  drawsInPass,
  PIPELINE_DEFERRAL_STALL_MS,
} from "./webgpu-pipeline-deferral";
import { DriverCompileWatch } from "./driver-compile";
import { webGpuEngine } from "./webgpu-test-fixtures";

const objectPass = (pass: number) => pass === 1;
/** Lets the device's settled promise reach the deferral. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("beginPipelineDeferral", () => {
  beforeEach(() => WebGPUCacheRenderPipelineTree.ResetCache());
  afterEach(() => vi.restoreAllMocks());

  it("skips a draw whose pipeline is missing, creates it once asynchronously and draws with it once it exists", async () => {
    const { engine, device, drawn, draw, resolve } = webGpuEngine();
    const misses = WebGPUCacheRenderPipeline.NumCacheMiss;
    const frame = beginPipelineDeferral(engine, objectPass)!;
    draw(7);
    draw(7);
    expect(frame.close()).toBe(2);
    // One miss, counted in the frame that skipped it, as Babylon counts a synchronous creation.
    expect(WebGPUCacheRenderPipeline.NumCacheMiss).toBe(misses + 1);
    expect(drawn).toEqual([]);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    expect(frame.waiting()).toBe(true);
    expect(deferredPipelineCount(engine)).toBe(1);
    const pipeline = { label: "async" };
    resolve(pipeline);
    await settle();
    expect(frame.waiting()).toBe(false);
    const next = beginPipelineDeferral(engine, objectPass)!;
    draw(7);
    expect(next.close()).toBe(0);
    expect(drawn).toEqual([pipeline]);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    expect(WebGPUCacheRenderPipeline.NumCacheMiss).toBe(misses + 1);
  });

  it("renews loading waits while deferred pipelines finish, and only then", async () => {
    const { engine, draw, resolve } = webGpuEngine();
    const watch = new DriverCompileWatch(engine);
    const frame = beginPipelineDeferral(engine, objectPass)!;
    draw(7);
    frame.close();
    // Pending alone is no progress: WebGPU reports none until a pipeline exists.
    expect(watch.renew()).toBe(false);
    resolve({ label: "async" });
    await settle();
    expect(watch.renew()).toBe(true);
    expect(watch.renew()).toBe(false);
  });

  it("opens a nested scope only inside an open one", () => {
    const { engine, device, draw } = webGpuEngine();
    expect(beginPipelineDeferral(engine, objectPass, { nested: true })).toBeUndefined();
    // Without an enclosing deferring view, a capture's miss compiles synchronously.
    draw(3);
    expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
    const view = beginPipelineDeferral(engine, () => false)!;
    const capture = beginPipelineDeferral(engine, objectPass, { nested: true })!;
    draw(4);
    expect(capture.close()).toBe(1);
    expect(view.close()).toBe(1);
  });

  it("creates pipelines synchronously outside a scope and in passes no open scope admits", () => {
    const { engine, device, drawn, draw } = webGpuEngine();
    draw(1);
    const frame = beginPipelineDeferral(engine, objectPass)!;
    // A shadow map, for example, may draw only once.
    draw(2, 5);
    expect(frame.close()).toBe(0);
    expect(drawn).toHaveLength(2);
    expect(device.createRenderPipeline).toHaveBeenCalledTimes(2);
    expect(device.createRenderPipelineAsync).not.toHaveBeenCalled();
  });

  it("counts a nested scope's skipped draws in the enclosing one, which waits for them too", () => {
    const { engine, draw } = webGpuEngine();
    const view = beginPipelineDeferral(engine, objectPass)!;
    const capture = beginPipelineDeferral(engine, (pass) => pass === 3)!;
    draw(4, 3);
    expect(capture.close()).toBe(1);
    expect(view.close()).toBe(1);
    expect(view.waiting()).toBe(true);
  });

  it("keeps skipping a pending pipeline but compiles new misses synchronously once a scope starts no deferrals", () => {
    const { engine, device, drawn, draw } = webGpuEngine();
    const first = beginPipelineDeferral(engine, objectPass)!;
    draw(1);
    first.close();
    const capped = beginPipelineDeferral(engine, objectPass, { startsDeferrals: false })!;
    draw(1);
    draw(2);
    expect(capped.close()).toBe(1);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    expect(drawn).toEqual([{ label: "sync" }]);
  });

  it("compiles synchronously when asynchronous creation fails or stops making progress", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { engine, device, drawn, draw, reject } = webGpuEngine();
    const failed = beginPipelineDeferral(engine, objectPass)!;
    draw(1);
    failed.close();
    reject(new Error("invalid pipeline"));
    await settle();
    const retry = beginPipelineDeferral(engine, objectPass)!;
    draw(1);
    expect(retry.close()).toBe(0);
    expect(drawn).toEqual([{ label: "sync" }]);

    const stalled = beginPipelineDeferral(engine, objectPass)!;
    draw(2);
    stalled.close();
    expect(stalled.waiting()).toBe(true);
    now += PIPELINE_DEFERRAL_STALL_MS;
    expect(stalled.waiting()).toBe(false);
    const after = beginPipelineDeferral(engine, objectPass)!;
    draw(2);
    expect(after.close()).toBe(0);
    expect(drawn).toHaveLength(2);
    expect(device.createRenderPipeline).toHaveBeenCalledTimes(2);
  });

  /** An engine whose geometry pass (2) already has a pipeline for effect 5 (created outside any scope), as a drawn floor does. */
  function withFloor() {
    const fixture = webGpuEngine();
    fixture.draw(5, 2);
    fixture.device.createRenderPipeline.mockClear();
    fixture.drawn.length = 0;
    return fixture;
  }
  const geometryPass = 2;
  const admitted = (pass: number) => pass === 1 || pass === geometryPass;
  const omits = (pass: number) => pass === geometryPass;

  it("leaves a draw out of an omitted pass without counting it, starts its pipeline past the hold cap and draws once it exists", async () => {
    const { engine, device, drawn, draw, resolve } = withFloor();
    const first = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(5, geometryPass);
    draw(7, geometryPass);
    // The object pass's miss in the same scope still holds the frame.
    draw(8, 1);
    expect(first.close()).toBe(1);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
    // Past the view's hold cap its own misses compile synchronously; an omitted one still defers.
    const capped = beginPipelineDeferral(engine, admitted, { startsDeferrals: false, omits })!;
    draw(5, geometryPass);
    draw(7, geometryPass);
    draw(9, geometryPass);
    expect(capped.close()).toBe(0);
    expect(capped.waiting()).toBe(false);
    expect(drawn).toEqual([{ label: "sync" }, { label: "sync" }]);
    expect(drawsInPass(engine, geometryPass)).toBe(2);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(3);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    const pipeline = { label: "async" };
    resolve(pipeline);
    await settle();
    const next = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(9, geometryPass);
    expect(next.close()).toBe(0);
    expect(drawn.at(-1)).toBe(pipeline);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
  });

  it("holds for an omitted pass whose every draw was left out, so its output is never presented empty", async () => {
    const { engine, draw, resolve } = withFloor();
    const frame = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(7, geometryPass);
    expect(frame.close()).toBe(1);
    expect(frame.waiting()).toBe(true);
    resolve({ label: "async" });
    await settle();
    expect(frame.waiting()).toBe(false);
  });

  it("draws an omitted pass's draw with a synchronous pipeline once deferred creation stalls", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { engine, device, drawn, draw } = withFloor();
    const frame = beginPipelineDeferral(engine, omits, { omits })!;
    draw(5, geometryPass);
    draw(4, geometryPass);
    expect(frame.close()).toBe(0);
    now += PIPELINE_DEFERRAL_STALL_MS - 1;
    const early = beginPipelineDeferral(engine, omits, { omits })!;
    draw(4, geometryPass);
    draw(5, geometryPass);
    early.close();
    expect(drawn).toHaveLength(2);
    now += 1;
    const stalled = beginPipelineDeferral(engine, omits, { omits })!;
    draw(4, geometryPass);
    expect(stalled.close()).toBe(0);
    expect(drawn).toHaveLength(3);
    expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
  });

  it("gives up a left-out draw's own creation after the stall time while other creations keep the Engine progressing", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { engine, device, draw } = withFloor();
    const frame = (...draws: [number, number][]) => {
      const scope = beginPipelineDeferral(engine, admitted, { omits })!;
      draw(5, geometryPass);
      for (const [effect, pass] of draws) draw(effect, pass);
      scope.close();
    };
    frame([4, geometryPass]);
    // Another view's miss starts a creation later, so the Engine-wide stall is not reached when the first one's is.
    now += PIPELINE_DEFERRAL_STALL_MS / 2;
    frame([9, 1]);
    now += PIPELINE_DEFERRAL_STALL_MS / 2 - 1;
    frame([4, geometryPass]);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    now += 1;
    frame([4, geometryPass]);
    expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
    // The other creation still waits on its own.
    expect(deferredPipelineCount(engine)).toBe(1);
  });

  it("past the hold cap compiles a miss synchronously in an omitted pass that has drawn nothing yet, which would hold", () => {
    const { engine, device, drawn, draw } = withFloor();
    const capped = beginPipelineDeferral(engine, admitted, { startsDeferrals: false, omits })!;
    draw(7, geometryPass);
    expect({ skipped: capped.close(), waiting: capped.waiting(), drawn: drawn.length })
      .toEqual({ skipped: 0, waiting: false, drawn: 1 });
    expect(device.createRenderPipelineAsync).not.toHaveBeenCalled();
  });

  it("stops waiting for a left-out draw counted at close after its own stall time, while other creations progress", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { engine, device, draw } = withFloor();
    // The geometry pass draws nothing else: the frame holds for its left-out draw.
    const held = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(7, geometryPass);
    expect(held.close()).toBe(1);
    // Another view's miss starts a creation later, so the Engine-wide stall is not reached when this one's is.
    now += PIPELINE_DEFERRAL_STALL_MS / 2;
    const other = beginPipelineDeferral(engine, objectPass)!;
    draw(9);
    other.close();
    now += PIPELINE_DEFERRAL_STALL_MS / 2 - 1;
    expect(held.waiting()).toBe(true);
    now += 1;
    expect({ held: held.waiting(), other: other.waiting() }).toEqual({ held: false, other: true });
    // The next frame draws it with a synchronous pipeline.
    const next = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(7, geometryPass);
    expect(next.close()).toBe(0);
    expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
  });

  it("warms a pipeline without drawing: a miss starts it asynchronously past the hold cap, a hit is skipped too, and the view counts neither", async () => {
    const { engine, device, drawn, draw, resolve } = webGpuEngine();
    const warmPass = (pass: number) => pass === 9;
    // The view's hold cap is over: its own misses would compile synchronously.
    const view = beginPipelineDeferral(engine, objectPass, { startsDeferrals: false })!;
    const warm = beginPipelineDeferral(engine, warmPass, { warm: true })!;
    draw(7, 9);
    draw(7, 9);
    expect(warm.close()).toBe(2);
    expect(warm.warmed()).toBe(false);
    expect(warm.waiting()).toBe(true);
    expect(view.close()).toBe(0);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    resolve({ label: "async" });
    await settle();
    const again = beginPipelineDeferral(engine, warmPass, { warm: true })!;
    draw(7, 9);
    expect(again.close()).toBe(1);
    expect(again.warmed()).toBe(true);
    // Never drawn, though the pipeline exists; a real draw of the same state finds it.
    expect(drawn).toEqual([]);
    const next = beginPipelineDeferral(engine, (pass) => pass === 9)!;
    draw(7, 9);
    expect(next.close()).toBe(0);
    expect(drawn).toEqual([{ label: "async" }]);
    // A scope that saw no draw warmed nothing.
    expect(beginPipelineDeferral(engine, warmPass, { warm: true })!.warmed()).toBe(false);
  });

  it("never compiles a warm draw's pipeline synchronously, even when its creation stalls", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { engine, device, draw } = webGpuEngine();
    const warmPass = (pass: number) => pass === 9;
    const first = beginPipelineDeferral(engine, warmPass, { warm: true })!;
    draw(3, 9);
    first.close();
    // The stall its waiters stop at: none while a creation started less than the stall time ago.
    now += PIPELINE_DEFERRAL_STALL_MS - 1;
    expect(deferredPipelinesStalled(engine)).toBe(false);
    now += 1;
    expect(deferredPipelinesStalled(engine)).toBe(true);
    const later = beginPipelineDeferral(engine, warmPass, { warm: true })!;
    draw(3, 9);
    later.close();
    expect(later.waiting()).toBe(true);
    expect(later.warmed()).toBe(false);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
    // Another creation starting is progress again.
    const next = beginPipelineDeferral(engine, warmPass, { warm: true })!;
    draw(4, 9);
    next.close();
    expect(deferredPipelinesStalled(engine)).toBe(false);
  });

  it("looks pipelines up in a captured pass's state, creating none and starting no pass, and puts the current state back", async () => {
    const { engine, cache, device, draw, startedPasses, reject } = webGpuEngine();
    const warmPass = (pass: number) => pass === 9;
    // The pass: a half-float target with the depth test on, where effect 7 drew (its pipeline exists) and effect 3's
    // creation failed (its next draw would compile it synchronously).
    cache.setColorFormat("rgba16float");
    engine.depthCullingState.depthTest = true;
    draw(7);
    const failed = beginPipelineDeferral(engine, objectPass)!;
    draw(3);
    failed.close();
    reject(new Error("invalid pipeline"));
    await settle();
    const pass = capturePipelineTarget(engine)!;
    // Ahead of the pass, as a readiness probe finds the Engine: another target format and depth state.
    cache.setColorFormat("bgra8unorm");
    engine.depthCullingState.depthTest = false;
    const probeState = capturePipelineTarget(engine)!;
    device.createRenderPipeline.mockClear();
    device.createRenderPipelineAsync.mockClear();
    startedPasses.mockClear();
    const found = (effect: number, target = pass) => {
      const scope = beginPipelineDeferral(engine, warmPass, { lookup: target })!;
      draw(effect, 9);
      scope.close();
      return scope.warmed();
    };
    expect({
      drawn: found(7), neverDrawn: found(8), failed: found(3), otherState: found(7, probeState),
      synchronous: device.createRenderPipeline.mock.calls.length, asynchronous: device.createRenderPipelineAsync.mock.calls.length,
      passesStarted: startedPasses.mock.calls.length,
      restored: [(cache as unknown as { _webgpuColorFormat: string[] })._webgpuColorFormat[0], engine.depthCullingState.depthTest],
    }).toEqual({
      drawn: true, neverDrawn: false, failed: false, otherState: false, synchronous: 0, asynchronous: 0, passesStarted: 0,
      restored: ["bgra8unorm", false],
    });
    // Outside a lookup a draw asks for its pass as before.
    draw(7);
    expect(startedPasses).toHaveBeenCalledTimes(1);
  });

  it("does nothing on WebGL", () => {
    const engine = { isWebGPU: false } as never;
    expect(beginPipelineDeferral(engine, objectPass)).toBeUndefined();
  });
});
