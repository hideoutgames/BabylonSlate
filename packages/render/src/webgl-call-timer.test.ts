import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterEach, expect, it } from "vitest";
import { engineFrameBackpressure } from "./frame-backpressure";
import { timeWebGlCalls, webGlCallGroup, webGlCallsTimed, webGlCallTotals } from "./webgl-call-timer";

const engines: NullEngine[] = [];
afterEach(() => { while (engines.length) engines.pop()!.dispose(); });

/** A context whose calls are prototype methods, as a WebGL2 context's are; each advances the clock by its cost. */
class TimedContext {
  constructor(private readonly clock: { now: number }) {}
  fenceSync(): string { this.clock.now += 4; return "fence"; }
  getError(): number { this.clock.now += 1; return 0; }
  getShaderParameter(): boolean { this.clock.now += 2; return true; }
  drawElements(): void { this.clock.now += 0.5; }
  clear(): void { this.clock.now += 0.25; }
  blitFramebuffer(): void { this.clock.now += 0.25; }
  uniform4f(): void { this.clock.now += 0.125; }
  bufferSubData(): void { this.clock.now += 1; }
  bindTexture(): void { this.clock.now += 0.5; }
}

function host() {
  const engine = new NullEngine();
  engines.push(engine);
  const clock = { now: 0 };
  const context = new TimedContext(clock);
  // The gate is made first, with the Engine's own context: it submits no frame-end fence into this one.
  engineFrameBackpressure(engine).setMode("off");
  Object.assign(engine, { _gl: context });
  /** One Engine frame making `calls`; `rendered`: a view rendered in it (the frames-in-flight gate admitted it). */
  const frame = (calls: (keyof TimedContext)[], rendered = true) => {
    engine.beginFrame();
    if (rendered) engineFrameBackpressure(engine).admit();
    for (const call of calls) (context[call] as () => unknown)();
    engine.endFrame();
  };
  return { engine, clock, context, frame };
}

it("groups a call by what it does: each named read alone, other reads, draws, clears and blits, uniforms, uploads, the rest", () => {
  expect(["fenceSync", "getSyncParameter", "readPixels", "getParameter", "getShaderParameter", "isContextLost", "checkFramebufferStatus",
    "drawArraysInstanced", "drawBuffers", "blitFramebuffer", "clearBufferfv", "uniformMatrix4fv", "uniform1i", "texSubImage2D", "texStorage3D",
    "bufferData", "bindFramebuffer", "createBuffer"].map(webGlCallGroup)).toEqual([
    "fenceSync", "getSyncParameter", "readPixels", "getParameter", "reads", "reads", "checkFramebufferStatus",
    "draws", "other", "clears", "clears", "uniforms", "uniforms", "uploads", "uploads", "uploads", "other", "other",
  ]);
});

it("times each call while on, per group, over the frames a view rendered in, and returns what the call returns", () => {
  const { engine, clock, context, frame } = host();
  expect(timeWebGlCalls(engine, true, () => clock.now)).toBe(true);
  expect(webGlCallsTimed(engine)).toBe(true);
  expect(timeWebGlCalls(engine, true, () => clock.now)).toBe(false);
  expect(context.fenceSync()).toBe("fence");
  frame(["drawElements", "drawElements", "uniform4f", "clear", "blitFramebuffer", "bufferSubData", "getShaderParameter"]);
  // A frame every view skipped: its calls (the fence poll) still count, but not as a frame.
  frame(["getError"], false);
  frame(["drawElements", "bindTexture"]);
  const totals = webGlCallTotals(engine)!;
  expect(totals.frames).toBe(2);
  expect(totals.groups).toMatchObject({
    fenceSync: { ms: 4, calls: 1 }, getError: { ms: 1, calls: 1 }, reads: { ms: 2, calls: 1 },
    draws: { ms: 1.5, calls: 3 }, clears: { ms: 0.5, calls: 2 }, uniforms: { ms: 0.125, calls: 1 },
    uploads: { ms: 1, calls: 1 }, other: { ms: 0.5, calls: 1 }, getParameter: { ms: 0, calls: 0 },
  });
  // A copy: reading again later does not change what was read.
  frame(["drawElements"]);
  expect(totals.groups.draws.calls).toBe(3);
  expect(webGlCallTotals(engine)!.groups.draws.calls).toBe(4);
});

it("puts back exactly the calls it found, a wrapper already installed as an own property included", () => {
  const { engine, clock, context } = host();
  const own = context as unknown as Record<string, unknown>;
  const installed = function installed() { return "wrapped"; };
  own.getError = installed;
  const before = Object.getOwnPropertyNames(context).sort();
  timeWebGlCalls(engine, true, () => clock.now);
  expect(own.getError).not.toBe(installed);
  expect(context.getError()).toBe("wrapped");
  expect(timeWebGlCalls(engine, false)).toBe(true);
  expect(Object.getOwnPropertyNames(context).sort()).toEqual(before);
  expect(own.getError).toBe(installed);
  expect(Object.hasOwn(context, "drawElements")).toBe(false);
  expect([webGlCallsTimed(engine), webGlCallTotals(engine), timeWebGlCalls(engine, false)]).toEqual([false, null, false]);
  // Off, nothing is timed and no frame is counted.
  const drawn = clock.now;
  context.drawElements();
  expect(clock.now - drawn).toBe(0.5);
});

it("times nothing on an Engine without a context", () => {
  const headless = new NullEngine();
  engines.push(headless);
  expect(timeWebGlCalls(headless, true)).toBe(false);
  expect(webGlCallTotals(headless)).toBeNull();
});
