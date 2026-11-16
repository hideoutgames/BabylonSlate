import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";

/**
 * Debug (`discardsamples`): after a frame's last write to a multisampled target is resolved, its samples are discarded
 * (`invalidateFramebuffer`), so a tile-based GPU need not store them; a measurement of what storing them costs, a
 * switch until it is decided as behaviour.
 *
 * Every frame graph render pass resolves its multisampled targets as it unbinds them, so a target is resolved after
 * "Forward clear", again after "Forward objects" and after any later pass that draws into it again (water's "Forward
 * transparent" reloads the samples). Only the render pass that writes a multisampled texture last in the graph's order
 * (`lastSampleWriters`, enabled and disabled passes both counted as writers) discards it, after its own resolve; and a
 * colour it does not resolve (`resolveMSAAColors` off: `MultisamplePresentTask` reads the samples) only after that
 * task's blit. Nothing is decided when the graph is built: the switch is read at each resolve.
 */

/** Engines whose `discardsamples` is on. */
const enabled = new WeakSet<AbstractEngine>();
/** Engines whose multisampled resolve also discards (`installSampleDiscard`). */
const hooked = new WeakSet<AbstractEngine>();

/** The sample attachments of a pass's render target that nothing reads after its resolve. */
export interface SampleDiscard {
  /** Colour attachment indices. */
  colors: readonly number[];
  depth: boolean;
}

/** Per render target of a frame graph pass that writes a multisampled texture last: what it discards. */
const discards = new WeakMap<RenderTargetWrapper, SampleDiscard>();

/** Switches `discardsamples` for `engine`; true when that changed it. */
export function setDiscardSamples(engine: AbstractEngine, on: boolean): boolean {
  if (enabled.has(engine) === on) return false;
  if (on) enabled.add(engine); else enabled.delete(engine);
  return true;
}

/** Whether `engine` discards samples after their last resolve (`RenderDiagnostics.settings`' `msaa.discard`). */
export function discardsSamples(engine: AbstractEngine): boolean {
  return enabled.has(engine);
}

/** A frame graph pass as `lastSampleWriters` reads it: a render pass has `setRenderTarget`. */
export interface SampleWriterPass {
  setRenderTarget?: unknown;
  readonly renderTarget?: FrameGraphTextureHandle | FrameGraphTextureHandle[];
  readonly renderTargetDepth?: FrameGraphTextureHandle;
  readonly frameGraphRenderTarget?: { readonly renderTargetWrapper?: RenderTargetWrapper };
}

/** A frame graph task as `lastSampleWriters` reads it, in execution order. */
export interface SampleWriterTask {
  readonly passes: readonly unknown[];
  readonly passesDisabled: readonly unknown[];
}

/**
 * For each multisampled texture the tasks' render passes draw into, the pass that draws into it last in execution
 * order, with the attachments that are its; a task's disabled passes count as writers too, so a pass that might not be
 * last is never chosen.
 */
export function lastSampleWriters(
  tasks: readonly SampleWriterTask[], multisampled: (handle: FrameGraphTextureHandle) => boolean,
): Map<SampleWriterPass, SampleDiscard> {
  const last = new Map<FrameGraphTextureHandle, { pass: SampleWriterPass; color: number | null }>();
  for (const task of tasks) {
    for (const entry of [...task.passes, ...task.passesDisabled]) {
      const pass = entry as SampleWriterPass;
      if (pass.setRenderTarget === undefined) continue;
      const colors = pass.renderTarget === undefined ? [] : Array.isArray(pass.renderTarget) ? pass.renderTarget : [pass.renderTarget];
      colors.forEach((handle, index) => { if (handle !== undefined) last.set(handle, { pass, color: index }); });
      if (pass.renderTargetDepth !== undefined) last.set(pass.renderTargetDepth, { pass, color: null });
    }
  }
  const writers = new Map<SampleWriterPass, SampleDiscard>();
  for (const [handle, { pass, color }] of last) {
    if (!multisampled(handle)) continue;
    const discard = writers.get(pass) ?? { colors: [], depth: false };
    writers.set(pass, color === null ? { ...discard, depth: true } : { ...discard, colors: [...discard.colors, color].sort((a, b) => a - b) });
  }
  return writers;
}

/** Marks the render targets of a graph's last multisampled writers (`lastSampleWriters`), after each build. */
export function markLastSampleWriters(
  tasks: readonly SampleWriterTask[], multisampled: (handle: FrameGraphTextureHandle) => boolean,
): void {
  for (const [pass, discard] of lastSampleWriters(tasks, multisampled)) {
    const target = pass.frameGraphRenderTarget?.renderTargetWrapper;
    if (target) discards.set(target, discard);
  }
}

type DiscardTarget = RenderTargetWrapper & {
  _MSAAFramebuffer?: WebGLFramebuffer | null;
  _generateStencilBuffer?: boolean;
  resolveMSAAColors?: boolean;
};
type ResolvingEngine = AbstractEngine & {
  _gl?: WebGL2RenderingContext;
  resolveMultiFramebuffer?: (texture: RenderTargetWrapper) => void;
};

/**
 * Has `engine`'s multisampled resolve (`resolveMultiFramebuffer`, which every frame graph target takes) discard what a
 * marked render target leaves unread, while `discardsamples` is on. Once per Engine.
 */
export function installSampleDiscard(engine: AbstractEngine): void {
  if (hooked.has(engine)) return;
  hooked.add(engine);
  const target = engine as ResolvingEngine;
  const resolve = target.resolveMultiFramebuffer;
  if (typeof resolve !== "function") return;
  target.resolveMultiFramebuffer = function resolveAndDiscard(this: ResolvingEngine, texture: RenderTargetWrapper) {
    resolve.call(this, texture);
    if (enabled.has(engine)) discardResolved(target, texture as DiscardTarget);
  };
}

/** After a resolve, which leaves the multisampled framebuffer bound: invalidates the attachments nothing reads again. */
function discardResolved(engine: ResolvingEngine, texture: DiscardTarget): void {
  const discard = discards.get(texture);
  const gl = engine._gl;
  if (!discard || !gl || !texture._MSAAFramebuffer || typeof gl.invalidateFramebuffer !== "function") return;
  const attachments: number[] = [];
  // An unresolved colour is still read (the multisampled present blit).
  if (texture.resolveMSAAColors !== false) for (const index of discard.colors) attachments.push(gl.COLOR_ATTACHMENT0 + index);
  if (discard.depth) {
    attachments.push(gl.DEPTH_ATTACHMENT);
    if (texture._generateStencilBuffer) attachments.push(gl.STENCIL_ATTACHMENT);
  }
  if (attachments.length) gl.invalidateFramebuffer(gl.FRAMEBUFFER, attachments);
}

/** After `MultisamplePresentTask`'s blit, with its read framebuffer still bound: discards the colour samples it read. */
export function discardPresentedSamples(engine: AbstractEngine, gl: WebGL2RenderingContext): void {
  if (enabled.has(engine) && typeof gl.invalidateFramebuffer === "function") gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
}
