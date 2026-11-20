import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitSteadyFirstDraws, FIRST_DRAWS_PER_FRAME, registerFirstDrawPasses, withFirstDrawRound,
} from "./variant-first-draws";
import { probeVariantSwaps } from "./variant-swaps";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** A NullEngine whose main object pass a world view warms, with that pass current, as in its real draws. */
function steadyView() {
  const engine = new NullEngine();
  engines.push(engine);
  const pass = engine.createRenderPassId("Forward objects");
  registerFirstDrawPasses(engine, [pass]);
  engine.currentRenderPassId = pass;
  const nextFrame = () => { (engine as unknown as { _frameId: number })._frameId += 1; };
  return { engine, nextFrame };
}

/**
 * Variants first requested in one readiness round of a view that has drawn steady frames (a strict question, which
 * admits none it requests), so they are cold: unready in the view's main pass until admitted.
 */
function coldVariants(engine: NullEngine, ids: readonly number[]): Effect[] {
  return withFirstDrawRound(engine, true, () => ids.map((id) => engine.createEffect(
    { vertexSource: `void main() { gl_Position = vec4(${id}.0); }`, fragmentSource: `void main() { gl_FragColor = vec4(${id}.0); }` },
    ["position"], [], [], `#define VARIANT_${id}`,
  )));
}

describe("first draws of new variants in a world view's steady frames", () => {
  it("a steady frame admits a cold variant that no readiness round admitted", () => {
    const { engine } = steadyView();
    const [variant] = coldVariants(engine, [1]) as [Effect];
    // Linked, but cold: the view's main pass may not draw it yet.
    expect(variant.isReady()).toBe(false);
    admitSteadyFirstDraws(engine);
    expect(variant.isReady()).toBe(true);
  });

  it("a steady frame and its rounds share one frame's first-draw budget, oldest first", () => {
    const { engine, nextFrame } = steadyView();
    const budget = FIRST_DRAWS_PER_FRAME;
    const variants = coldVariants(engine, Array.from({ length: 2 * budget + 1 }, (_, index) => index));
    const admitted = (count: number) => variants.map((_, index) => index < count);
    nextFrame();
    admitSteadyFirstDraws(engine);
    // The same frame's tolerant round admits nothing more: the frame already spent its first draws.
    probeVariantSwaps(true, () => withFirstDrawRound(engine, true, () => undefined));
    expect(variants.map((variant) => variant.isReady())).toEqual(admitted(budget));
    nextFrame();
    admitSteadyFirstDraws(engine);
    expect(variants.map((variant) => variant.isReady())).toEqual(admitted(2 * budget));
  });

  it("a steady view's strict question admits linked cold variants from the frame's budget, so it passes within as many frames, never all at once", () => {
    const { engine, nextFrame } = steadyView();
    const variants = coldVariants(engine, [1, 2, 3]);
    // A quality change's preparation asks the strict question every frame until every variant it waits on is ready.
    const ask = () => withFirstDrawRound(engine, true, () => variants.map((variant) => variant.isReady()));
    expect(ask()).toEqual([true, false, false]);
    // Asked again in the same Engine frame, it admits nothing more: that frame's first draw is spent.
    expect(ask()).toEqual([true, false, false]);
    nextFrame();
    expect(ask()).toEqual([true, true, false]);
    nextFrame();
    expect(ask()).toEqual([true, true, true]);
  });

  const linkedVariant = (engine: NullEngine, id: number): Effect => probeVariantSwaps(true, () => engine.createEffect(
    { vertexSource: `void main() { gl_Position = vec4(${id}.0); }`, fragmentSource: `void main() { gl_FragColor = vec4(${id}.0); }` },
    ["position"], [], [], `#define VARIANT_${id}`,
  ));

  it("gives a variant linked as it is requested the budget of the frame it is requested in", () => {
    const { engine, nextFrame } = steadyView();
    coldVariants(engine, [1]);
    nextFrame();
    admitSteadyFirstDraws(engine);
    nextFrame();
    admitSteadyFirstDraws(engine);
    // The queue was empty this frame, so nothing else has asked for its budget yet.
    expect(linkedVariant(engine, 2).isReady()).toBe(true);
  });

  it("does not spend an earlier frame's unspent budget on top of the frame's own", () => {
    const { engine, nextFrame } = steadyView();
    const [cold] = coldVariants(engine, [1]) as [Effect];
    nextFrame();
    const linked = linkedVariant(engine, 2);
    admitSteadyFirstDraws(engine);
    expect([linked.isReady(), cold.isReady()]).toEqual([true, false]);
  });

  it("spends no first draw on a cold variant disposed before its admission", () => {
    const { engine, nextFrame } = steadyView();
    const [stale, waiting] = coldVariants(engine, [1, 2]) as [Effect, Effect];
    stale.dispose(true);
    nextFrame();
    admitSteadyFirstDraws(engine);
    expect(waiting.isReady()).toBe(true);
  });
});
