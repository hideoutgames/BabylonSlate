import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import {
  beginPipelineDeferral,
  deferredPipelineCount,
  PIPELINE_DEFERRAL_STALL_MS,
} from "./webgpu-pipeline-deferral";
import { DriverCompileWatch } from "./driver-compile";

type Pipeline = { label: string };

/**
 * Prototype-level WebGPUEngine (its constructor needs a real device) whose
 * pipeline cache is Babylon's own tree, so every lookup, miss and stored
 * pipeline goes through Babylon 9.29's `getRenderPipeline`. The GPU device and
 * the descriptor builder are the seams; `_draw` stands in for Babylon's: it
 * asks the cache for its pipeline, then records the draw.
 */
function webGpuEngine() {
  let resolveAsync!: (pipeline: Pipeline) => void;
  let rejectAsync!: (error: Error) => void;
  const device = {
    limits: {},
    createRenderPipeline: vi.fn(() => ({ label: "sync" })),
    createRenderPipelineAsync: vi.fn(() => new Promise<Pipeline>((resolve, reject) => {
      resolveAsync = resolve;
      rejectAsync = reject;
    })),
  };
  const cache = new WebGPUCacheRenderPipelineTree(device as never, {} as never);
  (cache as unknown as { _buildRenderPipelineDescriptor: () => object })._buildRenderPipelineDescriptor = () => ({});
  const drawn: unknown[] = [];
  const engine = Object.assign(Object.create(WebGPUEngine.prototype), {
    _isWebGPU: true,
    _caps: { parallelShaderCompile: false },
    _compiledEffects: {},
    _device: device,
    _cacheRenderPipeline: cache,
    _snapshotRendering: { play: false, record: false },
    currentRenderPassId: 0,
    onDisposeObservable: new Observable(),
    _draw(this: { _cacheRenderPipeline: WebGPUCacheRenderPipelineTree }, effectId: number) {
      const effect = { uniqueId: effectId, _pipelineContext: { shaderProcessingContext: { attributeNamesFromEffect: [], attributeLocationsFromEffect: [] } } };
      drawn.push(this._cacheRenderPipeline.getRenderPipeline(0, effect as never, 1, 0));
    },
  }) as WebGPUEngine & { currentRenderPassId: number };
  const draw = (effectId: number, pass = 1) => {
    engine.currentRenderPassId = pass;
    (engine as unknown as { _draw(effectId: number): void })._draw(effectId);
  };
  return { engine, device, drawn, draw, resolve: (pipeline: Pipeline) => resolveAsync(pipeline), reject: (error: Error) => rejectAsync(error) };
}

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

  it("leaves a draw out of an omitted pass without counting it, starts its pipeline past the hold cap and draws once it exists", async () => {
    const { engine, device, drawn, draw, resolve } = webGpuEngine();
    const geometryPass = 2;
    const admitted = (pass: number) => pass === 1 || pass === geometryPass;
    const omits = (pass: number) => pass === geometryPass;
    const first = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(7, geometryPass);
    // The object pass's miss in the same scope still holds the frame.
    draw(8, 1);
    expect(first.close()).toBe(1);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
    // Past the view's hold cap its own misses compile synchronously; an omitted one still defers.
    const capped = beginPipelineDeferral(engine, admitted, { startsDeferrals: false, omits })!;
    draw(7, geometryPass);
    draw(9, geometryPass);
    expect(capped.close()).toBe(0);
    expect(capped.waiting()).toBe(false);
    expect(drawn).toEqual([]);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(3);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    const pipeline = { label: "async" };
    resolve(pipeline);
    await settle();
    const next = beginPipelineDeferral(engine, admitted, { omits })!;
    draw(9, geometryPass);
    expect(next.close()).toBe(0);
    expect(drawn).toEqual([pipeline]);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
  });

  it("draws an omitted pass's draw with a synchronous pipeline once deferred creation stalls", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { engine, device, drawn, draw } = webGpuEngine();
    const omits = (pass: number) => pass === 2;
    const frame = beginPipelineDeferral(engine, omits, { omits })!;
    draw(4, 2);
    expect(frame.close()).toBe(0);
    now += PIPELINE_DEFERRAL_STALL_MS - 1;
    const early = beginPipelineDeferral(engine, omits, { omits })!;
    draw(4, 2);
    early.close();
    expect(drawn).toEqual([]);
    now += 1;
    const stalled = beginPipelineDeferral(engine, omits, { omits })!;
    draw(4, 2);
    expect(stalled.close()).toBe(0);
    expect(drawn).toEqual([{ label: "sync" }]);
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
    now += PIPELINE_DEFERRAL_STALL_MS;
    const later = beginPipelineDeferral(engine, warmPass, { warm: true })!;
    draw(3, 9);
    later.close();
    expect(later.waiting()).toBe(true);
    expect(later.warmed()).toBe(false);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(1);
  });

  it("does nothing on WebGL", () => {
    const engine = { isWebGPU: false } as never;
    expect(beginPipelineDeferral(engine, objectPass)).toBeUndefined();
  });
});
