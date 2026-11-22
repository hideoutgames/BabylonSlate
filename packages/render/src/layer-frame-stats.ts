import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/**
 * What one frame's Scene Layer work did and cost on the CPU (`SceneLayerCompositor.frameStats`,
 * `RenderDiagnostics.layerFrame`): the split the Layer Stack Renderer is measured by. Two phases are counted apart:
 * the layer pass after the world (`SceneLayerCompositor.render`) and the layer work done before the world draws
 * (`SceneLayerCompositor.beforeWorld`).
 */
export interface LayerFrameStats {
  /** Layer Scenes the layer pass rendered (`SceneRenderCoordinator.render`); the shared stack's passes not counted. */
  scenes: number;
  /** Main-thread ms of the layer pass in all. */
  ms: number;
  /**
   * Of `ms`, the time inside the layers' batched passes (`OverlayDrawBatcher.draw`: batch upkeep and draw dispatch).
   * The rest is per-Scene overhead: admission, the frame graph, `Scene.render`'s own work, the cull, list preparation.
   */
  batchMs: number;
  /** Engine clears during the layer pass. */
  clears: number;
  /** Of `clears`, those that clear depth or stencil. */
  depthClears: number;
  /** Changes of the bound framebuffer during the layer pass, a return to the one bound before included. */
  targetSwitches: number;
  /** Glyph page uploads and image page cell copies during the layer pass. */
  uploads: number;
  /** The layer work done before the world draws: its time, its uploads and copies, and its framebuffer changes. */
  beforeWorld: { ms: number; uploads: number; targetSwitches: number };
  /**
   * What reached the backbuffer (the default framebuffer) from the work before the world to the end of the layer pass,
   * the world's own clears included (`backbuffer-depth-tracker.ts`): its clears, those that cleared depth or stencil,
   * and the layer depth-stencil clears left out because the backbuffer already held cleared depth and stencil. All
   * zero on an Engine without a WebGL context.
   */
  backbuffer: { clears: number; depthClears: number; elided: number };
}

export function emptyLayerFrameStats(): LayerFrameStats {
  return {
    scenes: 0, ms: 0, batchMs: 0, clears: 0, depthClears: 0, targetSwitches: 0, uploads: 0, beforeWorld: { ms: 0, uploads: 0, targetSwitches: 0 },
    backbuffer: { clears: 0, depthClears: 0, elided: 0 },
  };
}

/** Copies `from`'s counts into `to` (a new one when not given) and returns it. */
export function copyLayerFrameStats(from: LayerFrameStats, to: LayerFrameStats = emptyLayerFrameStats()): LayerFrameStats {
  to.scenes = from.scenes; to.ms = from.ms; to.batchMs = from.batchMs; to.clears = from.clears; to.depthClears = from.depthClears;
  to.targetSwitches = from.targetSwitches; to.uploads = from.uploads;
  to.beforeWorld.ms = from.beforeWorld.ms; to.beforeWorld.uploads = from.beforeWorld.uploads;
  to.beforeWorld.targetSwitches = from.beforeWorld.targetSwitches;
  to.backbuffer.clears = from.backbuffer.clears; to.backbuffer.depthClears = from.backbuffer.depthClears;
  to.backbuffer.elided = from.backbuffer.elided;
  return to;
}

/** What a phase counts into: the layer pass's fields, or `beforeWorld`'s. */
interface PhaseCounts {
  uploads: number;
  targetSwitches: number;
  clears?: number;
  depthClears?: number;
  batchMs?: number;
}

let counting: PhaseCounts | undefined;
let countingEngine: object | undefined;

type CountedEngine = {
  clear(color: unknown, backBuffer: boolean, depth: boolean, stencil?: boolean, stencilClearValue?: number): void;
  clearAttachments?(color: unknown, attachments: number[], clearColor: boolean, clearDepth: boolean, clearStencil?: boolean, stencilClearValue?: number): void;
  _bindUnboundFramebuffer(framebuffer: unknown): void;
  _currentFramebuffer: unknown;
};

const installed = new WeakSet<object>();
/** A clear counted by the call running it (`clearAttachments`, which a WebGL Engine runs through `clear`). */
let clearing = false;

function countClear(engine: object, depth: boolean | undefined, stencil: boolean | undefined): void {
  const phase = counting;
  if (clearing || phase?.clears === undefined || countingEngine !== engine) return;
  phase.clears += 1;
  if (depth || stencil) phase.depthClears! += 1;
}

/**
 * Lets `engine`'s clears and framebuffer changes count while a layer phase runs (`countLayerPhase`). Installed once per
 * Engine as own properties that call Babylon's own methods; outside a counted phase each costs one comparison. A frame
 * graph pass's start clear goes through `clearAttachments`, every other clear through `clear`, and every framebuffer
 * change on a WebGL Engine through `_bindUnboundFramebuffer`.
 */
export function installLayerFrameCounters(engine: AbstractEngine): void {
  if (installed.has(engine)) return;
  installed.add(engine);
  const counted = engine as unknown as CountedEngine;
  const clear = counted.clear;
  const clearAttachments = counted.clearAttachments;
  const bind = counted._bindUnboundFramebuffer;
  counted.clear = function (this: CountedEngine, color, backBuffer, depth, stencil, stencilClearValue) {
    countClear(this, depth, stencil);
    clear.call(this, color, backBuffer, depth, stencil, stencilClearValue);
  };
  if (clearAttachments) {
    counted.clearAttachments = function (this: CountedEngine, color, attachments, clearColor, clearDepth, clearStencil, stencilClearValue) {
      countClear(this, clearDepth, clearStencil);
      const outer = clearing;
      clearing = true;
      try {
        clearAttachments.call(this, color, attachments, clearColor, clearDepth, clearStencil, stencilClearValue);
      } finally {
        clearing = outer;
      }
    };
  }
  counted._bindUnboundFramebuffer = function (this: CountedEngine, framebuffer) {
    const phase = counting;
    if (phase && countingEngine === this && this._currentFramebuffer !== framebuffer) phase.targetSwitches += 1;
    bind.call(this, framebuffer);
  };
}

/**
 * Runs `phase` with `engine`'s clears, framebuffer changes, atlas uploads and batched pass time counted into `into`:
 * the layer pass's fields of a `LayerFrameStats`, or its `beforeWorld`. Phases do not nest; an inner one counts to itself.
 */
export function countLayerPhase<T>(engine: AbstractEngine, into: PhaseCounts, phase: () => T): T {
  const previous = counting;
  const previousEngine = countingEngine;
  counting = into;
  countingEngine = engine;
  try {
    return phase();
  } finally {
    counting = previous;
    countingEngine = previousEngine;
  }
}

/** A glyph page upload or an image page cell copy happened now: counted to the layer phase running, if any. */
export function noteLayerUpload(): void {
  if (counting) counting.uploads += 1;
}

/**
 * The start of a batched pass: `performance.now()` while the layer pass counts its batched time, else -1, which
 * `endLayerBatch` ignores.
 */
export function beginLayerBatch(): number {
  return counting?.batchMs !== undefined ? performance.now() : -1;
}

export function endLayerBatch(start: number): void {
  if (start >= 0 && counting?.batchMs !== undefined) counting.batchMs += performance.now() - start;
}
