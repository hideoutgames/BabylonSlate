import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheBindGroups } from "@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";

/**
 * Babylon 9.29 keeps two process-wide WebGPU caches that never forget an
 * entry: `WebGPUCacheBindGroups._Cache` (keyed by uniform/storage buffer ids,
 * sampler hashes and texture ids) and `WebGPUCacheRenderPipelineTree._Cache`
 * (keyed by pipeline state, including `Effect.uniqueId`). Every closed Scene,
 * Play session, preview and recompiled material leaves its bind groups and
 * render pipelines behind. WebKit backs each bind group with Metal argument
 * buffers, so an editor session grows GPU memory until allocation fails.
 *
 * Babylon hands out buffer, texture and Effect ids from counters, so an entry
 * keyed by a released one is never looked up again. Pruning only removes cache
 * entries: a later miss rebuilds the bind group or pipeline, so a wrong prune
 * can never break a draw. Two cases prune an entry that is still wanted, and
 * both only cost a miss: `Texture.Parse` restoring a serialized texture id, and
 * an unbound slot, which keys as id 0 (so releasing buffer or texture 0 prunes
 * every unbound-slot entry). render.md lists both.
 */

/** `webgpuCacheBindGroups.js` key ranges: sampler hash < 2^20 <= buffer id + 2^20 < 2^35 <= texture id + 2^35. */
const BUFFER_ID_START = 2 ** 20;
const TEXTURE_ID_START = 2 ** 35;
/** `StatePosition.ShaderStage` in `webgpuCacheRenderPipeline.js`: the tree depth whose keys are `Effect.uniqueId`. */
const SHADER_STAGE_DEPTH = 11;
/** Released ids that trigger a prune at the next frame end. */
const PRUNE_THRESHOLD = 256;
/** Frames after which any pending release is pruned even below the threshold. */
const PRUNE_MAX_FRAMES = 600;

type BindGroupNode = { values: Record<string, BindGroupNode>; bindGroups?: unknown };
type PipelineNode = { values: Record<string, PipelineNode>; pipeline?: unknown };

type ReleasingEngine = {
  _releaseBuffer(buffer: unknown): boolean;
  _releaseTexture(texture: unknown): void;
  _releaseEffect(effect: unknown): void;
};

export type WebGpuCacheCounts = { bindGroups: number; pipelines: number };

function bindGroupRoot(): BindGroupNode {
  return (WebGPUCacheBindGroups as unknown as { _Cache: BindGroupNode })._Cache;
}

function pipelineRoot(): PipelineNode {
  return (WebGPUCacheRenderPipelineTree as unknown as { _Cache: PipelineNode })._Cache;
}

function countBindGroups(node: BindGroupNode): number {
  let count = node.bindGroups ? 1 : 0;
  for (const key in node.values) count += countBindGroups(node.values[key]!);
  return count;
}

function countPipelines(node: PipelineNode): number {
  let count = node.pipeline ? 1 : 0;
  for (const key in node.values) count += countPipelines(node.values[key]!);
  return count;
}

/** Cached bind groups and render pipelines across every WebGPU Engine in this page. */
export function webGpuCacheCounts(): WebGpuCacheCounts {
  return { bindGroups: countBindGroups(bindGroupRoot()), pipelines: countPipelines(pipelineRoot()) };
}

function isEmpty(values: Record<string, unknown>): boolean {
  for (const _key in values) return false;
  return true;
}

function pruneBindGroups(node: BindGroupNode, buffers: ReadonlySet<number>, textures: ReadonlySet<number>): number {
  let removed = 0;
  for (const key in node.values) {
    const id = Number(key);
    const child = node.values[key]!;
    const released = id >= TEXTURE_ID_START
      ? textures.has(id - TEXTURE_ID_START)
      : id >= BUFFER_ID_START && buffers.has(id - BUFFER_ID_START);
    if (released) {
      removed += countBindGroups(child);
      delete node.values[key];
      continue;
    }
    removed += pruneBindGroups(child, buffers, textures);
    // Bind-group lookups walk from the root every time, so emptied branches can go.
    if (!child.bindGroups && isEmpty(child.values)) delete node.values[key];
  }
  return removed;
}

function prunePipelines(node: PipelineNode, effects: ReadonlySet<number>, depth: number): number {
  let removed = 0;
  for (const key in node.values) {
    const child = node.values[key]!;
    if (depth === SHADER_STAGE_DEPTH) {
      if (!effects.has(Number(key))) continue;
      removed += countPipelines(child);
      // Only the released Effect's branch goes: the Engine's lookup stack may
      // still point at shared state nodes above it.
      delete node.values[key];
    } else {
      removed += prunePipelines(child, effects, depth + 1);
    }
  }
  return removed;
}

const pruners = new WeakMap<object, () => WebGpuCacheCounts>();

/** Prune everything `engine` released so far now (an idle drain); nothing for other Engines. */
export function pruneWebGpuCachesNow(engine: object): WebGpuCacheCounts | null {
  return pruners.get(engine)?.() ?? null;
}

/**
 * Track what `engine` releases and drop the matching entries from Babylon's
 * global WebGPU caches at a frame end, once enough have accumulated.
 * Returns a function that prunes everything pending now, with the counts removed.
 */
export function pruneReleasedWebGpuCacheEntries(engine: WebGPUEngine): () => WebGpuCacheCounts {
  const native = engine as unknown as ReleasingEngine;
  const releaseBuffer = native._releaseBuffer;
  const releaseTexture = native._releaseTexture;
  const releaseEffect = native._releaseEffect;
  if (typeof releaseBuffer !== "function" || typeof releaseTexture !== "function" || typeof releaseEffect !== "function")
    throw new Error("Unsupported Babylon WebGPU release layout: _releaseBuffer, _releaseTexture or _releaseEffect is missing.");
  const buffers = new Set<number>();
  const textures = new Set<number>();
  const effects = new Set<number>();
  const idOf = (value: unknown): number | null => {
    const id = (value as { uniqueId?: unknown } | null)?.uniqueId;
    return typeof id === "number" ? id : null;
  };
  native._releaseBuffer = function (this: unknown, buffer: unknown) {
    const released = releaseBuffer.call(this, buffer);
    const id = released ? idOf(buffer) : null;
    if (id !== null) buffers.add(id);
    return released;
  };
  native._releaseTexture = function (this: unknown, texture: unknown) {
    const id = idOf(texture);
    releaseTexture.call(this, texture);
    if (id !== null) textures.add(id);
  };
  native._releaseEffect = function (this: unknown, effect: unknown) {
    const id = idOf(effect);
    releaseEffect.call(this, effect);
    if (id !== null) effects.add(id);
  };
  const prune = (): WebGpuCacheCounts => {
    const removed = {
      bindGroups: buffers.size || textures.size ? pruneBindGroups(bindGroupRoot(), buffers, textures) : 0,
      pipelines: effects.size ? prunePipelines(pipelineRoot(), effects, 0) : 0,
    };
    buffers.clear();
    textures.clear();
    effects.clear();
    return removed;
  };
  let framesSincePrune = 0;
  engine.onEndFrameObservable.add(() => {
    const pending = buffers.size + textures.size + effects.size;
    framesSincePrune += 1;
    if (pending === 0 || (pending < PRUNE_THRESHOLD && framesSincePrune < PRUNE_MAX_FRAMES)) return;
    framesSincePrune = 0;
    prune();
  });
  pruners.set(engine, prune);
  return prune;
}
