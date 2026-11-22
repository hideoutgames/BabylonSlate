import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/**
 * What the default framebuffer's depth and stencil hold, followed at the WebGL calls that can change them, so a clear
 * that would write the values they already hold everywhere can be left out (`BackbufferDepthTracker.eliding`). The
 * Scene Layers use it: Play's world output pass clears the backbuffer's depth and stencil with its colour
 * (`foldsBackbufferDepthStencil`), and a layer drawn straight over the world then skips its own depth-stencil clear
 * while nothing since has written depth or stencil there.
 *
 * Exact by construction: the buffers are "clean" only after a clear of both that covered every pixel (no scissor test,
 * depth writes on, every stencil bit writable), and stop being clean at anything on the default framebuffer that can
 * write either: a draw with the depth test and depth writes on, or with the stencil test on (in WebGL a draw writes
 * depth only while the depth test is enabled); a partial or single-buffer clear; a depth or stencil blit into it; an
 * invalidate; a new Engine frame, a resize or a lost context. A clear left out would have written, wherever it reached,
 * the values every pixel already holds, so its scissor and write masks cannot matter.
 *
 * The state it reads is shadowed from the calls themselves (bindings, the depth, stencil and scissor tests, the write
 * masks, the clear values), read once from the context when installed: no query per frame. The wrappers are own
 * properties of the context, as the GPU probe's are (`installGlSignature`); a probe installed later wraps these and
 * restores them when it stops. A clear is only ever left out by this `clear` wrapper, so a probe that restored the
 * context's own functions over these leaves every clear in place.
 */

const DEPTH_BUFFER_BIT = 0x100;
const STENCIL_BUFFER_BIT = 0x400;
const DEPTH_STENCIL_BITS = DEPTH_BUFFER_BIT | STENCIL_BUFFER_BIT;
const DEPTH_TEST = 0x0b71;
const STENCIL_TEST = 0x0b90;
const SCISSOR_TEST = 0x0c11;
const FRAMEBUFFER = 0x8d40;
const DRAW_FRAMEBUFFER = 0x8ca9;
const FRONT = 0x0404;
const BACK = 0x0405;
const FRONT_AND_BACK = 0x0408;
/** The default framebuffer's depth and stencil attachments, as `invalidateFramebuffer` and `clearBuffer*` name them. */
const DEPTH = 0x1801;
const STENCIL = 0x1802;
const DEPTH_STENCIL = 0x84f9;
const DEPTH_STENCIL_ATTACHMENT = 0x821a;
const DEPTH_ATTACHMENT = 0x8d00;
const STENCIL_ATTACHMENT = 0x8d20;

/** The WebGL calls the tracker follows; a test can stand in for them. */
export interface TrackedContext {
  bindFramebuffer(target: number, framebuffer: unknown): void;
  enable(capability: number): void;
  disable(capability: number): void;
  depthMask(flag: boolean): void;
  stencilMask(mask: number): void;
  stencilMaskSeparate(face: number, mask: number): void;
  clearDepth(depth: number): void;
  clearStencil(stencil: number): void;
  clear(mask: number): void;
  clearBufferfi?(buffer: number, drawBuffer: number, depth: number, stencil: number): void;
  clearBufferfv?(buffer: number, drawBuffer: number, values: ArrayLike<number>, offset?: number): void;
  clearBufferiv?(buffer: number, drawBuffer: number, values: ArrayLike<number>, offset?: number): void;
  drawArrays(...args: unknown[]): void;
  drawElements(...args: unknown[]): void;
  drawArraysInstanced?(...args: unknown[]): void;
  drawElementsInstanced?(...args: unknown[]): void;
  drawRangeElements?(...args: unknown[]): void;
  blitFramebuffer?(...args: number[]): void;
  invalidateFramebuffer?(target: number, attachments: number[]): void;
  invalidateSubFramebuffer?(target: number, attachments: number[], ...rect: number[]): void;
  getParameter(name: number): unknown;
  isEnabled(capability: number): boolean;
}

const DRAW_FRAMEBUFFER_BINDING = 0x8ca6;
const DEPTH_WRITEMASK = 0x0b72;
const STENCIL_WRITEMASK = 0x0b98;
const STENCIL_BACK_WRITEMASK = 0x8ca5;
const DEPTH_CLEAR_VALUE = 0x0b73;
const STENCIL_CLEAR_VALUE = 0x0b91;

