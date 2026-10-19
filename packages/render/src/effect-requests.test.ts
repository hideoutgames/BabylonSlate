import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, type Effect } from "@babylonjs/core";
import { collectEffectRequests } from "./effect-requests";

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
