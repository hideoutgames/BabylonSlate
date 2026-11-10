import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";

/**
 * A measurement, never a mode: a view's frames with the WebGL2 calls that make the GPU work turned into no-ops, so the
 * frame's CPU time that remains is the engine's own JavaScript and the state it sets. A Check reads it beside the
 * normal frame to say how a frame's CPU time divides between the two (`feature-test-check.ts`).
 *
 * Stubbed: every draw, clear and framebuffer blit, and every uniform upload but the two that also assign a sampler
 * its unit (`uniform1i`, `uniform1iv`), which a program linked meanwhile needs. Everything that binds, allocates or
 * uploads to a resource stays real, so the context's state stays what the Engine believes it is and nothing
 * allocated or uploaded meanwhile is lost. The canvas shows no new frame meanwhile (what it shows is the browser's to
 * decide: its last composited frame, or an emptied drawing buffer). Ending it forgets each program's cached uniform
 * values, which the stubbed uploads never reached, so the next draws upload them again.
 */
const STUBBED = [
  "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements",
  "clear", "clearBufferfv", "clearBufferiv", "clearBufferuiv", "clearBufferfi", "blitFramebuffer",
] as const;
const KEPT_UNIFORMS = new Set(["uniform1i", "uniform1iv", "uniformBlockBinding"]);

type Context = Record<string, unknown>;
type StubEngine = { _gl?: Context; _compiledEffects?: Record<string, Effect> };

const stubs = new WeakMap<AbstractEngine, () => void>();
const noop = (): void => {};

/** The calls `context` has that the measurement turns off. */
function stubbedCalls(context: Context): string[] {
  const names = new Set<string>(STUBBED);
  for (let prototype: object | null = Object.getPrototypeOf(context) as object | null; prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null) {
    for (const name of Object.getOwnPropertyNames(prototype)) if (name.startsWith("uniform") && !KEPT_UNIFORMS.has(name)) names.add(name);
  }
  return [...names].filter((name) => typeof context[name] === "function");
}

/**
 * Turns `engine`'s draws, clears and uniform uploads into no-ops (`on`) or back; whether it did. False on WebGPU, on
 * an Engine without a context, and when it already is as asked.
 */
export function stubWebGlDraws(engine: AbstractEngine, on: boolean): boolean {
  const restore = stubs.get(engine);
  if (!on) {
    if (!restore) return false;
    stubs.delete(engine);
    restore();
    return true;
  }
  const target = engine as unknown as StubEngine;
  const context = target._gl;
  if (restore || engine.isWebGPU || !context) return false;
  const names = stubbedCalls(context);
  // Own properties shadow the prototype's methods, which deleting them brings back.
  for (const name of names) context[name] = noop;
  stubs.set(engine, () => {
    for (const name of names) delete context[name];
    for (const effect of Object.values(target._compiledEffects ?? {})) {
      const pipeline = effect.getPipelineContext() as { _valueCache?: Record<string, unknown> } | null;
      if (pipeline?._valueCache) pipeline._valueCache = {};
    }
  });
  return true;
}

/** Whether `engine`'s draws are stubbed now. */
export function webGlDrawsStubbed(engine: AbstractEngine): boolean {
  return stubs.has(engine);
}