export class BackbufferDepthTracker {
  /** While true, a clear of the default framebuffer's depth or stencil that would write what they hold is left out. */
  eliding = false;
  /** Clears that wrote the default framebuffer's depth or stencil, and those left out. */
  depthClears = 0;
  elided = 0;
  /** Every clear that reached the default framebuffer (colour only included). */
  clears = 0;
  private clean = false;
  private heldDepth = 1;
  private heldStencil = 0;
  private drawFramebuffer: unknown;
  private depthTest: boolean;
  private stencilTest: boolean;
  private scissorTest: boolean;
  private depthWrites: boolean;
  private stencilFront: number;
  private stencilBack: number;
  private clearDepthValue: number;
  private clearStencilValue: number;

  constructor(gl: TrackedContext) {
    this.drawFramebuffer = gl.getParameter(DRAW_FRAMEBUFFER_BINDING) ?? null;
    this.depthTest = gl.isEnabled(DEPTH_TEST);
    this.stencilTest = gl.isEnabled(STENCIL_TEST);
    this.scissorTest = gl.isEnabled(SCISSOR_TEST);
    this.depthWrites = gl.getParameter(DEPTH_WRITEMASK) !== false;
    this.stencilFront = Number(gl.getParameter(STENCIL_WRITEMASK) ?? 0xff);
    this.stencilBack = Number(gl.getParameter(STENCIL_BACK_WRITEMASK) ?? 0xff);
    this.clearDepthValue = Number(gl.getParameter(DEPTH_CLEAR_VALUE) ?? 1);
    this.clearStencilValue = Number(gl.getParameter(STENCIL_CLEAR_VALUE) ?? 0);
    this.wrap(gl);
  }

  /** Whether the default framebuffer's depth and stencil hold, at every pixel, the values its last full clear wrote. */
  get holdsCleared(): boolean {
    return this.clean;
  }

  /** Whatever the default framebuffer holds now is unknown (a new frame, a resize, a lost context). */
  forget(): void {
    this.clean = false;
  }

  private get onDefault(): boolean {
    return this.drawFramebuffer === null;
  }

