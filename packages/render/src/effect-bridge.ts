import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { watchEngineEffects } from "./effect-requests";

/** Longest a bridge keeps Effects for a view that never presents (a load that failed or was abandoned). */
export const EFFECT_BRIDGE_MS = 120_000;

/**
 * Most Effects an Engine keeps for its next Play (`keepPlayEffects`), least recently used first out: about two
 * Feature Test scenes' Play programs (a large level links about 100, a light one about 50). An Effect holds its
 * program and, on WebGPU, its pipelines, never a texture or render target, so the bound is a count of programs.
 */
export const PLAY_EFFECT_KEEP_BUDGET = 256;

type Bridge = { effects: Effect[]; timer: ReturnType<typeof setTimeout> };
const bridges = new WeakMap<AbstractEngine, Bridge>();
/** Engines whose disposal ends their bridge. */
const watched = new WeakSet<AbstractEngine>();

/**
 * Keeps every Effect compiled on `engine` until its next world view has presented (`releaseBridgedEffects`), when a
 * view closes on an Engine that outlives it. The editor's scene view closes before Play loads, and Play's before the
 * editor's scene reloads; both draw mostly the same Materials. Babylon releases an Effect, its program and its
 * pipelines with its last draw wrapper, so without the bridge every such load compiles them again; with it the next
 * load's Materials find them in the Engine's Effect cache. One reference each; a later bridge takes over an earlier
 * one, and the bridge ends after `EFFECT_BRIDGE_MS` or with the Engine.
 */
export function bridgeEngineEffects(engine: AbstractEngine): void {
  if (engine.isDisposed) return;
  const effects = takeCompiledEffects(engine);
  // Retained before the earlier bridge lets go, so an Effect both hold never reaches zero in between.
  const previous = bridges.get(engine);
  if (!watched.has(engine)) {
    watched.add(engine);
    engine.onDisposeObservable.addOnce(() => releaseBridgedEffects(engine));
  }
  bridges.set(engine, { effects, timer: setTimeout(() => releaseBridgedEffects(engine), EFFECT_BRIDGE_MS) });
  if (previous) release(previous);
}

/** One reference on each Effect in `engine`'s cache, returned. */
function takeCompiledEffects(engine: AbstractEngine): Effect[] {
  const compiled = (engine as unknown as { _compiledEffects?: Record<string, unknown> })._compiledEffects ?? {};
  const effects: Effect[] = [];
  for (const effect of Object.values(compiled)) {
    if (!(effect instanceof Effect) || effect.isDisposed) continue;
    effect._refCount += 1;
    effects.push(effect);
  }
  return effects;
}

/**
 * Holds one reference on every Effect compiled on `engine` now, until the returned release, the Engine's disposal or a
 * lost context (a WebGL2 restore relinks every Effect left in the cache). For a switch that stops drawing programs the
 * view draws again once switched back (Play's `postprocessing off`): they stay in the Effect cache meanwhile, so
 * switching back links none of them again, whatever the Play keep's budget let go.
 */
export function holdCompiledEffects(engine: AbstractEngine): () => void {
  if (engine.isDisposed) return () => {};
  const effects = takeCompiledEffects(engine);
  const release = () => {
    engine.onDisposeObservable.remove(disposed);
    engine.onContextLostObservable.remove(lost);
    for (const effect of effects.splice(0)) effect.dispose();
  };
  const disposed = engine.onDisposeObservable.addOnce(release);
  const lost = engine.onContextLostObservable.add(release);
  return release;
}

/** Ends `engine`'s bridge: Effects no view draws any more are released. */
export function releaseBridgedEffects(engine: AbstractEngine): void {
  const bridge = bridges.get(engine);
  if (!bridge) return;
  bridges.delete(engine);
  release(bridge);
}

function release(bridge: Bridge): void {
  clearTimeout(bridge.timer);
  for (const effect of bridge.effects) effect.dispose();
  bridge.effects.length = 0;
}

/**
 * The Effects an Engine keeps for Play, in use order (the most recently used last), with one reference each, and
 * the Engine observers that end the keep, attached only while it holds any.
 */
type Keep = {
  engine: AbstractEngine;
  effects: Set<Effect>;
  /** Effects returned while they compile, kept once they have. */
  compiling: WeakSet<Effect>;
  budget: number;
  observers: { disposed: Observer<AbstractEngine>; lost: Observer<AbstractEngine> } | null;
};
const keeps = new WeakMap<AbstractEngine, Keep>();

const failed = (effect: Effect) => Boolean(effect.getCompilationError()) && effect.allFallbacksProcessed();

function keepFor(engine: AbstractEngine): Keep {
  const existing = keeps.get(engine);
  if (existing) return existing;
  const keep: Keep = { engine, effects: new Set(), compiling: new WeakSet(), budget: PLAY_EFFECT_KEEP_BUDGET, observers: null };
  keeps.set(engine, keep);
  return keep;
}

