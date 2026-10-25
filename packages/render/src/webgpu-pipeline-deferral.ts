import { Observable, type AbstractEngine, type Nullable, type RenderTargetWrapper } from "@babylonjs/core";
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
  /** The bound target's formats (Babylon 9.29 `WebGPUCacheRenderPipeline`), which key every pipeline looked up. */
  _webgpuColorFormat?: (GPUTextureFormat | null)[];
  _webgpuDepthStencilFormat?: GPUTextureFormat;
  mrtTextureCount?: number;
  setColorFormat?(format: GPUTextureFormat | null): void;
  setDepthStencilFormat?(format: GPUTextureFormat | undefined): void;
};

type DrawEngine = {
  _draw(drawType: number, fillMode: number, start: number, count: number, instancesCount: number): void;
  _currentEffect: object;
  _cacheRenderPipeline: PipelineCache;
  _device: GPUDevice;
  _snapshotRendering: { record: boolean };
  currentRenderPassId: number;
  _currentRenderPass?: object | null;
  /** Starts the bound target's render pass when none is open (Babylon 9.29 `WebGPUEngine`). */
  _getCurrentRenderPass?(): object | null;
};

/**
 * What a draw's pipeline lookup reads from its pass besides the draw's own state (Babylon 9.29): the bound target (its
 * formats, sample count and Y flip) and the depth state the pass leaves to its draws (`capturePipelineTarget`).
 */
export type PipelineTarget = {
  /** The bound render target (null: the main pass), which sets a draw's sample count and front face. */
  readonly renderTarget: Nullable<RenderTargetWrapper>;
  readonly colorFormat: GPUTextureFormat | null;
  readonly depthStencilFormat: GPUTextureFormat | undefined;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly depthFunction: number | null;
};

type Scope = {
  allows: (renderPassId: number) => boolean;
  /** Admitted passes whose draws a missing pipeline leaves out without counting a skip (`omits`). */
  omits: ((renderPassId: number) => boolean) | undefined;
  /** Per omitting pass, the draws left out and the pending pipelines they need. */
  omitted: Map<number, { draws: number; nodes: Set<CacheNode> }>;
  /** Omitting passes in which some draw drew while the scope was open. */
  drew: Set<number>;
  startsDeferrals: boolean;
  /** A warm scope (`warm`): skips every draw, starts any missing pipeline asynchronously, never synchronously. */
  warm: boolean;
  /** A lookup scope (`lookup`, a warm scope): starts no pipeline either, and its draws start no GPU pass. */
  lookup: boolean;
  skipped: number;
  /** Draws that looked their pipeline up (warm scopes), and those that found it. */
  lookups: number;
  hits: number;
  /** The pending pipelines its skipped draws wait for. */
  nodes: Set<CacheNode>;
  /** Of `nodes`, those only left-out draws counted at `close()` wait for: each is given up after its own stall. */
  leftOut: Set<CacheNode>;
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
  /** Draws that drew, by render pass id, while a scope was open (`drawsInPass`). */
  passDraws: Map<number, number>;
  /** When each deferred creation started: a left-out draw's own stall clock. */
  startedAt: WeakMap<CacheNode, number>;
  /** Open scopes with `omits`. */
  omitting: number;
  /** Open lookup scopes: a draw starts no render pass meanwhile. */
  lookingUp: number;
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
  const state: DeferralState = {
    scopes: [], pending: new Set(), synchronous: new WeakSet(), progressAt: 0, settled: 0, drawn: new WeakSet(), passDraws: new Map(),
    startedAt: new WeakMap(), omitting: 0, lookingUp: 0,
  };
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
    state.startedAt.set(node, state.progressAt);
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
    // A lookup only asks whether the pipeline exists: a miss starts nothing, and a node that would compile at its draw
    // (a cache that keeps none, a failed creation) is a miss too.
    if (scope?.lookup) throw DEFERRED;
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
    const pass = target.currentRenderPassId;
    // An omitted draw is left out of its pass and holds nothing: the scope neither counts nor waits for it.
    const omitted = scope.omits?.(pass) === true;
    /** Records the skipped draw (left out of an omitting pass, or counted and waited for); throw what it returns. */
    const skip = () => {
      if (omitted) {
        let entry = scope.omitted.get(pass);
        if (!entry) scope.omitted.set(pass, (entry = { draws: 0, nodes: new Set() }));
        entry.draws += 1;
        entry.nodes.add(node);
      } else {
        scope.skipped += 1;
        scope.nodes.add(node);
        scope.leftOut.delete(node);
      }
      return DEFERRED;
    };
    if (state.pending.has(node)) {
      if (now - state.progressAt >= PIPELINE_DEFERRAL_STALL_MS) {
        for (const stalled of state.pending) state.synchronous.add(stalled);
        state.pending.clear();
        return create.call(this, effect, topology, sampleCount);
      }
      // Any creation finishing renews the Engine's stall, which a left-out draw (it holds no view) may then never
      // reach: past the stall time its own creation is given up and it compiles synchronously.
      if (omitted && now - (state.startedAt.get(node) ?? now) >= PIPELINE_DEFERRAL_STALL_MS) {
        state.pending.delete(node);
        state.synchronous.add(node);
        return create.call(this, effect, topology, sampleCount);
      }
      throw skip();
    }
    // The hold cap bounds held frames. An omitted draw holds none while its pass draws something else, so past the cap
    // its miss still starts asynchronously; in a pass that has drawn nothing yet in the scope it compiles synchronously,
    // since leaving it out could hold the view for it (`close()`).
    if ((!omitted || !scope.drew.has(pass)) && !scopes.filter((open) => !open.warm).every((open) => open.startsDeferrals))
      return create.call(this, effect, topology, sampleCount);
    defer(this, node, effect, topology, sampleCount);
    throw skip();
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
      if (state.scopes.length) {
        const pass = this.currentRenderPassId;
        state.passDraws.set(pass, (state.passDraws.get(pass) ?? 0) + 1);
        if (state.omitting) for (const scope of state.scopes) if (scope.omits?.(pass)) scope.drew.add(pass);
      }
    } catch (error) {
      if (error !== DEFERRED) throw error;
    }
  };
  // Babylon 9.29 `_draw` asks for the current render pass first, which starts the bound target's (or the canvas's) pass
  // when none is open, and uses it only after the pipeline lookup: a lookup's draw, made outside its pass, starts none.
  const currentPass = target._getCurrentRenderPass;
  if (typeof currentPass === "function") {
    target._getCurrentRenderPass = function (this: DrawEngine) {
      return state.lookingUp > 0 ? this._currentRenderPass ?? null : currentPass.call(this);
    };
  }
  // Babylon creates the observable on first use, as its own observers do.
  const released = (engine._onReleaseRenderPassObservable ??= new Observable()).add((id) => state.passDraws.delete(id));
  engine.onDisposeObservable.addOnce(() => {
    cache._createRenderPipeline = create;
    cache.getRenderPipeline = lookup;
    target._draw = draw;
    if (typeof currentPass === "function") target._getCurrentRenderPass = currentPass;
    engine._onReleaseRenderPassObservable?.remove(released);
    states.delete(engine);
  });
  return state;
}

