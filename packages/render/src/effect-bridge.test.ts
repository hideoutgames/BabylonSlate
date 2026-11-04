import { afterEach, expect, it, vi } from "vitest";
import { NullEngine, type Effect } from "@babylonjs/core";
import type { WebGLPipelineContext } from "@babylonjs/core/Engines/WebGL/webGLPipelineContext";
import { bridgeEngineEffects, EFFECT_BRIDGE_MS, keepPlayEffects, keptEffectCount, releaseBridgedEffects } from "./effect-bridge";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const engine of engines.splice(0)) engine.dispose();
});

function compile(engine: NullEngine, defines = ""): Effect {
  return engine.createEffect(
    { vertexSource: "void main(){gl_Position=vec4(0.0);}", fragmentSource: "void main(){gl_FragColor=vec4(1.0);}" },
    { attributes: [], uniformsNames: [], samplers: [], defines, fallbacks: null, onCompiled: null, onError: null },
    engine,
  );
}

it("keeps a closed view's Effects for the next view's Materials, then releases those it does not draw", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const shared = compile(engine);
  const unused = compile(engine, "#define UNUSED");
  bridgeEngineEffects(engine);
  // The closing view's draw wrappers release their references.
  shared.dispose();
  unused.dispose();
  expect(shared.isDisposed).toBe(false);
  // The next view's Material finds the compiled Effect in the Engine's cache.
  expect(compile(engine)).toBe(shared);
  releaseBridgedEffects(engine);
  expect(shared.isDisposed).toBe(false);
  expect(unused.isDisposed).toBe(true);
  shared.dispose();
  expect(shared.isDisposed).toBe(true);
});

it("ends a bridge no view presents after its time bound, and a later bridge takes over an earlier one", () => {
  vi.useFakeTimers();
  const engine = new NullEngine();
  engines.push(engine);
  const effect = compile(engine);
  bridgeEngineEffects(engine);
  bridgeEngineEffects(engine);
  effect.dispose();
  // Held once, by the later bridge only.
  expect(effect._refCount).toBe(1);
  vi.advanceTimersByTime(EFFECT_BRIDGE_MS);
  expect(effect.isDisposed).toBe(true);
});

it("keeps a Play view's programs past its close and the editor's next presentation, so the next Play compiles none", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const stop = keepPlayEffects(engine);
  const lit = compile(engine, "#define LIT");
  // A program the load released and asked for again (a graph rebuilt during the load) is the same one.
  lit.dispose();
  expect(compile(engine, "#define LIT")).toBe(lit);
  const sky = compile(engine, "#define SKY");
  stop();
  // Play closes: the bridge holds every Effect, then the editor's reloaded view presents without these.
  bridgeEngineEffects(engine);
  lit.dispose();
  sky.dispose();
  releaseBridgedEffects(engine);
  expect(lit.isDisposed).toBe(false);
  expect(sky.isDisposed).toBe(false);
  // The next Play finds both in the Engine's cache.
  expect(compile(engine, "#define LIT")).toBe(lit);
  expect(compile(engine, "#define SKY")).toBe(sky);
  // Effects returned once the keep has stopped are not kept.
  const preview = compile(engine, "#define PREVIEW");
  preview.dispose();
  expect(preview.isDisposed).toBe(true);
});

it("keeps at most its budget of programs, releasing the least recently returned first", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const stop = keepPlayEffects(engine, 2);
  const first = compile(engine, "#define FIRST");
  const second = compile(engine, "#define SECOND");
  first.dispose();
  second.dispose();
  // Returned again: now the most recent.
  compile(engine, "#define FIRST").dispose();
  const third = compile(engine, "#define THIRD");
  third.dispose();
  stop();
  expect(second.isDisposed).toBe(true);
  expect(first.isDisposed).toBe(false);
  expect(third.isDisposed).toBe(false);
  expect(keptEffectCount(engine)).toBe(2);
});

it("lets a program it stops keeping go only once a parallel-compile driver has finished linking it", async () => {
  vi.useFakeTimers();
  const engine = new NullEngine();
  engines.push(engine);
  // NullEngine has no driver: only its pending-completion query is modelled, as on iPad WebKit or D3D11.
  let linked = false;
  const prepare = engine._preparePipelineContextAsync.bind(engine);
  vi.spyOn(engine, "_preparePipelineContextAsync").mockImplementation((...args) => {
    (args[0] as WebGLPipelineContext).isParallelCompiled = true;
    return prepare(...args);
  });
  vi.spyOn(engine, "_isRenderingStateCompiled").mockImplementation((pipeline) => {
    if (!linked) return false;
    const native = pipeline as WebGLPipelineContext;
    native.onCompiled?.();
    native.onCompiled = undefined;
    return true;
  });
  const deleted = new Set<unknown>();
  const deletePipeline = engine._deletePipelineContext.bind(engine);
  vi.spyOn(engine, "_deletePipelineContext").mockImplementation((pipeline) => {
    deleted.add(pipeline);
    deletePipeline(pipeline);
  });
  const stop = keepPlayEffects(engine, 1);
  const compiling = compile(engine, "#define COMPILING");
  const pipeline = compiling.getPipelineContext();
  expect(compiling.isReady()).toBe(false);
  compiling.dispose();
  // Out of the budget while it still links: Babylon keeps polling its program.
  compile(engine, "#define NEXT").dispose();
  expect(compiling.isDisposed).toBe(false);
  expect(deleted.has(pipeline)).toBe(false);
  linked = true;
  await vi.advanceTimersByTimeAsync(32);
  expect(compiling.isDisposed).toBe(true);
  expect(deleted.has(pipeline)).toBe(true);
  stop();
});

it("lets the kept programs go with a lost context, and forgets their creators' compile callbacks once Play stops", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const stop = keepPlayEffects(engine);
  const created = engine.createEffect(
    { vertexSource: "void main(){gl_Position=vec4(0.0);}", fragmentSource: "void main(){gl_FragColor=vec4(0.5);}" },
    { attributes: [], uniformsNames: [], samplers: [], defines: "", fallbacks: null, onCompiled: () => {}, onError: () => {} },
    engine,
  );
  const held = compile(engine, "#define HELD");
  stop();
  // The closed Play's callbacks (its Materials, its Scene) are no longer reachable from the kept Effect.
  expect(created.onCompiled).toBeNull();
  expect(created.onError).toBeNull();
  created.dispose();
  expect(created.isDisposed).toBe(false);
  engine.onContextLostObservable.notifyObservers(engine);
  // A restore would relink every Effect left in the cache: only the one its owner still holds stays.
  expect(created.isDisposed).toBe(true);
  expect(held.isDisposed).toBe(false);
  expect(keptEffectCount(engine)).toBe(0);
});
