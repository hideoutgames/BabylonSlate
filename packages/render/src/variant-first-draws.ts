import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { variantSwapsTolerated } from "./variant-swaps";
import { effectDrawnOn } from "./first-draw-stats";

/**
 * First draws of new variants in a world view's steady frames.
 *
 * An Effect first requested by a world view that draws steady frames (inside a tolerant scope: its steady frames and
 * their preparations; or inside any readiness round once it has drawn one, such as Play's strict end-of-frame
 * question, which often asks for a new variant first) is cold: it reports not ready in the view's main object pass and
 * blended depth pre-pass, so a Material keeps drawing its previous Effect and a spawned mesh stays hidden
 * (`reveal-pending.ts`). A cold Effect turns ready only when it is admitted, and each steady frame admits at most
 * `FIRST_DRAWS_PER_FRAME` of them (oldest first; one that links inside the frame that requests it is admitted at once
 * while the frame has room), so a burst of swaps spreads its first draws over frames: a new program's first draw can
 * hold a thread (about 100 ms on iPad WebKit WebGL2). A cold Effect is admissible once linked.
 *
 * Admission happens in tolerant rounds and at the start of each steady frame of a view that has drawn one
 * (`admitSteadyFirstDraws`, sharing the frame's budget): a cold variant that no probe counts as a swap (a re-planned
 * graph's new pass, whose draw wrappers keep no previous Effect) starts no round of its own. A strict round of a view's
 * new run (after an invalidation, until it draws steady frames again) probes a cold Effect as it is and settles it once
 * ready: that run waits for every variant anyway, and an Effect left cold by the previous run would otherwise hold its
 * preparation for good.
 */
type ColdEntry = { base: () => boolean };

/**
 * New variants a world view's steady frame admits at most, so their first draws spread over frames. A program's first
 * use holds the thread (about 100 ms on iPad WebKit WebGL2), so one a frame keeps each such frame to one stall.
 */
export const FIRST_DRAWS_PER_FRAME = 1;

type WarmupState = {
  /** Cold Effects, oldest first. */
  cold: Map<Effect, ColdEntry>;
  /** Every Effect the Engine held at installation or returned since (a new one is cold). */
  known: WeakSet<Effect>;
  /** Admissions left in the Engine frame `budgetFrame` (`engine.frameId`), shared by its rounds and views. */
  budget: number;
  budgetFrame: number;
  /** Effects that were cold and are not any more: never cold again. */
  settled: WeakSet<Effect>;
  /** Open readiness rounds of a view that has drawn steady frames: new Effects are cold there too. */
  marking: number;
  /** Open strict rounds of a view's new run: cold Effects are probed as they are, and settle once ready. */
  strict: number;
};

type EffectEngine = { createEffect(...args: unknown[]): Effect };

const states = new WeakMap<AbstractEngine, WarmupState>();
/** Per Engine, the render passes of world views that spread their first draws: a cold Effect is unready only there. */
const warmedPasses = new WeakMap<AbstractEngine, Map<number, number>>();

/**
 * A world view's main object pass and its blended depth pre-pass: a cold Effect waits there only (a probe pass nothing
 * draws, such as the camera's, or a shadow map's takes it at once). Returns the release.
 */
export function registerFirstDrawPasses(engine: AbstractEngine, passIds: readonly number[]): () => void {
  let passes = warmedPasses.get(engine);
  if (!passes) warmedPasses.set(engine, (passes = new Map()));
  const owned = passes;
  for (const id of passIds) owned.set(id, (owned.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of passIds) {
      const count = (owned.get(id) ?? 1) - 1;
      if (count > 0) owned.set(id, count);
      else owned.delete(id);
    }
  };
}

function install(engine: AbstractEngine): WarmupState {
  const target = engine as unknown as EffectEngine;
  const create = target.createEffect;
  if (typeof create !== "function") throw new Error("Unsupported Babylon engine layout: createEffect is missing.");
  const compiled = (engine as unknown as { _compiledEffects?: Record<string, Effect> })._compiledEffects ?? {};
  const state: WarmupState = {
    cold: new Map(), known: new WeakSet(Object.values(compiled)), budget: 0, budgetFrame: -1, settled: new WeakSet(), marking: 0, strict: 0,
  };
  const own = Object.prototype.hasOwnProperty.call(engine, "createEffect");
  if (!warmedPasses.has(engine)) warmedPasses.set(engine, new Map());
  target.createEffect = function (this: EffectEngine, ...args: unknown[]) {
    const effect = create.apply(this, args);
    const known = state.known.has(effect);
    state.known.add(effect);
    if ((state.marking === 0 && !variantSwapsTolerated()) || state.cold.has(effect) || state.settled.has(effect)) return effect;
    // A variant no draw has drawn with has its program's first use ahead, a new one or one compiled and never drawn (a
    // mid-game spawn preparation's warm-up, a mesh hidden at load); untracked Engines count every variant they held at
    // installation or returned since as drawn.
    if (effectDrawnOn(engine, effect) ?? known) return effect;
    // A variant linked as soon as it is requested (a synchronous driver) draws in this frame while it has room.
    if (variantSwapsTolerated() && state.budget > 0 && effect.isReady()) {
      state.budget -= 1;
      state.settled.add(effect);
      return effect;
    }
    makeCold(state, effect);
    return effect;
  };
  engine.onDisposeObservable.addOnce(() => {
    if (own) target.createEffect = create;
    else delete (target as Partial<EffectEngine>).createEffect;
    states.delete(engine);
  });
  return state;
}