/** The pipeline cache of `engine` when a lookup can replay a target through it (Babylon 9.29's layout). */
function lookupCache(engine: AbstractEngine): Required<Pick<PipelineCache, "setColorFormat" | "setDepthStencilFormat" | "_webgpuColorFormat">> &
  PipelineCache | undefined {
  const target = engine as unknown as DrawEngine;
  const cache = target._cacheRenderPipeline;
  if (!engine.isWebGPU || typeof target._getCurrentRenderPass !== "function" || typeof cache?.setColorFormat !== "function" ||
    typeof cache.setDepthStencilFormat !== "function" || !Array.isArray(cache._webgpuColorFormat))
    return undefined;
  return cache as ReturnType<typeof lookupCache>;
}

/** `engine`'s current target and depth state, as a lookup reads them; undefined where one cannot replay them. */
function currentTarget(engine: AbstractEngine): PipelineTarget | undefined {
  const cache = lookupCache(engine);
  // A multiple render target pass (more formats) and the stencil test (more state) are not replayed.
  if (!cache || (cache.mrtTextureCount ?? 0) > 0) return undefined;
  const depth = engine.depthCullingState;
  return {
    renderTarget: engine._currentRenderTarget, colorFormat: cache._webgpuColorFormat[0] ?? null,
    depthStencilFormat: cache._webgpuDepthStencilFormat, depthTest: depth.depthTest, depthWrite: depth.depthMask,
    depthFunction: depth.depthFunc,
  };
}

/**
 * The pipeline state the current pass gives its draws on `engine` (WebGPU), for a lookup outside that pass (`lookup` in
 * `beginPipelineDeferral`): its target and the depth state its draws inherit. None for a pass with multiple render
 * targets or the stencil test on, or where Babylon's layout differs: a lookup does not replay them.
 */
export function capturePipelineTarget(engine: AbstractEngine): PipelineTarget | undefined {
  return engine.isWebGPU && !engine.stencilState.stencilTest ? currentTarget(engine) : undefined;
}

