import { NullEngine, type Effect } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitSteadyFirstDraws, FIRST_DRAWS_PER_FRAME, registerPipelineWarmPasses, withPipelineWarmupRound,
} from "./variant-pipeline-warmup";
import { probeVariantSwaps } from "./variant-swaps";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** A NullEngine whose main object pass a world view warms, with that pass current, as in its real draws. */
function steadyView() {
  const engine = new NullEngine();
  engines.push(engine);
  const pass = engine.createRenderPassId("Forward objects");
  registerPipelineWarmPasses(engine, [pass]);
  engine.currentRenderPassId = pass;
  const nextFrame = () => { (engine as unknown as { _frameId: number })._frameId += 1; };
  return { engine, nextFrame };
}

/**
 * Variants first requested in one readiness round of a view that has drawn steady frames (a strict question, which
 * admits none it requests), so they are cold: unready in the view's main pass until admitted.
 */
function coldVariants(engine: NullEngine, ids: readonly number[]): Effect[] {
  return withPipelineWarmupRound(engine, true, () => ids.map((id) => engine.createEffect(
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
    const budget = FIRST_DRAWS_PER_FRAME.webgl2;
    const variants = coldVariants(engine, Array.from({ length: 2 * budget + 1 }, (_, index) => index));
    const admitted = (count: number) => variants.map((_, index) => index < count);
    nextFrame();
    admitSteadyFirstDraws(engine);
    // The same frame's tolerant round admits nothing more: the frame already spent its first draws.
    probeVariantSwaps(true, () => withPipelineWarmupRound(engine, true, () => undefined));
    expect(variants.map((variant) => variant.isReady())).toEqual(admitted(budget));
    nextFrame();
    admitSteadyFirstDraws(engine);
    expect(variants.map((variant) => variant.isReady())).toEqual(admitted(2 * budget));
  });
});
