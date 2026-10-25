import { vi } from "vitest";
import { Observable } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";

type Pipeline = { label: string };

/**
 * Prototype-level WebGPUEngine (its constructor needs a real device) whose
 * pipeline cache is Babylon's own tree, so every lookup, miss and stored
 * pipeline goes through Babylon 9.29's `getRenderPipeline`. The GPU device and
 * the descriptor builder are the seams; `_draw` stands in for Babylon's: it
 * asks the cache for its pipeline, then records the draw. Its frame id
 * (`engine.frameId`) is `_frameId`. Reset Babylon's static cache
 * (`WebGPUCacheRenderPipelineTree.ResetCache`) before each test.
 */
export function webGpuEngine() {
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
    _frameId: 0,
    currentRenderPassId: 0,
    onDisposeObservable: new Observable(),
    _draw(this: { _cacheRenderPipeline: WebGPUCacheRenderPipelineTree }, effectId: number) {
      const effect = { uniqueId: effectId, _pipelineContext: { shaderProcessingContext: { attributeNamesFromEffect: [], attributeLocationsFromEffect: [] } } };
      drawn.push(this._cacheRenderPipeline.getRenderPipeline(0, effect as never, 1, 0));
    },
  }) as WebGPUEngine & { currentRenderPassId: number; _frameId: number };
  const draw = (effectId: number, pass = 1) => {
    engine.currentRenderPassId = pass;
    (engine as unknown as { _draw(effectId: number): void })._draw(effectId);
  };
  return { engine, device, drawn, draw, resolve: (pipeline: Pipeline) => resolveAsync(pipeline), reject: (error: Error) => rejectAsync(error) };
}
