import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { engineFrameBackpressure } from "./frame-backpressure";

/**
 * A measurement, never a mode (as `webgl-draw-stub.ts`): every call on the Engine's WebGL context timed on the main
 * thread, by what it does, so a Check can say where a frame's CPU time goes inside WebGL. Where the context runs in
 * another process (WebKit's GPU process), a call that returns a value to JavaScript waits until that process has taken
 * every earlier call: its time is that wait. The present at the end of the browser's frame is not a context call and is
 * not timed.
 *
 * Groups: the calls that return a value, each of `WEBGL_TIMED_READS` alone and the rest together (`reads`: every other
 * `get*`, `is*` and `check*` call); `draws`; `clears` (clears and framebuffer blits); `uniforms`; `uploads` (buffer
 * and texture data and storage); `other`, everything else on the context.
 */
export const WEBGL_TIMED_READS = [
  "fenceSync", "clientWaitSync", "getSyncParameter", "getError", "checkFramebufferStatus", "readPixels", "getParameter",
] as const;
export const WEBGL_CALL_GROUPS = [...WEBGL_TIMED_READS, "reads", "draws", "clears", "uniforms", "uploads", "other"] as const;
export type WebGlCallGroup = (typeof WEBGL_CALL_GROUPS)[number];

/** Time and calls since the timing started, per group, and the Engine frames that rendered since (`renderedThisFrame`). */
export interface WebGlCallTotals {
  frames: number;
  groups: Record<WebGlCallGroup, { ms: number; calls: number }>;
}

const DRAWS = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);
const CLEARS = new Set(["clear", "clearBufferfv", "clearBufferiv", "clearBufferuiv", "clearBufferfi", "blitFramebuffer"]);
const UPLOADS = /^(bufferData|bufferSubData|copyBufferSubData|texImage|texSubImage|compressedTex|copyTex|texStorage)/;
const READS = new Set<string>(WEBGL_TIMED_READS);

/** The group a context call is timed in, by its name. */
export function webGlCallGroup(name: string): WebGlCallGroup {
  if (READS.has(name)) return name as WebGlCallGroup;
  if (/^(get|is|check)[A-Z]/.test(name)) return "reads";
  // `drawBuffers` sets the draw buffer list: state, not a draw.
  if (DRAWS.has(name)) return "draws";
  if (CLEARS.has(name)) return "clears";
  if (name.startsWith("uniform")) return "uniforms";
  if (UPLOADS.test(name)) return "uploads";
  return "other";
}

type Context = Record<string, unknown>;
type Timing = { totals: WebGlCallTotals; restore: () => void };

const timings = new WeakMap<AbstractEngine, Timing>();

function emptyTotals(): WebGlCallTotals {
  return { frames: 0, groups: Object.fromEntries(WEBGL_CALL_GROUPS.map((group) => [group, { ms: 0, calls: 0 }])) as WebGlCallTotals["groups"] };
}

/** Every method name on `context`'s prototype chain (a WebGL2 context's calls are prototype methods). */
function contextCalls(context: Context): string[] {
  const names = new Set<string>();
  for (let prototype: object | null = Object.getPrototypeOf(context) as object | null; prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor && typeof descriptor.value === "function") names.add(name);
    }
  }
  return [...names];
}

/**
 * Times every call on `engine`'s context (`on`) or stops (`off`); whether it did. False on an Engine without a context
 * and when it already is as asked. Each call becomes an own property that times the call it shadows (the prototype's,
 * or a wrapper already installed as an own property); stopping puts back exactly what was there before, so off it costs
 * nothing and the context is as it was found. Totals are kept until it stops (`webGlCallTotals`).
 */
export function timeWebGlCalls(engine: AbstractEngine, on: boolean, now: () => number = () => performance.now()): boolean {
  const timing = timings.get(engine);
  if (!on) {
    if (!timing) return false;
    timings.delete(engine);
    timing.restore();
    return true;
  }
  const context = (engine as unknown as { _gl?: Context })._gl;
  if (timing || !context) return false;
  const totals = emptyTotals();
  const restores: (() => void)[] = [];
  for (const name of contextCalls(context)) {
    const original = context[name];
    if (typeof original !== "function") continue;
    const previous = Object.getOwnPropertyDescriptor(context, name);
    const group = totals.groups[webGlCallGroup(name)];
    const timed = function timed(this: unknown, ...args: unknown[]) {
      const start = now();
      try {
        return (original as (...rest: unknown[]) => unknown).apply(context, args);
      } finally {
        group.ms += now() - start;
        group.calls += 1;
      }
    };
    context[name] = timed;
    restores.push(() => {
      // A wrapper installed over this one meanwhile is left as it is: removing this one would remove it too.
      if (context[name] !== timed) return;
      if (previous) Object.defineProperty(context, name, previous);
      else delete context[name];
    });
  }
  // Counted after the frames-in-flight gate's own frame end, which records whether a view rendered in the frame.
  const gate = engineFrameBackpressure(engine);
  const frameEnd = engine.onEndFrameObservable.add(() => { if (gate.renderedThisFrame()) totals.frames += 1; });
  timings.set(engine, {
    totals,
    restore: () => {
      engine.onEndFrameObservable.remove(frameEnd);
      for (const restore of restores.splice(0).reverse()) restore();
    },
  });
  return true;
}

/** Whether `engine`'s context calls are timed now. */
export function webGlCallsTimed(engine: AbstractEngine): boolean {
  return timings.has(engine);
}

/** A copy of the totals since `engine`'s timing started; null while it is not timed. */
export function webGlCallTotals(engine: AbstractEngine): WebGlCallTotals | null {
  const totals = timings.get(engine)?.totals;
  if (!totals) return null;
  return { frames: totals.frames, groups: Object.fromEntries(WEBGL_CALL_GROUPS.map((group) => [group, { ...totals.groups[group] }])) as WebGlCallTotals["groups"] };
}
