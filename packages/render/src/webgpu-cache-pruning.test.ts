import { beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheBindGroups } from "@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";
import { pruneReleasedWebGpuCacheEntries, webGpuCacheCounts } from "./webgpu-cache-pruning";

type FakeBuffer = { uniqueId: number; references: number };
type FakeTexture = { uniqueId: number; _hardwareTexture: { view: object } };

/**
 * Prototype-level WebGPUEngine (its constructor needs a real device). Babylon's
 * own release methods and both global caches run unchanged; the GPU device and
 * buffer manager are the seams.
 */
function webGpuEngine() {
  const bufferManager = {
    releaseBuffer: (buffer: FakeBuffer) => --buffer.references === 0,
  };
  const textureHelper = { releaseTexture: () => {} };
  return Object.assign(Object.create(WebGPUEngine.prototype), {
    _bufferManager: bufferManager,
    _textureHelper: textureHelper,
    _internalTexturesCache: [],
    _compiledEffects: {} as Record<string, unknown>,
    onEndFrameObservable: new Observable(),
  }) as WebGPUEngine;
}

const device = { createBindGroup: vi.fn(() => ({})), limits: {} };

/** One draw of a shader with a Scene and a Mesh uniform block and one texture, through Babylon's bind-group cache. */
function bindGroupsFor(cache: WebGPUCacheBindGroups, scene: FakeBuffer, mesh: FakeBuffer, texture: FakeTexture) {
  const entry = () => [{ binding: 0, resource: {} }, { binding: 1, resource: {} }, { binding: 2 }];
  const pipelineContext = {
    shaderProcessingContext: {
      bufferNames: ["Scene", "Mesh"], samplerNames: [], textureNames: ["albedo"],
      bindGroupLayoutEntries: [[{ binding: 0, buffer: {} }, { binding: 1, buffer: {} }, { binding: 2, texture: {} }]],
      bindGroupEntries: [entry()],
      bindGroupLayoutEntryInfo: [{ 0: { name: "Scene" }, 1: { name: "Mesh" }, 2: { name: "albedo" } }],
    },
    bindGroupLayouts: { 0: [{}] },
  };
  const drawContext = { buffers: { Scene: scene, Mesh: mesh }, isDirty: () => true, resetIsDirty() {}, bindGroups: undefined };
  const materialContext = { textures: { albedo: { texture } }, samplers: {}, updateId: 0, isDirty: true, forceBindGroupCreation: false, textureState: 0 };
  return cache.getBindGroups(pipelineContext as never, drawContext as never, materialContext as never);
}

/** Cache one render pipeline for an attribute-less Effect through Babylon's own state lookup. */
function cachePipelineFor(tree: WebGPUCacheRenderPipelineTree, effectId: number) {
  const lookup = tree as unknown as {
    _lookupRenderPipeline(fillMode: number, effect: unknown, sampleCount: number, textureState: number): unknown;
    _setRenderPipeline(param: unknown): void;
    _parameter: { pipeline: unknown };
  };
  const effect = { uniqueId: effectId, _pipelineContext: { shaderProcessingContext: { attributeNamesFromEffect: [], attributeLocationsFromEffect: [] } } };
  expect(lookup._lookupRenderPipeline(0, effect, 1, 0)).toBeNull();
  lookup._parameter.pipeline = { effectId };
  lookup._setRenderPipeline(lookup._parameter);
}

describe("pruneReleasedWebGpuCacheEntries", () => {
  beforeEach(() => {
    WebGPUCacheBindGroups.ResetCache();
    WebGPUCacheRenderPipelineTree.ResetCache();
    device.createBindGroup.mockClear();
  });

  it("drops bind groups of released buffers and textures and keeps live ones cached", () => {
    const engine = webGpuEngine();
    const prune = pruneReleasedWebGpuCacheEntries(engine);
    const cache = new WebGPUCacheBindGroups(device as never, {} as never, engine);
    const scene = { uniqueId: 1, references: 1 };
    const closedMesh = { uniqueId: 2, references: 1 };
    const liveMesh = { uniqueId: 3, references: 1 };
    const closedTexture = { uniqueId: 40, _hardwareTexture: { view: {} } };
    const liveTexture = { uniqueId: 41, _hardwareTexture: { view: {} } };
    bindGroupsFor(cache, scene, closedMesh, liveTexture);
    bindGroupsFor(cache, scene, liveMesh, closedTexture);
    const live = bindGroupsFor(cache, scene, liveMesh, liveTexture);
    expect(webGpuCacheCounts().bindGroups).toBe(3);

    engine._releaseBuffer(closedMesh as never);
    engine._releaseTexture(closedTexture as never);
    expect(prune().bindGroups).toBe(2);

    expect(webGpuCacheCounts().bindGroups).toBe(1);
    device.createBindGroup.mockClear();
    expect(bindGroupsFor(cache, scene, liveMesh, liveTexture)).toBe(live);
    expect(device.createBindGroup).not.toHaveBeenCalled();
  });

  it("keeps a buffer's bind groups while another owner still references it", () => {
    const engine = webGpuEngine();
    const prune = pruneReleasedWebGpuCacheEntries(engine);
    const cache = new WebGPUCacheBindGroups(device as never, {} as never, engine);
    const shared = { uniqueId: 5, references: 2 };
    bindGroupsFor(cache, shared, { uniqueId: 6, references: 1 }, { uniqueId: 42, _hardwareTexture: { view: {} } });

    engine._releaseBuffer(shared as never);
    prune();

    expect(webGpuCacheCounts().bindGroups).toBe(1);
  });

  it("drops render pipelines of released Effects only", () => {
    const engine = webGpuEngine();
    const prune = pruneReleasedWebGpuCacheEntries(engine);
    const tree = new WebGPUCacheRenderPipelineTree({ limits: {} } as never, {} as never);
    cachePipelineFor(tree, 101);
    cachePipelineFor(tree, 102);
    const released = { uniqueId: 101, _key: "released", getPipelineContext: () => null };
    (engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects.released = released;

    engine._releaseEffect(released as never);
    expect(prune().pipelines).toBe(1);

    expect(webGpuCacheCounts().pipelines).toBe(1);
    expect(WebGPUCacheRenderPipelineTree.GetPipelines().map((path) => path[11])).toEqual([102]);
  });

  it("prunes at a frame end once releases accumulate", () => {
    const engine = webGpuEngine();
    pruneReleasedWebGpuCacheEntries(engine);
    const cache = new WebGPUCacheBindGroups(device as never, {} as never, engine);
    const scene = { uniqueId: 1, references: 1 };
    const texture = { uniqueId: 43, _hardwareTexture: { view: {} } };
    const meshes = Array.from({ length: 300 }, (_, index) => ({ uniqueId: 1000 + index, references: 1 }));
    for (const mesh of meshes) bindGroupsFor(cache, scene, mesh, texture);

    for (const mesh of meshes) engine._releaseBuffer(mesh as never);
    engine.onEndFrameObservable.notifyObservers(engine);

    expect(webGpuCacheCounts().bindGroups).toBe(0);
  });
});