  private wrap(gl: TrackedContext): void {
    const own = gl as unknown as Record<string, unknown>;
    const wrap = (name: string, around: (original: (...args: unknown[]) => unknown, args: unknown[]) => unknown) => {
      const original = own[name];
      if (typeof original !== "function") return;
      const call = (...args: unknown[]) => (original as (...rest: unknown[]) => unknown).apply(gl, args);
      own[name] = function tracked(...args: unknown[]) { return around(call, args); };
    };
    const after = (name: string, note: (args: unknown[]) => void) =>
      wrap(name, (original, args) => { const result = original(...args); note(args); return result; });
    after("bindFramebuffer", ([target, framebuffer]) => {
      if (target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER) this.drawFramebuffer = framebuffer ?? null;
    });
    const capability = (enabled: boolean) => ([cap]: unknown[]) => {
      if (cap === DEPTH_TEST) this.depthTest = enabled;
      else if (cap === STENCIL_TEST) this.stencilTest = enabled;
      else if (cap === SCISSOR_TEST) this.scissorTest = enabled;
    };
    after("enable", capability(true));
    after("disable", capability(false));
    after("depthMask", ([flag]) => { this.depthWrites = !!flag; });
    after("stencilMask", ([mask]) => { this.stencilFront = this.stencilBack = Number(mask); });
    after("stencilMaskSeparate", ([face, mask]) => {
      if (face === FRONT || face === FRONT_AND_BACK) this.stencilFront = Number(mask);
      if (face === BACK || face === FRONT_AND_BACK) this.stencilBack = Number(mask);
    });
    after("clearDepth", ([depth]) => { this.clearDepthValue = Math.min(1, Math.max(0, Number(depth))); });
    after("clearStencil", ([stencil]) => { this.clearStencilValue = Number(stencil); });
    wrap("clear", (original, [mask]) => this.clear(original, Number(mask)));
    after("clearBufferfi", ([buffer, , depth, stencil]) => {
      if (!this.onDefault || buffer !== DEPTH_STENCIL) return;
      this.clears += 1;
      this.depthClears += 1;
      this.cleared(DEPTH_STENCIL_BITS, Number(depth), Number(stencil));
    });
    for (const name of ["clearBufferfv", "clearBufferiv"]) {
      after(name, ([buffer]) => {
        if (!this.onDefault) return;
        this.clears += 1;
        if (buffer === DEPTH || buffer === STENCIL) {
          this.depthClears += 1;
          this.clean = false;
        }
      });
    }
    for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]) {
      after(name, () => {
        if (this.onDefault && ((this.depthTest && this.depthWrites) || this.stencilTest)) this.clean = false;
      });
    }
    after("blitFramebuffer", (args) => {
      if (this.onDefault && (Number(args[8]) & DEPTH_STENCIL_BITS)) this.clean = false;
    });
    for (const name of ["invalidateFramebuffer", "invalidateSubFramebuffer"]) {
      after(name, ([target, attachments]) => {
        const draw = target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER;
        if (!draw || !this.onDefault) return;
        for (const attachment of (attachments as number[] | undefined) ?? []) {
          if ([DEPTH, STENCIL, DEPTH_STENCIL, DEPTH_ATTACHMENT, STENCIL_ATTACHMENT, DEPTH_STENCIL_ATTACHMENT].includes(attachment)) this.clean = false;
        }
      });
    }
  }

  private clear(original: (...args: unknown[]) => unknown, mask: number): unknown {
    const bits = mask & DEPTH_STENCIL_BITS;
    if (!this.onDefault) return original(mask);
    if (bits && this.eliding && this.clean && this.writesHeld(bits)) {
      this.elided += 1;
      const rest = mask & ~DEPTH_STENCIL_BITS;
      if (!rest) return undefined;
      this.clears += 1;
      return original(rest);
    }
    this.clears += 1;
    const result = original(mask);
    if (bits) {
      this.depthClears += 1;
      this.cleared(bits, this.clearDepthValue, this.clearStencilValue);
    }
    return result;
  }

  /** Whether a clear of `bits` would write exactly what the buffers hold. */
  private writesHeld(bits: number): boolean {
    return (!(bits & DEPTH_BUFFER_BIT) || this.clearDepthValue === this.heldDepth) &&
      (!(bits & STENCIL_BUFFER_BIT) || (this.clearStencilValue & 0xff) === this.heldStencil);
  }

  /** After a clear of `bits` to `depth` and `stencil` on the default framebuffer. */
  private cleared(bits: number, depth: number, stencil: number): void {
    const whole = !this.scissorTest;
    const depthWritten = !(bits & DEPTH_BUFFER_BIT) || this.depthWrites;
    const stencilWritten = !(bits & STENCIL_BUFFER_BIT) || (this.stencilFront & this.stencilBack & 0xff) === 0xff;
    if (bits === DEPTH_STENCIL_BITS && whole && depthWritten && stencilWritten) {
      this.clean = true;
      this.heldDepth = depth;
      this.heldStencil = stencil & 0xff;
      return;
    }
    // A partial clear keeps the buffers clean only where it wrote what they held.
    if (!(this.clean && depth === this.heldDepth && (stencil & 0xff) === this.heldStencil)) this.clean = false;
  }
}

const trackers = new WeakMap<object, BackbufferDepthTracker>();

/**
 * `engine`'s tracker, installed on its WebGL context with the first call; null for an Engine without one (NullEngine,
 * WebGPU). Forgets what it knew at every Engine frame, resize and lost context.
 */
export function backbufferDepthTracker(engine: AbstractEngine): BackbufferDepthTracker | null {
  const known = trackers.get(engine);
  if (known) return known;
  const gl = (engine as unknown as { _gl?: TrackedContext })._gl;
  if (!gl || typeof gl.clear !== "function" || typeof gl.isEnabled !== "function") return null;
  const tracker = new BackbufferDepthTracker(gl);
  trackers.set(engine, tracker);
  const forget = () => tracker.forget();
  engine.onBeginFrameObservable.add(forget);
  engine.onResizeObservable.add(forget);
  engine.onContextLostObservable.add(forget);
  engine.onContextRestoredObservable.add(forget);
  return tracker;
}

const folding = new WeakSet<object>();

/**
 * Whether the world output pass on `engine` clears the backbuffer's depth and stencil with its colour this frame
 * (`full-target-clear.ts`): set by the Scene Layer compositor before the world draws when layers will draw straight
 * over it with their depth clears skipped where exact (`SceneLayerCompositor.beforeWorld`), cleared after them.
 */
export function setBackbufferDepthStencilFold(engine: object, fold: boolean): void {
  if (fold) folding.add(engine);
  else folding.delete(engine);
}

export function foldsBackbufferDepthStencil(engine: object): boolean {
  return folding.has(engine);
}