function drop(keep: Keep, effect: Effect): void {
  if (!keep.effects.delete(effect)) return;
  // An Effect its owner disposed for good (`dispose(true)`) holds no reference of ours any more.
  if (!effect.isDisposed) effect.dispose();
  if (keep.effects.size > 0 || !keep.observers) return;
  keep.engine.onDisposeObservable.remove(keep.observers.disposed);
  keep.engine.onContextLostObservable.remove(keep.observers.lost);
  keep.observers = null;
}

/** Takes one reference on a compiled `effect`. */
function retain(keep: Keep, effect: Effect): void {
  effect._refCount += 1;
  keep.effects.add(effect);
  const { engine } = keep;
  keep.observers ??= {
    disposed: engine.onDisposeObservable.addOnce(() => releaseKept(keep)),
    // A WebGL2 restore relinks every Effect left in the cache: let the kept ones go with the lost context.
    lost: engine.onContextLostObservable.add(() => releaseKept(keep)),
  };
  for (const oldest of keep.effects) {
    if (keep.effects.size <= keep.budget) break;
    drop(keep, oldest);
  }
}

/** One `keepPlayEffects` call: the Effects it took, and whether it has stopped or discarded them. */
type Session = { taken: Set<Effect>; stopped: boolean; discarded: boolean };

/**
 * Retains `effect` once it has compiled, or marks a kept one the most recently used. Only a compiled program is kept:
 * one its owners let go while it still compiles is abandoned (Babylon then skips preparing it), and holding it would
 * have Babylon finish it for nobody, from shader sources its owner may have removed (a post-process pass's), or keep a
 * program that cannot link, which a later requester would get from the cache without its error.
 */
function take(keep: Keep, effect: Effect, session: Session): void {
  if (!(effect instanceof Effect) || effect.isDisposed || failed(effect)) return;
  if (keep.effects.delete(effect)) {
    keep.effects.add(effect);
    return;
  }
  if (effect.isReady()) {
    retain(keep, effect);
    session.taken.add(effect);
    return;
  }
  if (keep.compiling.has(effect)) return;
  keep.compiling.add(effect);
  // Babylon notifies the observable after its creator's `onCompiled`.
  effect.onCompileObservable.addOnce(() => {
    keep.compiling.delete(effect);
    if (session.discarded || effect.isDisposed || keep.effects.has(effect)) return;
    retain(keep, effect);
    session.taken.add(effect);
    if (session.stopped) forgetCreator(effect);
  });
}

/**
 * Keeps every Effect `engine` returns from now until the returned stop (a Play view's life), and past it: Play's
 * programs then survive Stop and the editor's reload, so the next Play finds those it draws again in the Engine's
 * Effect cache, and a load that releases a program and asks for it again (a graph rebuilt during the load, an
 * environment filter run twice) links it once. One reference each, taken once the program has compiled (`take`), at
 * most `PLAY_EFFECT_KEEP_BUDGET` Effects (`budget`, which only tests lower), the least recently returned released first. The keep goes with
 * the Engine and with a lost context. Stopping clears a kept Effect's compile callbacks, which belong to whoever first
 * created it, so a kept Effect holds no closed Play's Scene. Stopping with `discard` (a view whose construction
 * failed) instead releases the Effects this call took, leaving the keep as it found it.
 */
export function keepPlayEffects(engine: AbstractEngine, budget = PLAY_EFFECT_KEEP_BUDGET): (discard?: boolean) => void {
  if (engine.isDisposed) return () => {};
  const keep = keepFor(engine);
  keep.budget = budget;
  const session: Session = { taken: new Set(), stopped: false, discarded: false };
  const stopWatching = watchEngineEffects(engine, (effect) => take(keep, effect, session));
  return (discard = false) => {
    if (session.stopped) return;
    session.stopped = true;
    stopWatching();
    if (discard) {
      session.discarded = true;
      for (const effect of session.taken) drop(keep, effect);
      return;
    }
    for (const effect of keep.effects) forgetCreator(effect);
  };
}

function forgetCreator(effect: Effect): void {
  effect.onCompiled = null;
  effect.onError = null;
}

/**
 * Ends `engine`'s keep: Effects nothing else holds are released. Test seam: production ends it through the Engine's
 * dispose and context-lost observers.
 */
export function releaseKeptEffects(engine: AbstractEngine): void {
  const keep = keeps.get(engine);
  if (keep) releaseKept(keep);
}

function releaseKept(keep: Keep): void {
  for (const effect of [...keep.effects]) drop(keep, effect);
}

/** How many Effects `engine` keeps for Play. Test seam: production code does not call it. */
export function keptEffectCount(engine: AbstractEngine): number {
  return keeps.get(engine)?.effects.size ?? 0;
}
