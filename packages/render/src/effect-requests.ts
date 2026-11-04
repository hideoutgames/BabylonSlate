import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";

type EffectEngine = { createEffect(...args: unknown[]): Effect };

type Requests = {
  /** The sets the open `collectEffectRequests` calls fill, innermost last. */
  open: Set<Effect>[];
  /** `watchEngineEffects` listeners, told of every Effect the Engine returns. */
  watchers: Set<(effect: Effect) => void>;
};

const engines = new WeakMap<AbstractEngine, Requests>();

function requestsFor(engine: AbstractEngine): Requests {
  const existing = engines.get(engine);
  if (existing) return existing;
  const target = engine as unknown as EffectEngine;
  const create = target.createEffect;
  if (typeof create !== "function") throw new Error("Unsupported Babylon engine layout: createEffect is missing.");
  const requests: Requests = { open: [], watchers: new Set() };
  const own = Object.prototype.hasOwnProperty.call(engine, "createEffect");
  target.createEffect = function (this: EffectEngine, ...args: unknown[]) {
    const effect = create.apply(this, args);
    // A cached Effect another owner built first is still this owner's request.
    for (const into of requests.open) into.add(effect);
    for (const watch of requests.watchers) watch(effect);
    return effect;
  };
  engine.onDisposeObservable.addOnce(() => {
    if (own) target.createEffect = create;
    else delete (target as Partial<EffectEngine>).createEffect;
    engines.delete(engine);
  });
  engines.set(engine, requests);
  return requests;
}

/**
 * Runs `run`, adding every Effect the Engine's `createEffect` returns meanwhile to `into`. Babylon requests
 * an Effect when a probe first needs a variant and then waits on it, so the set names the Effects one owner's
 * own readiness probes wait for among everything compiling on the shared Engine (previews, thumbnails and
 * Custom GLSL probes included). Only code that runs inside `run` is attributed, never work that awaits.
 */
export function collectEffectRequests<T>(engine: AbstractEngine, into: Set<Effect>, run: () => T): T {
  const { open } = requestsFor(engine);
  open.push(into);
  try {
    return run();
  } finally {
    open.splice(open.lastIndexOf(into), 1);
  }
}

/** Tells `watch` of every Effect the Engine's `createEffect` returns, a cached one included, until the returned stop. */
export function watchEngineEffects(engine: AbstractEngine, watch: (effect: Effect) => void): () => void {
  const { watchers } = requestsFor(engine);
  // A listener of its own: one function passed twice still stops each watch separately.
  const listener = (effect: Effect) => watch(effect);
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/**
 * Counts the programs the Engine compiles until the returned stop is called: each Effect `createEffect` returns that
 * was not in the Engine's cache when counting began, and how many of them have compiled (at once where links are
 * synchronous, at Babylon's readiness notification on a parallel-compile driver). `onChange` hears every change. A
 * loading phase reports it as progress while its passes compile what no warm-up unit counted.
 */
export function countEffectCompiles(
  engine: AbstractEngine,
  onChange: (count: { compiled: number; requested: number }) => void,
): () => void {
  const cached = new Set(Object.values((engine as unknown as { _compiledEffects?: Record<string, Effect> })._compiledEffects ?? {}));
  const counted = new Set<Effect>();
  let compiled = 0;
  let stopped = false;
  const report = () => { if (!stopped) onChange({ compiled, requested: counted.size }); };
  const watch = (effect: Effect) => {
    if (cached.has(effect) || counted.has(effect)) return;
    counted.add(effect);
    if (effect.isReady()) compiled += 1;
    else effect.onCompileObservable.addOnce(() => { compiled += 1; report(); });
    report();
  };
  const stop = watchEngineEffects(engine, watch);
  return () => {
    stopped = true;
    stop();
  };
}
