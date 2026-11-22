import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { readEngineDrawCalls, type DrawCallEngine } from "./draw-calls";

/**
 * Whether the backbuffer's depth and stencil still hold, at every pixel, what a full clear of both wrote, so a Scene
 * Layer's depth-stencil clear that would write the same can be left out (`SceneLayerCompositor.skipClears`). Play's
 * world output pass clears them with its colour in such a frame (`foldsBackbufferDepthStencil`), so the first layer's
 * own clear finds them cleared.
 *
 * It reads Babylon's own state caches, never the WebGL context, and adds nothing to the world frame's GL calls:
 * - `clear`, `enableScissor` and `disableScissor` are wrapped once per Engine (fixed arity; a clear is a few calls a
 *   frame, scissor changes are clipped layer draws). A clear's depth and stencil writes are what Babylon's caches say
 *   when it applies them (`clear` applies the cached states first; the stencil from its global state).
 * - The draws are followed only during the layer pass: `beginLayerPass` puts two fixed-arity wrappers, made once, on
 *   `drawElementsType` and `drawArraysType` (every Babylon draw goes through one) and `endLayerPass` takes them off,
 *   also after a throw. A draw writes depth only with the depth test and depth writes on (WebGL writes no depth without
 *   the test), and may write stencil with the stencil test on; each is read from the caches the draw applies.
 *
 * The buffers count as cleared only after a clear of both on the default framebuffer with the scissor test off (as
 * Babylon last set it; WebGL starts with it off and only Babylon turns it on, while a raw `disable` only makes the
 * tracker more careful), depth writes on and every stencil bit writable. Outside the layer pass no draw is followed, so
 * a clear made there holds at the next layer pass only if the Engine drew no more than it allows since: none after a
 * loading frame's clear, one after the world output pass's merged clear (`noteFoldedClear`): that pass's own
 * full-screen draw, which neither tests nor writes depth or stencil (`fullTargetCover`: no depth test into the
 * backbuffer, no stencil state; the copy draws without either). Any other draw in between, another Engine frame (a
 * lost context ends the frame) or another backbuffer size than the clear's, and the end of each layer pass forget it. A clear left out would have written what every
 * pixel holds, so its scissor and masks cannot matter: the picture is the same.
 */
export class BackbufferDepthTracker {
  /** Clears of the backbuffer's depth or stencil that ran, those left out, and every clear that reached it. */
  depthClears = 0;
  elided = 0;
  clears = 0;
  private clean = false;
  private heldDepth = 1;
  private heldStencil = 0;
  /** The Engine frame, backbuffer size and draw count when the buffers were last cleared, and the draws a layer pass allows since. */
  private frame = -1;
  private width = 0;
  private height = 0;
  private mark = 0;
  private allowance = 0;
  private scissor = false;
  private eliding = false;
  private passOpen = false;
  private readonly engine: AbstractEngine;
  private readonly drawElements: AbstractEngine["drawElementsType"];
  private readonly drawArrays: AbstractEngine["drawArraysType"];
  private readonly trackedElements: AbstractEngine["drawElementsType"];
  private readonly trackedArrays: AbstractEngine["drawArraysType"];

  constructor(engine: AbstractEngine) {
    this.engine = engine;
    const own = engine as unknown as Record<string, unknown>;
    const clear = engine.clear;
    own.clear = (color: unknown, backBuffer: boolean, depth: boolean, stencil?: boolean, stencilClearValue?: number) => {
      this.clear(clear, color, backBuffer, depth, stencil === true, stencilClearValue ?? 0);
    };
    const enable = (engine as unknown as { enableScissor?: (x: number, y: number, width: number, height: number) => void }).enableScissor;
    const disable = (engine as unknown as { disableScissor?: () => void }).disableScissor;
    if (enable) own.enableScissor = (x: number, y: number, width: number, height: number) => {
      this.scissor = true;
      enable.call(engine, x, y, width, height);
    };
    if (disable) own.disableScissor = () => {
      this.scissor = false;
      disable.call(engine);
    };
    this.drawElements = engine.drawElementsType;
    this.drawArrays = engine.drawArraysType;
    const drawElements = this.drawElements, drawArrays = this.drawArrays;
    this.trackedElements = (fillMode: number, indexStart: number, indexCount: number, instancesCount?: number) => {
      this.drew();
      drawElements.call(engine, fillMode, indexStart, indexCount, instancesCount);
    };
    this.trackedArrays = (fillMode: number, verticesStart: number, verticesCount: number, instancesCount?: number) => {
      this.drew();
      drawArrays.call(engine, fillMode, verticesStart, verticesCount, instancesCount);
    };
  }

  /** Whether the backbuffer holds, at every pixel, the depth and stencil its last full clear wrote. */
  get holdsCleared(): boolean {
    return this.clean;
  }

  /** The world output pass's clear just took depth and stencil: its own full-screen draw may follow before the layers. */
  noteFoldedClear(): void {
    if (this.clean && this.mark === this.drawCount()) this.allowance = 1;
  }

