import type { AbstractEngine, Scene, ShadowGenerator } from "@babylonjs/core";
import { isFirstDrawHeld, setFirstDrawHeld, withWarmShadowRender } from "./shadow-first-draw";
import {
  beginPipelineDeferral,
  deferredPipelineCount,
  deferredPipelinesStalled,
  type PipelineDeferral,
} from "./webgpu-pipeline-deferral";

/**
 * WebGPU warm renders of shadow maps. Babylon's shadow pass creates a missing render pipeline synchronously at its
 * draw, so a map's casters' depth pipelines are created ahead by rendering the map inside a warm deferral scope that
 * admits only its own render passes (`renderPassIds`: one per cascade of a cascaded map, per face of a cube map): every
 * draw is skipped, and every missing pipeline starts creating asynchronously, with the map's own target state. A
 * variant prediction's prediction map renders so (`variant-prediction.ts`), as does a map awaiting its first draw
 * (`firstDrawPipelinesReady`).
 */

/**
 * New render pipelines warm renders of shadow maps may start per Engine frame (`engine.frameId`), shared by every view
 * on it: a render runs only while the frame has room, and starts every caster pipeline its map misses, so one render
 * can start more. A render that finds every pipeline costs nothing.
 */
export const WARM_MAP_PIPELINES_PER_FRAME = 2;

const budgets = new WeakMap<AbstractEngine, { frame: number; left: number }>();

function budgetOf(engine: AbstractEngine): { frame: number; left: number } {
  let budget = budgets.get(engine);
  if (!budget) budgets.set(engine, (budget = { frame: -1, left: 0 }));
  if (budget.frame !== engine.frameId) {
    budget.frame = engine.frameId;
    budget.left = WARM_MAP_PIPELINES_PER_FRAME;
  }
  return budget;
}

/** Whether the current Engine frame has room for a warm render of a shadow map. */
export function warmMapRoom(engine: AbstractEngine): boolean {
  return budgetOf(engine).left > 0;
}

/** Charges the Engine frame for the pipelines a warm render started; `pendingBefore` is `deferredPipelineCount` before it. */
export function chargeWarmMap(engine: AbstractEngine, pendingBefore: number): void {
  budgetOf(engine).left -= Math.max(0, deferredPipelineCount(engine) - pendingBefore);
}

/** Maps awaiting their first draw whose last warm render missed a pipeline: its scope, which waits for them. */
const waiting = new WeakMap<ShadowGenerator, PipelineDeferral>();
/** Maps whose warm render threw: they draw as they did without one. */
const failed = new WeakSet<ShadowGenerator>();
/** Scenes whose warm renders failed once already, reported once. */
const reported = new WeakSet<Scene>();

/**
 * A world view's steady frame on WebGPU (`ManagedShadowsTask`): whether `generator`'s map, which awaits its first draw
 * and whose casters' depth Effects are ready, may draw now without creating a pipeline synchronously; until then it
 * stays neutral (nothing samples its content). `render` draws the map with its real draw's target and state, restoring
 * them even when it throws; here it runs as a warm render (`withWarmShadowRender`, so the map's pass observers count no
 * draw), within the Engine frame's warm budget.
 *
 * A warm render that misses no pipeline lets the map draw at once (the real draw follows in the same frame). One that
 * misses waits, rendering nothing, until no pipeline it started is still being created, then renders again (its casters
 * can change meanwhile). The wait ends at the deferral's stall (`deferredPipelinesStalled`: no deferred pipeline started
 * or finished for `PIPELINE_DEFERRAL_STALL_MS`), when the map draws and creates what is still missing synchronously, as
 * a stalled deferral's draws do. A warm render that throws is reported once per scene and is not run again for that
 * map, which draws at once, as without one. A map this holds back is marked (`setFirstDrawHeld`), so a manual Render
 * Target capture can wait a frame for it (`render-target-capture.ts`).
 */
export function firstDrawPipelinesReady(scene: Scene, generator: ShadowGenerator, render: () => void): boolean {
  const ready = warmFirstDraw(scene, generator, render);
  setFirstDrawHeld(generator, !ready);
  if (ready) waiting.delete(generator);
  return ready;
}

function warmFirstDraw(scene: Scene, generator: ShadowGenerator, render: () => void): boolean {
  const engine = scene.getEngine();
  const map = generator.getShadowMap();
  if (!map || failed.has(generator)) return true;
  // A previous wait counts only while it still holds this first draw: a moved or resumed map starts afresh.
  if (isFirstDrawHeld(generator) && waiting.get(generator)?.waiting()) return deferredPipelinesStalled(engine);
  if (!warmMapRoom(engine)) return false;
  const passes = new Set(map.renderPassIds);
  const scope = beginPipelineDeferral(engine, (pass) => passes.has(pass), { warm: true });
  if (!scope) return true;
  const pendingBefore = deferredPipelineCount(engine);
  try {
    withWarmShadowRender(generator, render);
  } catch (error) {
    failed.add(generator);
    if (!reported.has(scene)) {
      reported.add(scene);
      console.warn(`[render] Shadow map warm render failed: ${String(error)}`);
    }
    return true;
  } finally {
    scope.close();
    chargeWarmMap(engine, pendingBefore);
  }
  if (!scope.waiting()) return true;
  waiting.set(generator, scope);
  return false;
}
