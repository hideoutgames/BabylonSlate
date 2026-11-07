import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Observable } from "@babylonjs/core/Misc/observable";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { collectEffectRequests, countEffectCompiles } from "./effect-requests";

describe("Effect request collection", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const engine of engines.splice(0)) engine.dispose();
  });
  /** An Engine whose `createEffect` hands out these Effects in order. */
  function engineMaking(count: number) {
    const engine = new NullEngine();
    engines.push(engine);
    const made = Array.from({ length: count }, (_, index) => ({ name: `effect-${index}` }) as unknown as Effect);
    let next = 0;
    vi.spyOn(engine, "createEffect").mockImplementation((() => made[next++]) as unknown as typeof engine.createEffect);
    return { engine, made };
  }

  it("gives each owner the Effects requested while its own call runs, nested calls included", () => {
    const { engine, made } = engineMaking(5);
    const outer = new Set<Effect>();
    const inner = new Set<Effect>();
    engine.createEffect("before", [], [], [], "");
    collectEffectRequests(engine, outer, () => {
      engine.createEffect("outer", [], [], [], "");
      collectEffectRequests(engine, inner, () => engine.createEffect("inner", [], [], [], ""));
      engine.createEffect("outer again", [], [], [], "");
    });
    engine.createEffect("after", [], [], [], "");
    expect([...outer]).toEqual([made[1], made[2], made[3]]);
    expect([...inner]).toEqual([made[2]]);
  });

  it("returns the probe's result and stops collecting when it throws", () => {
    const { engine, made } = engineMaking(2);
    const into = new Set<Effect>();
    expect(collectEffectRequests(engine, into, () => 7)).toBe(7);
    expect(() => collectEffectRequests(engine, into, () => {
      engine.createEffect("during", [], [], [], "");
      throw new Error("probe failed");
    })).toThrow("probe failed");
    engine.createEffect("after", [], [], [], "");
    expect([...into]).toEqual([made[0]]);
  });
});

// A loading phase shows this count while its passes compile programs no warm-up unit counted.
describe("Effect compile counting", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const engine of engines.splice(0)) engine.dispose();
  });
  function compile(engine: NullEngine, defines: string): Effect {
    return engine.createEffect(
      { vertexSource: "void main(){gl_Position=vec4(0.0);}", fragmentSource: "void main(){gl_FragColor=vec4(1.0);}" },
      { attributes: [], uniformsNames: [], samplers: [], defines, fallbacks: null, onCompiled: null, onError: null },
      engine,
    );
  }

  it("counts the programs compiled after it began, not cached ones, until stopped", () => {
    const engine = new NullEngine();
    engines.push(engine);
    compile(engine, "#define CACHED");
    const counts: string[] = [];
    const stop = countEffectCompiles(engine, ({ compiled, requested }) => counts.push(`${compiled}/${requested}`));
    // A cache hit compiles nothing; a new variant links (at once on this Engine) and is counted once however often requested.
    compile(engine, "#define CACHED");
    compile(engine, "#define NEW_A");
    compile(engine, "#define NEW_A");
    compile(engine, "#define NEW_B");
    stop();
    compile(engine, "#define AFTER");
    expect(counts).toEqual(["1/1", "2/2"]);
  });

  it("counts a program still linking once Babylon reports it compiled", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const counts: string[] = [];
    const pending = { isReady: () => false, onCompileObservable: new Observable<Effect>() } as unknown as Effect;
    // The Engine's own createEffect, which the counting wraps.
    vi.spyOn(engine, "createEffect").mockReturnValueOnce(pending);
    const stop = countEffectCompiles(engine, ({ compiled, requested }) => counts.push(`${compiled}/${requested}`));
    engine.createEffect("linking", [], [], [], "");
    expect(counts).toEqual(["0/1"]);
    pending.onCompileObservable.notifyObservers(pending);
    expect(counts).toEqual(["0/1", "1/1"]);
    stop();
  });
});
