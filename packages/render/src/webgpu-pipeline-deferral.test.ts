import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";
import {
  beginPipelineDeferral,
  deferredPipelineCount,
  PIPELINE_DEFERRAL_STALL_MS,
} from "./webgpu-pipeline-deferral";

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
    const frame = beginPipelineDeferral(engine, objectPass)!;
    draw(7);
    draw(7);
    expect(frame.close()).toBe(2);
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
    const capped = beginPipelineDeferral(engine, objectPass, false)!;
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

  it("does nothing on WebGL", () => {
    const engine = { isWebGPU: false } as never;
    expect(beginPipelineDeferral(engine, objectPass)).toBeUndefined();
  });
});
