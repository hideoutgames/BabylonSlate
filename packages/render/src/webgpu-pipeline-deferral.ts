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
  getRenderPipeline(fillMode: number, effect: unknown, sampleCount: number, textureState?: number): GPURenderPipeline;
  _createRenderPipeline(effect: unknown, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipeline;
  _buildRenderPipelineDescriptor(effect: unknown, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
};

type DrawEngine = {
  _draw(drawType: number, fillMode: number, start: number, count: number, instancesCount: number): void;
  _currentEffect: object;
  _cacheRenderPipeline: PipelineCache;
  _device: GPUDevice;
  _snapshotRendering: { record: boolean };
  currentRenderPassId: number;
};

type Scope = {
  allows: (renderPassId: number) => boolean;
  startsDeferrals: boolean;
  /** A warm scope (`warm`): skips every draw, starts any missing pipeline asynchronously, never synchronously. */
  warm: boolean;
  skipped: number;
  /** Draws that looked their pipeline up (warm scopes), and those that found it. */
  lookups: number;
  hits: number;
  /** The pending pipelines its skipped draws wait for. */
  nodes: Set<CacheNode>;
  /** Warm scopes: the cache nodes its draws looked up (found or started), each one Effect's pipeline for one state. */
  tokens: Map<CacheNode, object>;
};

type DeferralState = {
  scopes: Scope[];
  pending: Set<CacheNode>;
  /** Nodes whose asynchronous creation failed or stalled: their draws compile synchronously. */
  synchronous: WeakSet<CacheNode>;
  /** When a deferral last started or finished. */
  progressAt: number;
  /** Deferred creations that finished (created or failed) since installation. */
  settled: number;
  /** Effects some draw has drawn with since installation: each has a pipeline for that draw's state. */
  drawn: WeakSet<object>;
};

/** Babylon 9.29 pipeline-cache statistics a synchronous creation updates. */
const statistics = WebGPUCacheRenderPipeline as unknown as { NumCacheMiss: number; _NumPipelineCreationCurrentFrame: number };

/** Thrown out of the pipeline cache to skip the draw that missed it. */
const DEFERRED = Symbol("deferred render pipeline");
const states = new WeakMap<AbstractEngine, DeferralState>();

function install(engine: AbstractEngine): DeferralState {
  const target = engine as unknown as DrawEngine;
  const cache = target._cacheRenderPipeline;
  const draw = target._draw;
  const create = cache?._createRenderPipeline;
  const lookup = cache?.getRenderPipeline;
  if (typeof draw !== "function" || typeof create !== "function" || typeof lookup !== "function" ||
    typeof cache._buildRenderPipelineDescriptor !== "function")
    throw new Error("Unsupported Babylon WebGPU pipeline cache layout: _draw, getRenderPipeline, _createRenderPipeline or _buildRenderPipelineDescriptor is missing.");
  const state: DeferralState = { scopes: [], pending: new Set(), synchronous: new WeakSet(), progressAt: 0, settled: 0, drawn: new WeakSet() };
  /** The innermost open scope that admits the current render pass. */
  const scopeOfPass = (): Scope | undefined => {
    const scopes = state.scopes, pass = target.currentRenderPassId;
    for (let index = scopes.length - 1; index >= 0; index -= 1) if (scopes[index]!.allows(pass)) return scopes[index];
    return undefined;
  };
  /** Starts creating `node`'s pipeline asynchronously; the draw that missed it is skipped. */
  const defer = (pipelines: PipelineCache, node: CacheNode, effect: unknown, topology: GPUPrimitiveTopology, sampleCount: number) => {
    const descriptor = pipelines._buildRenderPipelineDescriptor(effect, topology, sampleCount);
    state.pending.add(node);
    state.progressAt = performance.now();
    // Counted where Babylon counts a synchronous creation: in the frame that
    // missed. A failed or stalled attempt that falls back to a synchronous
    // creation is counted again by Babylon, in the frame that pays for it
    // (the first-frame completion allowance reads each frame's count), so the
    // two creations are not merged.
    statistics.NumCacheMiss++;
    statistics._NumPipelineCreationCurrentFrame++;
    target._device.createRenderPipelineAsync(descriptor).then((pipeline) => {
      state.progressAt = performance.now();
      state.settled += 1;
      if (state.pending.delete(node)) node.pipeline = pipeline;
    }, () => {
      state.progressAt = performance.now();
      state.settled += 1;
      // The draw creates it synchronously and reports the error the usual way.
      if (state.pending.delete(node)) state.synchronous.add(node);
    });
  };
  // Babylon 9.29 calls `_createRenderPipeline` from `getRenderPipeline` only on
  // a cache miss, after the lookup left the missing tree node in
  // `_parameter.token`, and `_draw` changes no state between that call and its
  // draw. Throwing there skips the draw and leaves the node empty.
  cache._createRenderPipeline = function (this: PipelineCache, effect, topology, sampleCount) {
    const node = this._parameter.token;
    const scopes = state.scopes;
    const scope = scopes.length ? scopeOfPass() : undefined;
    if (scope?.warm) {
      // A warm draw never creates a pipeline synchronously: it starts the missing one (whatever the hold cap or a
      // stall) or waits for it. A cache that cannot keep it, or a creation that failed, has nothing to warm.
      if (this.disabled || !node || target._snapshotRendering.record || state.synchronous.has(node)) {
        scope.hits += 1;
        throw DEFERRED;
      }
      if (!state.pending.has(node)) defer(this, node, effect, topology, sampleCount);
      scope.nodes.add(node);
      scope.tokens.set(node, effect as object);
      throw DEFERRED;
    }
    if (!scope || this.disabled || !node || target._snapshotRendering.record || state.synchronous.has(node))
      return create.call(this, effect, topology, sampleCount);
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
    if (!scopes.filter((open) => !open.warm).every((open) => open.startsDeferrals)) return create.call(this, effect, topology, sampleCount);
    defer(this, node, effect, topology, sampleCount);
    scope.skipped += 1;
    scope.nodes.add(node);
    throw DEFERRED;
  };
  // A warm draw looks its pipeline up (a miss starts it above) and is skipped either way.
  cache.getRenderPipeline = function (this: PipelineCache, ...args) {
    const scope = state.scopes.length ? scopeOfPass() : undefined;
    if (!scope?.warm) return lookup.apply(this, args);
    scope.lookups += 1;
    scope.skipped += 1;
    lookup.apply(this, args);
    scope.hits += 1;
    if (this._parameter.token) scope.tokens.set(this._parameter.token, args[1] as object);
    throw DEFERRED;
  };
  target._draw = function (this: DrawEngine, ...args) {
    try {
      draw.apply(this, args);
      if (this._currentEffect) state.drawn.add(this._currentEffect);
    } catch (error) {
      if (error !== DEFERRED) throw error;
    }
  };
  engine.onDisposeObservable.addOnce(() => {
    cache._createRenderPipeline = create;
    cache.getRenderPipeline = lookup;
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
   * deferred creation stalled: the next draw compiles it synchronously; a warm
   * scope's pipelines are never compiled synchronously, so it waits on).
   */
  waiting(): boolean;
  /** A warm scope: some draw looked its pipeline up, and every one found it. */
  warmed(): boolean;
  /** A warm scope: each Effect a draw looked a pipeline up for, with that pipeline's cache node. */
  pipelineEffects?(): readonly (readonly [object, object])[];
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
 * miss synchronously. `nested` opens a scope only inside an open one, so a
 * capture defers only while the view whose frame draws it does (that view then
 * holds instead of presenting the capture's partial image). Only for output
 * that is drawn again every frame, never for a render-once target or a capture
 * that is read back.
 *
 * `warm` opens a warm scope, for draws made only to create their pipelines
 * ahead of the real ones (a Material's next variant drawn under a second
 * render pass id, inside the real pass's target and state): every draw in an
 * admitted pass is skipped, a missing pipeline starts creating asynchronously
 * whatever the enclosing scopes' `startsDeferrals` or a stall (a warm draw
 * never compiles synchronously), and `warmed()` reports whether every draw
 * found its pipeline. Its skips never count in an enclosing scope.
 */
export function beginPipelineDeferral(
  engine: AbstractEngine,
  allows: (renderPassId: number) => boolean,
  options: { startsDeferrals?: boolean; nested?: boolean; warm?: boolean } = {},
): PipelineDeferral | undefined {
  if (!engine.isWebGPU) return undefined;
  if (options.nested && !states.get(engine)?.scopes.length) return undefined;
  const state = states.get(engine) ?? install(engine);
  states.set(engine, state);
  const scopes = state.scopes;
  const warm = options.warm === true;
  const scope: Scope = {
    allows, startsDeferrals: options.startsDeferrals ?? true, warm, skipped: 0, lookups: 0, hits: 0, nodes: new Set(), tokens: new Map(),
  };
  scopes.push(scope);
  let closed = false;
  return {
    close: () => {
      if (closed) return scope.skipped;
      closed = true;
      const index = scopes.lastIndexOf(scope);
      if (index >= 0) scopes.splice(index, 1);
      const parent = scopes[index - 1];
      if (parent && !warm) {
        parent.skipped += scope.skipped;
        for (const node of scope.nodes) parent.nodes.add(node);
      }
      return scope.skipped;
    },
    waiting: () => {
      if (!warm && performance.now() - state.progressAt >= PIPELINE_DEFERRAL_STALL_MS) return false;
      for (const node of scope.nodes) if (state.pending.has(node)) return true;
      return false;
    },
    warmed: () => scope.lookups > 0 && scope.hits === scope.lookups,
    pipelineEffects: () => [...scope.tokens].map(([node, effect]) => [effect, node] as const),
  };
}

/**
 * Drops the pipelines warm draws created (or are creating) at `nodes`, cache nodes of Effects since released, at once:
 * Babylon's pipeline cache, a tree keyed by each Effect's unique id, keeps a released Effect's pipelines until the
 * Engine's cache pruning (`webgpu-cache-pruning.ts`) drops its branch.
 */
export function releaseWarmPipelines(engine: AbstractEngine, nodes: Iterable<object>): void {
  const state = states.get(engine);
  for (const node of nodes as Iterable<CacheNode>) {
    // A creation still in flight finds its node gone and keeps nothing.
    state?.pending.delete(node);
    node.pipeline = undefined;
  }
}

/**
 * Whether some draw on `engine` has drawn with `effect` since a deferring view first drew (so it has a pipeline for
 * that draw's state); true while no view defers, when nothing is known.
 */
export function effectDrawn(engine: AbstractEngine, effect: object): boolean {
  return states.get(engine)?.drawn.has(effect) ?? true;
}

/**
 * Whether `engine` creates render pipelines apart from its shaders, so a new variant waits for its pipeline after
 * its Effect is ready (WebGPU; the compile-hold harness models it on NullEngine).
 */
export function pipelinesDeferred(engine: AbstractEngine): boolean {
  return engine.isWebGPU;
}

/** Render pipelines still being created for skipped draws on `engine`. */
export function deferredPipelineCount(engine: AbstractEngine): number {
  return states.get(engine)?.pending.size ?? 0;
}

/**
 * No deferred pipeline on `engine` started or finished for `PIPELINE_DEFERRAL_STALL_MS`: the stall after which a
 * deferring view's pending pipelines compile synchronously at their next draw. False while nothing defers.
 */
export function deferredPipelinesStalled(engine: AbstractEngine): boolean {
  const state = states.get(engine);
  return !!state && performance.now() - state.progressAt >= PIPELINE_DEFERRAL_STALL_MS;
}

/**
 * Deferred pipeline creations on `engine` that have finished, a monotonic count.
 * Loading waits count each as compile progress (`DriverCompileWatch`): on
 * WebKit, where pipelines build one after another, a held first frame may
 * outlast a loading budget while they still arrive.
 */
export function deferredPipelinesSettled(engine: AbstractEngine): number {
  return states.get(engine)?.settled ?? 0;
}