  /**
   * A layer pass that leaves already-cleared clears out starts: its draws are followed until `endLayerPass`. A clear
   * made before it holds only if the Engine drew no more than it allowed since.
   */
  beginLayerPass(): void {
    const engine = this.engine;
    if (this.clean && (this.drawCount() - this.mark > this.allowance || engine.frameId !== this.frame ||
      engine.getRenderWidth(true) !== this.width || engine.getRenderHeight(true) !== this.height)) this.clean = false;
    this.eliding = true;
    this.passOpen = true;
    const own = this.engine as unknown as Record<string, unknown>;
    own.drawElementsType = this.trackedElements;
    own.drawArraysType = this.trackedArrays;
  }

  /** The layer pass ended (or threw): the Engine's draws are its own again, and nothing after is followed. */
  endLayerPass(): void {
    if (!this.passOpen) return;
    this.passOpen = false;
    this.eliding = false;
    this.clean = false;
    const own = this.engine as unknown as Record<string, unknown>;
    own.drawElementsType = this.drawElements;
    own.drawArraysType = this.drawArrays;
  }

  private drawCount(): number {
    return readEngineDrawCalls(this.engine as unknown as DrawCallEngine);
  }

  private onBackbuffer(): boolean {
    return (this.engine as unknown as { _currentFramebuffer: unknown })._currentFramebuffer === null;
  }

  /** A draw in the layer pass: on the backbuffer, one that can write depth or stencil makes the buffers uncleared. */
  private drew(): void {
    if (!this.clean || !this.onBackbuffer()) return;
    const depth = this.engine.depthCullingState;
    if ((depth.depthTest && depth.depthMask) || this.stencilTest()) this.clean = false;
  }

  /** The stencil test the next draw applies, as Babylon's stencil composer picks it. */
  private stencilTest(): boolean {
    const composer = this.engine.stencilStateComposer;
    const material = !composer.useStencilGlobalOnly && !!composer.stencilMaterial?.enabled;
    return material ? true : !!composer.stencilGlobal?.enabled;
  }

  private clear(original: AbstractEngine["clear"], color: unknown, backBuffer: boolean, depth: boolean, stencil: boolean, stencilValue: number): void {
    const engine = this.engine;
    const call = original as (color: unknown, backBuffer: boolean, depth: boolean, stencil: boolean, stencilClearValue: number) => void;
    if (!this.onBackbuffer() || (!depth && !stencil)) {
      if (color && backBuffer && this.onBackbuffer()) this.clears += 1;
      call.call(engine, color, backBuffer, depth, stencil, stencilValue);
      return;
    }
    const depthValue = engine.useReverseDepthBuffer ? 0 : 1;
    const stencilHeld = stencilValue & 0xff;
    const writesHeld = (!depth || depthValue === this.heldDepth) && (!stencil || stencilHeld === this.heldStencil);
    if (this.eliding && this.clean && writesHeld) {
      this.elided += 1;
      if (color && backBuffer) this.clears += 1;
      // The colour, and the states the clear applies, as before: only depth and stencil are left out.
      call.call(engine, color, backBuffer, false, false, stencilValue);
      return;
    }
    this.clears += 1;
    this.depthClears += 1;
    const whole = depth && stencil && !this.scissor && engine.depthCullingState.depthMask &&
      (engine.stencilState.stencilMask & 0xff) === 0xff;
    call.call(engine, color, backBuffer, depth, stencil, stencilValue);
    if (whole) {
      this.clean = true;
      this.heldDepth = depthValue;
      this.heldStencil = stencilHeld;
      this.mark = this.drawCount();
      this.allowance = 0;
      this.frame = engine.frameId;
      this.width = engine.getRenderWidth(true);
      this.height = engine.getRenderHeight(true);
    } else if (!(this.clean && writesHeld)) this.clean = false;
  }
}

const trackers = new WeakMap<object, BackbufferDepthTracker>();

/** `engine`'s tracker, made with the first call (its `clear` and scissor wrappers with it); it holds no observer. */
export function backbufferDepthTracker(engine: AbstractEngine): BackbufferDepthTracker {
  const known = trackers.get(engine);
  if (known) return known;
  const tracker = new BackbufferDepthTracker(engine);
  trackers.set(engine, tracker);
  return tracker;
}

const folding = new WeakSet<object>();

/**
 * Whether the world output pass on `engine` clears the backbuffer's depth and stencil with its colour this frame
 * (`full-target-clear.ts`): set by the Scene Layer compositor before the world draws when layers will draw straight
 * over it with their already-cleared clears left out (`SceneLayerCompositor.beforeWorld`), cleared after them.
 */
export function setBackbufferDepthStencilFold(engine: object, fold: boolean): void {
  if (fold) folding.add(engine);
  else folding.delete(engine);
}

export function foldsBackbufferDepthStencil(engine: object): boolean {
  return folding.has(engine);
}

/** The world output pass's merged clear just ran on `engine` (`full-target-clear.ts`). */
export function noteFoldedBackbufferClear(engine: object): void {
  trackers.get(engine)?.noteFoldedClear();
}
