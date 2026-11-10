import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterEach, expect, it } from "vitest";
import { stubWebGlDraws, webGlDrawsStubbed } from "./webgl-draw-stub";

const engines: NullEngine[] = [];
afterEach(() => { while (engines.length) engines.pop()!.dispose(); });

/** A context that records the calls made on it, its methods on its prototype as a WebGL2 context's are. */
class RecordingContext {
  readonly calls: string[] = [];
  drawElements(): void { this.calls.push("drawElements"); }
  drawArraysInstanced(): void { this.calls.push("drawArraysInstanced"); }
  clear(): void { this.calls.push("clear"); }
  blitFramebuffer(): void { this.calls.push("blitFramebuffer"); }
  uniform4f(): void { this.calls.push("uniform4f"); }
  uniformMatrix4fv(): void { this.calls.push("uniformMatrix4fv"); }
  uniform1i(): void { this.calls.push("uniform1i"); }
  uniformBlockBinding(): void { this.calls.push("uniformBlockBinding"); }
  bindTexture(): void { this.calls.push("bindTexture"); }
  bufferSubData(): void { this.calls.push("bufferSubData"); }
  texSubImage2D(): void { this.calls.push("texSubImage2D"); }
}
const EVERY_CALL = ["drawElements", "drawArraysInstanced", "clear", "blitFramebuffer", "uniform4f", "uniformMatrix4fv", "uniform1i",
  "uniformBlockBinding", "bindTexture", "bufferSubData", "texSubImage2D"] as const;

function host() {
  const engine = new NullEngine();
  engines.push(engine);
  const context = new RecordingContext();
  const pipeline = { _valueCache: { world: 7 } as Record<string, unknown> };
  Object.assign(engine, { _gl: context, _compiledEffects: { lit: { getPipelineContext: () => pipeline } } });
  const made = () => {
    context.calls.length = 0;
    for (const call of EVERY_CALL) context[call]();
    return [...context.calls];
  };
  return { engine, pipeline, made };
}

it("turns draws, clears, blits and uniform uploads into no-ops, and leaves what binds, uploads to or sets up a resource", () => {
  const { engine, made } = host();
  expect(made()).toEqual([...EVERY_CALL]);
  expect(stubWebGlDraws(engine, true)).toBe(true);
  expect(webGlDrawsStubbed(engine)).toBe(true);
  // A sampler's unit and a block's binding are set once per program, and a texture or buffer written meanwhile must
  // reach the resource the Engine believes is bound.
  expect(made()).toEqual(["uniform1i", "uniformBlockBinding", "bindTexture", "bufferSubData", "texSubImage2D"]);
  // Already stubbed: nothing more to do.
  expect(stubWebGlDraws(engine, true)).toBe(false);
});

it("draws again when ended, with every program's cached uniform values forgotten", () => {
  const { engine, pipeline, made } = host();
  stubWebGlDraws(engine, true);
  expect(stubWebGlDraws(engine, false)).toBe(true);
  expect(webGlDrawsStubbed(engine)).toBe(false);
  expect(made()).toEqual([...EVERY_CALL]);
  // The uploads made meanwhile never reached the programs: their next draws must upload again.
  expect(pipeline._valueCache).toEqual({});
  expect(stubWebGlDraws(engine, false)).toBe(false);
});

it("stubs nothing on WebGPU or on an Engine without a context", () => {
  const webgpu = host();
  Object.defineProperty(webgpu.engine, "isWebGPU", { value: true });
  expect(stubWebGlDraws(webgpu.engine, true)).toBe(false);
  expect(webgpu.made()).toEqual([...EVERY_CALL]);
  const headless = new NullEngine();
  engines.push(headless);
  expect(stubWebGlDraws(headless, true)).toBe(false);
});