/** Puts `pipelines` in place on `engine` for a lookup's draws, the stencil test off; returns the restore. */
function replayTarget(engine: AbstractEngine, pipelines: PipelineTarget): (() => void) | undefined {
  const cache = lookupCache(engine);
  const previous = currentTarget(engine);
  if (!cache || !previous) return undefined;
  const stencil = engine.stencilState.stencilTest;
  const depth = engine.depthCullingState;
  const apply = (state: PipelineTarget) => {
    engine._currentRenderTarget = state.renderTarget;
    cache.setColorFormat(state.colorFormat);
    cache.setDepthStencilFormat(state.depthStencilFormat);
    depth.depthTest = state.depthTest;
    depth.depthMask = state.depthWrite;
    depth.depthFunc = state.depthFunction;
  };
  apply(pipelines);
  engine.stencilState.stencilTest = false;
  return () => {
    apply(previous);
    engine.stencilState.stencilTest = stencil;
  };
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
 *
 * `lookup` opens a lookup scope, a warm scope that creates nothing: for draws
 * made outside their pass, before it, only to learn whether their pipelines
 * exist (a hidden mesh about to be revealed). It replays the target the pass
 * was found drawing to (`capturePipelineTarget`: formats, sample count and Y
 * flip) and the depth state it left its draws, with the stencil test off, and
 * restores them on `close()`; meanwhile a draw starts no GPU pass, and a miss
 * starts no creation, synchronous or not. A node whose creation failed, or a
 * cache that keeps nothing, is a miss: its draw would create a pipeline
 * synchronously. None opens (undefined) where Babylon's layout differs.
 *
 * `omits` names admitted passes whose output may miss a draw for a few frames
 * (a world view's geometry passes in its steady frames): a draw there whose
 * pipeline is missing is left out without counting (`close()` and `waiting()`
 * ignore it, so the owner may present), and its pipeline starts creating
 * asynchronously whatever `startsDeferrals`, since it holds nothing. A pass
 * whose every draw in the scope was left out counts them as skips at
 * `close()`, so its output is never presented empty; so past the hold cap
 * (`startsDeferrals: false`) a miss in an omitted pass that has drawn nothing
 * yet in the scope compiles synchronously, as any other miss there does. The
 * stall rule still applies: once no deferred pipeline has started or finished
 * for `PIPELINE_DEFERRAL_STALL_MS` the pending ones compile synchronously at
 * their next draw, and a left-out draw's own creation is given up after that
 * long whatever else progresses (each started or finished creation renews the
 * Engine's stall; `waiting()` gives up such a pipeline counted at `close()` as
 * well); a failed creation compiles synchronously too, so a pipeline that never
 * arrives cannot leave the draw out for good.
 */
export function beginPipelineDeferral(
  engine: AbstractEngine,
  allows: (renderPassId: number) => boolean,
  options: {
    startsDeferrals?: boolean; nested?: boolean; warm?: boolean; lookup?: PipelineTarget; omits?: (renderPassId: number) => boolean;
  } = {},
): PipelineDeferral | undefined {
  if (!engine.isWebGPU) return undefined;
  if (options.nested && !states.get(engine)?.scopes.length) return undefined;
  const state = states.get(engine) ?? install(engine);
  states.set(engine, state);
  const scopes = state.scopes;
  const lookup = options.lookup !== undefined;
  const warm = options.warm === true || lookup;
  const omits = warm ? undefined : options.omits;
  const restoreTarget = options.lookup && replayTarget(engine, options.lookup);
  if (lookup && !restoreTarget) return undefined;
  const scope: Scope = {
    allows, omits, omitted: new Map(), drew: new Set(), startsDeferrals: options.startsDeferrals ?? true, warm, lookup, skipped: 0,
    lookups: 0, hits: 0, nodes: new Set(), leftOut: new Set(), tokens: new Map(),
  };
  scopes.push(scope);
  if (omits) state.omitting += 1;
  if (lookup) state.lookingUp += 1;
  let closed = false;
  return {
    close: () => {
      if (closed) return scope.skipped;
      closed = true;
      const index = scopes.lastIndexOf(scope);
      if (index >= 0) scopes.splice(index, 1);
      if (omits) state.omitting -= 1;
      if (restoreTarget) {
        state.lookingUp -= 1;
        restoreTarget();
      }
      // A pass that drew nothing but left-out draws would present empty: it holds for them as an unadmitted pass does.
      for (const [pass, { draws, nodes }] of scope.omitted) {
        if (scope.drew.has(pass)) continue;
        scope.skipped += draws;
        for (const node of nodes) {
          if (!scope.nodes.has(node)) scope.leftOut.add(node);
          scope.nodes.add(node);
        }
      }
      const parent = scopes[index - 1];
      if (parent && !warm) {
        parent.skipped += scope.skipped;
        for (const node of scope.leftOut) if (!parent.nodes.has(node)) parent.leftOut.add(node);
        for (const node of scope.nodes) parent.nodes.add(node);
      }
      return scope.skipped;
    },
    waiting: () => {
      const now = performance.now();
      if (!warm && now - state.progressAt >= PIPELINE_DEFERRAL_STALL_MS) return false;
      for (const node of scope.nodes) {
        if (!state.pending.has(node)) continue;
        // As at its draw: a left-out draw's creation is given up after its own stall, whatever else progresses.
        if (scope.leftOut.has(node) && now - (state.startedAt.get(node) ?? now) >= PIPELINE_DEFERRAL_STALL_MS) continue;
        return true;
      }
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

/**
 * Draws on `engine` that drew (not skipped or left out) in `renderPassId` while a deferral scope was open, a monotonic
 * count; 0 where pipelines are not deferred.
 */
export function drawsInPass(engine: AbstractEngine, renderPassId: number): number {
  return states.get(engine)?.passDraws.get(renderPassId) ?? 0;
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
