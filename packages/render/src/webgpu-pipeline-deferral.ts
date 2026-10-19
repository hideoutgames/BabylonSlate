import type { AbstractEngine } from "@babylonjs/core";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";

/**
 * A deferring view that has held its image this long starts no more
 * deferrals: later misses compile synchronously, as without deferral, so a
 * view whose pipelines keep changing still presents.
 */
export const PIPELINE_DEFERRAL_HOLD_CAP_MS = 2_000;
/**
 * No deferred pipeline finished for this long: every pending one compiles
 * synchronously at its next draw (a stuck asynchronous compile never holds a
 * view for good). WebKit builds pipelines one after another (about a second
 * each), so this bounds the time between completions, not their total.
 */
export const PIPELINE_DEFERRAL_STALL_MS = 10_000;

/** A pipeline-cache tree node (Babylon 9.29 `WebGPUCacheRenderPipelineTree` NodeState). */
type CacheNode = { pipeline?: GPURenderPipeline };

type PipelineCache = {
  disabled: boolean;
  _parameter: { token: CacheNode | undefined };
  _createRenderPipeline(effect: unknown, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipeline;
  _buildRenderPipelineDescriptor(effect: unknown, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
};

type DrawEngine = {
  _draw(drawType: number, fillMode: number, start: number, count: number, instancesCount: number): void;
  _cacheRenderPipeline: PipelineCache;
  _device: GPUDevice;
  _snapshotRendering: { record: boolean };
  currentRenderPassId: number;
};

type Scope = {
  allows: (renderPassId: number) => boolean;
  startsDeferrals: boolean;
  skipped: number;
  /** The pending pipelines its skipped draws wait for. */
  nodes: Set<CacheNode>;
};

type DeferralState = {
  scopes: Scope[];
  pending: Set<CacheNode>;
  /** Nodes whose asynchronous creation failed or stalled: their draws compile synchronously. */
  synchronous: WeakSet<CacheNode>;
  /** When a deferral last started or finished. */
  progressAt: number;
};

/** Thrown out of the pipeline cache to skip the draw that missed it. */
const DEFERRED = Symbol("deferred render pipeline");
const states = new WeakMap<AbstractEngine, DeferralState>();

function install(engine: AbstractEngine): DeferralState {
  const target = engine as unknown as DrawEngine;
  const cache = target._cacheRenderPipeline;
  const draw = target._draw;
  const create = cache?._createRenderPipeline;
  if (typeof draw !== "function" || typeof create !== "function" || typeof cache._buildRenderPipelineDescriptor !== "function")
    throw new Error("Unsupported Babylon WebGPU pipeline cache layout: _draw, _createRenderPipeline or _buildRenderPipelineDescriptor is missing.");
  const state: DeferralState = { scopes: [], pending: new Set(), synchronous: new WeakSet(), progressAt: 0 };
  // Babylon 9.29 calls `_createRenderPipeline` from `getRenderPipeline` only on
  // a cache miss, after the lookup left the missing tree node in
  // `_parameter.token`, and `_draw` changes no state between that call and its
  // draw. Throwing there skips the draw and leaves the node empty.
  cache._createRenderPipeline = function (this: PipelineCache, effect, topology, sampleCount) {
    const node = this._parameter.token;
    const scopes = state.scopes;
    if (!scopes.length || this.disabled || !node || target._snapshotRendering.record || state.synchronous.has(node))
      return create.call(this, effect, topology, sampleCount);
    const pass = target.currentRenderPassId;
    let scope: Scope | undefined;
    for (let index = scopes.length - 1; index >= 0 && !scope; index -= 1)
      if (scopes[index]!.allows(pass)) scope = scopes[index];
    if (!scope) return create.call(this, effect, topology, sampleCount);
    const now = performance.now();
    if (state.pending.has(node)) {
      if (now - state.progressAt < PIPELINE_DEFERRAL_STALL_MS) {
        scope.skipped += 1;
        scope.nodes.add(node);
        throw DEFERRED;
      }
      for (const stalled of state.pending) state.synchronous.add(stalled);
      state.pending.clear();
      return create.call(this, effect, topology, sampleCount);
    }
    if (!scopes.every((open) => open.startsDeferrals)) return create.call(this, effect, topology, sampleCount);
    const descriptor = this._buildRenderPipelineDescriptor(effect, topology, sampleCount);
    state.pending.add(node);
    state.progressAt = now;
    target._device.createRenderPipelineAsync(descriptor).then((pipeline) => {
      state.progressAt = performance.now();
      if (!state.pending.delete(node)) return;
      node.pipeline = pipeline;
      WebGPUCacheRenderPipeline.NumCacheMiss++;
    }, () => {
      state.progressAt = performance.now();
      // The draw creates it synchronously and reports the error the usual way.
      if (state.pending.delete(node)) state.synchronous.add(node);
    });
    scope.skipped += 1;
    scope.nodes.add(node);
    throw DEFERRED;
  };
  target._draw = function (this: DrawEngine, ...args) {
    try {
      draw.apply(this, args);
    } catch (error) {
      if (error !== DEFERRED) throw error;
    }
  };
  engine.onDisposeObservable.addOnce(() => {
    cache._createRenderPipeline = create;
    target._draw = draw;
    states.delete(engine);
  });
  return state;
}

export type PipelineDeferral = {
  /** Ends the scope; returns the draws it skipped, its nested scopes' included. */
  close(): number;
  /**
   * Whether a pipeline a skipped draw needs is still being created (false once
   * deferred creation stalled: the next draw compiles it synchronously).
   */
  waiting(): boolean;
};

/**
 * WebGPU only. While open, a draw in a render pass `allows` accepts whose
 * render pipeline is not cached starts creating it with
 * `createRenderPipelineAsync` and is skipped, instead of creating it
 * synchronously (the renderer would then wait for the GPU process to compile
 * it, about 200 ms per pipeline on D3D12). A later draw of the same state skips
 * too until the pipeline exists. The owner must not present output that skipped
 * a draw. Scopes nest: a draw belongs to the innermost scope that allows its
 * pass, and a closed scope's skips count in its parent. `startsDeferrals: false`
 * still skips draws whose pipeline is already pending but compiles any other
 * miss synchronously. Only for output that is drawn again every frame, never
 * for a render-once target or a capture that is read back.
 */
export function beginPipelineDeferral(
  engine: AbstractEngine,
  allows: (renderPassId: number) => boolean,
  startsDeferrals = true,
): PipelineDeferral | undefined {
  if (!engine.isWebGPU) return undefined;
  const state = states.get(engine) ?? install(engine);
  states.set(engine, state);
  const scopes = state.scopes;
  const scope: Scope = { allows, startsDeferrals, skipped: 0, nodes: new Set() };
  scopes.push(scope);
  let closed = false;
  return {
    close: () => {
      if (closed) return scope.skipped;
      closed = true;
      const index = scopes.lastIndexOf(scope);
      if (index >= 0) scopes.splice(index, 1);
      const parent = scopes[index - 1];
      if (parent) {
        parent.skipped += scope.skipped;
        for (const node of scope.nodes) parent.nodes.add(node);
      }
      return scope.skipped;
    },
    waiting: () => {
      if (performance.now() - state.progressAt >= PIPELINE_DEFERRAL_STALL_MS) return false;
      for (const node of scope.nodes) if (state.pending.has(node)) return true;
      return false;
    },
  };
}

/** Render pipelines still being created for skipped draws on `engine`. */
export function deferredPipelineCount(engine: AbstractEngine): number {
  return states.get(engine)?.pending.size ?? 0;
}