function makeCold(state: WarmupState, effect: Effect): void {
  const base = effect.isReady.bind(effect);
  const engine = effect.getEngine();
  const passes = warmedPasses.get(engine)!;
  state.cold.set(effect, { base });
  effect.isReady = () => {
    if (state.strict > 0 && state.cold.has(effect)) {
      const ready = base();
      if (ready) warmUp(state, effect);
      return ready;
    }
    return base() && (!state.cold.has(effect) || !passes.has(engine.currentRenderPassId));
  };
}

/** An Effect that leaves the cold queue keeps its original readiness as its own `isReady` (a bound copy), deliberately: one closure. */
function warmUp(state: WarmupState, effect: Effect): void {
  const entry = state.cold.get(effect);
  if (!entry) return;
  state.cold.delete(effect);
  state.settled.add(effect);
  effect.isReady = entry.base;
}

/**
 * Runs a world view's readiness round: the Effects it requests first are cold when the round is tolerant, or when the
 * view has drawn steady frames (`steady`). A tolerant round (one per steady frame) first admits up to
 * `FIRST_DRAWS_PER_FRAME` admissible cold Effects, oldest first.
 */
export function withFirstDrawRound<T>(engine: AbstractEngine, steady: boolean, run: () => T): T {
  const tolerated = variantSwapsTolerated();
  if (!(tolerated || steady)) {
    const strict = states.get(engine);
    if (!strict?.cold.size) return run();
    strict.strict += 1;
    try {
      return run();
    } finally {
      strict.strict -= 1;
    }
  }
  let state = states.get(engine);
  if (!state) states.set(engine, (state = install(engine)));
  if (tolerated) admitColdEffects(engine, state);
  else {
    // A steady view's strict question (a preparation after the view drew): it draws no frame, so no tolerant round
    // follows to admit a cold Effect, and one that is linked would hold it until its stall. It answers as it is; the
    // first draws it spreads are the frames' own.
    for (const [effect, entry] of state.cold) if (entry.base()) warmUp(state, effect);
  }
  state.marking += 1;
  try {
    return run();
  } finally {
    state.marking -= 1;
  }
}

/**
 * Admits up to the Engine frame's remaining first-draw budget of admissible cold Effects, oldest first. The budget is
 * per Engine frame: a frame's tolerant rounds, its views and the steady frame itself (`admitSteadyFirstDraws`) share it.
 */
function admitColdEffects(engine: AbstractEngine, state: WarmupState): void {
  if (state.budgetFrame !== engine.frameId) {
    state.budgetFrame = engine.frameId;
    state.budget = FIRST_DRAWS_PER_FRAME;
  }
  let budget = state.budget;
  for (const [effect, entry] of state.cold) {
    // A variant that failed to link, every fallback included, never turns ready (the mesh keeps its previous
    // Effect for good): it leaves the queue without a first draw to spread.
    if (effect.getCompilationError() && effect.allFallbacksProcessed()) {
      warmUp(state, effect);
      continue;
    }
    if (budget === 0) break;
    if (!entry.base()) continue;
    warmUp(state, effect);
    budget -= 1;
  }
  state.budget = budget;
}

/**
 * A world view's steady frame admits cold Effects as its tolerant round does, whether or not a round runs in it: a
 * round runs only after an invalidation or while a probe counts a swap, and a cold variant is not always a swap. A
 * re-planned graph's new passes give a mesh draw wrappers with no previous Effect to keep, and a variant its real
 * draws first ask for there (a Water quality change, which marks frozen water Materials dirty after the frame's probe)
 * otherwise stayed cold, the mesh drawing nothing, until something else invalidated the view.
 */
export function admitSteadyFirstDraws(engine: AbstractEngine): void {
  const state = states.get(engine);
  if (state?.cold.size) admitColdEffects(engine, state);
}
